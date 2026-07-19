# ISSUE-35 - Implement reasonable list limits - Technical Spec & Implementation Plan

Ratified design: [docs/specs/35-implement-reasonable-list-limits.md](./35-implement-reasonable-list-limits.md)
Branch: claude/sdlc-issue-35 . PR #36

---

## PART I - SPEC (what & the contract)

### Problem statement

The shared todo app enforces no bound on an individual item's text and gives no user-visible
feedback when a write is dropped: an over-limit change looks saved locally, then silently fails to
persist. This work adds three fixed product limits -- at most 32 characters and at most 128 UTF-8
bytes per item's text, and at most 10 items in the list -- enforced authoritatively in the shared
server handler (so a direct PUT /api/todos cannot bypass them, identically on the Bun and Worker/D1
runtimes), plus additive client-side prevention (hard-capped input, blocked-when-full add) so a user
is stopped and told WHY at the moment they hit a limit rather than losing work silently. Over-limit
input is refused with a clear message, never truncated. Pre-existing over-limit data is left
untouched and must remain viewable/completable/deletable.

### Definitions (measurement is normative - the adversary will probe this)

- Character count of a text string = number of Unicode CODE POINTS, computed as
  `Array.from(text).length` (equivalently the spread `[...text].length`). This counts by code
  point, NOT by UTF-16 code unit (`String.prototype.length`, which double-counts astral characters
  such as most emoji) and NOT by grapheme cluster. Rationale: the design fixes the companion byte cap
  as "128 bytes = the worst-case byte size of 32 characters in UTF-8"; that equivalence
  (32 x 4 bytes/code-point = 128) is exact ONLY under code-point counting, so code-point counting is
  the reading that makes the two ratified constants self-consistent, and it is deterministic and
  identical on Bun, Workers, and browsers with no Intl.Segmenter dependency. See Open Question 1
  (grapheme-cluster alternative) - resolved to code points as the build default.
- Byte count of a text string = length of its UTF-8 encoding, computed as
  `new TextEncoder().encode(text).length`. TextEncoder is a Web platform primitive present in Bun,
  the Workers runtime, and browsers, so the result is byte-identical across all three.
- Item text for limit purposes = the exact `text` string AS IT WILL BE STORED - i.e. the `text`
  field of the object in the PUT body, unmodified. The server does NOT trim or normalize text
  (consistent with current handler behavior); the client trims before sending, and trimming can only
  shrink a string, so a client value within the limit stays within it after trim.

### The byte cap is redundant-by-construction under code points (honest framing - see F4/OQ1)

Because UTF-8 encodes every Unicode code point in at most 4 bytes, `itemCharCount(text) <= 32`
mathematically implies `itemByteCount(text) <= 128`, and the exact worst case (32 four-byte code
points = 128 bytes) is ACCEPTED (see R2). Therefore, under the ratified code-point interpretation,
MAX_ITEM_BYTES can NEVER be the deciding predicate: no input is at most 32 code points yet over 128
bytes. This is intentional. The byte cap is retained as (a) documentation of the storage-size intent,
(b) a defense-in-depth backstop that keeps the stored-size guarantee explicit and machine-checked,
and (c) the binding guard IF Open Question 1 is ever resolved to grapheme clusters (where 32 glyphs
can exceed 128 bytes). It is NOT an independently-triggerable success criterion, and this spec does
not claim any input will exercise the byte branch alone; the design body's "both checks must hold
independently" wording is read here as "both checks are evaluated," with the byte check's independent
reject being unreachable-by-construction under the chosen measurement. This is called out so a
verifier does not chase an untestable "byte-only rejection" case.

### Fixed constants

| Constant | Value | Meaning |
|---|---|---|
| MAX_ITEM_CHARS | 32 | max code points in one item's text (the binding per-item guard) |
| MAX_ITEM_BYTES | 128 | max UTF-8 bytes in one item's text (redundant-by-construction backstop under code points - see note above) |
| MAX_LIST_ITEMS | 10 | product cap on list length (new growth) |
| MAX_LIST_LEN (existing, unchanged) | 1000 | absolute hard ceiling / DoS + D1-batch backstop |
| MAX_BODY_BYTES (existing, unchanged) | 1048576 | 1 MB transport body cap |

### Requirements (each is verifiable - a falsifying test is named)

Per-item text limit

- R1. On a PUT /api/todos whose body is a shape-conforming list, the server evaluates each item's
  `text` against the per-item limits, with an EXPLICIT grandfather carve-out for unchanged legacy
  items. Precisely, using the single `store.readAll()` performed at the start of the write path
  (see Plan step 7) to build `storedById` = a Map from each stored item's `id` to its stored `text`:
  an item is REJECTED (whole PUT fails HTTP 400, JSON `{"error":"item too long"}`) iff its `text`
  exceeds MAX_ITEM_CHARS code points OR exceeds MAX_ITEM_BYTES UTF-8 bytes, AND it is NOT an unchanged
  legacy item -- i.e. AND `storedById.get(item.id) !== item.text`. An item whose `text` is over-limit
  but whose `(id, text)` pair is already present verbatim in the stored list is ACCEPTED
  (grandfathered; see R11/INV-5). Falsify: PUT one NEW item with 33-code-point text -> expect 400
  `item too long`, stored list unchanged; separately, seed a legacy item `{id:"L", text:<50 chars>}`
  and PUT a body that re-sends that exact `{id:"L", text:<50 chars>}` unchanged alongside a toggle of
  a different item -> 200 (grandfathered), and PUT a body that EDITS item L to a different 40-char
  text -> 400 `item too long`.
- R2. An item whose `text` is EXACTLY 32 code points AND at most 128 bytes is accepted (HTTP 200).
  Falsify: PUT "a" repeated 32 times -> 200; GET returns it. PUT a 4-byte emoji repeated 32 times
  (128 bytes) -> 200. (The 128-byte case is the code-point worst case; it demonstrates R2's upper
  boundary, NOT an independent byte-cap rejection, which is unreachable-by-construction - see the byte-
  cap note above.)
- R3. R1/R2 hold IDENTICALLY on both runtimes (Bun server/index.js, Worker worker/index.js), because
  the check lives once in server/handler.js. Falsify: the same over-limit new-item PUT returns 400
  `item too long` in the Bun integration lane and the Worker cloud lane.
- R4. The client input for adding a todo and for editing a todo WILL NOT ACCEPT a change that raises
  the text above MAX_ITEM_CHARS code points (typing or paste); an attempt is refused (the value does
  not change) and a message is shown. Falsify: render the add input, fire a change to a
  33-code-point value -> the controlled value remains the previous at-most-32 value.
- R5. The client refuses to SAVE an edit whose committed text exceeds MAX_ITEM_CHARS code points (the
  case where an existing over-limit legacy item is being edited): the list is not mutated and a
  message is shown. Falsify: start editing a 40-char legacy item, commit without shrinking ->
  editTodo is not applied; the item is unchanged; message shown.

List limit

- R6. The server rejects a PUT with HTTP 400 and body `{"error":"list full"}` when the submitted list
  would GROW the stored list beyond the cap - precisely: when
  `body.length > MAX_LIST_ITEMS AND body.length > currentStoredLength` (currentStoredLength from the
  same single readAll). Falsify: seed 10 items, PUT 11 -> 400 `list full`, stored list still the
  prior 10.
- R7. A PUT whose length is at most MAX_LIST_ITEMS is accepted regardless of stored length (subject
  to R1/R8). Falsify: seed 10, PUT 10 (an edit/toggle) -> 200; seed 10, PUT 9 (a delete) -> 200.
- R8. A PUT whose length is > MAX_LIST_ITEMS but at most currentStoredLength is accepted - this is
  the legacy-drain path (delete-one or edit on an already-oversized list). Falsify: seed a 15-item
  list (bypassing the client), PUT the same 15 with one item's completed flipped -> 200; PUT 14 of
  them (a delete) -> 200; PUT 16 -> 400 `list full`.
- R9. The pre-existing absolute ceiling is retained: a PUT with body.length > MAX_LIST_LEN (1000) is
  rejected 400 `{"error":"list too long"}` (unchanged behavior, evaluated before the single readAll
  and both new checks). Falsify: PUT 1001 items -> 400 `list too long`.
- R10. The client blocks the ADD action when the current in-memory list already holds at least
  MAX_LIST_ITEMS items (covering both an exactly-full list and a legacy over-full list): no
  optimistic mutation occurs and a "list is full" message is shown. Falsify: render with 10 items,
  submit the add form -> list length stays 10, message shown, no PUT emitted.

Legacy data (must-not-lock-out)

- R11. Items already stored beyond the limits (long text, or a list already > MAX_LIST_ITEMS) are
  returned unchanged by GET, render fully, and can be toggled/completed and deleted - no scan,
  truncation, forced edit, or block on read. The grandfather carve-out in R1 is what makes a PUT that
  re-sends an unchanged over-limit legacy item (as part of toggling/deleting a sibling) succeed.
  Falsify: seed a 15-item list with a 50-char item; GET returns all 15 verbatim; a PUT that deletes
  one (14 items) succeeds (R8); a PUT that toggles the long item's completed without editing its text
  succeeds (R1 grandfather + R8).

Cross-cutting

- R12. The client's pre-checks (R4, R5, R10) run BEFORE the optimistic state mutation, so the UI never
  MINTS a limit-violating optimistic state from a user's own single action - a user's add/edit that
  would violate a limit is refused locally and never issued as a PUT. This covers every single-client,
  no-concurrency path. It does NOT claim that every PUT the client issues is guaranteed to be accepted
  by the server: under concurrent writers a benign PUT (a toggle/delete that the client's pre-checks
  passed) can still be rejected by the server because another client changed the shared list underneath
  it (see the concurrency note and R13). Falsify: drive the component through add-when-full,
  add-over-32, edit-to-over-32 - in each case the in-memory list is not mutated and no rejectable PUT
  is issued.
- R13. No save is silently dropped: when a genuine user mutation's PUT does NOT succeed (any non-2xx,
  network error, or timeout - including the concurrency-race rejection in R1/R6 that R12 cannot
  prevent), the client surfaces a non-silent notice (via the same aria-live channel as the limit
  messages) telling the user their latest change may not have been saved and to refresh. This does NOT
  add reconciliation/merge/auto-reload (out of scope); it makes the drop VISIBLE, which is the design's
  core promise ("no action ... silently dropped"). For this notice to be trustworthy, `saveTodos` must
  resolve its boolean unambiguously (see Plan: the coalesced early-return must resolve to the drain's
  eventual result, not a bare `false`). Falsify: stub `saveTodos` to resolve `false` for a genuine
  mutation -> a save-failure notice is shown; stub it to resolve `true` -> no such notice; and a rapid
  double-edit where the first call coalesces must NOT show a false-positive notice when the drain
  ultimately succeeds.

### Non-goals (unchanged from design; scope fences)

- No migration, backfill, scan, or cleanup of pre-existing over-limit data.
- No per-user/per-tenant quotas, rate limiting, rich text, or attachments.
- No configurable limits - all four constants are fixed.
- No change to MAX_BODY_BYTES (1 MB) or to the transport 411/413/403 guard semantics.
- No new SQL CHECK constraint for text length or list size (would require a migration - out of scope
  - and would double-enforce; SQLite length() counts characters not bytes, so it could not express
  the byte cap anyway). Enforcement stays in the shared handler, the ratified authoritative boundary.
- No client reconciliation / conflict-merge / auto-reload flow after a rejected PUT. R13 makes a
  rejected save VISIBLE (a notice) but deliberately stops short of re-fetching and reconciling the
  server list into local state - that is a multi-client conflict-resolution feature the app has never
  had (src/storage.js is documented best-effort newest-wins) and is out of scope here. The user's
  remedy is an explicit refresh.

### Failure modes & invariants (what must never happen)

- INV-1 (authoritative bound). After any successful PUT, every stored item's text is at most 32 code
  points AND at most 128 bytes, UNLESS that exact over-limit `(id, text)` pair was already present in
  the pre-PUT stored list (legacy passthrough on an untouched item, per R1's grandfather carve-out).
  A NEW `id`, or any item whose text CHANGED from what `storedById` holds for its id, must be within
  limits.
- INV-2 (no growth past cap). The API never increases the stored list length above
  max(MAX_LIST_ITEMS, lengthAtStartOfRequest). Above the cap, list length is monotonically
  non-increasing through the API. A list at 10 or below can never be grown past 10 via the API.
- INV-3 (atomic / old-list-intact). A rejected PUT (any 4xx) commits nothing; the prior stored list
  is returned intact by the next GET. (Already guaranteed by the existing atomic replaceAll; the new
  checks all run BEFORE replaceAll, so they cannot partially write.)
- INV-4 (never truncate). No code path silently shortens a user's text or drops items to fit a limit
  - the response is refusal + message.
- INV-5 (no lock-out). Viewing, completing, and deleting existing items always works regardless of
  legacy over-limit state (protected by INV-2's non-increasing rule, R8's drain path, and R1's
  grandfather carve-out for re-sent unchanged legacy items).
- INV-6 (cross-runtime identity). The character check, byte check, grandfather check, and list-growth
  check produce identical accept/reject decisions on Bun and Worker/D1 for identical input and
  identical stored state (guaranteed by living in the one shared server/handler.js / shared
  src/limits.js).

---

## PART II - PLAN (how the builder implements it)

### Chosen approach and why

1. Single source of truth for limit logic: a new pure module src/limits.js.
The constants and the pure predicates are defined once and imported by ALL THREE consumers - the
shared server handler (which both runtimes already delegate to), the client shell, and the tests.
This is the same pattern the codebase already uses for src/todos.js (a zero-dependency,
browser-global-free pure ESM core imported identically by Vite and by the Node/Vitest test runner).
server/handler.js will import from ../src/limits.js; wrangler/esbuild (Worker), Bun, and Vite all
bundle a zero-dep pure ESM module cleanly, so there is exactly one definition of "32 / 128 / 10" and
of HOW they are measured - no drift between the two runtimes and no drift between client and server.

Rejected alternative: define the predicates inline in server/handler.js and re-implement them in
App.jsx. Rejected because two copies of the measurement rule (code-point counting, UTF-8 byte
counting) is exactly the drift liability this codebase's D-SEAM architecture exists to avoid.

2. Server enforcement lives once in server/handler.js, the runtime-agnostic handler both
server/index.js (Bun) and worker/index.js (Worker/D1) already delegate to. Adding the checks there
satisfies R3/R6 identity for free (INV-6). No change to either adapter file is required.

3. ONE read, up front, feeds BOTH new checks (fixes F1 ordering + the grandfather dependency).
Both the grandfather carve-out (R1) and the growth rule (R6) need the current stored list. The
handler performs exactly one `store.readAll()` at the start of the new logic and derives from it
both `storedById` (Map id -> text, for R1) and `current.length` (for R6). This eliminates the F1
contradiction where the per-item check referenced a stored set that had not been read yet.

4. List-limit semantics: a non-increasing-above-cap "growth" rule, not a flat length cap.
This is the real design question the product spec left open, because the whole API is a whole-list
PUT (replace), not add-one/remove-one. A naive rule ("reject any body with length > 10") is WRONG: it
would make a legacy 15-item list undrainable - deleting an item is a PUT of 14 items, still > 10, so
it too would be rejected, permanently locking the user out (violates R11/INV-5). The correct rule
distinguishes GROWTH from SHRINK/EDIT by comparing the submitted length to the current stored length:

  Reject with `list full` IFF body.length > MAX_LIST_ITEMS AND body.length > currentStoredLength.

Consequences (all desired):

| Stored | PUT body | Decision | Why |
|---|---|---|---|
| 5 | 6 (add) | accept | 6 <= 10 |
| 10 | 11 (add) | REJECT list full | 11 > 10 and 11 > 10 |
| 10 | 10 (edit/toggle) | accept | 10 <= 10 |
| 10 | 9 (delete) | accept | 9 <= 10 |
| 15 (legacy) | 15 (edit/toggle) | accept | 15 <= 15 (not growth) |
| 15 (legacy) | 14 (delete) | accept | 14 <= 15 (drain) |
| 15 (legacy) | 16 (add) | REJECT list full | 16 > 10 and 16 > 15 |

Rejected alternative: an identity/set-diff rule that inspects which ids are new. Rejected as more
complex than needed - because duplicate ids are already rejected upstream (hasDuplicateIds), list
LENGTH is a faithful proxy for "how many items exist," and length is what INV-2 must bound.

5. Grandfather carve-out keyed on stored `id`, not a concatenated string (fixes F3). Because stored
ids are unique (duplicate ids are rejected upstream by hasDuplicateIds), the stored list is a
well-formed Map from id to text. The grandfather test for an over-limit submitted item is exactly
`storedById.get(item.id) === item.text`. This is collision-proof by construction: there is no
separator to overload, so the F3 attack (choosing an id/text pair that concatenates to the same key
as a legacy over-limit entry, e.g. `(id='a:b', text=T)` vs `(id='a', text='b:'+T)`) cannot occur - a
Map lookup by exact id followed by an exact `===` text comparison has no ambiguity. Rejected
alternative: a `Set` of `id + separator + text` strings (F3's bypass) or `JSON.stringify([id,text])`
keys - the id-keyed Map is simpler, needs no encoding decision, and is exactly as expressive because
ids are unique.

6. Keep the existing MAX_LIST_LEN (1000) absolute ceiling unchanged, evaluated BEFORE the readAll and
both new checks (R9). It is now largely a backstop (the growth rule already caps new lists at 10), but
it still protects the D1 batch() statement limit and bounds a pathological legacy list, and the design
says not to touch transport-level caps. Cheap defense-in-depth; retained.

7. Client checks mirror the server but are phrased for the client's own knowledge. The client always
knows its full list, so its list guard is the simpler `todos.length >= MAX_LIST_ITEMS` blocks ADD
(R10). The per-item guard uses the shared itemCharCount predicate at the input boundary (R4) and again
at commit (R5). The client does NOT attempt to reproduce the grandfather rule - it never mints a new
over-limit item, and re-sending an unchanged legacy item is exactly what the server grandfathers.

### Concurrency note (named weakest point - fixes F2)

The write path is readAll -> decide -> replaceAll with no lock, so it is read-then-write (TOCTOU)
under concurrent clients. There are two interleavings to reason about; neither breaks an invariant,
and R13 makes the client-visible consequence non-silent.

(a) Growth-check TOCTOU / resurrection. To ACCEPT a body of length L > 10 the handler must have read
currentStoredLength >= L, and a stored length >= 11 is only ever reachable from pre-existing legacy
data (never minted by the API, per INV-2 induction) - so no interleaving can grow a 10-or-below list
past 10. INV-2 is a per-request invariant and holds. The residual multi-client effect (client A
deletes down from legacy 11->10 while client B, having read 11, re-commits 11) is the PRE-EXISTING
last-write-wins semantics of a whole-list PUT with no conflict resolution.

(b) Grandfather-set TOCTOU (the F2 finding). Stored has a legacy over-limit item `(X, 50chars)`.
Client A deletes X, or edits X's text. Client B, holding stale in-memory state, does a benign action
(toggle/delete a DIFFERENT item Y) and its whole-list PUT re-sends `(X, 50chars)`. The server rebuilds
`storedById` from CURRENT storage, which no longer maps `X -> 50chars`, so B's re-sent over-limit item
is scored as NEW/EDITED and the PUT is rejected 400 `item too long` (or, in the delete-of-X case where
B's body is now longer than current, 400 `list full` via (a)). This is a real, bounded race. We ACCEPT
it rather than try to eliminate it, for these reasons:

- It cannot be narrowed away while honoring the design. The design mandates that EDITING a legacy
  item's text is "a new write [that] must be brought within limits," so the grandfather test must
  compare submitted text against CURRENT stored text for that id; any relaxation that accepts B's
  stale `(X, 50chars)` after A edited X would also accept a genuine over-limit edit, violating the
  design. The race is inherent to grandfathering-against-current-state under whole-list-replace + LWW.
- It is the SAME class as (a)'s accepted resurrection: a stale whole-list re-send loses under
  last-write-wins. This feature changes only the HTTP outcome of that lost write (a 400 instead of a
  silent resurrection), not the pre-existing fact that one of two concurrent whole-list writers loses.
- Preconditions are narrow: it requires a pre-existing legacy OVER-LIMIT item, one client
  deleting/editing exactly that item, and a second client's concurrent stale re-send. It cannot arise
  on a list that has ever been fully within limits.

Because (b) means R12's pre-checks canNOT guarantee every issued PUT is accepted, the design's
"no silent drop" promise is honored by R13 instead: B's rejected benign PUT surfaces a non-silent
"your latest change may not have been saved - refresh" notice. See the App.jsx / storage.js changes
below for why the boolean R13 keys on is made trustworthy.

### Files to touch

NEW - src/limits.js (pure, zero-dependency, no browser globals; mirrors src/todos.js style)

- `export const MAX_ITEM_CHARS = 32;`
- `export const MAX_ITEM_BYTES = 128;`
- `export const MAX_LIST_ITEMS = 10;`
- `export function itemCharCount(text)` -> `Array.from(String(text)).length` (code points).
- `export function itemByteCount(text)` -> `new TextEncoder().encode(String(text)).length`.
- `export function isItemTextWithinLimits(text)` ->
  `itemCharCount(text) <= MAX_ITEM_CHARS && itemByteCount(text) <= MAX_ITEM_BYTES`.
- `export function exceedsListGrowth(newLen, currentLen)` ->
  `newLen > MAX_LIST_ITEMS && newLen > currentLen` (pure; the server's R6/R8 rule).

server/handler.js - extend the PUT path only. The new logic is inserted AFTER the existing shape-
validation / MAX_LIST_LEN (1000) / duplicate-id checks and BEFORE store.replaceAll, in this exact
order (the single read comes first so both checks depend on data that exists):

- Import `{ isItemTextWithinLimits, exceedsListGrowth }` from ../src/limits.js.
- Step A - single read: `const current = await store.readAll();` and build
  `const storedById = new Map(current.map((t) => [t.id, t.text]));`. (Replaces the pre-existing
  separate reads; there is exactly one readAll on the write path.)
- Step B - per-item text check with grandfather (R1/INV-1): iterate `parsed`; if any item has
  `!isItemTextWithinLimits(el.text)` AND `storedById.get(el.id) !== el.text`, return
  `json({ error: 'item too long' }, 400)`. (An unchanged over-limit legacy item -
  `storedById.get(el.id) === el.text` - passes through.)
- Step C - list-growth check (R6): if `exceedsListGrowth(parsed.length, current.length)` return
  `json({ error: 'list full' }, 400)`.
- Step D: `await store.replaceAll(parsed)` (unchanged), immediately after C.
- Ordering rule for tests: MAX_LIST_LEN (1000) 'list too long' is still evaluated before the readAll;
  among the new checks, the per-item 'item too long' (Step B) is evaluated before the growth
  'list full' (Step C), both against the one `current` read in Step A.
- No change to checkWriteGuard, the body ladder, isConformingList, hasDuplicateIds, or the constraint
  classifier. The two adapters (server/index.js, worker/index.js) need NO changes.

src/App.jsx - additive client UX (never the enforcement boundary):

- Import `{ MAX_ITEM_CHARS, MAX_LIST_ITEMS, itemCharCount }` from ./limits.js.
- Add a `notice` state (string | null) rendered as an aria-live="polite" message near the input so
  screen readers announce it (consistent with the a11y posture in tests/App.a11y.test.jsx). Cleared
  at the start of the next successful mutating action.
- Input hard-cap (R4) for both the add draft and the edit field: replace the raw
  `onChange={(e) => setX(e.target.value)}` with a capped setter that accepts the new value IFF
  `itemCharCount(next) <= MAX_ITEM_CHARS || itemCharCount(next) <= itemCharCount(prev)`. The second
  clause is essential: it lets a user SHRINK an over-limit legacy value in the edit field
  (40->39->...), which a plain `<= 32` guard would freeze. When a change is refused, set notice to
  "Item text is limited to 32 characters.". Do NOT use the HTML maxLength attribute - it counts UTF-16
  code units and would diverge from the server's code-point measure for astral characters.
- Add-when-full (R10) in handleAdd: before generating an id / calling addTodo, if
  `todos.length >= MAX_LIST_ITEMS` set notice to
  "The list is full (10 items max). Delete an item to add a new one." and return without mutating
  state or emitting a PUT (leave the draft text intact so the user's text is not lost).
- Edit commit guard (R5) in commitEdit: if `itemCharCount(editText) > MAX_ITEM_CHARS`, set notice and
  return WITHOUT exiting edit mode and without calling editTodo, so the user stays in the field to
  shrink the text (refuse-don't-truncate). Only when within the limit does it apply editTodo and leave
  edit mode.
- Save-failure notice (R13): in the save effect (the genuine-mutation branch that calls
  `saveTodos(todos)`), consume the resolved boolean:
  `saveTodos(todos).then((ok) => { if (!ok) setNotice('Your last change may not have been saved. Refresh to see the current list.'); })`.
  This is the ONLY place the design's "no silent drop" promise is closed for the concurrency race
  (F2/R12). It adds no reconciliation - just a visible notice cleared by the next successful action.
- startEdit continues to prefill editText with the item's current (possibly over-limit) text verbatim
  - never truncated (INV-4); the shrink-allowed cap + commit guard handle it.

src/storage.js - one contract tightening so R13's boolean is trustworthy (INV-J, INV-F unchanged):
the coalesced early-return currently taken when a drain loop is already running (`if (sending) return
false;`, storage.js:56) returns a bare `false` even though the newest state WILL be sent by the
running drain - so a naive caller would read that `false` as a failure (a false-positive notice on
every rapid successive edit). Change it so the coalesced call resolves to the EVENTUAL result of the
current drain (the newest state's PUT outcome) rather than an immediate `false`. Mechanism (builder's
choice, e.g. a module-scoped promise that the owning drain resolves with its final `lastResult`, which
the coalesced branch returns). After this change, a `false` resolution from `saveTodos` unambiguously
means "the newest state failed to persist," which is exactly what R13 keys on. No change to
newest-wins ordering (INV-J) or the never-rejects (INV-F) guarantee.

No changes to src/todos.js (its addTodo/editTodo no-op-on-invalid contract stays; adding a silent
length no-op there would violate INV-4's "refuse + message" - messaging lives in App.jsx),
migrations/0001_init.sql, worker/index.js, or server/index.js.

### How the design handles each failure mode

- INV-1 / INV-4 (bound, never truncate): server Step B rejects any NEW or EDITED over-limit item
  before any write, grandfathering only an exact unchanged legacy `(id, text)`; client input cap +
  commit guard refuse rather than shorten.
- INV-2 (no growth past cap): the exceedsListGrowth rule (Step C); proven by R6/R7/R8 and the
  induction in the concurrency note (a).
- INV-3 (atomic): all new checks are pre-replaceAll; the existing atomic replace is untouched.
- INV-5 (no lock-out): GET never filters; the growth rule's `<= currentStoredLength` branch and R1's
  grandfather carve-out keep delete/edit/toggle around legacy items working (R8/R11).
- INV-6 (cross-runtime): one handler, one limits.js, one read-then-decide path; the Worker cloud lane
  re-proves it.
- Concurrency-race visible-not-silent (F2): R13's save-failure notice, backed by the storage.js
  boolean tightening.

### Test strategy - what the verifier must prove

A. Pure unit - tests/limits.test.js (Node env, drives src/limits.js directly):
- itemCharCount: "a" x32 -> 32; 32 emoji -> 32 (code points, not 64 code units); combining sequences
  counted by code point.
- itemByteCount: ASCII 1 byte/char; one 4-byte emoji -> 4 bytes; a 3-byte char (Euro sign) -> 3.
- isItemTextWithinLimits: 32 code points accepted; 33 rejected; 32 four-byte emoji (128 bytes)
  accepted; 33 emoji rejected. Assert the DOCUMENTED redundancy property (F4): for all tested inputs,
  `itemCharCount <= 32` implies `itemByteCount <= 128` - i.e. the byte check never rejects an input
  the char check accepts. Do NOT assert an "over-128-bytes-but-<=32-code-points" case; it does not
  exist under code points (the verifier should not chase it).
- exceedsListGrowth: the full truth table from the "Chosen approach" section (5/6, 10/11, 10/10,
  10/9, 15/15, 15/14, 15/16).

B. Handler unit - NEW fast lane tests/handler.test.js driving handleRequest(req, {store, config})
with an IN-MEMORY fake store (array-backed readAll/replaceAll), run once with a Bun-style config and
once with a Worker-style config to prove decision-identity without spawning either runtime:
- Per-item: NEW 32-char item accept, NEW 33-char item -> 400 item too long, NEW 32 four-byte emoji
  accept, and old list intact after a rejected PUT.
- Grandfather (R1/INV-1): seed a legacy `{id:"L", text:<50 chars>}`; PUT re-sending it verbatim +
  toggling a sibling -> 200; PUT editing L to a different 40-char text -> 400 item too long; PUT
  introducing a NEW 40-char item -> 400 item too long.
- F3 collision guard: seed a legacy over-limit `{id:"a:b", text:T}`; PUT a NEW item
  `{id:"a", text:"b:"+T}` (would collide under a `id+':'+text` key) -> 400 item too long (proves the
  id-keyed Map, not a concatenated key). Re-sending `{id:"a:b", text:T}` unchanged -> grandfathered.
- List growth: seed 10 -> PUT 11 -> 400 list full, list unchanged; PUT 10 and PUT 9 accepted; seed 15
  legacy -> PUT 15-edit / 14-delete accepted, PUT 16 -> 400 list full.
- Ordering: list too long (1001) still wins over item too long / list full; among the new checks,
  item too long (Step B) is evaluated before list full (Step C).
- F2 race (documented expected behavior): seed legacy `{id:"X", text:<50 chars>}`; simulate A's change
  by mutating the fake store's contents (drop X or change X's text), then PUT a body that still
  contains the old `{id:"X", text:<50 chars>}` -> 400 (item too long, or list full if the body is now
  longer than current). This ENCODES the accepted race so a future refactor that silently "fixes" it
  by relaxing the grandfather rule (and thereby admitting genuine over-limit edits) trips the test.

C. Bun integration - extend tests/integration/server.test.js (real spawned server + bun:sqlite):
per-item boundary/over (R1/R2), list growth boundary/over (R6/R7), and a legacy-drain case seeded via
direct PUT (R8/R11) including a re-send of an unchanged over-limit legacy item -> 200 (grandfather).

D. Worker cloud - extend tests/cloud/worker-contract.test.js (real wrangler dev + D1): the same
per-item over-limit -> 400 item too long and list-growth -> 400 list full, proving runtime identity
(R3/INV-6). An emoji/multi-byte case is included so UTF-8 byte counting is exercised on the real
workerd.

E. Client component - extend/add tests/App.*.test.jsx (happy-dom + Testing Library):
- R4: change the add input to a 33-code-point value -> controlled value unchanged, notice shown.
- R10: render with 10 items, submit add -> list length stays 10, notice shown, saveTodos/PUT not
  called (spy).
- R5: start editing a seeded 40-char legacy item, commit unchanged -> item text unchanged, still in
  edit mode / notice shown; then shrink to at most 32 and commit -> applied.
- R11 (client): a seeded legacy list of 12 items renders all 12; delete works; toggle works.
- R13: with saveTodos stubbed to resolve `false` on a genuine mutation (toggle) -> the save-failure
  notice appears; stubbed to resolve `true` -> no such notice appears.
- Emoji edge at the input: typing 32 emoji is accepted, the 33rd refused.

F. Storage coalescing - extend tests/storage*.test.js (or add one): a rapid double-`saveTodos` where
the second call coalesces into an in-flight drain must resolve to the drain's TRUE final result (so
R13 shows no false-positive notice when the newest send ultimately succeeds), and a single failing PUT
resolves `false`. Proves the storage.js contract tightening.

---

## Open questions (operator decides at the spec checkpoint)

1. Character measurement - code points vs. grapheme clusters, AND the resulting status of the byte
   cap. The design says "32 USER-VISIBLE characters" (which literally means grapheme clusters, e.g. a
   ZWJ family emoji = 1 user-visible glyph) but also fixes the byte cap as "the worst-case byte size
   of 32 characters in UTF-8" (= 32 x 4 = 128, the CODE-POINT worst case). These are only mutually
   consistent under CODE-POINT counting, so the build defaults to code points (Array.from().length):
   simple, deterministic, identical across Bun/Workers/browser, no Intl.Segmenter. IMPORTANT
   CONSEQUENCE (F4): under this default the 128-byte cap is REDUNDANT-BY-CONSTRUCTION - it can never
   independently reject an input (32 code points is always at most 128 bytes), so it is a documented
   backstop, not an independently-testable guard, and the design's "both checks hold independently"
   line means "both are evaluated," not "each can independently fire." If instead you want true
   grapheme-cluster counting ("32 glyphs"), the 128-byte cap BECOMES the independently binding guard
   (32 giant emoji can exceed 128 bytes), "128 = worst case of 32 chars" is then false, Intl.Segmenter
   is required, and emoji behavior differs. DECISION NEEDED: confirm code-point counting with the byte
   cap as a redundant backstop (recommended default), or switch to grapheme clusters (byte cap becomes
   binding)?

2. Grandfather rule for an UNCHANGED over-limit legacy item (now baked into R1 as the build default -
   confirm). The per-item check applies ONLY to items whose `text` differs from the current stored
   text for that `id` (via `storedById.get(id) !== text`); an item whose exact `(id, text)` is already
   stored is grandfathered (passes through), but any NEW id or any changed text must be within limits.
   This preserves INV-5 (toggling/deleting around a legacy item always works) and still refuses
   new/edited over-limit text (INV-1). Encoding is pinned to an id-keyed Map (F3): no separator, no
   collision. NOTE the accepted, documented consequence (F2): under concurrent clients, if one client
   deletes/edits a legacy over-limit item while another re-sends it in a stale whole-list PUT, that
   second benign PUT is rejected (400) - visible to the user via R13's notice, never a silent drop,
   but not reconciled. CONFIRM this grandfather rule and its accepted race. (The strict no-grandfather
   alternative freezes any list containing a long item except by deleting that item first - a lock-out
   the design forbids.)

3. Status code for the two new rejections - 400 vs 409. Both item too long and list full are
   specified as 400 to match the existing handler convention (every current validation rejection,
   including list too long, duplicate id, bad request, is 400). list full is arguably a 409 Conflict.
   Defaulting to 400 for contract consistency; flag if you prefer 409 for the list case.

## Assumptions

- The verifier's fast lanes (tests/limits.test.js, tests/handler.test.js) run in the default
  `bun run test` (Vitest) lane; the Worker cloud additions run only in `bun run test:cloud`
  (wrangler/workerd), matching the existing split.
- src/limits.js may be imported by server/handler.js across the src/ <-> server/ boundary; this is
  consistent with the codebase already treating src/todos.js as runtime-agnostic pure core shared by
  Vite and the Node test runner, and it bundles cleanly under wrangler (Worker), Bun, and Vite because
  it is zero-dependency pure ESM with no browser globals.
- The error-body shape stays the existing flat `{"error": "<message>"}` at HTTP 400; the client's
  limit-message copy (R4/R5/R10) is generated client-side from its own pre-checks. The client does NOT
  parse server error text; for a server rejection it cannot pre-empt (the F2 race), R13's notice is
  generic ("may not have been saved - refresh"), which does not depend on the server's error string.
