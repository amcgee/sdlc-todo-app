# Rearrange filter and sort controls — mini-spec (trivial)

**Diagnosis.** `src/App.jsx`: the filter row (`All`/`Active`/`Completed`, "N items left",
"Clear completed") sits at lines ~489–536, and the "Sort by date" toggle at ~538–552 — both
**below** the `<ul>` list (closes line 487). "Clear completed" (line ~528) renders
unconditionally regardless of whether any todo is completed.

**Fix.**
1. Split the single control block into two JSX fragments: a **filter+sort row** (the
   All/Active/Completed buttons + the Sort-by-date toggle) and an **item-count+clear row**
   ("N items left" + "Clear completed").
2. Render the filter+sort row **above** `<ul>` (after the notice/undo block, before line 378).
3. Render the item-count+clear row **below** `</ul>`, in its current relative position.
4. Gate "Clear completed": wrap it in `{filtered.some((t) => t.completed) && (...)}` — `filtered`
   is the pre-sort, post-filter array already computed at line 190. This ties visibility to the
   currently-filtered view (hidden on "Active"), not the raw `todos` array.
5. No changes to filter/sort logic, state, or the selected-state cues.

**Proving test.** New assertions in `tests/App.a11y.test.jsx`:
- Renders the filter buttons before the first `<li>` in DOM order (was after).
- With `filter: 'active'` and a completed todo present in `todos`, "Clear completed" is not in
  the document.
- With `filter: 'all'` (or `'completed'`) and a completed todo present, "Clear completed" is in
  the document; clicking it still clears as before.
- "N items left" and the sort toggle remain functionally unchanged (regression guard).

**Required update to an existing test (ISSUE-57-F1).** `tests/App.a11y.test.jsx`'s "A5 —
accessible names" test (`New todo input and control buttons have accessible names`, ~lines
106–117) adds a single *non-completed* todo under the default `filter: 'all'` and asserts
`getByRole('button', { name: 'Clear completed' })` is present — once Clear-completed is gated on
`filtered.some(t => t.completed)`, that assertion regresses (button no longer mounted). Fix
alongside the reflow: complete the todo (toggle its checkbox) before that assertion, so the test
still proves the button's accessible name while remaining valid under the new visibility rule.

**Docs-impact.**

visual: `empty-list`, `active-and-done`, `list-at-cap`, `undo-after-delete`, `due-dates`,
`editing-todo` changed — the control reflow moves the filter/sort row above the list, shifting
every still baseline (`list-at-cap` and `due-dates` past the 2% CI threshold, the rest under it).
No new scene: per scene_policy this is element reordering of already-documented states, so the
existing baselines are regenerated and pm-reviewed, not added to.

docs: `docs/guide/managing-todos.md` and `README.md` embed affected scenes (their screenshots are
re-captured) and `managing-todos.md`'s "Clear completed" section must state the new hiding rule
(hidden whenever the currently-filtered view has no completed todo).
