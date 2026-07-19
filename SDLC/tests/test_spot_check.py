#!/usr/bin/env python3
"""Tests for spot_check.py's infrastructure-error handling.

The dangerous failure mode is a hung test run: if a timeout propagated as an uncaught
exception it would crash the script (exit 1), indistinguishable from a DISPROVEN claim
and hard-failing the arbiter gate. A timeout is infrastructure, not a disproof — this
proves it is skipped, and the run exits 0.

Framework test (Python, stdlib only). Standalone (`python3 SDLC/tests/test_spot_check.py`)
or under pytest.
"""
from __future__ import annotations
import json, stat, subprocess, sys, tempfile
from pathlib import Path

import sandbox


def _sandbox_with_prefix_commit(tmp: Path):
    """A git repo carrying spot_check.py, a pre-fix commit, and a named test at HEAD."""
    repo = sandbox.make_repo(tmp, spot_check=True, commit=True)   # 'base' = the pre-fix commit
    pre = sandbox.head(repo)
    # the proving test exists only at HEAD (as in real usage)
    (repo / "tests").mkdir()
    (repo / "tests" / "x.test.js").write_text("// proving test\n")
    sandbox.git(repo, "add", "-A")
    sandbox.git(repo, "commit", "-q", "-m", "add proving test")
    # a sleeper stands in for the test runner; it ignores args and runs long
    sleeper = repo / "sleeper.sh"
    sleeper.write_text("#!/usr/bin/env bash\nsleep 30\n")
    sleeper.chmod(sleeper.stat().st_mode | stat.S_IEXEC)
    sandbox.rounds(repo).write_text(
        json.dumps({"ts": "2026-07-06T00:00:00Z", "type": "test", "ref": "IT-1-F1",
                    "by": "verifier", "msg": "m", "tests": ["tests/x.test.js"],
                    "pre_sha": pre, "post_sha": "HEAD"}) + "\n")
    return repo, sleeper


def test_timeout_is_skipped_not_disproven():
    with tempfile.TemporaryDirectory() as d:
        repo, sleeper = _sandbox_with_prefix_commit(Path(d))
        r = subprocess.run(
            [sys.executable, str(repo / "SDLC" / "lib" / "spot_check.py"), "--item", "IT-1",
             "--timeout", "1", "--test-cmd", f"bash {sleeper}", "--install-cmd", "true"],
            cwd=repo, capture_output=True, text=True)
        out = r.stdout + r.stderr
        assert r.returncode == 0, f"a timeout must not fail the check:\n{out}"
        assert "timeout" in out.lower() and "skipped" in out.lower(), out
        assert "DISPROVEN" not in out, out


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
