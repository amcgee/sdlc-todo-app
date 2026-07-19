#!/usr/bin/env python3
"""check-review-threads.py — fail while any solicited (Copilot) review thread on the PR has
no disposition reply.

The driver solicits a Copilot review as second-opinion leads and owes every one of its
threads a disposition reply before merge-ready (driver §6.2). This is the mechanical
backstop, scoped to reviews the framework itself solicits — human review threads stay in the
human's hands.

A pure `unanswered_solicited()` holds the rule so it is unit-testable without the network
(SDLC/tests/test_review_threads.py); `main()` fetches the PR's review comments and reports.

Fail-closed on API trouble (deliberately unlike spot_check.py's infra-skip): a reconciliation
this check cannot verify must not pass a required gate, and re-running is cheap — the check
re-runs on the next push or PR event.

Usage: check-review-threads.py --repo owner/name --pr <n>   (GH_TOKEN in env)
"""
from __future__ import annotations
import argparse, json, os, sys, urllib.error, urllib.request

API = "https://api.github.com"
PAGE_CAP = 10          # 1000 comments; warn (never silently truncate) if we hit it full


def is_solicited(comment: dict) -> bool:
    """A comment authored by the Copilot review bot — a Bot account whose login carries
    'copilot' (so a human account named e.g. 'copilot-fan' is never matched)."""
    u = comment.get("user") or {}
    return u.get("type") == "Bot" and "copilot" in (u.get("login") or "").lower()


def unanswered_solicited(comments: list[dict]) -> list[dict]:
    """Solicited THREAD ROOTS (a top-level comment, no in_reply_to_id) that the driver has
    not answered — the threads still owed a disposition. A root counts as answered only when
    a NON-solicited comment replies to it (the disposition comes from the driver, so a
    Copilot reply to its own thread does not clear it)."""
    replied = {c.get("in_reply_to_id") for c in comments
               if c.get("in_reply_to_id") and not is_solicited(c)}
    return [c for c in comments
            if is_solicited(c) and not c.get("in_reply_to_id") and c.get("id") not in replied]


def _fetch(repo: str, pr: str, token: str) -> list[dict]:
    """All review comments on the PR, paginated. Raises on transport/HTTP error (main
    turns that into a fail-closed gate error, not a traceback)."""
    comments, page = [], 1
    while page <= PAGE_CAP:
        req = urllib.request.Request(
            f"{API}/repos/{repo}/pulls/{pr}/comments?per_page=100&page={page}",
            headers={"Authorization": f"Bearer {token}",
                     "Accept": "application/vnd.github+json",
                     "User-Agent": "sdlc-arbiter-gate"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            batch = json.load(resp)
        comments.extend(batch)
        if len(batch) < 100:
            return comments
        page += 1
    print(f"::warning title=arbiter-gate::review-thread pagination hit the {PAGE_CAP}-page "
          f"cap ({PAGE_CAP * 100} comments); threads beyond it were not checked")
    return comments


def main() -> int:
    p = argparse.ArgumentParser(description="Solicited review threads must carry a disposition reply")
    p.add_argument("--repo", required=True, help="owner/name")
    p.add_argument("--pr", required=True)
    a = p.parse_args()
    token = os.environ.get("GH_TOKEN", "")

    try:
        comments = _fetch(a.repo, a.pr, token)
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        print(f"::error title=arbiter-gate::could not fetch PR review comments ({e}) — the "
              f"solicited-review check is fail-closed; re-run once the API is reachable")
        return 1

    unanswered = unanswered_solicited(comments)
    if unanswered:
        print(f"::error title=arbiter-gate::{len(unanswered)} solicited (Copilot) review "
              f"thread(s) have no disposition reply — each needs one before merge-ready "
              f"(fixed via <F-id> / covered by <test file::name> / rebutted — driver §6.2):")
        for c in unanswered:
            print(f" - {c.get('path')}:{c.get('line') or c.get('original_line')} — "
                  f"{(c.get('body') or '')[:100].strip()!r} → {c.get('html_url')}")
        return 1
    n = sum(1 for c in comments if is_solicited(c) and not c.get("in_reply_to_id"))
    print(f"✅ solicited review threads reconciled ({n} thread(s), all replied)"
          if n else "✅ no solicited review threads on this PR")
    return 0


if __name__ == "__main__":
    sys.exit(main())
