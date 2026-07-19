#!/usr/bin/env python3
"""sandbox.py — the ONE builder for framework-test repo sandboxes.

Every suite that needs a throwaway repo builds it here, so the layout the framework
assumes — `sdlc.py` under `SDLC/`, the ledger at `.sdlc/ledger/` OUTSIDE the immutable
framework dir, hooks under `.claude/hooks/` — is encoded once. A layout change edits
this file and the code under test, not every suite.

Not a suite itself (no `test_` prefix), so the CI runner and pytest skip it; suites
import it as a sibling module (standalone runs and pytest both put this directory on
sys.path).
"""
from __future__ import annotations
import json, shutil, subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SDLC_PY = REPO_ROOT / "SDLC" / "sdlc.py"
MANIFEST_PY = REPO_ROOT / "SDLC" / "lib" / "manifest.py"
SPOT_PY = REPO_ROOT / "SDLC" / "lib" / "spot_check.py"
GATE_GUARD = REPO_ROOT / ".claude" / "hooks" / "gate_guard.py"
BASH_GUARD = REPO_ROOT / ".claude" / "hooks" / "bash_write_guard.py"
GITATTR = REPO_ROOT / ".gitattributes"

LEDGER_DIR_REL = Path(".sdlc") / "ledger"        # the default ledger dir (manifest.DEFAULT_LEDGER_DIR)


def rounds(repo: Path) -> Path:
    """The sandbox's append-only ledger file."""
    return repo / LEDGER_DIR_REL / "rounds.jsonl"


def git(repo: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True)


def head(repo: Path) -> str:
    """The sandbox's current HEAD sha."""
    return subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo,
                          capture_output=True, text=True).stdout.strip()


def make_repo(tmp: Path, *, sdlc_py=True, manifest_py=False, spot_check=False, hooks=False,
              project_manifest=None, rounds_text=None, files=None, gitattributes=False,
              git_init=False, commit=False) -> Path:
    """A throwaway repo at tmp/repo: an empty ledger dir plus whichever framework files the
    suite exercises. `files` maps repo-relative paths to content, written before any commit;
    `commit=True` implies `git_init` and commits the whole tree as 'base'."""
    repo = tmp / "repo"
    (repo / LEDGER_DIR_REL).mkdir(parents=True)
    if sdlc_py:
        (repo / "SDLC").mkdir(exist_ok=True)
        shutil.copy(SDLC_PY, repo / "SDLC" / "sdlc.py")
    if manifest_py or spot_check:
        (repo / "SDLC" / "lib").mkdir(parents=True, exist_ok=True)
    if manifest_py:
        shutil.copy(MANIFEST_PY, repo / "SDLC" / "lib" / "manifest.py")
    if spot_check:
        shutil.copy(SPOT_PY, repo / "SDLC" / "lib" / "spot_check.py")
    if hooks:
        (repo / ".claude" / "hooks").mkdir(parents=True)
        shutil.copy(GATE_GUARD, repo / ".claude" / "hooks" / "gate_guard.py")
        shutil.copy(BASH_GUARD, repo / ".claude" / "hooks" / "bash_write_guard.py")
    if project_manifest is not None:
        (repo / "sdlc.config.json").write_text(json.dumps(project_manifest))
    if rounds_text is not None:
        rounds(repo).write_text(rounds_text)
    for rel, content in (files or {}).items():
        p = repo / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
    if gitattributes:
        shutil.copy(GITATTR, repo / ".gitattributes")
    if git_init or commit:
        git(repo, "init", "-q", "-b", "main")
        git(repo, "config", "user.email", "t@t.t")
        git(repo, "config", "user.name", "t")
    if commit:
        git(repo, "add", "-A")
        git(repo, "commit", "-q", "-m", "base")
    return repo
