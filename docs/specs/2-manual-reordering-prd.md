# Manual reordering of todos (drag-and-drop)

## Summary
Today todos appear only in the order they were added, with no way to promote or demote an item by
priority. This feature lets a user manually reorder their list — drag an item by a handle to a new
position, with an accessible keyboard alternative — and have that order persist across reloads.
Manual ordering is the most conspicuous gap in the current feature set (add / toggle / edit /
delete / clear-completed / filter / count), and the persistence layer is already position-ordered,
so this closes an everyday-expected capability without changing what a todo *is*.

## Users & motivation
Everyday users of the todo app who use it to track and prioritize their own tasks. They want the
most important or most urgent items near the top and less pressing ones lower down, they expect
that arrangement to be a deliberate manual act — not something the app decides for them — and they
expect it to still be there when they come back.

## Scope
- A user can move any todo to a new position in the list by direct manipulation: dragging it by a
  **per-row drag handle** (not the whole row), seeing where the item will land before releasing.
- The drag handle is **revealed on hover or keyboard focus** of a row, not shown persistently — the
  resting list stays uncluttered, and the affordance appears when a user engages a row.
- A **keyboard-accessible equivalent** exists for users who don't or can't drag — a simple
  **move-up / move-down** model, reachable and operable without a pointer, with each move announced
  to assistive technology. This is the non-pointer path; there are no separate always-visible
  move-up/move-down buttons.
- Manual reordering is available only in the **unfiltered "All" view with the default (manual)
  ordering**. When an Active/Completed **filter** is applied, or the view-only **"Sort by date"**
  toggle is active, the drag handle is **disabled/hidden** and dragging is not offered — in those
  views the displayed order is a subset or a derived order, so "move to any position" is not
  meaningful.
- The new order is persisted through the existing whole-list save and is stable across reloads and
  across both backend runtimes (the ordering a user sets is the ordering they get back).

## Non-goals
- No reordering *within* a filtered subset (Active/Completed) or while "Sort by date" is active —
  manual reorder is an "All"-view, manual-order-only capability.
- No auto-sorting as a *stored* order (by due date, alphabetical, creation time, etc.) — this is
  *manual* order only. The existing view-only "Sort by date" toggle is unaffected and stays
  view-only.
- No grouping, sections, columns, or nesting/sub-tasks.
- No multi-select or bulk move — one item moves at a time.
- No always-visible move-up/move-down controls as a second visible affordance alongside the drag
  handle.
- No cross-device or real-time collaborative reordering beyond what the current single-list
  persistence already provides.

## Success criteria
- In the "All" view, a user can drag an item by its handle from any position to any other position
  and the list visibly reflects the new order, with a clear indication of the drop target during
  the drag.
- The drag handle appears on hover/focus and is absent at rest; while a filter or "Sort by date" is
  active, the handle is not offered and dragging does nothing.
- A keyboard-only user can move an item up and down through the list and reach any position, with
  each move announced.
- After a reload (and when served from either runtime), the list comes back in exactly the order
  the user last arranged.
- Switching into and back out of a filter or "Sort by date" never silently loses, duplicates, or
  reorders items — the stored manual order is preserved and re-shown on return to the default "All"
  view.
- The reordering interaction does not regress existing add/toggle/edit/delete/clear-completed/undo
  behavior.

## Architectural direction
The set order must **persist and stay stable across reloads and across both backend runtimes**
(Bun and the Cloudflare Worker), which share one HTTP contract. This is essential to the feature —
a reordering that doesn't survive a reload, or that differs between runtimes, would be the wrong
product. The existing model already supports this (storage is position-ordered and the whole list
is saved via the current `PUT`), so the expectation is that reordering reuses that contract rather
than introducing a new ordering concept or endpoint. The architect owns how to implement the move
and persist it; this clause only fixes the outcome — durable, runtime-stable order through the
established whole-list save.

## Design
Design-impact: yes. Mockups + interaction brief: `docs/specs/2-manual-reordering-design.md`
(screens/states under `docs/specs/2-manual-reordering-design/`), ratified alongside this PRD at
PRD-rev 2.
