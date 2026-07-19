#!/usr/bin/env python3
"""Tests for the parallel-safe SDLC ledger.

Proves the two mechanisms that let two SDLC workflows run in parallel and still merge:
  1. finding ids are scoped per work item, so parallel branches never mint the same id;
  2. the ledger is a `merge=union` file, so two branches' appends concatenate with no
     git conflict — and the merged ledger is still integrity-clean (`doctor`).

Runnable standalone (`python3 SDLC/tests/test_ledger.py`) or under pytest.
"""
from __future__ import annotations
import json, subprocess, sys, tempfile
from pathlib import Path

import sandbox


def _run(args, cwd, check=True):
    r = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    if check and r.returncode != 0:
        raise AssertionError(f"cmd {args} failed ({r.returncode}):\n{r.stdout}\n{r.stderr}")
    return r


def _sdlc(sandbox_repo, *args, check=True):
    return _run([sys.executable, str(sandbox_repo / "SDLC" / "sdlc.py"), *args],
                cwd=sandbox_repo, check=check)


def _read_ledger(sandbox_repo):
    return [json.loads(l) for l in sandbox.rounds(sandbox_repo).read_text().splitlines()
            if l.strip()]


def _finding_ids(entries):
    return [e["id"] for e in entries if e.get("type") == "finding"]


def _make_sandbox(tmp: Path) -> Path:
    """A minimal committed git repo carrying just the ledger tooling + .gitattributes
    (the empty ledger file exists at the merge-base)."""
    return sandbox.make_repo(tmp, gitattributes=True, rounds_text="", commit=True)


# --- tests -------------------------------------------------------------------

def test_finding_ids_are_item_scoped():
    """Findings on different items get ids namespaced by item — never bare F1/F2."""
    with tempfile.TemporaryDirectory() as d:
        repo = _make_sandbox(Path(d))
        _sdlc(repo, "open", "--item", "ISSUE-A", "--title", "A")
        _sdlc(repo, "open", "--item", "ISSUE-B", "--title", "B")
        _sdlc(repo, "finding", "--item", "ISSUE-A", "--sev", "major", "--by", "adversary", "--msg", "a1")
        _sdlc(repo, "finding", "--item", "ISSUE-A", "--sev", "minor", "--by", "adversary", "--msg", "a2")
        _sdlc(repo, "finding", "--item", "ISSUE-B", "--sev", "blocker", "--by", "adversary", "--msg", "b1")
        ids = _finding_ids(_read_ledger(repo))
        assert ids == ["ISSUE-A-F1", "ISSUE-A-F2", "ISSUE-B-F1"], ids
        # per-item numbering restarts, so the two items collide on NOTHING
        assert len(set(ids)) == len(ids)


def test_parallel_branches_union_merge_without_conflict():
    """Two branches, each running a workflow on its own item, merge cleanly."""
    with tempfile.TemporaryDirectory() as d:
        repo = _make_sandbox(Path(d))

        # branch A: workflow on ISSUE-A
        _run(["git", "checkout", "-q", "-b", "wf-a"], cwd=repo)
        _sdlc(repo, "open", "--item", "ISSUE-A", "--title", "A")
        _sdlc(repo, "finding", "--item", "ISSUE-A", "--sev", "major", "--by", "adversary", "--msg", "a1")
        _sdlc(repo, "finding", "--item", "ISSUE-A", "--sev", "minor", "--by", "adversary", "--msg", "a2")
        _run(["git", "commit", "-qam", "wf-a"], cwd=repo)

        # branch B (from main): workflow on ISSUE-B, appends to the same file+region
        _run(["git", "checkout", "-q", "main"], cwd=repo)
        _run(["git", "checkout", "-q", "-b", "wf-b"], cwd=repo)
        _sdlc(repo, "open", "--item", "ISSUE-B", "--title", "B")
        _sdlc(repo, "finding", "--item", "ISSUE-B", "--sev", "blocker", "--by", "adversary", "--msg", "b1")
        _run(["git", "commit", "-qam", "wf-b"], cwd=repo)

        # merge A into B — union driver must resolve it automatically
        merge = _run(["git", "merge", "--no-edit", "wf-a"], cwd=repo, check=False)
        assert merge.returncode == 0, f"union merge conflicted:\n{merge.stdout}\n{merge.stderr}"
        assert "CONFLICT" not in (merge.stdout + merge.stderr)

        # both workflows' entries survived, ids stay unique, ledger is clean
        entries = _read_ledger(repo)
        ids = _finding_ids(entries)
        assert set(ids) == {"ISSUE-A-F1", "ISSUE-A-F2", "ISSUE-B-F1"}, ids
        assert len(ids) == len(set(ids)), f"duplicate ids after merge: {ids}"
        items = {e["item"] for e in entries if e.get("item")}
        assert {"ISSUE-A", "ISSUE-B"} <= items
        _sdlc(repo, "doctor", "--exit-code")  # exits 1 on any integrity problem


def test_doctor_detects_same_item_collision():
    """The pathological case union-merge can't save — same item run twice — is caught."""
    with tempfile.TemporaryDirectory() as d:
        repo = _make_sandbox(Path(d))
        ledger = sandbox.rounds(repo)
        # two findings sharing an id, as a bad same-item parallel merge would produce
        ledger.write_text(
            json.dumps({"type": "open", "item": "X", "title": "x"}) + "\n" +
            json.dumps({"type": "finding", "id": "X-F1", "item": "X", "sev": "major", "msg": "one"}) + "\n" +
            json.dumps({"type": "finding", "id": "X-F1", "item": "X", "sev": "major", "msg": "two"}) + "\n"
        )
        r = _sdlc(repo, "doctor", "--exit-code", check=False)
        assert r.returncode == 1, r.stdout
        assert "duplicate finding id X-F1" in r.stdout


def test_doctor_detects_dangling_ref():
    """A ref to a finding that isn't present (dropped by a bad merge) is flagged."""
    with tempfile.TemporaryDirectory() as d:
        repo = _make_sandbox(Path(d))
        ledger = sandbox.rounds(repo)
        ledger.write_text(
            json.dumps({"type": "open", "item": "X", "title": "x"}) + "\n" +
            json.dumps({"type": "fix", "ref": "X-F9", "by": "builder", "msg": "phantom"}) + "\n"
        )
        r = _sdlc(repo, "doctor", "--exit-code", check=False)
        assert r.returncode == 1, r.stdout
        assert "X-F9" in r.stdout


def test_doctor_allows_item_ref_for_build_notes():
    """A fix/test may reference the item itself (build-phase note) — not dangling."""
    with tempfile.TemporaryDirectory() as d:
        repo = _make_sandbox(Path(d))
        ledger = sandbox.rounds(repo)
        ledger.write_text(
            json.dumps({"type": "open", "item": "X", "title": "x"}) + "\n" +
            json.dumps({"type": "fix", "ref": "X", "by": "builder", "msg": "implemented plan"}) + "\n"
        )
        _sdlc(repo, "doctor", "--exit-code")  # must exit 0


def test_escape_never_reblocks_released_gates():
    """A post-merge finding (escape) is outcome data — it must not re-close the merge
    gate or move `state` off done; the fix ships via a new item (incident lane)."""
    with tempfile.TemporaryDirectory() as d:
        repo = _make_sandbox(Path(d))
        _sdlc(repo, "open", "--item", "E-1", "--title", "e")
        _sdlc(repo, "gate", "--item", "E-1", "--phase", "spec")
        _sdlc(repo, "gate", "--item", "E-1", "--phase", "build")
        _sdlc(repo, "round", "--item", "E-1")
        r = _sdlc(repo, "gate", "--item", "E-1", "--phase", "merge", "--exit-code")
        assert "OPEN" in r.stdout, r.stdout
        _sdlc(repo, "finding", "--item", "E-1", "--sev", "blocker", "--by", "adversary",
              "--msg", "escaped bug", "--phase", "post-merge")
        r = _sdlc(repo, "gate", "--item", "E-1", "--phase", "merge", "--exit-code")
        assert "OPEN" in r.stdout, f"escape re-blocked the released gate:\n{r.stdout}"
        r = _sdlc(repo, "state", "--item", "E-1")
        assert "next=done" in r.stdout, r.stdout


def test_defer_debt_flagged_and_cleared_by_exact_id():
    """A defer with no follow-up issue is non-fatal debt; a later note clears it only
    when it names the EXACT id (X-F3 must not be cleared by a note about X-F30)."""
    with tempfile.TemporaryDirectory() as d:
        repo = _make_sandbox(Path(d))
        ledger = sandbox.rounds(repo)
        ledger.write_text(
            json.dumps({"type": "open", "item": "X", "title": "x"}) + "\n" +
            json.dumps({"type": "finding", "id": "X-F3", "item": "X", "sev": "minor",
                        "by": "adversary", "msg": "a"}) + "\n" +
            json.dumps({"type": "finding", "id": "X-F30", "item": "X", "sev": "minor",
                        "by": "adversary", "msg": "b"}) + "\n" +
            json.dumps({"type": "defer", "ref": "X-F3", "by": "defender", "msg": "later"}) + "\n" +
            json.dumps({"type": "note", "item": "X", "by": "defender",
                        "msg": "deferred X-F30 → issue #9"}) + "\n"
        )
        r = _sdlc(repo, "doctor", "--exit-code")   # debt is a note, never fatal
        assert "X-F3 has no follow-up issue" in r.stdout, \
            f"X-F30's note must not clear X-F3 (substring bug):\n{r.stdout}"
        with ledger.open("a") as f:
            f.write(json.dumps({"type": "note", "item": "X", "by": "defender",
                                "msg": "deferred X-F3 → issue #12"}) + "\n")
        r = _sdlc(repo, "doctor", "--exit-code")
        assert "X-F3 has no follow-up issue" not in r.stdout, r.stdout


def test_metrics_scorecard_counts_outcomes():
    """metrics derives outcomes, adversary precision, and escapes from the ledger."""
    with tempfile.TemporaryDirectory() as d:
        repo = _make_sandbox(Path(d))
        _sdlc(repo, "open", "--item", "M-1", "--title", "m")
        _sdlc(repo, "finding", "--item", "M-1", "--sev", "major", "--by", "adversary", "--msg", "bug")
        _sdlc(repo, "fix", "--ref", "M-1-F1", "--by", "builder", "--msg", "fixed")
        _sdlc(repo, "finding", "--item", "M-1", "--sev", "minor", "--by", "adversary", "--msg", "polish")
        _sdlc(repo, "defer", "--ref", "M-1-F2", "--by", "defender", "--msg", "parked as issue #5")
        # --force: an escape is normally accepted only after the merge gate opens; this
        # metrics test records one directly as a deliberate override to exercise counting.
        _sdlc(repo, "finding", "--item", "M-1", "--sev", "blocker", "--by", "adversary",
              "--msg", "escaped", "--phase", "post-merge", "--force")
        out = _sdlc(repo, "metrics", "--item", "M-1").stdout
        for expect in ("escapes 1", "1 resolved", "1 deferred", "adversary precision: 2/2"):
            assert expect in out, f"metrics missing {expect!r}:\n{out}"


def test_test_entry_requires_named_tests_and_anchor_shas():
    """A proving-test claim must be re-executable: named test(s) plus both anchor
    commits, or the CLI refuses the append."""
    with tempfile.TemporaryDirectory() as d:
        repo = _make_sandbox(Path(d))
        _sdlc(repo, "open", "--item", "T-9", "--title", "t")
        _sdlc(repo, "finding", "--item", "T-9", "--sev", "major", "--by", "adversary", "--msg", "bug")
        _sdlc(repo, "fix", "--ref", "T-9-F1", "--by", "builder", "--msg", "fixed")
        r = _sdlc(repo, "test", "--ref", "T-9-F1", "--by", "verifier", "--msg", "m", check=False)
        assert r.returncode != 0 and "must be named" in (r.stdout + r.stderr)
        r = _sdlc(repo, "test", "--ref", "T-9-F1", "--by", "verifier", "--msg", "m",
                  "--test", "tests/x.test.js", check=False)
        assert r.returncode != 0 and "must be anchored" in (r.stdout + r.stderr)
        _sdlc(repo, "test", "--ref", "T-9-F1", "--by", "verifier", "--msg", "m",
              "--test", "tests/x.test.js", "--pre-sha", "aaa", "--post-sha", "bbb")


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
