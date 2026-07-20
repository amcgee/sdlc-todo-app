# ISSUE-2 — Manual reordering of todos (drag-and-drop) — Technical Spec & Plan

Ratified PRD: [docs/specs/2-manual-reordering-prd.md](./2-manual-reordering-prd.md)
Ratified design brief: [docs/specs/2-manual-reordering-design.md](./2-manual-reordering-design.md)
(its **binding** states are requirements here)
Branch: claude/sdlc-issue-2

---

## PART I — SPEC (what & the contract)

### Problem

Todos render in stored array order with no way to re-prioritize. This lets a user reorder the
list — drag a row by a per-row handle, or move it with the keyboard — in the unfiltered **All**
view, persisting the new order through the **existing** whole-list `PUT`. No new endpoint, field,
or ordering concept; the stored array order *is* the order.

### Definitions (normative)

- **Stored order** — the order of the `todos` array; storage is position-ordered, so the array a
  user arranges is the array they get back.
- **Reorderable context** — `filter === 'all' && sortByDate === false`. Exactly here the rendered
  list (`visible`) equals `todos` in order, so a rendered index equals a stored index. In any other
  view `visible` is a filtered subset or derived order where "move to index N" has no stored position
  — so reordering is disabled there (a correctness guard, not only UX).

### Requirements (each names a falsifying test)

- **R1.** `moveTodo(list, id, toIndex)` returns a new array with the item relocated to the clamped
  destination; a non-matching id, or a destination equal to the current index, returns the **same
  list reference** (no-op, so no redundant `PUT`); input never mutated. `toIndex` is the item's
  **final** 0-based resting index (remove-then-insert semantics: the item is spliced out, then
  inserted so it lands at `toIndex` in the resulting array). Falsify (`tests/todos.test.js`)
  via the oracle table below, plus: unknown id → same ref; no-op move → same ref; original array
  unmodified.
- **R2.** Reordering is offered **only** in a reorderable context. Elsewhere the handle still renders
  but is disabled: `aria-disabled`, not draggable, its arrow keys inert, and it carries the tooltip
  *"Reordering is only available in the All view with manual order"*. Falsify (`tests/App.reorder.test.jsx`):
  in All+manual the handle is enabled and a move mutates the list; with any filter active **or**
  "Sort by date" on, the handle is `aria-disabled`, ArrowUp/Down and a simulated drag do nothing, and
  no `PUT` fires.
- **R3.** With a handle focused, `ArrowUp`/`ArrowDown` moves the item one stored position immediately
  (no pick-up mode) and focus stays on that same handle at its new position; at an end the key is a
  no-op. While a handle is focused in a reorderable context, a hint **"Press ↑ / ↓ to move"** is
  shown and programmatically associated with the handle (`aria-describedby`); it is absent when the
  handle is unfocused, and in a non-reorderable context the R2 disabled-tooltip is shown instead of
  the hint. Falsify (`tests/App.reorder.test.jsx`): ArrowDown on the 2nd of 3 items reorders the DOM
  and `document.activeElement` is still that handle; ArrowUp on the first item leaves order unchanged
  and fires no `PUT`; focusing an enabled handle exposes the hint text and blurring removes it.
- **R4.** A pointer drag from the handle lifts the row and, until release, renders three elements
  together: (1) the dragged row in a **lifted** presentation, (2) a distinct **drop-target
  indicator** at the prospective gap, and (3) a **dashed source-gap placeholder** in the slot the
  row left. The prospective gap maps to `moveTodo`'s destination by pointer geometry: for the row
  under the pointer at rendered index `r` (dragged item's origin index `i`), the target gap is
  `g = r` when the pointer is in that row's **upper** half and `g = r + 1` in its **lower** half;
  then `toIndex = g` when `g ≤ i`, else `toIndex = g − 1`. This one rule agrees with `moveTodo`'s
  post-removal semantics in **both** drag directions. On release it commits exactly one
  `moveTodo(list, id, toIndex)`; a release whose `toIndex` equals `i` (either half of the origin
  row) commits nothing. Falsify (`tests/App.reorder.test.jsx`, row `getBoundingClientRect` stubbed
  to synthetic vertical bands): mid-drag exactly one lifted-row, one drop-indicator, and one
  source-placeholder marker are present and all vanish on pointerup; and each drag-oracle row below
  issues exactly one `PUT` placing the item at the stated index (zero `PUT` for the origin case).
- **R5.** Every completed move announces `"<text> moved to position N of M."` (N = 1-based stored
  position, M = list length) in the app's existing `role="status" aria-live="polite"` region; an
  end-of-list no-op announces `"<text> is already at the top."` / `"…at the bottom."`. The move
  announcement and the region's `notice`/undo-label content are **mutually exclusive**: setting the
  announcement clears `notice` and finalizes any pending undo, and any later action that writes the
  region (a `notice`, or arming/finalizing undo via add/toggle/edit/delete/clear/undo) resets the
  announcement to null — so a move message never coexists with, nor outlives, a later unrelated
  action. Because an `aria-live` region does not re-announce unchanged text, each announcement
  carries a monotonically increasing sequence nonce (surfaced as `data-announce-seq`) so an
  identical repeated message (e.g. ArrowUp twice at index 0) still re-renders and re-announces.
  Falsify (`tests/App.reorder.test.jsx`): status text after a keyboard move equals the position
  copy and after an end no-op equals the top/bottom copy; toggling a todo after a move removes the
  move text from the region; two successive ArrowUp presses at index 0 emit the identical no-op copy
  with `data-announce-seq` incremented on each press.
- **R6.** The new order persists through the **unchanged** whole-list `PUT`: a move issues exactly one
  `PUT` of the whole `todos` array in its new order, and a subsequent `GET` returns that order on both
  runtimes. Falsify: R3/R4 assert the single new-order `PUT`; the existing verbatim round-trip in
  `tests/handler.test.js` and `tests/cloud/worker-contract.test.js` already proves array order is
  stored and returned unchanged (no server code changes, so no new server test is warranted).
- **R7.** The handle is a real `<button>`, the **first** focusable control in each row (Tab order:
  handle → checkbox → text → Edit → Delete), sitting in a reserved ~20px left gutter. In a
  **reorderable** context it is hidden at rest and revealed on row hover or focus-within; in a
  **non-reorderable** (disabled) context it is instead **visible-but-dimmed at rest** (no hover
  needed) so the affordance stays discoverable, per the design brief's `filtered` state. Falsify
  (`tests/App.a11y.test.jsx`): each row's first focusable element is the reorder handle with an
  accessible name; in a disabled context the handle is present at rest without hover; the
  reveal/dim styling is a visual concern proven by the `reordering` recording and the regenerated
  still baselines (Docs impact).

`moveTodo` oracle (R1; `list = [A,B,C,D]`, moved by id):

| move | result |
|---|---|
| A → 2 | `B, C, A, D` |
| D → 0 | `D, A, B, C` |
| B → 1 | `A, B, C, D` (same ref — no-op) |
| C → 99 | `A, B, D, C` (clamped to last) |
| X → 1 | `A, B, C, D` (absent — same ref) |

Drag oracle (R4; `list = [A,B,C,D]`, dragged item origin index `i`, rendered rows 0..3 with a
placeholder at `i`):

| drag | pointer over | half | g | toIndex | result / PUT |
|---|---|---|---|---|---|
| A down (`i`=0) | row C (`r`=2) | lower | 3 | 2 | `B, C, A, D` |
| D up (`i`=3) | row A (`r`=0) | upper | 0 | 0 | `D, A, B, C` |
| A (`i`=0) | placeholder row (`r`=0) | either | 0 / 1 | 0 | same ref — zero `PUT` |

### Non-goals

- No reordering within a filtered subset or while "Sort by date" is active (All + manual only).
- No persisted auto-sort; the view-only "Sort by date" toggle is unchanged and stays view-only.
- No multi-select / bulk move (one item at a time); no always-visible move-up/down buttons as a
  second affordance; no grouping, nesting, or cross-device reordering.

### Invariants & failure modes

- **INV-PERMUTATION.** A reorder is a pure permutation: `moveTodo` preserves list length and the
  id multiset and edits no field — an item is never added, dropped, duplicated, or altered.
- **INV-CANONICAL-ORDER.** Every reorder reads and writes only `todos` (the canonical stored order)
  and is enabled only when rendered order equals stored order, so a rendered index can never write a
  wrong stored position. Switching into and back out of a filter/sort therefore re-shows the stored
  order intact (the filter/sort remain view-only, mutating nothing).
- **INV-CONTRACT-STABLE.** No new endpoint, wire field, DB column, migration, or ordering concept —
  order is array order through the existing `PUT`, identical on both runtimes (the PRD constraint).

---

## PART II — PLAN (how the builder implements it)

### Chosen approach and why

Reuse the position-ordered array and the existing whole-list `PUT` (the PRD's binding architectural
direction), so the entire feature is client-side: **zero** changes to `server/handler.js`,
`server/index.js`, `worker/index.js`, `migrations/`, or the storage schema. One pure
`moveTodo(list, id, toIndex)` is the sole list primitive; drag supplies a drop index and keyboard
supplies `currentIndex ± 1`, so there is one relocation rule to test. Drag uses the **Pointer Events**
API so the single handle drives mouse, pen, and touch uniformly. Keyboard moves are immediate
one-step (no grab/drop mode); because the handle is keyed by `todo.id`, React moves the same DOM node
on reorder and browser focus rides along for free — no manual focus restoration.

Rejected: **native HTML5 drag-and-drop** (no touch support — would need a separate touch path).
A **drag-and-drop library** (violates the no-extra-dependency posture; a single-column, one-at-a-time
move is simple to own). **Separate `moveUp`/`moveDown`/`moveToIndex`** (one `moveTodo` composes both).
**Hiding the handle when disabled** (the design brief chose shown-but-disabled + tooltip for
discoverability). **A persisted "order" field or reorder endpoint** (array order already carries it —
new surface the PRD forbids).

### Files to touch

- **`src/todos.js`** — add pure `moveTodo(list, id, toIndex)`: find index; if absent return `list`;
  clamp `toIndex` to `[0, length-1]`; if clamped equals current index return `list` (same ref);
  else splice out and re-insert so the item lands at `toIndex`. (Per R1/INV-PERMUTATION.)
- **`src/App.jsx`** — reorder wiring:
  - `reorderable = filter === 'all' && !sortByDate` (one derived boolean).
  - Per-row drag handle `<button>` rendered **first** in each `<li>`; disabled presentation +
    tooltip when `!reorderable`.
  - `onKeyDown` on the handle: ArrowUp/Down → `setTodos(cur => moveTodo(cur, id, indexOf(id) ± 1))`,
    then announce; inert when `!reorderable`. A "Press ↑ / ↓ to move" hint (`aria-describedby`) shows
    while the handle is focused in a reorderable context (R3).
  - Pointer drag on the handle: pointerdown starts it, pointermove computes the target gap from row
    rects (R4 geometry) and renders the lifted row + source-gap placeholder + drop indicator,
    pointerup commits `moveTodo`; guarded by `reorderable`.
  - New `announcement` state (`{ text, seq }`) rendered inside the **existing** `role="status"`
    region (R5); setting it clears `notice` and `finalizeUndo()`s, and it is reset to null by any
    later status-writing action; the `seq` nonce (as `data-announce-seq`) forces re-announcement of
    identical repeated copy.
  - Handle gutter, hover/focus-within reveal (dimmed-at-rest when disabled), grab cursor, lifted-row
    + source-gap placeholder + drop-indicator (R4), and settle highlight are Tailwind/`src/index.css`
    classes drawn from existing tokens; settle + drag motion honor `prefers-reduced-motion`.
- **`docs/screenshots/scenes.json`** — add the `reordering` **recording** scene (the interaction a
  still can't show). **`scripts/screenshots.mjs`** — add a keyboard-move (and/or drag) action verb the
  recording scripts (builder infra for the new scene).
- **`docs/guide/managing-todos.md`** — document reordering: drag by the handle, keyboard
  ArrowUp/Down, and that it is available only in the All view with manual order.

Wiring the builder can't infer: put the **drop-index geometry behind a pure helper** (row rects +
pointer Y → `toIndex` per the R4 rule) so R4 is unit-testable with stubbed rects, rather than reading
layout inside the event handler.

### Architecture impact

None. `moveTodo` is a new pure export of `src/todos.js` consumed by `src/App.jsx` — no new container,
no cross-boundary dependency, no rule change, no server/worker/migration touch. No ADR or
`scripts/check-architecture.mjs` change.

### Docs impact

- **visual:** reordering added — a recording (GIF, documentation-only, not pixel-compared) of the
  reorder interaction: handle reveal on focus/hover, a keyboard move-down with the live announcement,
  and the settle; existing still baselines changed — the reserved ~20px handle gutter shifts every
  resting row, so `active-and-done`, `list-at-cap`, `undo-after-delete`, `due-dates`, and
  `editing-todo` are regenerated + pm-reviewed. No new *still* scene: the handle is invisible at rest
  and its revealed/drag/keyboard states are transient (scene_policy: transient/focus behavior).
- **docs:** `managing-todos.md` — a reordering section covering drag-by-handle, keyboard
  ArrowUp/Down, the move announcement, and the All-view-with-manual-order-only restriction.

### Open questions (operator decides at the spec checkpoint)

1. **Touch model** (flagged provisional in the PRD/design): this spec builds full handle-drag on
   touch via Pointer Events. Confirm, or switch touch to the keyboard-style move-up/down (only the
   touch drag path changes; the handle and disabled-context treatment are unaffected).
2. **Announcement copy**: adopting the design brief's `"<text> moved to position N of M."`. Confirm,
   or choose position-only / relative "moved up/down" — copy-only, no structural change.
