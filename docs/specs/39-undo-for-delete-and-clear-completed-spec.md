# ISSUE-39 - Undo for delete and clear-completed - Technical Spec & Implementation Plan

Ratified design: [docs/specs/39-undo-for-delete-and-clear-completed.md](./39-undo-for-delete-and-clear-completed.md)
Branch: claude/sdlc-issue-39

---

## PART I - SPEC (what & the contract)

### Problem statement

Delete and clear-completed are instant and irreversible today: a stray click loses a task, a
clear-completed wipes a batch, with no recovery. This work adds a 5-second, session-scoped **Undo**
after each of those two destructive actions, shown inline in the app's existing status/notice line.
The destructive action still commits immediately (optimistic delete + persist, as today); Undo is a
compensating **re-insert** of exactly what was removed, re-persisted through the normal save path so
it is visible to other viewers and survives reload. Restore is a non-destructive merge against a
**freshly-refetched server list**: it re-inserts only items genuinely absent from that list and
never overwrites or duplicates one already present (so a concurrent same-id edit is preserved).

### Definitions (normative)

- **Removed entry** - a captured `{ item: {id,text,completed}, prevId: string|null }`, where `item` is
  the exact removed todo (text and completed preserved verbatim) and `prevId` is the id of the item
  immediately preceding it in the pre-removal list, or `null` if it was first.
- **Pending undo** - the ordered list of removed entries from the single most recent destructive
  action, plus a live 5s timer. **At most one exists at a time.**
- **Genuinely absent** (restore admission test) - an entry's `item.id` is not present in the
  **freshly-refetched server list** obtained at the moment Undo is taken (via `loadTodos()`). That
  refetched list is what the merge is applied to and PUT, so a concurrent recreation/edit under the
  same id is seen and left as-is, never clobbered by the stale snapshot (FM-2/FM-4).

### Requirements (each names a falsifying test)

- R1. After deleting a single todo, an Undo control appears in the status/notice line; taking it
  within 5s restores that exact todo (text + completed). Falsify: delete an item, click Undo -> item
  is back in the list with identical text/completed.
- R2. After clear-completed, one Undo restores **all** just-removed completed items together as a
  batch, in their original relative order. Falsify: seed 3 completed + 1 active, clear-completed,
  click Undo -> all 3 completed items return; a partial restore is a fail.
- R3. If no Undo is taken within 5s, the pending undo is discarded and the removal stays final
  (nothing re-inserted). Falsify: delete, advance fake timers past 5s -> pending undo cleared, Undo
  control gone, list unchanged (item still absent).
- R4. **Any** subsequent list-mutating action (add, commit edit, toggle, delete, clear-completed)
  discards the pending undo immediately and finalizes the prior removal; a second destructive action
  discards the first's pending undo and arms its own. Falsify: delete A, then toggle B -> A's Undo
  control is gone and clicking it (if referenced) is a no-op; delete A then delete B -> only B is
  restorable.
- R5. Restore never overwrites or duplicates an item whose id is present in the current list; only
  genuinely-absent entries are re-inserted, the rest left as-is. Falsify (pure): `restoreTodos([X],
  [entry(X), entry(Y)])` -> `[X, Y]` (X not duplicated/overwritten, Y inserted).
- R6. Restored items are re-inserted at a **best-effort** position: immediately after `prevId` if that
  id is present, at the front if `prevId` is `null`, else appended. Falsify (pure): the batch/order
  cases in the plan's restore table.
- R7. Undo re-fetches the current server list, merges the removed entries into it, and applies the
  result via `setTodos`, persisting through the normal save effect as **exactly one PUT that carries
  the merged list** (no `storage.js` special-casing). Falsify: click Undo -> one `loadTodos`, then
  exactly one `saveTodos` PUT carrying `restoreTodos(<server list>, entries)`.
- R8. Undo state is client-only and non-durable: it lives in React state, is never persisted, and is
  absent after reload. Falsify: no Undo-related key is written to storage/server; a freshly mounted
  App shows no Undo control.
- R9. The Undo control is a focusable element **outside** the `aria-live` region (a sibling in the
  notice area), keyboard-reachable in Tab order, with accessible name "Undo". Falsify: the removal
  text sits in the `role="status"` node while the Undo `<button>` is not its descendant, is reachable
  by keyboard, and exposes the name "Undo".

### Non-goals

- No persistent trash, history, or multi-level undo stack; no undo for add/toggle/edit; no
  confirmation dialogs; no cross-session or post-reload undo; no exact re-ordering guarantee.
- No new toast/snackbar component; the existing aria-live status line is reused.
- No `storage.js` change and no server/worker change (see architecture note).

### Failure modes & invariants

- FM-1 / INV (at most one pending). Arming a new pending undo first clears any prior timer and state;
  the timer ref is cleared on finalize and on unmount (no leaked timer, no double-fire).
- FM-2 (no overwrite/dup). `restoreTodos` skips any entry whose id is already present -> restore can
  only add genuinely-absent items, never mutate or duplicate an existing one (R5). This is the
  design's safety-critical merge property.
- FM-3 (completed/text integrity). The captured `item` is re-inserted unchanged; `restoreTodos` does
  not re-normalize or reset `completed` (so it cannot silently downgrade a completed item to active).
- FM-4 (bounded, named weakest point). "Genuinely absent" is judged against a server list refetched
  at Undo time, so a concurrent same-id recreation/edit within the window is seen and preserved, not
  overwritten by the stale snapshot (closes the F1 clobber). The residual window is only between that
  refetch and the single merge-PUT: a change another session commits in that sub-second gap is subject
  to the app's pre-existing last-write-wins, identical to any ordinary edit - Undo adds no new
  clobber beyond that.
- FM-5 (legacy over-cap list). On a list already longer than `MAX_LIST_ITEMS` (10, legacy), a restore
  can be rejected by the server growth rule (ISSUE-35 R6); the existing save-failure notice surfaces it
  (no silent loss). Accepted; lists <=10 are unaffected (restoring to exactly 10 is not growth).

---

## PART II - PLAN (how the builder implements it)

### Chosen approach and why

The destructive action stays optimistic-then-persist (unchanged); Undo is a **compensating
re-insert**, not a deferred delete and not a snapshot rollback - so expiry is trivial (delete already
committed) and restore flows through the same refetch+`setTodos`+save-effect path (R7), honoring the
design's "re-persist through the normal save path" and "non-destructive merge, not snapshot" constraints.
The pure merge lives in `src/todos.js`; the timer/state/wiring lives in `App.jsx` (keeping its "no
list-mutation logic" posture). Rejected: **deferring** the delete (contradicts "commits instantly");
reusing `addTodo` (forces `completed:false`, re-normalizes, no position control - a dedicated
`restoreTodos` preserves `completed`, controls position, shares the duplicate-id skip).

### Files to touch

**`src/todos.js`** - add one pure export (mirrors existing style, no globals):
`restoreTodos(list, entries)` ->
- `result = [...list]`; for each `{item, prevId}` of `entries` (in order):
  - if `result.some(t => t.id === item.id)` -> continue (present: leave as-is, R5/FM-2).
  - `idx = prevId == null ? 0 : (i => i === -1 ? result.length : i + 1)(result.findIndex(t => t.id === prevId))`.
  - `result.splice(idx, 0, item)`.
- return `result`. Processing in original order means a batch entry whose `prevId` was itself removed
  finds its predecessor already re-inserted -> original clustering/order preserved (R6).

Restore position table (proving R6):

| current | entries (item:prevId) | result |
|---|---|---|
| `[A,C]` | `B:A, D:C` | `[A,B,C,D]` |
| `[C]` | `A:null, B:A` | `[A,B,C]` |
| `[X]` | `X:null` (present) | `[X]` (skipped) |
| `[C]` | `B:Z` (prev gone) | `[C,B]` (appended) |

**`src/App.jsx`** - state, timer, wiring, render:

- New state `pendingUndo` (`{ entries, label } | null`) and a `undoTimerRef` (holds the setTimeout id).
- `finalizeUndo()` helper: if a timer is set, `clearTimeout` + null the ref, and `setPendingUndo(null)`.
  It fires **only on an actual list mutation** (R4), never on a validation-rejected no-op. Per handler
  (co-located with the existing `setNotice(null)`), the exact finalize condition - mirroring each pure
  op's own no-op guard so it fires exactly when the list reference changes:
  | handler | finalize iff |
  |---|---|
  | `handleAdd` | past the list-full early-return AND `draft.trim() !== ''` (blank/whitespace add is an `addTodo` no-op; id is fresh so never a dup) |
  | `handleToggle` | always (toggling an existing row always mutates) |
  | `handleDelete` | always (mutates; also re-arms its own undo) |
  | `handleClearCompleted` | `todos.some(t => t.completed)` (else nothing removed) |
  | `commitEdit` | past the over-limit early-return AND `editText.trim() !== ''` (empty-after-trim is an `editTodo` no-op) |
- **Hydration/load also finalizes (F3/R4).** The mount-load resolver (both branches of the `loadTodos`
  effect) calls `finalizeUndo()` before applying the loaded list: a whole-list replacement from storage
  is an external mutation that invalidates captured entries, so any undo armed during the pre-hydration
  flash is dismissed rather than later merged against freshly-hydrated data.
- `handleDelete(id)`: compute `entries = [{ item: <the todo>, prevId: <todos[idx-1]?.id ?? null> }]`
  from current `todos` **before** applying `deleteTodo`; then `finalizeUndo()` (clears any prior),
  apply `deleteTodo`, `armUndo(entries, '"<text>" deleted.')`.
- `handleClearCompleted()`: from current `todos`, build one entry per completed item in original order
  (`prevId` = id of the item at `idx-1` in the full pre-removal list, or null); `finalizeUndo()`, apply
  `clearCompleted`, `armUndo(entries, '<n> completed items cleared.')`. If no completed items, do not
  arm (nothing removed).
- `armUndo(entries, label)`: clears any prior timer, then `setPendingUndo({entries, label})`,
  `setNotice(null)`, and `undoTimerRef.current = setTimeout(finalizeUndo, 5000)` (R3).
- `handleUndo()` (async): capture `entries`, call `finalizeUndo()` first (single-fire: clears
  timer+state so a mid-fetch re-click or expiry can't double-apply), then `const fresh = await
  loadTodos()` and `setTodos(restoreTodos(fresh, entries))` - one merge-PUT via the save effect (R7).
  `loadTodos` never rejects (returns `[]` on failure), so a failed refetch degrades to merging into
  `[]` (restore all) rather than throwing.
- Unmount cleanup effect clears `undoTimerRef` (FM-1).
- Render (R9): a notice area wraps two siblings - (a) the existing `role="status" aria-live="polite"`
  node, which now also announces `pendingUndo.label` (removal text) as text-only, and (b) when
  `pendingUndo` is set, a ghost `<Button>` "Undo" wired to `handleUndo`, rendered **outside** the live
  region (a sibling, not a descendant), keyboard-reachable with accessible name "Undo". Keeping the
  interactive control out of the `aria-live` node avoids undefined AT focus/announce behavior; a
  save-failure notice and the undo affordance can still show together.

**No change** to `src/storage.js`, `server/`, `worker/`, `migrations/`, or `src/todos.js`'s existing
exports (only an addition).

### Architecture impact

None. The change is confined to `src/` (SPA), adds no cross-boundary dependency, and touches no
container boundary or dependency rule in [docs/architecture.md](../architecture.md). No ADR or
`check-architecture.mjs` change is required.

### Docs impact

- `README.md`: the feature sentence (line ~3) and the `src/todos.js` export list (line ~46) gain
  Undo / `restoreTodos`.
- `docs/screenshots/`: no existing scene renders the transient post-delete state, so no baseline
  changes; if a new Undo-affordance scene is added it needs the pm's `visual:` approval per the visual
  gate. Default: none.

### Test strategy - what the verifier must prove

- **Pure (`tests/todos.test.js`)**: `restoreTodos` - single restore; batch order/clustering (table
  rows); id-present skip (no dup/overwrite, R5/FM-2); `prevId` missing -> append; `prevId` null ->
  front; `completed`/`text` preserved verbatim (FM-3); input list not mutated (returns new array).
- **Component (`tests/App.undo.test.jsx`, happy-dom + fake timers)**:
  - R1 delete then Undo -> item restored with same text/completed.
  - R2 clear-completed then one Undo -> whole batch restored, order preserved.
  - R3 delete, advance timers >5s -> Undo control gone, item stays deleted.
  - R4 delete then toggle/add/edit/second-delete -> prior pending undo discarded (Undo control gone);
    second destructive action arms only its own.
  - R7 clicking Undo issues one `loadTodos` then exactly one `saveTodos` PUT carrying
    `restoreTodos(<refetched list>, entries)`.
  - R8 fresh mount shows no Undo control; no undo data persisted.
  - R9/a11y: the Undo `<button>` is NOT a descendant of the `role="status"` node, is reachable by Tab,
    and exposes accessible name "Undo".
  - F1 concurrent-collision: arm undo for id X, have `loadTodos` resolve a list already containing X
    (or an edited X'), click Undo -> X'/X is preserved (not overwritten/duplicated); a genuinely-absent
    entry in the same batch is still restored.
  - F2 no-op preserves undo: arm undo, then perform a blank add / whitespace-only edit commit -> the
    Undo control remains (finalizeUndo did not fire on the no-op).
  - F3 hydration: arm undo during the pre-hydration flash, resolve the mount load -> Undo control gone.

---

## Open questions (operator decides at the spec checkpoint)

1. **Undo affordance copy** - confirm the label text: single delete `"<text>" deleted. [Undo]` and
   clear `"<n> completed items cleared. [Undo]"`. (Truncating long item text in the label is assumed;
   confirm or specify a cap.)
2. **Legacy over-cap interaction (FM-5)** - on a list already longer than 10 items, an Undo restore
   can be rejected by the ISSUE-35 server growth rule and surface the existing save-failure notice.
   Confirm this bounded behavior is acceptable (recommended) rather than adding a growth-rule carve-out
   for restores (out of scope here).
