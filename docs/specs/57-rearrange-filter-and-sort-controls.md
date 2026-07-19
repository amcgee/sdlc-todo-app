# Rearrange filter and sort controls

## Summary
Reposition the filter ("All" / "Active" / "Completed") and sort ("Sort by date") controls from
below the todo list to above it, so the tools that shape what the user sees appear before the
content they act on. The item count and "Clear completed" action stay below the list. "Clear
completed" is hidden whenever the current view (after filtering) shows no completed todos.

## Users & motivation
Everyday users who filter or sort their list expect the controls that shape what's shown to sit
near the top, above the content they govern. A "Clear completed" button that does nothing in the
current view is noise.

## Scope
- The filter control ("All" / "Active" / "Completed") and the "Sort by date" toggle move to
  **above** the todo list, as a single control row. Behavior, selected-state cues, and
  accessibility semantics are unchanged — only position moves.
- The item count ("N items left") and "Clear completed" stay in their own row **below** the list,
  in their current relative position.
- **"Clear completed" is hidden whenever the currently filtered view contains no completed
  todos** — e.g. viewing "Active" (which never shows completed items) always hides it, even if
  completed todos exist elsewhere in the full list. It reappears as soon as the filtered view
  contains at least one completed todo.

## Non-goals
- No new sort capability or filter option — both controls already exist.
- No change to filtering or sorting logic, only where the controls that trigger them sit.
- No change to what "Clear completed" *does* — only when it's visible.
- No restyling/relabeling of list items or the add-todo input.

## Success criteria
- On load, the filter + sort control row renders **above** the todo list.
- The item count and "Clear completed" render **below** the list, as today.
- "Clear completed" is absent from the DOM whenever the filtered view has zero completed todos
  (including while viewing "Active" with completed todos elsewhere).
- "Clear completed" appears as soon as the filtered view contains a completed todo.
- Filtering, sorting, and their selected-state cues are unchanged in behavior.
