#!/usr/bin/env python3
"""Tests for `sdlc.py verify-gate` — the one CI entry point that bundles the ledger-semantic
gate checks (integrity, append-only, proving-tests-exist, merge gate). The workflow calls it
once; these prove it exits 0 only when every check passes and 1 on each failure mode.

Framework test (Python, stdlib only). Standalone (`python3 SDLC/tests/test_verify_gate.py`)
or under pytest.
"""
from __future__ import annotations
import json, subprocess, sys, tempfile
from pathlib import Path

import sandbox


# A minimal ledger whose MERGE gate is open: spec+build gates open, one round, no findings.
def _open_ledger(with_test_file: bool):
    lines = [
        {"type": "open", "item": "IT-1", "title": "t", "size": "standard"},
        {"type": "gate", "item": "IT-1", "phase": "spec", "result": "open"},
        {"type": "gate", "item": "IT-1", "phase": "build", "result": "open"},
        {"type": "round", "item": "IT-1", "by": "adversary"},
    ]
    if with_test_file:
        lines.append({"type": "test", "ref": "IT-1", "by": "verifier", "msg": "m",
                      "tests": ["tests/x.test.js"], "pre_sha": "a", "post_sha": "b"})
    # Every real entry carries an ordered timestamp; the gate math reads it.
    for i, l in enumerate(lines):
        l["ts"] = f"2026-07-06T00:{i:02d}:00Z"
    return "".join(json.dumps(l) + "\n" for l in lines)


def _sandbox(tmp: Path, *, with_test_file=True, create_test=True):
    repo = sandbox.make_repo(tmp, rounds_text=_open_ledger(with_test_file),
                             files={"tests/x.test.js": "// proving test\n"} if create_test else {},
                             commit=True)
    return repo, sandbox.head(repo)


def _run(repo, *args):
    return subprocess.run([sys.executable, str(repo / "SDLC" / "sdlc.py"), "verify-gate", *args],
                          cwd=repo, capture_output=True, text=True)


def test_verify_gate_passes_when_clean():
    with tempfile.TemporaryDirectory() as d:
        repo, base = _sandbox(Path(d))
        r = _run(repo, "--item", "IT-1", "--base", base)
        assert r.returncode == 0, r.stdout + r.stderr
        assert "all ledger checks passed" in r.stdout


def test_verify_gate_fails_on_missing_named_test():
    with tempfile.TemporaryDirectory() as d:
        repo, base = _sandbox(Path(d), with_test_file=True, create_test=False)  # ledger names it; file absent
        r = _run(repo, "--item", "IT-1", "--base", base)
        assert r.returncode == 1, r.stdout + r.stderr
        assert "does not exist" in r.stdout


def test_verify_gate_fails_on_ledger_deletion():
    with tempfile.TemporaryDirectory() as d:
        repo, base = _sandbox(Path(d))
        # rewrite the ledger to DROP a line, commit — the append-only check must catch it
        led = sandbox.rounds(repo)
        led.write_text("\n".join(led.read_text().splitlines()[:-1]) + "\n")
        sandbox.git(repo, "commit", "-qam", "rewrite ledger")
        r = _run(repo, "--item", "IT-1", "--base", base)
        assert r.returncode == 1, r.stdout + r.stderr
        assert "append-only" in r.stdout


# ---- artifact-only attestation (a fix a proving test structurally can't cover) --------------

def _ledger_with_finding(resolution: list[dict]):
    """A merge-ready-shaped ledger with one blocker finding whose resolution is `resolution`
    (the fix + whichever proving disposition the test is exercising). A round filing a blocker
    is dirty until a fresh clean round surveys the fix, so the fixture closes with a second,
    empty round — exactly what a real re-attack round does."""
    lines = [
        {"type": "open", "item": "IT-1", "title": "t", "size": "standard"},
        {"type": "gate", "item": "IT-1", "phase": "spec", "result": "open"},
        {"type": "gate", "item": "IT-1", "phase": "build", "result": "open"},
        {"type": "round", "item": "IT-1", "by": "adversary"},
        {"type": "finding", "id": "IT-1-F1", "item": "IT-1", "sev": "blocker",
         "by": "adversary", "msg": "weak test oracle", "state": "open"},
        *resolution,
        {"type": "round", "item": "IT-1", "by": "adversary"},   # clean re-attack round
    ]
    for i, l in enumerate(lines):
        l["ts"] = f"2026-07-06T00:{i:02d}:00Z"
    return "".join(json.dumps(l) + "\n" for l in lines)


def _attest_sandbox(tmp, resolution, files):
    repo = sandbox.make_repo(tmp, rounds_text=_ledger_with_finding(resolution),
                             files=files, commit=True)
    return repo, sandbox.head(repo)


def test_attest_resolves_a_test_only_fix():
    # A fix entirely in tests/ resolves the finding via `attest` — no fabricated proving test,
    # and the merge gate opens.
    with tempfile.TemporaryDirectory() as d:
        resolution = [
            {"type": "fix", "ref": "IT-1-F1", "by": "builder", "msg": "rewrote the oracle"},
            {"type": "attest", "ref": "IT-1-F1", "by": "verifier",
             "files": ["tests/todos.test.js"], "msg": "test-only; no product code changed"},
        ]
        repo, base = _attest_sandbox(Path(d), resolution, {"tests/todos.test.js": "// oracle\n"})
        r = _run(repo, "--item", "IT-1", "--base", base)
        assert r.returncode == 0, r.stdout + r.stderr
        assert "all ledger checks passed" in r.stdout


def test_attest_product_file_without_kind_comment_fails_the_gate():
    # A shipped file named without `kind: comment` reads as a behavioral product fix — which
    # owes a real proving test. CI must refuse it.
    with tempfile.TemporaryDirectory() as d:
        resolution = [
            {"type": "fix", "ref": "IT-1-F1", "by": "builder", "msg": "touched product code"},
            {"type": "attest", "ref": "IT-1-F1", "by": "verifier",
             "files": ["src/App.jsx"], "msg": "no kind — reads as a behavioral fix"},
        ]
        repo, base = _attest_sandbox(Path(d), resolution, {"src/App.jsx": "// product\n"})
        r = _run(repo, "--item", "IT-1", "--base", base)
        assert r.returncode == 1, r.stdout + r.stderr
        assert "without kind=comment" in r.stdout


def test_attest_comment_only_in_shipped_code_passes_with_flag():
    # A comment/docstring-only fix INSIDE product code is untestable too — allowed with an
    # explicit `kind: comment`, passing the gate but flagged for arbiter/human confirmation.
    with tempfile.TemporaryDirectory() as d:
        resolution = [
            {"type": "fix", "ref": "IT-1-F1", "by": "builder", "msg": "fixed a misleading comment"},
            {"type": "attest", "ref": "IT-1-F1", "by": "verifier", "kind": "comment",
             "files": ["src/App.jsx"], "msg": "comment-only; no behavior changed"},
        ]
        repo, base = _attest_sandbox(Path(d), resolution, {"src/App.jsx": "// product\n"})
        r = _run(repo, "--item", "IT-1", "--base", base)
        assert r.returncode == 0, r.stdout + r.stderr
        assert "all ledger checks passed" in r.stdout
        assert "flagged for review" in r.stdout


def test_attest_naming_missing_file_fails_the_gate():
    with tempfile.TemporaryDirectory() as d:
        resolution = [
            {"type": "fix", "ref": "IT-1-F1", "by": "builder", "msg": "fix"},
            {"type": "attest", "ref": "IT-1-F1", "by": "verifier",
             "files": ["tests/ghost.test.js"], "msg": "names a file that isn't there"},
        ]
        repo, base = _attest_sandbox(Path(d), resolution, {})  # no such file committed
        r = _run(repo, "--item", "IT-1", "--base", base)
        assert r.returncode == 1, r.stdout + r.stderr
        assert "does not exist" in r.stdout


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"  PASS {t.__name__}")
        except Exception as e:
            failed += 1
            print(f"  FAIL {t.__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
