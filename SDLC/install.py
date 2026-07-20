#!/usr/bin/env python3
"""install.py — bootstrap the Adversarial Agentic SDLC into a target repository.

The framework lives under `SDLC/` and copies as one directory. The platform wiring it
needs to run — `.claude/` (agents, skills, the `sdlc` driver, the guard hooks, settings),
three `.github/workflows/`, and the one app-specific manifest `sdlc.config.json` at the
repo root — lives OUTSIDE `SDLC/` but travels with the framework repo. This installer
materializes all of it into a target repo, at the hardcoded `<repo-root>/SDLC/...` and
`<repo-root>/.claude/...` paths that the CLI, hooks, and workflows resolve against.

Obtain the framework however you like — clone, `git submodule add`, download, or a vendored
copy — then run this from the framework checkout:

    python3 SDLC/install.py --target /path/to/your/repo

Git-submodule recipe (vendors upstream once, then materializes into place):

    git submodule add <framework-repo-url> vendor/agentic-sdlc
    python3 vendor/agentic-sdlc/SDLC/install.py --target .
    # upgrade later:  git submodule update --remote && python3 vendor/agentic-sdlc/SDLC/install.py --target . --force

The installer is idempotent, never overwrites your `sdlc.config.json` or app files, and
uses `--force` only to refresh wiring it previously wrote. It automates the manual playbook
in SDLC/docs/reuse.md — read that for the why behind each step. Stdlib only; Python 3.8+.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

# Framework layout, relative to the framework checkout root (the parent of SDLC/).
FRAMEWORK_DIR = "SDLC"
CLAUDE_DIR = ".claude"
WORKFLOWS_DIR = ".github/workflows"
MANIFEST = "sdlc.config.json"

# The three framework workflows (thin orchestrators). App workflows are NOT copied.
FRAMEWORK_WORKFLOWS = ("framework-tests.yml", "security.yml", "sdlc-arbiter-gate.yml")

# The `.claude/` wiring the framework needs; only these subdirectories are copied, so any
# app-specific files a target keeps in its own `.claude/` are untouched.
CLAUDE_WIRING = ("agents", "skills", "commands", "hooks")

# The mutable ledger lives OUTSIDE SDLC/ (default here) so the framework directory is fully
# immutable — a submodule works as-is and copying SDLC/ needs no exceptions. Overridable in
# the target via the `ledger_dir` manifest key or the SDLC_LEDGER_DIR env.
DEFAULT_LEDGER_DIR = ".sdlc/ledger"

# Ledger artifacts wiped so a port starts from an empty record; `.gitkeep` is preserved.
LEDGER_ARTIFACTS = ("rounds.jsonl", "gates.json", "audit.jsonl", ".build-open")

# The append-only ledger is union-merged so parallel SDLC workflows never conflict; that
# depends on this `.gitattributes` line at the repo root. Merged into the target's file.
LEDGER_MERGE_LINE = f"{DEFAULT_LEDGER_DIR}/rounds.jsonl merge=union"
GITATTRIBUTES_BLOCK = (
    "# The adversarial SDLC ledger is append-only: every line is a self-contained,\n"
    "# timestamped JSON record and the CLI (SDLC/sdlc.py) reconstructs state by scanning\n"
    "# the whole file, independent of line order. That makes concatenating two branches'\n"
    "# appends the correct merge — so parallel SDLC workflows merge without conflicts.\n"
    "# Combined with item-scoped finding ids, union-merged ledgers stay collision-free.\n"
    f"{LEDGER_MERGE_LINE}\n"
)

# Directories skipped when copying the framework tree.
COPY_IGNORE = shutil.ignore_patterns("__pycache__", "*.pyc", ".pytest_cache")

MARK_BEGIN = "<!-- SDLC:BEGIN operator guide (managed by SDLC/install.py) -->"
MARK_END = "<!-- SDLC:END operator guide -->"


class Reporter:
    """Prints each action and, in dry-run mode, guarantees nothing is written."""

    def __init__(self, dry_run: bool) -> None:
        self.dry_run = dry_run
        self.wrote = False

    def act(self, msg: str) -> None:
        print(f"  {'[dry-run] ' if self.dry_run else ''}{msg}")
        self.wrote = self.wrote or not self.dry_run

    def skip(self, msg: str) -> None:
        print(f"  · {msg}")

    def note(self, msg: str) -> None:
        print(msg)


def manifest_template() -> str:
    """A commented starter manifest — the one file a port must hand-edit for its stack.

    Distinct from any concrete manifest: every value is a placeholder the operator sets.
    Read only through SDLC/lib/manifest.py; see SDLC/docs/reuse.md §2.
    """
    template = {
        "_about": (
            "The project adapter manifest — the one app-specific file, at the repo root "
            "so SDLC/ ports unedited. Read only through SDLC/lib/manifest.py. "
            "Edit every value below for your stack. See SDLC/docs/reuse.md §2."
        ),
        "_shipped_paths_note": "The code dirs the build gate protects — your source layout, any language.",
        "shipped_paths": ["src/"],
        "_trust_boundaries_note": "Dirs whose diffs trigger the mandatory STRIDE pass (subset of shipped_paths, or others).",
        "trust_boundaries": [],
        "_scan_paths_note": "ADDITIVE extra dirs for the semgrep floor, on top of shipped_paths (e.g. build/dev tooling).",
        "scan_paths": [],
        "_toolchain_note": "How tests run — any language. `install` runs whenever set; `name_flag` is the single-test selector (pytest -k, vitest -t).",
        "toolchain": {
            "install": "",
            "test": "",
            "coverage": "",
            "name_flag": "-k",
        },
        "_docs_note": "Paths the pm keeps current — screenshot baselines, the architecture map, the user guide.",
        "docs": {
            "screenshots": "docs/screenshots/",
            "architecture": "docs/architecture.md",
            "user_guide": "docs/guide/",
        },
        "_ledger_dir_note": (
            f"Optional. Where the mutable ledger lives, relative to the repo root; "
            f"default '{DEFAULT_LEDGER_DIR}' (outside SDLC/). Change to relocate the record; "
            f"keep the .gitattributes union-merge line in sync."
        ),
    }
    return json.dumps(template, indent=2) + "\n"


def operator_block() -> str:
    """The generic CLAUDE.md operator section, merged into the target's CLAUDE.md."""
    return f"""{MARK_BEGIN}
# Adversarial Agentic SDLC — operator guide

This repo develops software with the **Adversarial Agentic SDLC**: a blue team builds, a red
team attacks, and a neutral arbiter opens each gate only on the strength of an append-only
ledger — nothing is "done" because an agent says so, only because the record proves it.

**The framework documents itself under `SDLC/`.** Start at **[SDLC/README.md](SDLC/README.md)**.
The one app-specific file is **`sdlc.config.json`** at the repo root — edit it for your stack
(see [SDLC/docs/reuse.md](SDLC/docs/reuse.md) §2).

## Working rules
- **Keep the PR description up to date.** Whenever the scope, approach, or set of changes on a
  PR shifts, refresh that PR's description in the same turn so it always reflects the current
  state of the branch.
- **Terse, current, useful prose.** Write every comment, docstring, and doc to describe the
  *current* framework — no archaeology, no rejected-alternative asides. State what the code does
  and why it matters, once.

## Where everything is

| I want to… | Go to |
|---|---|
| Understand the flow, teams, phases & gates | [SDLC/docs/methodology.md](SDLC/docs/methodology.md) |
| Use the ledger CLI (the spine) | `python SDLC/sdlc.py --help` |
| Run a full cycle from a GitHub issue | the `/sdlc` driver — [.claude/commands/sdlc.md](.claude/commands/sdlc.md) |
| Set up the GitHub routine | [SDLC/docs/SETUP.md](SDLC/docs/SETUP.md) |
| Tune framework constants | `SDLC/constants.json` (app/stack couplings: `sdlc.config.json` at the repo root) |
{MARK_END}
"""


def merge_lists(base: list, extra: list) -> list:
    """Union preserving order: base first, then any extra not already present."""
    out = list(base)
    for item in extra:
        if item not in out:
            out.append(item)
    return out


def merge_settings(existing: dict, source: dict) -> dict:
    """Merge the framework's `.claude/settings.json` into an existing one without clobber.

    Permission lists become unions; `env` keys the target hasn't set are added; hook groups
    are appended only when no existing hook already references our guard scripts (so re-runs
    don't stack duplicates). The target's own settings always win on conflict.
    """
    merged = json.loads(json.dumps(existing))  # deep copy

    perms = merged.setdefault("permissions", {})
    for key in ("allow", "ask", "deny"):
        src = source.get("permissions", {}).get(key, [])
        if src:
            perms[key] = merge_lists(perms.get(key, []), src)

    env = merged.setdefault("env", {})
    for key, val in source.get("env", {}).items():
        env.setdefault(key, val)

    # Hooks: merged per matcher-group, then per individual hook, so an upgrade can ADD a
    # framework hook to a group the target already has (e.g. a new guard joining the Bash
    # matcher) without ever duplicating one that is wired. Each hook is identified by a
    # SLOT — the framework guards by filename, and the session-install hook by either its
    # manifest-driven form or a hand-edited legacy install command — so functionally
    # equivalent variants collide instead of stacking.
    def _slot(cmd: str) -> str:
        for m in ("gate_guard.py", "git_branch_guard.py", "bash_write_guard.py"):
            if m in cmd:
                return m
        if "manifest.toolchain" in cmd or "install" in cmd:
            return "session-install"
        return cmd

    hooks = merged.setdefault("hooks", {})
    for event, groups in source.get("hooks", {}).items():
        existing_groups = hooks.setdefault(event, [])
        for group in groups:
            matcher = group.get("matcher")
            target = next((g for g in existing_groups if g.get("matcher") == matcher), None)
            if target is None:
                existing_groups.append(json.loads(json.dumps(group)))
                continue
            wired = {_slot(h.get("command", "")) for g in existing_groups
                     for h in g.get("hooks", [])}
            for hook in group.get("hooks", []):
                if _slot(hook.get("command", "")) not in wired:
                    target.setdefault("hooks", []).append(dict(hook))
    return merged


def copy_tree(src: Path, dst: Path, rep: Reporter, *, force: bool) -> None:
    """Copy a directory tree, refusing to overwrite an existing dst unless --force."""
    if dst.exists() and not force:
        rep.skip(f"{dst} exists — kept (use --force to refresh)")
        return
    rep.act(f"copy {src.name}/ → {dst}")
    if rep.dry_run:
        return
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst, ignore=COPY_IGNORE)


def copy_file(src: Path, dst: Path, rep: Reporter, *, force: bool) -> None:
    if dst.exists() and not force:
        rep.skip(f"{dst} exists — kept (use --force to refresh)")
        return
    rep.act(f"copy {src.name} → {dst}")
    if not rep.dry_run:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)


def clean_ledger(ledger: Path, rep: Reporter) -> None:
    """Start a FRESH target on an empty record. A target that already holds a record is
    left completely untouched — an upgrade re-run (`--force` after a submodule update)
    must never erase history."""
    if (ledger / "rounds.jsonl").exists():
        rep.skip(f"{ledger} already holds a record — left untouched")
        return
    rep.act(f"start clean ledger at {ledger}")
    if rep.dry_run:
        return
    ledger.mkdir(parents=True, exist_ok=True)
    for name in LEDGER_ARTIFACTS:
        f = ledger / name
        if f.exists():
            f.unlink()
    (ledger / ".gitkeep").touch()


def _target_ledger_dir(dst_root: Path) -> Path:
    """The target's ledger dir — the manifest's `ledger_dir` if set, else the default,
    anchored at the target root. Lives outside SDLC/, so the framework copies unedited."""
    try:
        raw = json.loads((dst_root / MANIFEST).read_text()).get("ledger_dir")
    except Exception:
        raw = None
    p = Path(raw or DEFAULT_LEDGER_DIR)
    return p if p.is_absolute() else (dst_root / p)


def install_framework(src_root: Path, dst_root: Path, rep: Reporter, *, force: bool) -> None:
    # SDLC/ carries no mutable state, so it copies as one directory with no exceptions.
    src = src_root / FRAMEWORK_DIR
    dst = dst_root / FRAMEWORK_DIR
    if src.resolve() == dst.resolve():
        rep.skip(f"{dst} is the framework source in place — not copied")
    else:
        copy_tree(src, dst, rep, force=force)
    clean_ledger(_target_ledger_dir(dst_root), rep)


def install_claude(src_root: Path, dst_root: Path, rep: Reporter, *, force: bool) -> None:
    src = src_root / CLAUDE_DIR
    dst = dst_root / CLAUDE_DIR
    for name in CLAUDE_WIRING:
        if (src / name).exists():
            copy_tree(src / name, dst / name, rep, force=force)

    # settings.json — merge rather than clobber.
    src_settings = src / "settings.json"
    dst_settings = dst / "settings.json"
    if not src_settings.exists():
        return
    if not dst_settings.exists():
        copy_file(src_settings, dst_settings, rep, force=force)
        return
    source = json.loads(src_settings.read_text())
    existing = json.loads(dst_settings.read_text())
    merged = merge_settings(existing, source)
    if merged == existing:
        rep.skip(f"{dst_settings} already has the SDLC wiring — unchanged")
    else:
        rep.act(f"merge SDLC wiring into {dst_settings}")
        if not rep.dry_run:
            dst_settings.write_text(json.dumps(merged, indent=2) + "\n")


def install_workflows(src_root: Path, dst_root: Path, rep: Reporter, *, force: bool) -> None:
    src = src_root / WORKFLOWS_DIR
    dst = dst_root / WORKFLOWS_DIR
    for name in FRAMEWORK_WORKFLOWS:
        if (src / name).exists():
            copy_file(src / name, dst / name, rep, force=force)
        else:
            rep.skip(f"{name} not found in source — skipped")


def install_gitattributes(dst_root: Path, rep: Reporter) -> None:
    """Ensure the ledger union-merge driver is wired in the target's `.gitattributes`."""
    dst = dst_root / ".gitattributes"
    if not dst.exists():
        rep.act(f"create {dst} with the ledger union-merge driver")
        if not rep.dry_run:
            dst.write_text(GITATTRIBUTES_BLOCK)
        return
    text = dst.read_text()
    if any(line.strip() == LEDGER_MERGE_LINE for line in text.splitlines()):
        rep.skip(f"{dst} already wires the ledger union-merge driver — unchanged")
        return
    rep.act(f"append the ledger union-merge driver to {dst}")
    if not rep.dry_run:
        sep = "" if text.endswith("\n") else "\n"
        dst.write_text(text + sep + "\n" + GITATTRIBUTES_BLOCK)


def install_manifest(dst_root: Path, rep: Reporter) -> None:
    dst = dst_root / MANIFEST
    if dst.exists():
        rep.skip(f"{dst} exists — kept (your manifest is never overwritten)")
        return
    rep.act(f"scaffold {dst} (edit it for your stack)")
    if not rep.dry_run:
        dst.write_text(manifest_template())


def install_claude_md(dst_root: Path, rep: Reporter) -> None:
    dst = dst_root / "CLAUDE.md"
    block = operator_block()
    if not dst.exists():
        rep.act(f"create {dst} with the operator guide")
        if not rep.dry_run:
            dst.write_text(block)
        return
    text = dst.read_text()
    if MARK_BEGIN in text and MARK_END in text:
        head, _, rest = text.partition(MARK_BEGIN)
        _, _, tail = rest.partition(MARK_END)
        new = head + block.rstrip("\n") + tail
        if new == text:
            rep.skip(f"{dst} operator guide already current — unchanged")
        else:
            rep.act(f"refresh operator guide in {dst}")
            if not rep.dry_run:
                dst.write_text(new)
    else:
        rep.act(f"append operator guide to {dst}")
        if not rep.dry_run:
            sep = "" if text.endswith("\n\n") else ("\n" if text.endswith("\n") else "\n\n")
            dst.write_text(text + sep + block)


def smoke_test(dst_root: Path, rep: Reporter) -> bool:
    """Confirm the ported framework runs: version + a doctor integrity check."""
    import subprocess

    cli = dst_root / FRAMEWORK_DIR / "sdlc.py"
    if not cli.exists():
        rep.note(f"  · {cli} not present — skipping smoke test")
        return True
    ok = True
    for args, label in (
        (["version"], "version"),
        (["doctor", "--exit-code"], "doctor"),
    ):
        try:
            res = subprocess.run(
                [sys.executable, str(cli), *args],
                cwd=dst_root, capture_output=True, text=True, timeout=120,
            )
        except Exception as exc:  # pragma: no cover - defensive
            rep.note(f"  ✗ smoke {label}: could not run ({exc})")
            ok = False
            continue
        tag = "✓" if res.returncode == 0 else "✗"
        rep.note(f"  {tag} smoke {label}: {(res.stdout or res.stderr).strip().splitlines()[0] if (res.stdout or res.stderr).strip() else 'ok'}")
        ok = ok and res.returncode == 0
    return ok


def next_steps(dst_root: Path) -> None:
    print(
        "\nNext steps:\n"
        f"  1. Edit {dst_root / MANIFEST} for your stack (shipped_paths, toolchain, trust_boundaries).\n"
        "  2. The SessionStart hook runs the manifest's toolchain.install automatically; on a\n"
        "     non-JS stack also swap the 'Install project runtime' step in sdlc-arbiter-gate.yml.\n"
        "  3. Reimplement or drop the app adapters (see SDLC/docs/reuse.md §3).\n"
        "  4. Set up the GitHub routine and branch protection — SDLC/docs/SETUP.md.\n"
        "  5. Verify:  python3 SDLC/sdlc.py doctor --exit-code  &&  python3 SDLC/tests/test_ledger.py\n"
        "  6. Commit the wiring, then open your first `sdlc`-labelled issue.\n"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="install.py",
        description="Bootstrap the Adversarial Agentic SDLC into a target repository.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--target", "-t", default=".",
        help="Target repo root to install into (default: current directory).",
    )
    parser.add_argument(
        "--force", "-f", action="store_true",
        help="Refresh wiring files/dirs that already exist (never touches sdlc.config.json).",
    )
    parser.add_argument(
        "--dry-run", "-n", action="store_true",
        help="Show what would happen without writing anything.",
    )
    parser.add_argument(
        "--no-smoke", action="store_true",
        help="Skip the post-install smoke test (version + doctor).",
    )
    args = parser.parse_args(argv)

    src_root = Path(__file__).resolve().parents[1]   # framework checkout root (parent of SDLC/)
    dst_root = Path(args.target).resolve()
    rep = Reporter(args.dry_run)

    if not (src_root / FRAMEWORK_DIR / "sdlc.py").exists():
        print(f"error: framework not found next to this script (looked in {src_root}).", file=sys.stderr)
        return 2
    if not dst_root.exists():
        print(f"error: target {dst_root} does not exist.", file=sys.stderr)
        return 2
    if not (dst_root / ".git").exists():
        rep.note(f"warning: {dst_root} is not a git repository — installing anyway.")

    rep.note(f"Installing the Adversarial Agentic SDLC")
    rep.note(f"  from : {src_root}")
    rep.note(f"  into : {dst_root}{'  (dry run)' if args.dry_run else ''}\n")

    rep.note("Framework (SDLC/):")
    install_framework(src_root, dst_root, rep, force=args.force)
    rep.note(".claude/ wiring:")
    install_claude(src_root, dst_root, rep, force=args.force)
    rep.note(".github/workflows/ (framework):")
    install_workflows(src_root, dst_root, rep, force=args.force)
    rep.note("Manifest, .gitattributes & operator guide:")
    install_gitattributes(dst_root, rep)
    install_manifest(dst_root, rep)
    install_claude_md(dst_root, rep)

    if not args.dry_run and not args.no_smoke:
        rep.note("\nSmoke test:")
        smoke_test(dst_root, rep)

    next_steps(dst_root)
    if args.dry_run:
        rep.note("Dry run complete — nothing was written.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
