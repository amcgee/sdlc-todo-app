#!/usr/bin/env python3
"""Tests for bash_write_guard.py — the shell-side-channel write guard.

The guard is a hand-maintained parser (segment split, redirect targets, heredoc
stripping, a read-only allowlist). That is exactly the kind of code that regresses
silently on the next regex tweak, so it needs a committed harness. Each case feeds a
Bash tool event on stdin and asserts the exit code: 2 = blocked, 0 = allowed.

Framework test (Python, stdlib only). Standalone
(`python3 SDLC/tests/test_bash_write_guard.py`) or under pytest.
"""
from __future__ import annotations
import json, os, subprocess, sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
GUARD = REPO / ".claude" / "hooks" / "bash_write_guard.py"


def _run_guard(command: str, env_extra: dict | None = None):
    env = dict(os.environ)
    env.pop("SDLC_PROTECTED", None)
    env.pop("SDLC_ENFORCE", None)
    if env_extra:
        env.update(env_extra)
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": command}})
    return subprocess.run([sys.executable, str(GUARD)], input=payload,
                          capture_output=True, text=True, env=env, cwd=REPO)


def _blocked(command, **env):
    r = _run_guard(command, env or None)
    assert r.returncode == 2, f"expected BLOCK for {command!r}, got {r.returncode}:\n{r.stdout}\n{r.stderr}"


def _allowed(command, **env):
    r = _run_guard(command, env or None)
    assert r.returncode == 0, f"expected ALLOW for {command!r}, got {r.returncode}:\n{r.stdout}\n{r.stderr}"


# --- ledger is never shell-writable ------------------------------------------

def test_redirect_into_ledger_blocked():
    _blocked("echo hi >> .sdlc/ledger/rounds.jsonl")
    _blocked("echo hi > ./.sdlc/ledger/rounds.jsonl")


def test_python_c_touching_ledger_blocked():
    _blocked("python -c \"open('.sdlc/ledger/rounds.jsonl','a').write('x')\"")


def test_sdlc_cli_and_reads_of_ledger_allowed():
    # the CLI itself and read-only tools may name the ledger path
    _allowed("python SDLC/sdlc.py status --item X")
    _allowed("cat .sdlc/ledger/rounds.jsonl")
    _allowed("git log -- .sdlc/ledger/rounds.jsonl")


# --- framework dirs are not shell-writable -----------------------------------

def test_redirect_into_framework_blocked():
    _blocked("echo x > .claude/settings.json")
    _blocked("echo x >> .github/workflows/tests.yml")
    _blocked("sed -i s/a/b/ SDLC/sdlc.py")


def test_build_sentinel_is_allowlisted():
    _allowed("touch .sdlc/ledger/.build-open")
    _allowed("rm -f .sdlc/ledger/.build-open")


def test_ledger_dir_non_record_files_blocked():
    # SDLC/ is fully immutable; the ledger dir's derived files aren't shell-writable either
    # (the sanctioned sentinel above is the only exemption).
    _blocked("echo x >> SDLC/lib/manifest.py")
    _blocked("echo x > .sdlc/ledger/gates.json")


# --- heredoc bodies are data, not commands -----------------------------------

def test_heredoc_body_mentioning_ledger_allowed():
    # a commit message that merely NAMES the ledger must not be blocked
    cmd = "git commit -F - <<'EOF'\nfix: update .sdlc/ledger/rounds.jsonl handling\nEOF"
    _allowed(cmd)


# --- gated code paths follow SDLC_ENFORCE ------------------------------------

def test_gated_path_warn_mode_allows():
    # regardless of the build sentinel, warn mode never blocks a gated-path write
    _allowed("echo x > src/app.js", SDLC_ENFORCE="warn")


def test_unparseable_segment_fails_open():
    # a segment shlex can't parse must not brick the session
    _allowed("echo 'unterminated")


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
