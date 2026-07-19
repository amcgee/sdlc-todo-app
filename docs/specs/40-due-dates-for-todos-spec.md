# ISSUE-40 - Due dates for todos - Technical Spec & Implementation Plan

Ratified design: [docs/specs/40-due-dates-for-todos.md](./40-due-dates-for-todos.md)
Branch: claude/sdlc-issue-40

---

## PART I - SPEC (what & the contract)

### Problem statement

A todo is `{id, text, completed}` today; it cannot say *when* something is due. This adds an
optional **due date** per todo, carried additively through the existing whole-list contract on both
runtimes: a user sets/clears a calendar day on a row from edit mode (staged like the text, committed
together on Save), sees a relative "time left" label and a row highlight on past-due active items,
and can toggle a soonest-first sort. Undated items behave exactly as before.

### Definitions (normative)

- **Due date** - a calendar day encoded as a `"YYYY-MM-DD"` string, or `null` for "no date". No
  time-of-day, no timezone. ISO date strings sort lexically = chronologically, so the pure core
  compares/orders them with plain string ops and never parses a `Date` or reads the clock.
- **Todo shape** - `{id, text, completed, dueDate}` where `dueDate` is a valid `"YYYY-MM-DD"` string
  or `null`. `dueDate` rides the wire (JSON) as camelCase; the SQL column is `due_date`.
- **today** / **`todayLocal()`** - the user's **local** calendar day as a `"YYYY-MM-DD"` string,
  built in the UI layer from *local* `Date` components - `getFullYear()`, `getMonth()+1`, `getDate()`,
  each zero-padded - and **never** `toISOString()` (which is UTC and would report tomorrow's date for
  the last hours of each local day in behind-UTC zones, mislabeling a due-today item as overdue). It is
  threaded into the pure overdue test (mirrors how `makeId` receives its randomness); the core reads no
  clock.
- **Valid due date** (`isValidDueDate`) - a value that is `typeof value === 'string'` **and** matches
  `^\d{4}-\d{2}-\d{2}$` **and** is a real calendar day (round-trips through `Date.UTC`, so
  `2026-02-30`/`2026-13-01` are invalid). The `typeof` guard is load-bearing: without it a
  `String()`-coercible non-string (e.g. `['2026-07-20']`) would pass the regex. This one predicate is
  the single home of the rule.
- **Relative due label** (`dueDateLabel(dueDate, today)`) - a short, human-readable string describing
  a due date relative to `today` (both `"YYYY-MM-DD"`), or `null` when `dueDate` is `null`. Bucketed by
  the whole-day difference (`diff`, computed via `Date.UTC` day arithmetic - no local `Date` parsing):
  `diff === 0` -> `"due today"`; `diff === 1` -> `"due tomorrow"`; `diff > 1` -> `` `in ${diff} days` ``;
  `diff === -1` -> `"yesterday"`; `diff < -1` -> `` `${-diff} days ago` ``. The negative buckets' past-
  tense phrasing is the label's non-color-alone signal when the row is also overdue.

### Requirements (each names a falsifying test)

- R1. The todo shape gains `dueDate` (`"YYYY-MM-DD"` | `null`) and it round-trips through the
  whole-list GET/PUT unchanged on **both** backends. Falsify: PUT a list containing
  `{id,text,completed,dueDate:"2026-07-20"}`, GET returns it verbatim - proven in `tests/handler.test.js`
  (in-memory store) and `tests/cloud/worker-contract.test.js` (D1).
- R2. Both storage schemas carry `due_date` identically: the Bun inline schema (fresh DB via
  `CREATE TABLE`, existing DB via an idempotent `ADD COLUMN`) and the D1 migration `0002_due_date.sql`.
  Falsify: a Bun DB created under the old 4-column schema gains `due_date` on next boot and round-trips
  a date; the cloud round-trip (R1) proves D1 parity. A schema that persists the date on one runtime
  but not the other fails.
- R3. `isConformingList` accepts `dueDate` absent, `null`, or `isValidDueDate`; rejects any other type
  or a malformed date string (400). Falsify (`tests/handler.test.js`): PUT items with `dueDate` =
  omitted / `null` / `"2026-07-20"` -> 200; with `5` or `"banana"` -> 400 "bad request".
- R4. `sanitizeTodos` treats missing/`null`/malformed `dueDate` as `dueDate:null` and **never drops**
  the item; a valid date is preserved. Falsify (`tests/todos.test.js`): sanitize
  `[{id:'a',text:'x',completed:false,dueDate:'nope'},{id:'b',text:'y',completed:false,dueDate:'2026-07-20'}]`
  -> `[{...a,dueDate:null},{...b,dueDate:'2026-07-20'}]` (both kept).
- R5. `isValidDueDate(value)` is strict and requires an actual string. Falsify (`tests/todos.test.js`):
  `'2026-07-18'` -> true; `'2026-02-30'`, `'2026-13-01'`, `'2026-7-1'`, `'today'`, `null`, `5`,
  `''` (empty), `'2026-07-18T00:00'` (time component), `' 2026-07-18 '` (surrounding space), and
  `['2026-07-20']` (a non-string whose `String()` matches the regex - proves the `typeof` guard) ->
  all false.
- R6. `setDueDate(list, id, dueDate)` sets a valid date, clears on `null`, coerces an invalid value to
  `null`, no-ops a non-matching id, and never mutates its input. Falsify (`tests/todos.test.js`):
  set -> item's `dueDate` updated; `null` -> cleared; `'bad'` -> `null`; unknown id -> list returned
  unchanged; original array/objects unmodified.
- R7. `isOverdue(todo, today)` is true iff `dueDate != null`, `!completed`, and `dueDate < today`
  (strictly before). Falsify (`tests/todos.test.js`): `('2026-07-17',today='2026-07-18',active)` ->
  true; due-today `'2026-07-18'` -> false; future -> false; `dueDate:null` -> false; past **but
  completed** -> false.
- R8. `sortByDueDate(list)` returns a new array: dated items ascending by date (overdue therefore
  first), undated items last, relative order preserved among undated items and among equal dates;
  input not mutated. Falsify (`tests/todos.test.js`) via the oracle table below.
- R9. Entering edit mode (Edit button or double-click text) reveals a date `<input type="date">`
  alongside the text field and replaces that row's **Edit**/**Delete** buttons with **Save**/
  **Cancel**; an ordinary row shows no date input. Both the text and the date are staged drafts:
  changing either persists nothing by itself. **Save** (or Enter on the text field) commits both
  drafts together as one PUT; **Cancel** (or Escape) discards both, reverting to the row's original
  text and date with nothing persisted. Losing focus - clicking elsewhere, tabbing between the two
  fields - commits or cancels nothing. Falsify (`tests/App.duedate.test.jsx`): an ordinary row has no
  date `<input>`; entering edit mode reveals one; changing it issues no PUT; clicking Save issues
  exactly one PUT carrying both the text and the new `dueDate`, even when only the date changed;
  clicking Cancel after changing the date leaves the stored date unchanged with zero PUTs; a blur
  between the text and date fields, or toward anywhere else, commits or cancels nothing.
- R10. Outside edit mode, a dated item shows `dueDateLabel(dueDate, today)` as its label; an undated
  item shows no label. A past-due **active** item's row additionally gets a highlight (a background
  class distinct from the ordinary row), and its label is the past-tense bucket - never the literal
  word "Overdue". Completing it, clearing its date, or a due-today/future/undated item shows no
  highlight. Falsify (`tests/App.duedate.test.jsx`): a row with a past `dueDate` and `completed:false`
  carries the highlight class and a past-tense label ("yesterday"/"N days ago"), and the literal string
  "Overdue" appears nowhere in the document; toggling it complete removes the highlight; a future-dated
  row shows a future-tense label ("in N days") with no highlight; an undated row shows no label.
- R11. A user-toggled sort control orders the rendered list soonest-first when on and restores the
  default (position) order when off; sorting is **view-only** and issues no PUT. Falsify
  (`tests/App.duedate.test.jsx`): toggle on -> rendered order equals `sortByDueDate(visible)`; toggle
  off -> original order; neither toggle triggers `saveTodos`.
- R12. A list stored **before** this feature (rows with no `due_date`) loads and renders with zero
  errors, no highlighted rows, and no load-triggered PUT. Falsify (`tests/App.duedate.test.jsx`):
  mount with a legacy list (items lacking `dueDate`) -> all items render undated with no label or
  highlight, no `saveTodos` fires on hydration.
- R13. `todayLocal()` reads the **local** calendar day from local `Date` components (never
  `toISOString()`/UTC) - this is the feature's one clock read, so it is pinned directly. Falsify
  (`tests/App.duedate.test.jsx`, deterministic via `vi.useFakeTimers()` + `vi.setSystemTime(...)` under
  a fixed `TZ` like the undo fake-timer tests): with `TZ=America/New_York` and the system clock at
  `2026-07-18T02:00:00Z` (local `2026-07-17 22:00`), `todayLocal()` returns `'2026-07-17'`; a
  `toISOString().slice(0,10)` implementation returns `'2026-07-18'` and fails this test.
- R14. `dueDateLabel(dueDate, today)` returns `null` for `dueDate:null`, and for a dated item buckets
  the whole-day difference per the Definitions entry above. Falsify (`tests/todos.test.js`):
  `today='2026-07-18'` with `dueDate` = `null` -> `null`; `'2026-07-18'` -> `"due today"`;
  `'2026-07-19'` -> `"due tomorrow"`; `'2026-07-21'` -> `"in 3 days"`; `'2026-07-17'` -> `"yesterday"`;
  `'2026-07-13'` -> `"5 days ago"`.

`sortByDueDate` oracle (proving R8; `~` = undated, dates abbreviated):

| input (id:date) | result order |
|---|---|
| `A:07-17, B:~, C:07-15, D:~` | `C, A, B, D` |
| `A:~, B:~` | `A, B` (order preserved) |
| `A:07-15, B:07-15` | `A, B` (equal dates stable) |

### Non-goals

- No reminders/notifications, no recurring dates, no time-of-day/timezone (date-only, local calendar day).
- **No filter-by-due/overdue** - the label + highlight + sort meet the stated need; a dedicated
  filter is a candidate for a future, separate change. The All/Active/Completed filter is unchanged.
- No server-side sorting or persisted sort order - sort is a client view toggle, like the filters; the
  stored list stays position-ordered and the ordering contract is untouched.
- No change to the 10-item list cap or 32-char item cap; a `dueDate` change never grows the list.
- No calendar/timeline view; the date lives inline on the existing row.

### Failure modes & invariants

- INV-PARITY. Both backends persist and marshal `due_date` identically: the shared `isConformingList`
  gate (one copy) plus parallel `readAll`/`replaceAll` marshalling (`due_date` column <-> `dueDate`
  field, `null` when the column is null). The cloud contract test (R1/R2) is the drift guard.
- INV-PURE. The core reads no clock: `today` and the id randomness are injected from the UI;
  `isValidDueDate` uses deterministic `Date.UTC` arithmetic (no `Date.now`), preserving the core's
  nondeterminism-free posture.
- INV-SINGLE-RULE. `isValidDueDate` is defined once in `src/todos.js` and imported by
  `server/handler.js` (allowed by architecture rule 3), so the client sanitize path and the server
  shape gate cannot diverge on what "a valid date" means.
- FM-LEGACY. A missing/`null`/malformed date never drops an item: `sanitizeTodos` degrades it to
  `null` (client load), and any garbage that reaches storage is coerced on the next load. Legacy rows
  read back `due_date = null`.
- FM-COMPLETED. A completed item is never overdue - `isOverdue` guards on `!completed`, so no visual
  "overdue" state survives completion.
- FM-STAGED-EDIT. Neither the text nor the date draft is persisted until Save; Cancel (or abandoning
  the edit) discards both with nothing to revert server-side. Save applies both as one PUT, so a row
  is never left half-committed. Setting/clearing a date is otherwise an ordinary list mutation that
  dismisses any pending Undo and is not itself undoable; it preserves list length, so the ISSUE-35
  growth rule is unaffected on a legacy over-cap list.

---

## PART II - PLAN (how the builder implements it)

### Chosen approach and why

Encode the date as a nullable `"YYYY-MM-DD"` string on the **existing** whole-list contract - purely
additive. ISO strings sort lexically = chronologically, so overdue (`dueDate < today`) and
soonest-first sort are plain string operations in the pure core with no `Date` parsing and no clock
read; `today` is threaded in from the UI exactly as `makeId` receives its randomness. A single
`isValidDueDate` predicate lives in `src/todos.js` and is imported by both the client sanitize path
and the server `isConformingList` gate, so "what is a valid date" is defined once and cannot drift
between runtimes. Sort is a client view toggle (like the filters), leaving the stored order and the
ordering contract untouched. The date field is a staged edit-mode draft exactly like the text field,
so Save/Cancel govern the whole row atomically and there is no implicit commit-on-blur to get wrong.

Rejected: **epoch/number timestamps** (force timezone handling, lose date-only semantics, and are
opaque at rest - the ISO string is both human-readable and lexically sortable). A **date-picker
library** (native `<input type="date">` is date-only, locale-aware, and zero-dependency, matching the
app's no-extra-dep posture). **Server-side sort / persisted sort order** (adds contract surface a
view toggle already satisfies - scope creep). A **new module for `isValidDueDate`** (architecture
rule 3 lets `handler.js` import only `src/limits.js`/`src/todos.js`; `todos.js` is the sanctioned pure
home). **Persisting the date immediately on change** (mismatches the row's explicit Save/Cancel
contract and reintroduces the interaction hazard staging was meant to close).

### Files to touch

- **`src/todos.js`** - add five pure exports and extend one:
  - `isValidDueDate(value)` -> boolean (regex + `Date.UTC` round-trip).
  - `setDueDate(list, id, dueDate)` -> new list; coerces non-valid `dueDate` to `null`; non-matching
    id is a no-op.
  - `isOverdue(todo, today)` -> `todo.dueDate != null && !todo.completed && todo.dueDate < today`.
  - `sortByDueDate(list)` -> new array: partition dated/undated, stable-sort dated ascending by
    `dueDate`, then append undated in original order (guarantees R8's stability without relying on the
    engine's sort stability across keys).
  - `dueDateLabel(dueDate, today)` -> `null` | string, bucketed per the Definitions entry (R14). Whole-day
    `diff` via `(Date.UTC(...dueDate parts) - Date.UTC(...today parts)) / 86400000`, no local `Date`.
  - `sanitizeTodos` - add a coercion step: `dueDate = isValidDueDate(el.dueDate) ? el.dueDate : null`;
    emit `dueDate` on every returned item; item is never dropped for a bad date.
- **`server/handler.js`** - `import { isValidDueDate }` from `../src/todos.js`; in `isConformingList`
  accept `el.dueDate` when `=== undefined`, `=== null`, or `isValidDueDate(el.dueDate)`, else return
  false. (No other handler logic changes; `dueDate` flows through `replaceAll` untouched.)
- **`server/index.js`** - `CREATE TABLE` gains `due_date TEXT` (nullable); after it, an idempotent
  column-add for existing DBs (probe `PRAGMA table_info(todos)`; `ALTER TABLE todos ADD COLUMN
  due_date TEXT` if absent). `selectAll` and the insert statement carry `due_date`; `readAll` returns
  `dueDate: row.due_date ?? null`; `replaceAll` binds `t.dueDate ?? null`.
- **`worker/index.js`** - the D1 `readAll` SELECT and `replaceAll` INSERT carry `due_date`; same
  marshalling (`dueDate: row.due_date ?? null`, bind `t.dueDate ?? null`).
- **`migrations/0002_due_date.sql`** - `ALTER TABLE todos ADD COLUMN due_date TEXT;`
- **`src/App.jsx`**:
  - `todayLocal()` UI helper returning local `"YYYY-MM-DD"` built from local date components
    (`getFullYear()`/`getMonth()+1`/`getDate()`, zero-padded), **not** `toISOString()`.
  - `sortByDate` boolean state + a toggle control (near the filter row, `aria-pressed`, non-color-alone
    like the filter cue); `visible` becomes `sortByDate ? sortByDueDate(filterTodos(todos, filter)) :
    filterTodos(todos, filter)`.
  - `editDueDate` state mirrors `editText`: `startEdit(todo)` seeds both from the row's current text
    and `dueDate`. The date `<input type="date">` in edit mode is wired to `setEditDueDate` only - it
    never calls `setTodos` directly. `commitEdit(id)` applies both drafts to the todo in **one**
    `setTodos` call (composing `editTodo` and `setDueDate`, which touch disjoint fields), so Save is
    exactly one PUT; the text-blank-no-op guard (R5, ISSUE-35) applies to the text half only, and the
    date half always applies so a date-only change still saves. `cancelEdit()` discards both drafts;
    neither was ever persisted, so there's nothing to revert. `finalizeUndo()` fires on commit when
    either the text or the date actually changed from the row's original values.
  - While editing, the row's **Edit**/**Delete** buttons are replaced by **Save** (`commitEdit`) and
    **Cancel** (`cancelEdit`); `Enter` on the text field still calls `commitEdit` and `Escape` still
    calls `cancelEdit`, as shortcuts alongside the buttons. No blur handler commits or cancels anything.
  - Outside edit mode, render `dueDateLabel(todo.dueDate, todayLocal())` as a small text span when
    non-null (nothing when `null`). When `isOverdue(todo, todayLocal())`, the row's `<li>` gains a
    highlight class (a subdued background distinct from the ordinary row and from the completed
    strikethrough state) - no literal "Overdue" text anywhere.

Wiring the builder can't infer: the Bun idempotent `ADD COLUMN` is required because `CREATE TABLE IF
NOT EXISTS` leaves an existing `data/todos.sqlite` on the old 4-column schema - the D1 side gets this
from the migration, the Bun side needs the explicit probe-and-add.

### Architecture impact

None. No new container and no changed dependency rule: `server/handler.js` importing `isValidDueDate`
from `src/todos.js` is already permitted by rule 3 (handler may import the pure `src/todos.js`). No
ADR or `scripts/check-architecture.mjs` change is required.

### Docs impact

- visual: `due-dates` scene shows a working list with dated rows' relative labels ("in N days" /
  "yesterday" / etc.), a highlighted row for the past-due active item (no "Overdue" word), and the
  sort-by-date toggle. `editing-todo` scene shows one row driven into edit mode (a new still-scene
  action type `{"type": "edit", "match": "<row text>"}`, mirroring the existing `"delete"` action),
  with the text field, date field, and Save/Cancel buttons together - the only way a user ever sees
  the date input. **Scene determinism:** `scripts/screenshots.mjs` seeds `scene.todos` and renders the
  real app, and pins the page's `Date`/`Date.now()` via Playwright's `page.clock.setFixedTime(...)` to
  one constant timestamp before any capture (this only fixes what `new Date()` returns; it does not
  touch `setTimeout`/`setInterval`, so timer-driven scenes like the Undo window are unaffected). The
  `due-dates` scene's seed dates are chosen relative to that fixed timestamp so its rendered labels are
  exact and stable forever - a relative, day-counting label is a stronger clock dependency than a plain
  overdue boolean, since a fixed past date would otherwise produce different label text every day.
- docs: `managing-todos.md`'s "Edit" and "Due dates" sections describe the staged text/date drafts,
  Save/Cancel, the relative label, and the row highlight; `README.md`'s feature line and the
  `src/todos.js` export list include `dueDateLabel`.

### Test strategy - what the verifier must prove

- **`tests/todos.test.js`** (pure): `isValidDueDate` (R5), `setDueDate` set/clear/coerce/no-op/no-mutate
  (R6), `isOverdue` boundary + completed suppression (R7), `sortByDueDate` oracle table + no-mutate
  (R8), `sanitizeTodos` due-date tolerance keeping the item (R4), `dueDateLabel` bucket boundaries (R14).
- **`tests/handler.test.js`**: `isConformingList`/PUT accepts absent/`null`/valid `dueDate` (200) and
  rejects a malformed or wrong-typed one (400), and a valid `dueDate` round-trips through the in-memory
  store (R1/R3).
- **`tests/App.duedate.test.jsx`** (new, happy-dom): the date input is edit-mode-only and staged -
  changing it issues no PUT, Save commits text+date together as one PUT, Cancel discards the draft with
  zero PUTs (R9); relative-label and row-highlight presence/absence across past-active/completed/
  future/undated, with "Overdue" asserted absent everywhere (R10); sort toggle reorders the view and
  issues no PUT, reversible (R11); a legacy list (items with no `dueDate`) renders undated with no
  hydration PUT (R12); `todayLocal()` pinned under a fixed clock/TZ (R13).
- **`tests/cloud/worker-contract.test.js`**: extend the round-trip case to include an item with a
  `dueDate`, proving D1 persists and returns it (R1/R2 D1 half).
- **`tests/integration/legacy-schema.test.js`**: seed a DB on the old 4-column schema and assert the
  boot-time `ADD COLUMN` makes a `dueDate` round-trip on Bun (R2 Bun half).
