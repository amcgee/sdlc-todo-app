#!/usr/bin/env python3
"""Tests for sdlc.py's append-time integrity rules and ledger-derived state.

test_ledger.py covers the parallel-safe id/union-merge mechanics; this file covers
the rules the CLI enforces when an entry is appended and the state machine it derives
from the record — the logic the whole framework's trust rests on:

  * role checks (ENTRY_ROLES): only the right role may mint each entry type;
  * verdict-requires-rebut (with the --force override);
  * defer refuses blocker/major;
  * test entries must name a test and carry both anchor shas;
  * the finding budget warns past the cap;
  * gate prerequisite ordering (build needs spec; merge needs spec+build+a round);
  * the dirty-round rule (a round that files blocker/major holds the merge gate shut);
  * spec-phase findings resolve by a fix alone (no proving test);
  * `state`/_next_action transitions spec -> build -> test -> merge -> done.

This is a framework test (Python, stdlib only). Runnable standalone
(`python3 SDLC/tests/test_sdlc_rules.py`) or under pytest.
"""
from __future__ import annotations
import json, subprocess, sys, tempfile, time
from pathlib import Path

import sandbox


def _sandbox(tmp: Path) -> Path:
    """A throwaway tree carrying just the CLI + an empty ledger (no git needed —
    these tests exercise append-time rules, not the union-merge machinery)."""
    return sandbox.make_repo(tmp)


def _sdlc(repo, *args, check=True):
    r = subprocess.run([sys.executable, str(repo / "SDLC" / "sdlc.py"), *args],
                       cwd=repo, capture_output=True, text=True)
    if check and r.returncode != 0:
        raise AssertionError(f"cmd {args} failed ({r.returncode}):\n{r.stdout}\n{r.stderr}")
    return r


def _ledger(repo):
    return [json.loads(l) for l in sandbox.rounds(repo).read_text().splitlines() if l.strip()]


def _open_built(repo, item, size="standard"):
    """Drive an item to a recorded build gate + one round: the state where the
    engineering loop is live (spec open, build open, one attack round)."""
    _sdlc(repo, "open", "--item", item, "--title", "t", "--size", size)
    _sdlc(repo, "gate", "--item", item, "--phase", "spec")
    _sdlc(repo, "gate", "--item", item, "--phase", "build")
    _sdlc(repo, "round", "--item", item)


# --- role checks -------------------------------------------------------------

def test_role_check_rejects_wrong_author():
    """A builder cannot mint an arbiter verdict; an adversary cannot mint a test."""
    with tempfile.TemporaryDirectory() as d:
        repo = _sandbox(Path(d))
        _sdlc(repo, "open", "--item", "R-1", "--title", "t")
        _sdlc(repo, "finding", "--item", "R-1", "--sev", "major", "--by", "adversary", "--msg", "bug")
        # builder minting a verdict is refused
        r = _sdlc(repo, "verdict", "--ref", "R-1-F1", "--by", "builder", "--ruling", "accepted", check=False)
        assert r.returncode != 0 and "must be recorded by arbiter" in (r.stdout + r.stderr), r.stdout + r.stderr
        # adversary minting a test is refused
        r = _sdlc(repo, "test", "--ref", "R-1-F1", "--by", "adversary", "--msg", "m",
                  "--test", "x.test.js", "--pre-sha", "a", "--post-sha", "b", check=False)
        assert r.returncode != 0 and "must be recorded by verifier" in (r.stdout + r.stderr), r.stdout + r.stderr


def test_role_check_allows_correct_author():
    with tempfile.TemporaryDirectory() as d:
        repo = _sandbox(Path(d))
        _sdlc(repo, "open", "--item", "R-2", "--title", "t")
        _sdlc(repo, "finding", "--item", "R-2", "--sev", "major", "--by", "adversary", "--msg", "bug")
        _sdlc(repo, "fix", "--ref", "R-2-F1", "--by", "builder", "--msg", "fixed")  # builder may fix
        _sdlc(repo, "test", "--ref", "R-2-F1", "--by", "verifier", "--msg", "m",
              "--test", "x.test.js", "--pre-sha", "a", "--post-sha", "b")           # verifier may test


# --- verdict requires a rebut ------------------------------------------------

def test_verdict_requires_rebut_unless_forced():
    with tempfile.TemporaryDirectory() as d:
        repo = _sandbox(Path(d))
        _sdlc(repo, "open", "--item", "V-1", "--title", "t")
        _sdlc(repo, "finding", "--item", "V-1", "--sev", "major", "--by", "adversary", "--msg", "bug")
        # no rebuttal on record -> refused
        r = _sdlc(repo, "verdict", "--ref", "V-1-F1", "--by", "arbiter", "--ruling", "rejected", check=False)
        assert r.returncode != 0 and "no rebuttal on record" in (r.stdout + r.stderr), r.stdout + r.stderr
        # --force records an explicit override
        r = _sdlc(repo, "verdict", "--ref", "V-1-F1", "--by", "arbiter", "--ruling", "rejected", "--force")
        assert any(e.get("type") == "verdict" and e.get("forced") for e in _ledger(repo))
        # with a rebuttal on record, no force needed
        _sdlc(repo, "finding", "--item", "V-1", "--sev", "major", "--by", "adversary", "--msg", "bug2")
        _sdlc(repo, "rebut", "--ref", "V-1-F2", "--by", "defender", "--msg", "handled upstream")
        _sdlc(repo, "verdict", "--ref", "V-1-F2", "--by", "arbiter", "--ruling", "rejected")


# --- defer severity guard ----------------------------------------------------

def test_defer_refuses_blocker_and_major():
    with tempfile.TemporaryDirectory() as d:
        repo = _sandbox(Path(d))
        _sdlc(repo, "open", "--item", "D-1", "--title", "t")
        _sdlc(repo, "finding", "--item", "D-1", "--sev", "blocker", "--by", "adversary", "--msg", "big")
        _sdlc(repo, "finding", "--item", "D-1", "--sev", "minor", "--by", "adversary", "--msg", "small")
        r = _sdlc(repo, "defer", "--ref", "D-1-F1", "--by", "defender", "--msg", "later #1", check=False)
        assert r.returncode != 0 and "never deferred" in (r.stdout + r.stderr), r.stdout + r.stderr
        _sdlc(repo, "defer", "--ref", "D-1-F2", "--by", "defender", "--msg", "polish, issue #2")  # minor is fine


# --- finding budget warning --------------------------------------------------

def test_finding_budget_warns_past_cap():
    with tempfile.TemporaryDirectory() as d:
        repo = _sandbox(Path(d))
        _sdlc(repo, "open", "--item", "B-1", "--title", "t")
        _sdlc(repo, "round", "--item", "B-1")
        warned = False
        for i in range(9):                       # budget is 8/round
            r = _sdlc(repo, "finding", "--item", "B-1", "--sev", "minor",
                      "--by", "adversary", "--msg", f"n{i}")
            if "budget" in r.stderr:
                warned = True
        assert warned, "expected a budget warning past the 8th finding in a round"


# --- gate prerequisite ordering ----------------------------------------------

def test_merge_gate_needs_spec_build_and_round():
    with tempfile.TemporaryDirectory() as d:
        repo = _sandbox(Path(d))
        _sdlc(repo, "open", "--item", "G-1", "--title", "t")
        # merge before anything: blocked on prior phases
        r = _sdlc(repo, "gate", "--item", "G-1", "--phase", "merge", "--exit-code", check=False)
        assert r.returncode == 1 and "BLOCKED" in r.stdout, r.stdout
        assert "spec" in r.stdout and "build" in r.stdout
        _sdlc(repo, "gate", "--item", "G-1", "--phase", "spec")
        _sdlc(repo, "gate", "--item", "G-1", "--phase", "build")
        # still blocked: no adversarial round yet
        r = _sdlc(repo, "gate", "--item", "G-1", "--phase", "merge", "--exit-code", check=False)
        assert r.returncode == 1 and "round" in r.stdout, r.stdout
        _sdlc(repo, "round", "--item", "G-1")
        r = _sdlc(repo, "gate", "--item", "G-1", "--phase", "merge", "--exit-code")
        assert "OPEN" in r.stdout, r.stdout


# --- dirty round holds the merge gate ----------------------------------------

def test_dirty_round_holds_merge_until_clean_reattack():
    with tempfile.TemporaryDirectory() as d:
        repo = _sandbox(Path(d))
        _open_built(repo, "DR-1")
        # the latest round filed a blocker: dirty -> merge blocked even after fix+test
        _sdlc(repo, "finding", "--item", "DR-1", "--sev", "blocker", "--by", "adversary", "--msg", "bug")
        _sdlc(repo, "fix", "--ref", "DR-1-F1", "--by", "builder", "--msg", "fixed")
        _sdlc(repo, "test", "--ref", "DR-1-F1", "--by", "verifier", "--msg", "m",
              "--test", "x.test.js", "--pre-sha", "a", "--post-sha", "b")
        r = _sdlc(repo, "gate", "--item", "DR-1", "--phase", "merge", "--exit-code", check=False)
        assert r.returncode == 1 and "clean" in r.stdout.lower(), r.stdout
        # a fresh clean re-attack round (no new holding finding) clears it. Ledger
        # timestamps have 1-second resolution and the dirty-round rule attributes a
        # finding to a round by ts (>=), so the re-attack round must land in a strictly
        # later second than the blocker for the round boundary to separate them.
        time.sleep(1.1)
        _sdlc(repo, "round", "--item", "DR-1")
        r = _sdlc(repo, "gate", "--item", "DR-1", "--phase", "merge", "--exit-code")
        assert "OPEN" in r.stdout, r.stdout


# --- spec-phase findings resolve without a proving test ----------------------

def test_spec_phase_finding_resolved_by_fix_alone():
    with tempfile.TemporaryDirectory() as d:
        repo = _sandbox(Path(d))
        _sdlc(repo, "open", "--item", "S-1", "--title", "t")
        # a spec-phase blocker, fixed by a spec revision (fix), needs no test entry
        _sdlc(repo, "finding", "--item", "S-1", "--sev", "blocker", "--by", "adversary",
              "--msg", "spec ambiguous", "--phase", "spec")
        r = _sdlc(repo, "gate", "--item", "S-1", "--phase", "spec", "--exit-code", check=False)
        assert r.returncode == 1, r.stdout          # holding until fixed
        _sdlc(repo, "fix", "--ref", "S-1-F1", "--by", "architect", "--msg", "spec revised")
        r = _sdlc(repo, "gate", "--item", "S-1", "--phase", "spec", "--exit-code")
        assert "OPEN" in r.stdout, r.stdout


# --- escapes only after release ----------------------------------------------

def test_post_merge_finding_refused_before_release():
    """A post-merge finding (escape) is excluded from gate math, so filing one before
    the merge gate has opened would silently bypass the live gate — the CLI refuses it
    unless --force, and doctor flags an un-forced premature escape."""
    with tempfile.TemporaryDirectory() as d:
        repo = _sandbox(Path(d))
        _open_built(repo, "PM-1")
        # merge gate not yet opened -> escape refused
        r = _sdlc(repo, "finding", "--item", "PM-1", "--sev", "blocker", "--by", "adversary",
                  "--msg", "escaped?", "--phase", "post-merge", check=False)
        assert r.returncode != 0 and "no open merge gate" in (r.stdout + r.stderr), r.stdout + r.stderr
        # --force records a deliberate override
        _sdlc(repo, "finding", "--item", "PM-1", "--sev", "blocker", "--by", "adversary",
              "--msg", "override", "--phase", "post-merge", "--force")
        assert any(e.get("type") == "finding" and e.get("forced") for e in _ledger(repo))
        # after the merge gate opens, an escape needs no force and cannot re-block it
        repo2 = _sandbox(Path(d) / "b")
        _open_built(repo2, "PM-2")
        _sdlc(repo2, "gate", "--item", "PM-2", "--phase", "merge")
        _sdlc(repo2, "finding", "--item", "PM-2", "--sev", "blocker", "--by", "adversary",
              "--msg", "real escape", "--phase", "post-merge")
        r = _sdlc(repo2, "gate", "--item", "PM-2", "--phase", "merge", "--exit-code")
        assert "OPEN" in r.stdout, r.stdout


def test_doctor_flags_premature_escape():
    """A hand-written post-merge finding on an unreleased item is a fatal integrity problem."""
    with tempfile.TemporaryDirectory() as d:
        repo = _sandbox(Path(d))
        ledger = sandbox.rounds(repo)
        ledger.write_text(
            json.dumps({"type": "open", "item": "X", "title": "x"}) + "\n" +
            json.dumps({"type": "finding", "id": "X-F1", "item": "X", "sev": "blocker",
                        "by": "adversary", "msg": "escaped", "phase": "post-merge"}) + "\n"
        )
        r = _sdlc(repo, "doctor", "--exit-code", check=False)
        assert r.returncode == 1 and "premature escape" in r.stdout, r.stdout


# --- state machine transitions -----------------------------------------------

def test_state_transitions_spec_to_done():
    with tempfile.TemporaryDirectory() as d:
        repo = _sandbox(Path(d))
        _sdlc(repo, "open", "--item", "ST-1", "--title", "t")
        assert "next=spec" in _sdlc(repo, "state", "--item", "ST-1").stdout
        _sdlc(repo, "gate", "--item", "ST-1", "--phase", "spec")
        assert "next=build" in _sdlc(repo, "state", "--item", "ST-1").stdout
        _sdlc(repo, "gate", "--item", "ST-1", "--phase", "build")
        assert "next=test" in _sdlc(repo, "state", "--item", "ST-1").stdout
        _sdlc(repo, "round", "--item", "ST-1")
        assert "next=merge" in _sdlc(repo, "state", "--item", "ST-1").stdout
        _sdlc(repo, "gate", "--item", "ST-1", "--phase", "merge")
        assert "next=done" in _sdlc(repo, "state", "--item", "ST-1").stdout


# --- schema epoch bounds the grandfathering ----------------------------------

def test_schema_epoch_routes_anomaly_by_timestamp():
    """A role/verdict anomaly is a non-fatal note for a PRE-epoch (grandfathered) entry
    but a fatal problem for a POST-epoch one (written around the CLI)."""
    with tempfile.TemporaryDirectory() as d:
        repo = _sandbox(Path(d))
        ledger = sandbox.rounds(repo)
        # legacy: a builder-authored verdict + a verdict with no rebut, both pre-epoch
        ledger.write_text(
            json.dumps({"ts": "2025-01-01T00:00:00Z", "type": "open", "item": "L", "title": "l"}) + "\n" +
            json.dumps({"ts": "2025-01-01T00:00:01Z", "type": "finding", "id": "L-F1",
                        "item": "L", "sev": "major", "by": "adversary", "msg": "x"}) + "\n" +
            json.dumps({"ts": "2025-01-01T00:00:02Z", "type": "verdict", "ref": "L-F1",
                        "by": "builder", "ruling": "accepted", "msg": ""}) + "\n"
        )
        r = _sdlc(repo, "doctor", "--exit-code")          # pre-epoch anomalies: non-fatal
        assert r.returncode == 0, r.stdout
        assert "note" in r.stdout.lower(), r.stdout
        # same anomaly, post-epoch timestamp -> fatal
        ledger.write_text(
            json.dumps({"ts": "2099-01-01T00:00:00Z", "type": "open", "item": "N", "title": "n"}) + "\n" +
            json.dumps({"ts": "2099-01-01T00:00:01Z", "type": "finding", "id": "N-F1",
                        "item": "N", "sev": "major", "by": "adversary", "msg": "x"}) + "\n" +
            json.dumps({"ts": "2099-01-01T00:00:02Z", "type": "verdict", "ref": "N-F1",
                        "by": "builder", "ruling": "accepted", "msg": ""}) + "\n"
        )
        r = _sdlc(repo, "doctor", "--exit-code", check=False)
        assert r.returncode == 1, r.stdout
        assert "post-epoch" in r.stdout, r.stdout


# --- operator pause/resume/abort are real states -----------------------------

def test_pause_resume_abort_drive_state():
    """Pause/resume/abort are ledger-recorded controls that `state` honors, so a
    session re-deriving state (e.g. a §1 takeover) does not resume a paused cycle."""
    with tempfile.TemporaryDirectory() as d:
        repo = _sandbox(Path(d))
        _open_built(repo, "P-1")                 # state would otherwise be merge/test
        assert "next=merge" in _sdlc(repo, "state", "--item", "P-1").stdout
        # pause overrides the engineering state
        _sdlc(repo, "pause", "--item", "P-1", "--msg", "operator wants to look")
        assert "next=paused" in _sdlc(repo, "state", "--item", "P-1").stdout
        # resume restores the derived state
        _sdlc(repo, "resume", "--item", "P-1")
        assert "next=merge" in _sdlc(repo, "state", "--item", "P-1").stdout
        # abort is terminal
        _sdlc(repo, "abort", "--item", "P-1", "--msg", "scrapped")
        assert "next=aborted" in _sdlc(repo, "state", "--item", "P-1").stdout
        # cross-item overview reflects it too
        assert "aborted" in _sdlc(repo, "state").stdout


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
