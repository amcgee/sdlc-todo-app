#!/usr/bin/env python3
"""Tests for check-review-threads.py's pure rule (unanswered_solicited / is_solicited).

The solicited-review gate must fire only on the Copilot review bot's thread roots that have
no reply — not on human accounts that merely start with 'copilot', and not on threads that
were answered. The network fetch in main() is not exercised here; the rule is pure.

Framework test (Python, stdlib only). Standalone or under pytest.
"""
from __future__ import annotations
import importlib.util, sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location(
    "check_review_threads", REPO / "SDLC" / "scripts" / "check-review-threads.py")
crt = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(crt)


def _c(id, *, login, type="Bot", reply_to=None):
    return {"id": id, "user": {"login": login, "type": type}, "in_reply_to_id": reply_to,
            "path": "f.py", "line": 1, "body": "b", "html_url": "u"}


def test_solicited_matches_copilot_bot_only():
    assert crt.is_solicited(_c(1, login="Copilot", type="Bot"))
    assert crt.is_solicited(_c(2, login="copilot-pull-request-reviewer[bot]", type="Bot"))
    # a human account that merely starts with 'copilot' is NOT solicited
    assert not crt.is_solicited(_c(3, login="copilot-fan", type="User"))
    # a non-Copilot bot is not solicited
    assert not crt.is_solicited(_c(4, login="dependabot[bot]", type="Bot"))


def test_unanswered_is_solicited_roots_without_reply():
    comments = [
        _c(10, login="Copilot"),                       # root, no reply -> unanswered
        _c(11, login="Copilot"),                       # root, answered below
        _c(12, login="amcgee", type="User", reply_to=11),  # human reply to 11
        _c(13, login="copilot-fan", type="User"),      # not solicited
        _c(14, login="Copilot", reply_to=10),          # a reply, not a root
    ]
    got = {c["id"] for c in crt.unanswered_solicited(comments)}
    assert got == {10}, got


def test_all_answered_is_empty():
    comments = [
        _c(20, login="Copilot"),
        _c(21, login="amcgee", type="User", reply_to=20),
    ]
    assert crt.unanswered_solicited(comments) == []


def test_no_solicited_threads_is_empty():
    assert crt.unanswered_solicited([_c(30, login="amcgee", type="User")]) == []


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
