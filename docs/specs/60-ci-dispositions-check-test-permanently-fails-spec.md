# ISSUE-60 mini-spec

## Diagnosis
`tests/dispositions-check.test.js`'s `mergeBase()` (`tests/dispositions-check.test.js:27-43`)
computes `git merge-base(origin/main|main|origin/HEAD, HEAD)` at test-run time. That was meant to
land on the commit just before PR #55 (ISSUE-40) merged, so `--base <that sha>` makes
`check-dispositions.py` see ISSUE-40's `visual:`/`docs:` ledger notes as "added since base". Now
that #55 is squash-merged into `main` (commit `e7b9c74`), any branch's merge-base with `main` is
`main`'s own tip (at or after `e7b9c74`) — never before it — so the diff is always empty, the
notes never show as added, and the test fails `expected 1 to be +0` everywhere, including `main`
itself.

## Fix
Remove `tests/dispositions-check.test.js` outright rather than pinning a fixed base. It was a
regression guard for ISSUE-40-F7 (a spec-formatting parse bug in `check-dispositions.py`'s
`_DECL` regex, fixed by unwrapping the spec's `visual:`/`docs:` lines) — that fix is permanently
on `main` and the underlying parser logic remains covered by the pure unit test
`SDLC/tests/test_dispositions.py` (`evaluate()`, no git dependency). The integration test's whole
premise — diffing ledger notes against a moving `--base` to prove a now-historical, already-shipped
fix — has no future value and no safe fixed replacement worth the upkeep.

**Blast radius, checked:** no CI workflow or other test references this file by name (`vitest run`
picks up test files automatically, `package.json:11`); the only ledger `test` entries naming it
are scoped to `ISSUE-40` (`SDLC/sdlc.py`'s `_check_tests_exist` only checks entries whose `ref`
matches the *current* `--item`, so ISSUE-60's own gate never re-validates ISSUE-40's historical
test claims — confirmed by reading `_check_tests_exist` at `SDLC/sdlc.py:577-602`); `doctor`
validates ledger structure only, never filesystem test existence across items. Deleting the file
is safe.

## Proving test
None added — this is a deletion with no remaining behavior to prove. The suite must still pass in
full (`bun run test:coverage`), confirming nothing else depended on this file.

## Docs impact
- visual: none — no product/UI code touched, only a test file removed.
- docs: none — no user-facing behavior change; this is a CI-only regression-test cleanup.
