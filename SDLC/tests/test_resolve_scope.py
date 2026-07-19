#!/usr/bin/env python3
"""Tests for the CI scope resolver (SDLC/scripts/ci/resolve_scope.py) — the logic that decides
whether a PR is under SDLC enforcement and what its work item is. Pure function, no GitHub.

Framework test (Python, stdlib only). Standalone or under pytest.
"""
from __future__ import annotations
import importlib.util, sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("resolve_scope", REPO / "SDLC" / "scripts" / "ci" / "resolve_scope.py")
rs = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(rs)


def test_sdlc_branch_resolves_item():
    assert rs.resolve("claude/sdlc-issue-42", "[]", "") == (True, "ISSUE-42")


def test_ordinary_issue_branch_is_not_sdlc():
    # a branch that merely mentions an issue number must NOT be pulled into SDLC enforcement
    assert rs.resolve("fix/issue-7-typo", "[]", "") == (False, "")


def test_bare_sdlc_label_scopes_in():
    is_sdlc, item = rs.resolve("feature/x", '["bug","sdlc"]', "")
    assert is_sdlc and item == ""            # scoped in, but no resolvable item → gate errors loudly


def test_namespaced_sdlc_label_scopes_in():
    assert rs.resolve("feature/x", '["sdlc:review"]', "")[0] is True


def test_dispatch_item_overrides():
    assert rs.resolve("main", "[]", "ISSUE-9") == (True, "ISSUE-9")


def test_malformed_labels_json_is_safe():
    assert rs.resolve("main", "not json", "") == (False, "")


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t(); print(f"  PASS {t.__name__}")
        except Exception as e:
            failed += 1; print(f"  FAIL {t.__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
