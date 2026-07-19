# SPEC — TODO-1: React TODO application

Status: draft (awaiting spec gate)
Owner: architect

## Problem statement

There is no way for a user to track a personal list of tasks in this project. This
work delivers a single-page, client-only React TODO application. A user can add
tasks, mark them complete/incomplete, edit task text, delete tasks, clear all
completed tasks, filter the visible list (All / Active / Completed), and see how many
tasks remain active. The list survives a browser reload via `localStorage`. There is
no backend, no authentication, and no network I/O — all state lives in the browser.
The core list-mutation logic is isolated in a pure, dependency-free JavaScript module
so it can be unit-tested under Node without a DOM, with the React UI as a thin layer.

## Definitions

- **Todo**: an object `{ id: string, text: string, completed: boolean }`. These three
  fields are the entire schema. `id` is a non-empty string, unique within a list.
  `text` is a non-empty string (see R3 for normalization). `completed` is a boolean.
- **Todo list**: a JavaScript array of Todo objects. Order is insertion order
  (newest appended last) and is preserved by every operation except where stated.
- **Active todo**: a todo whose `completed` is `false`.
- **Pure function**: a function that returns a new value and does not mutate its
  arguments, read or write `localStorage`, read the clock/`Math.random` (unless the
  source of nondeterminism is passed in as an argument — see R10), or touch any global.
- **Logic module** (`src/todos.js`): the pure module under test.
- **UI layer** (`src/App.jsx`): the React component tree; the only place allowed to
  perform side effects (`localStorage`, rendering, event handling, id generation).

## Requirements

Each requirement is verifiable by `node:test` unit tests against `src/todos.js`
(R1–R12) or by a documented manual/UI check (R13–R18, marked **[UI]**).

### Logic module — `src/todos.js` (unit-testable with `node:test`)

1. **R1 — Module is pure and Node-importable.** `src/todos.js` imports with zero
   third-party dependencies and zero browser globals (`window`, `document`,
   `localStorage`). *Test:* importing the module under plain `node --test` succeeds;
   grep/static check confirms no `import` of non-builtin packages and no reference to
   browser globals.

2. **R2 — `addTodo(list, text, id)` appends one todo, rejecting duplicate ids.**
   Returns a new array equal to `list` with one todo
   `{ id, text: <normalized>, completed: false }` appended. `id` is supplied by the
   caller (not generated inside the module). To preserve INV2, `addTodo` MUST be a
   **no-op** (returns the input list unchanged, deep-equal) if `id` is already present
   in `list`, or if `id` is not a non-empty string, or if the normalized text is empty
   (R3). *Test:* a fresh `id` yields `list.length + 1` with the new element last and
   the input not mutated; an `id` already in `list` returns a list of the same length
   with no new element; a non-string/empty `id` is a no-op.

3. **R3 — Text is normalized; empty/whitespace-only text is rejected.** Normalization
   = trim leading/trailing whitespace. If the normalized text is the empty string,
   `addTodo` returns the input list **unchanged** (no todo added) and `editTodo` (R5)
   leaves the target todo's text unchanged. *Test:* `addTodo(list, "   ")` returns a
   list of the same length; `addTodo(list, "  hi  ")` stores `"hi"`.

4. **R4 — `toggleTodo(list, id)` flips exactly one `completed` flag.** Returns a new
   array where the todo with matching `id` has `completed` negated and all others are
   unchanged. If no `id` matches, the list is returned unchanged. *Test:* matching id
   flips; non-matching id is a no-op; only the targeted element differs.

5. **R5 — `editTodo(list, id, text)` replaces one todo's text.** Returns a new array
   where the matching todo's `text` is the normalized new text. Empty-after-trim text
   is rejected per R3 (target unchanged). Non-matching `id` is a no-op. `completed`
   and `id` are preserved. *Test:* text updates and is trimmed; whitespace-only edit
   is a no-op; id/completed preserved; non-matching id is a no-op.

6. **R6 — `deleteTodo(list, id)` removes one todo.** Returns a new array without the
   todo whose `id` matches. Non-matching `id` returns the list unchanged. *Test:*
   length decreases by 1 for a match; remaining order preserved; no-op for non-match.

7. **R7 — `clearCompleted(list)` removes all completed todos.** Returns a new array
   containing only active todos, order preserved. *Test:* all `completed: true`
   removed; active ones kept in order; empty/all-active lists handled.

8. **R8 — `filterTodos(list, filter)` selects by status.** For `filter === "all"`
   returns all todos; `"active"` returns todos with `completed === false`; `"completed"`
   returns todos with `completed === true`. Order preserved. An unrecognized filter
   value MUST be treated as `"all"` (defensive default). *Test:* each of the three
   filters; unknown filter falls back to all.

9. **R9 — `remainingCount(list)` counts active todos.** Returns the integer number of
   todos with `completed === false`. *Test:* mixed list, all-active, all-completed,
   empty list (returns 0).

10. **R10 — No internal nondeterminism.** The logic module never calls
    `Math.random()`, `Date.now()`, or generates ids itself. Any id is passed in by the
    caller (R2). *Test:* static check (grep) for absence of these calls; behavioral
    determinism follows from R2.

11. **R11 — Input immutability.** No exported function mutates its `list` argument or
    any todo object within it. *Test:* for every function, a deep-frozen input (via
    `Object.freeze` on list and elements) does not throw and the original snapshot is
    unchanged after the call.

12. **R12 — Tolerant load via `sanitizeTodos(raw)`.** The module exports
    `sanitizeTodos(raw)` that takes an arbitrary parsed value and returns a valid Todo
    list. If `raw` is not an array, returns `[]`. Otherwise it processes each element
    in order and applies the following rules in this exact sequence:
    1. **Drop non-objects.** If the element is not a non-null object (e.g. a string,
       number, `null`, or array), drop it.
    2. **Validate `id`.** If `id` is not a non-empty string, drop the element. (Ids are
       never coerced or generated here.)
    3. **Normalize then validate `text` (trim-then-validate).** Compute
       `text = String(element.text).trim()` **first**; if the result is the empty
       string, drop the element. The retained todo stores the trimmed value. This
       ordering guarantees no whitespace-only text survives (INV1). A `text` that is
       not a string is coerced via `String(...)` before trimming, then validated the
       same way.
    4. **Coerce `completed`.** `completed` is set to `true` only if the element's
       `completed` is the boolean `true`; every other value (missing, non-boolean,
       truthy non-boolean) becomes `false`. Elements are **never dropped** on account
       of `completed` — it is always coerced, never validated. (This resolves the
       earlier contradiction: the policy is *coerce*, not *drop*.)
    5. **De-duplicate `id`.** Keep the first surviving occurrence of each `id`; drop
       any later element whose `id` already appeared.

    *Test:* non-array input → `[]`; non-object elements dropped; missing/empty/non-
    string `id` dropped; whitespace-only `text` dropped (trim-then-validate);
    non-boolean `completed` (e.g. `1`, `"yes"`, missing) coerced to `false` while the
    element is kept; duplicate ids collapsed to first; output order preserved.

### UI layer — `src/App.jsx` (manual / lightweight verification) **[UI]**

13. **R13 — [UI] Add via input.** Typing text and submitting (Enter or an Add control)
    appends a todo and clears the input. Submitting empty/whitespace adds nothing.
    *Verification:* documented manual check, or a component test if the harness exists.

14. **R14 — [UI] Toggle, edit, delete, clear-completed wired to logic.** Each control
    invokes the corresponding `src/todos.js` function and re-renders. *Verification:*
    manual check; the underlying behavior is already proven by R4–R7.

15. **R15 — [UI] Filter controls.** All / Active / Completed controls switch the
    visible set via `filterTodos`; exactly one is active at a time. *Verification:*
    manual check.

16. **R16 — [UI] Remaining count displayed.** The UI shows `remainingCount(list)` of
    active items (e.g. "N items left"). *Verification:* manual check.

17. **R17 — [UI] Persistence to localStorage.** On every state change the current list
    is serialized to `localStorage` under a single fixed key
    (`todo-1.todos`). On load, the app reads that key, `JSON.parse`s it inside a
    try/catch, and passes the result through `sanitizeTodos` (R12) before use. A
    parse error or missing key yields an empty list, never a crash. *Verification:*
    manual reload check; corrupt-data handling is proven at the logic level by R12.

18. **R18 — [UI] Text rendered as an escaped text node only.** Todo text is rendered
    through React's default JSX interpolation (`{todo.text}`) as a text node, which
    React escapes. The app MUST NOT (a) use `dangerouslySetInnerHTML` anywhere, or
    (b) interpolate todo text into a URL/`href`/`src` attribute, an inline event
    handler, or a `style`/CSS context. *Verification:* grep confirms no
    `dangerouslySetInnerHTML` and no todo-text interpolation into href/src/style sinks;
    manual check that input like `<img src=x onerror=...>` renders as literal text.
    (Bounds INV5.)

## Non-goals

- No backend, server, API, database, or network request of any kind.
- No authentication, accounts, multi-user, or sync across devices/tabs.
- No cross-tab live synchronization (two open tabs may diverge until reload; last
  write to `localStorage` wins — see invariants).
- No drag-and-drop reordering, due dates, priorities, tags, categories, or sub-tasks.
- No undo/redo, no edit history.
- No internationalization, theming, or accessibility audit beyond using native form
  controls (a11y is encouraged but not a gated requirement here).
- No automated browser/E2E test harness is required by this spec; UI requirements are
  verified manually unless a component-test harness is added separately.
- No duplicate-text prevention: two todos may share identical `text`. Only `id` is
  required unique.

## Failure modes & invariants

Invariants — these must hold for every operation and must never be violated:

- **INV1 — Schema integrity.** Every todo in any list produced by the logic module
  has exactly `{ id: non-empty string, text: non-empty string, completed: boolean }`.
  Empty-text and malformed todos never enter the list (enforced by R3, R12).
- **INV2 — Unique ids.** No list produced by the module contains two todos with the
  same `id`. New ids are caller-supplied and `addTodo` rejects an id already present
  (R2); on load, collisions are collapsed (R12).
- **INV3 — No mutation.** Logic functions never mutate inputs (R11).
- **INV4 — No crash on bad storage.** Malformed, truncated, or non-JSON
  `localStorage` content results in an empty list, never an unhandled exception (R12,
  R17).
- **INV5 — No HTML injection via the enforced sinks.** Todo text reaches the DOM only
  as a React text node, which React escapes, so text cannot be parsed as markup. This
  invariant is bounded to what the spec actually enforces: (a) `dangerouslySetInnerHTML`
  is not used anywhere; (b) todo text is not interpolated into a URL/`href`/`src`
  attribute, an inline event handler, a `style`/CSS context, or any other
  non-text-node sink. The spec does not claim "XSS is impossible" in general — it
  claims these specific injection sinks are absent or escaped (R18).
- **INV6 — In-memory state is the source of truth; persistence is best-effort.** The
  authoritative todo list is the React in-memory state. After each successful state
  change the app *attempts* to serialize the current list to `localStorage`, but a
  persist may fail or be skipped (quota exceeded, private mode, storage disabled — see
  R17) without affecting correctness of the running session. The spec therefore does
  not guarantee that `localStorage` always equals the in-memory list; it guarantees
  only that (a) the app never crashes when a write fails, and (b) whatever is
  persisted is a serialize of a whole, consistent list, never a partially-applied
  operation.

Failure modes and required handling:

| Failure mode | Required behavior | Covered by |
|---|---|---|
| `localStorage` value is not valid JSON | catch parse error → empty list | R17, INV4 |
| `localStorage` value is valid JSON but wrong shape (object, number, array of junk) | `sanitizeTodos` drops invalid entries → valid list | R12, INV1 |
| Duplicate ids present in stored data | keep first, drop rest | R12, INV2 |
| Empty / whitespace-only add or edit | no-op (list unchanged) | R3, R5 |
| Very long text (e.g. 10k+ chars) | accepted as-is; no truncation, no crash; stored verbatim | R3 (note below) |
| Todo text containing HTML/JS (`<script>`, `onerror`) | rendered as inert literal text | R18, INV5 |
| Operation targeting a non-existent `id` | no-op, list returned unchanged | R4, R5, R6 |
| `localStorage` unavailable or write throws (quota/private mode) | catch the error; app continues in-memory for the session without crashing | R17 (note below) |

Notes:
- **Very long text** is explicitly *not* length-limited by this spec. If the adversary
  argues a max length is needed, that is an Open Question (Q1), not a silent default.
- **localStorage write failure** (quota exceeded / disabled): the app must not crash;
  it degrades to in-memory-only for the session. Persistence is best-effort.

## Open questions

1. **Q1 — Max text length?** Should there be an upper bound on todo text length (to
   bound storage and rendering cost)? Default in this spec: no limit. Resolve before
   plan gate if a bound is desired.
2. **Q2 — Storage key namespace.** This spec fixes the key as `todo-1.todos`. If a
   different naming convention is preferred for the repo, set it now.
3. **Q3 — Empty-edit semantics.** This spec treats an edit-to-empty as a no-op (text
   preserved). An alternative is "edit to empty deletes the todo" (common in TodoMVC).
   Default chosen: no-op. Confirm or override.
4. **Q4 — Component-test harness.** UI requirements (R13–R18) are verified manually by
   default. If the verifier should prove them automatically, a React testing harness
   (e.g. @testing-library/react + jsdom) must be added — out of scope unless approved.
