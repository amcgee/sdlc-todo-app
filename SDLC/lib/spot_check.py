#!/usr/bin/env python3
"""spot_check.py — re-execute the verifier's central claim mechanically.

A `test` ledger entry claims its named test FAILS at the recorded pre-fix commit and
PASSES after the fix. This tool re-runs that claim instead of trusting it: for each
eligible entry it creates a throwaway git worktree at `pre_sha`, copies the named test
files from the CURRENT tree in (the proving test did not exist pre-fix), runs each
recorded target there and requires a FAILING result, then runs the same targets in the
current tree and requires a PASS.

Targets run at the LEDGER'S granularity: a `file::name` entry is executed as that one
test (`<test-cmd> <file> <name-flag> <name>`, default flag `-t` — vitest/jest; use
`--name-flag -k` for pytest), never as its whole file — otherwise a vacuous named test
could hide behind an unrelated failing test in the same file.

Usage:
  python SDLC/lib/spot_check.py --item ISSUE-7             # all eligible entries
  python SDLC/lib/spot_check.py --item ISSUE-7 --base <sha>  # only entries the ledger
                                                           # gained since <sha> (CI
                                                           # passes the merge base)
  options: --max N (default 3) · --test-cmd "bunx vitest run" · --install-cmd "bun install"
           --name-flag -t

Exit 1 only when a proving claim is DISPROVEN — the test passes at pre_sha, or fails
at HEAD. Infrastructure trouble (missing pre_sha, worktree or install failure, or a run
that exceeds --timeout) is reported and skipped: this is a spot check, not a build step.
A timed-out run is explicitly infrastructure, NOT a disproof — a hung test must never be
scored as "fails pre-fix" (which would spuriously verify the claim).

Caveat, by design: in the pre-fix worktree an erroring run (e.g. the test imports a
helper that didn't exist yet) counts as "failing", the same as a clean assertion
failure. The strong guarantee is the one that matters — a test that PASSES on the
pre-fix code proves nothing, and that is what gets caught.
"""
from __future__ import annotations
import argparse, json, os, shlex, shutil, subprocess, sys, tempfile
from pathlib import Path

BASE = Path(__file__).resolve().parent          # the SDLC/lib/ directory
SDLC_DIR = BASE.parent                           # the SDLC/ directory
ROOT = BASE.parent.parent                        # the repo root


def _rounds_path() -> Path:
    """The append-only ledger file, resolved through the shared reader (the sibling
    manifest.py): SDLC_LEDGER_DIR env > manifest `ledger_dir` > default `.sdlc/ledger`.
    When the reader can't be imported (a sandbox carrying spot_check.py alone), only the
    env or the default applies — the manifest file is never parsed outside its one reader."""
    try:
        sys.path.insert(0, str(BASE))
        import manifest
        return manifest.rounds_path()
    except Exception:
        p = Path(os.environ.get("SDLC_LEDGER_DIR") or ".sdlc/ledger")
        return (p if p.is_absolute() else (ROOT / p)) / "rounds.jsonl"


LEDGER = _rounds_path()                           # <ledger_dir>/rounds.jsonl, outside SDLC/


def _run(args, cwd, timeout=600):
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout)


def _entries(base_sha: str | None) -> list[dict]:
    """All ledger entries, or only the lines the ledger gained since base_sha.
    A failed diff (unknown sha) must not silently become "nothing to verify" — fall
    back to the FULL ledger (still capped by --max) and say so."""
    if not base_sha:
        if not LEDGER.exists():
            return []
        lines = LEDGER.read_text().splitlines()
    else:
        try:
            r = _run(["git", "diff", base_sha, "HEAD", "--",
                      str(LEDGER.relative_to(ROOT))], cwd=ROOT)
        except subprocess.TimeoutExpired:
            print(f"spot-check: ⚠ git diff against {base_sha[:12]} timed out — "
                  f"falling back to the full ledger")
            return _entries(None)
        if r.returncode != 0:
            err = (r.stderr or "").strip().splitlines()
            print(f"spot-check: ⚠ git diff against {base_sha[:12]} failed "
                  f"({err[-1] if err else 'unknown error'}) — falling back to the full ledger")
            return _entries(None)
        lines = [l[1:] for l in r.stdout.splitlines()
                 if l.startswith("+") and not l.startswith("+++")]
    out = []
    for line in lines:
        line = line.strip()
        if line:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return out


def _toolchain():
    """Test-runner defaults from the project adapter manifest, via the one shared reader
    (the sibling manifest.py), so a ported repo points spot-check at its own runner — pytest,
    go test, cargo, anything — in one place. CLI flags still win. Without the reader the
    built-in defaults apply — the manifest file is never parsed outside its one reader."""
    try:
        sys.path.insert(0, str(BASE))
        import manifest
        return manifest.toolchain()
    except Exception:
        return {}


def main():
    tc = _toolchain()
    p = argparse.ArgumentParser(description="Re-run proving tests at their recorded pre-fix commits")
    p.add_argument("--item", required=True)
    p.add_argument("--base", default=None, help="only check test entries appended since this sha (CI: the merge base)")
    p.add_argument("--max", type=int, default=3, dest="cap", help="check at most the N most recent eligible entries")
    p.add_argument("--test-cmd", default=tc.get("test", "bunx vitest run"), help="command that runs the named test files (default: manifest toolchain.test)")
    p.add_argument("--install-cmd", default=tc.get("install", "bun install"), help="dependency install run inside the pre-fix worktree (default: manifest toolchain.install)")
    p.add_argument("--name-flag", dest="name_flag", default=tc.get("name_flag", "-t"),
                   help="flag that filters to one test name within a file (-t for vitest/jest, -k for pytest)")
    p.add_argument("--timeout", type=int, default=600,
                   help="per-run timeout in seconds; a run that exceeds it is an infra skip, not a disproof")
    a = p.parse_args()

    eligible = [e for e in _entries(a.base)
                if e.get("type") == "test" and e.get("pre_sha") and e.get("tests")
                and (e.get("ref") == a.item or str(e.get("ref", "")).startswith(a.item + "-"))]
    if not eligible:
        print(f"spot-check: no test entries with --pre-sha for {a.item}"
              + (f" since {a.base[:12]}" if a.base else "") + " — nothing to verify.")
        return 0
    eligible = eligible[-a.cap:]
    print(f"spot-check: verifying {len(eligible)} proving-test claim(s) for {a.item}")

    disproven, skipped = [], []
    for e in eligible:
        ref, pre = e["ref"], e["pre_sha"]
        files = sorted({t.partition("::")[0] for t in e["tests"]})
        missing = [f for f in files if not (ROOT / f).is_file()]
        if missing:
            disproven.append(f"{ref}: named test file(s) do not exist at HEAD: {missing}")
            continue

        wt = Path(tempfile.mkdtemp(prefix="sdlc-prefix-"))
        try:
            r = _run(["git", "worktree", "add", "--detach", str(wt), pre], cwd=ROOT)
            if r.returncode != 0:
                skipped.append(f"{ref}: cannot check out pre-fix commit {pre[:12]} "
                               f"({r.stderr.strip().splitlines()[-1] if r.stderr.strip() else 'worktree failed'})")
                continue
            for f in files:                       # the proving test didn't exist pre-fix
                dst = wt / f
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(ROOT / f, dst)
            # Install deps if the manifest declares an install command (any language). An
            # empty toolchain.install means no install step; a failing install is infra, skipped.
            if a.install_cmd and a.install_cmd.strip():
                r = _run(shlex.split(a.install_cmd), cwd=wt, timeout=a.timeout)
                if r.returncode != 0:
                    skipped.append(f"{ref}: dependency install failed in the pre-fix worktree")
                    continue
            # Each recorded target runs individually, at the ledger's granularity: a
            # whole-file run would let a vacuous `file::name` hide behind an unrelated
            # failing test in the same file.
            def target_args(t):
                f, _, name = t.partition("::")
                return [f] + ([a.name_flag, name] if name else [])

            verdict = None
            for t in e["tests"]:
                pre_run = _run(shlex.split(a.test_cmd) + target_args(t), cwd=wt, timeout=a.timeout)
                if pre_run.returncode == 0:
                    verdict = (f"{ref}: {t} PASSES at pre-fix {pre[:12]} — the "
                               f"'fails pre-fix' claim is false; this test proves nothing")
                    break
            if verdict is None:
                for t in e["tests"]:
                    post_run = _run(shlex.split(a.test_cmd) + target_args(t), cwd=ROOT, timeout=a.timeout)
                    if post_run.returncode != 0:
                        verdict = (f"{ref}: {t} FAILS at HEAD — the fix is not proven on "
                                   f"the current tree\n{(post_run.stdout + post_run.stderr)[-2000:]}")
                        break
            if verdict is not None:
                disproven.append(verdict)
                continue
            print(f"  ✅ {ref}: fails at {pre[:12]}, passes at HEAD — claim verified")
        except subprocess.TimeoutExpired as ex:
            # A hung run is infrastructure, never a disproof: routing a timeout to
            # "fails pre-fix" would spuriously VERIFY the claim, and to "fails at HEAD"
            # would spuriously disprove it. Skip it either way.
            cmd = ex.cmd[0] if isinstance(ex.cmd, (list, tuple)) and ex.cmd else "a run"
            skipped.append(f"{ref}: {cmd} exceeded the {a.timeout}s timeout — infrastructure, not a disproof")
            continue
        finally:
            _run(["git", "worktree", "remove", "--force", str(wt)], cwd=ROOT)
            shutil.rmtree(wt, ignore_errors=True)

    for s in skipped:
        print(f"  ⚠ skipped — {s}")
    if disproven:
        print(f"\n⛔ {len(disproven)} proving claim(s) DISPROVEN:")
        for d in disproven:
            print(f"  - {d}")
        return 1
    print("spot-check: all verified claims hold"
          + (f" ({len(skipped)} skipped on infrastructure)" if skipped else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
