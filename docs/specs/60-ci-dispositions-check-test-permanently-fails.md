# CI: dispositions-check test permanently fails now that #40 has merged

## Problem
`tests/dispositions-check.test.js` (added by #55 / ISSUE-40) hardcodes `--item ISSUE-40` and
computes its base via `git merge-base(origin/main, HEAD)`. Now that #55 has merged, that
merge-base always resolves to `main`'s own tip (or a later descendant), so
`git diff ..HEAD -- SDLC/ledger/rounds.jsonl` is always empty — ISSUE-40's pm `visual:`/`docs:`
notes never show as "added since base", and `check-dispositions.py` reports them missing. The
test then fails with `expected 1 to be +0` on **every** subsequent branch, including `main`'s own
tip in isolation (verified independently of any other PR).

## Motivation
This permanently breaks the `app-tests` CI check for every future PR — a real, escaped defect
from #40, not something any individual downstream PR did wrong. It surfaced while merging `main`
into #58 (issue #57).

## Rough direction
Either scope the test to a fixed historical base (the pre-#40 commit, not a moving merge-base) so
it stops depending on where `main` currently is, or retire the test now that ISSUE-40 has shipped
and its dispositions are permanently on the record — `check-dispositions.py` itself is exercised
elsewhere (`SDLC/tests/test_dispositions.py`, a pure unit test with no git dependency). A
contained, obvious fix.

## Non-goals
- No change to `check-dispositions.py`'s actual disposition logic — only this regression test's
  self-referential base computation.

Escape ledger record: `ISSUE-40-F16` (blocker, filed post-merge on ISSUE-40). Shipped PR: #55.
