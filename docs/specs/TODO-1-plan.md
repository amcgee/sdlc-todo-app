# PLAN — TODO-1: React TODO application

Status: draft (awaiting plan gate)
Owner: architect
Implements: docs/specs/TODO-1.md (ratified). This plan implements that spec and only
that spec; anything not in the ratified spec is out of scope for the builder.

Resolved spec defaults this plan builds to (the gate opened on these): Q1 no length
limit; Q2 storage key `todo-1.todos`; Q3 empty-edit is a no-op; Q4 UI requirements
(R13–R18) verified manually, no component-test harness added.

## 1. Chosen approach and why

**Approach: a pure functional core + a thin React shell + a tiny isolated storage
adapter.**

- `src/todos.js` is the **pure functional core** (R1–R12). Every list operation is a
  pure function `(list, …) -> newList` (or a scalar for `remainingCount`). No globals,
  no `localStorage`, no clock, no id generation. This is the single unit under
  `node:test`.
- `src/App.jsx` is a **thin React shell**. It holds the list in `useState`, calls core
  functions in event handlers, generates ids, and renders. It contains no list-mutation
  logic of its own — it only routes events to the core and renders the result.
- `src/storage.js` is a **thin side-effect boundary**: the only module that *names*
  `localStorage`. Its job is reduced to (a) reading/writing the raw string and (b)
  delegating every decision to pure, testable helpers in the core. All recovery logic
  (bad-JSON → empty list, write-throw → swallow) lives as pure functions in
  `src/todos.js` so the verifier can prove it under `node:test` without a browser
  (closes F6/F9). This keeps `storage.js` a near-trivial adapter — the only untestable
  residue is the literal `localStorage.getItem/setItem` calls themselves.

Why this split: the spec's central architectural constraint (R1, "pure,
dependency-free, Node-importable") and its testability claim ("verifier unit-tests the
logic with plain Node") are only satisfiable if the logic has zero browser/React
coupling. A pure core with the impurity pushed to the edges (App + storage) is the
smallest design that makes INV1–INV3 unit-provable and INV4 mostly provable at the
logic layer.

### Alternatives rejected

- **Logic inside React (hooks/reducer in App.jsx).** Rejected: violates R1 — the logic
  could not be imported and tested under plain `node:test` without a DOM/React. Directly
  contradicts the spec's testability requirement.
- **`useReducer` with the reducer in `todos.js`.** Tempting, but a reducer couples the
  core to an action-object protocol the spec never asks for. The spec names discrete
  functions (`addTodo`, `toggleTodo`, …); matching those names keeps the core's test
  surface 1:1 with the requirements. Rejected as unnecessary indirection (scope creep).
- **A state-management library (Redux/Zustand) or a persistence library.** Rejected:
  the spec is explicitly client-only and minimal; a dependency would also threaten R1's
  "dependency-free" claim for the core. No third-party runtime deps beyond React/Vite.
- **Storage logic merged into App.jsx (no `storage.js`).** Workable, but it widens the
  impure surface inside the component and makes the try/catch + sanitize path harder to
  audit against INV4/R17. A ~30-line adapter is the cheaper, clearer option.
- **TypeScript.** Out of scope; the spec and repo are plain JS. Not adding a type
  toolchain for a simple app. (INV1 schema integrity is enforced at runtime by the core,
  not by types.)

## 2. Module format (ESM) — how App.jsx/Vite and node:test consume the same file

Single source, single module system: **`src/todos.js` is authored as native ESM**
(`export function addTodo(...)`, etc.) with **no React, JSX, or browser references**.

- **Vite/React side:** `App.jsx` does `import { addTodo, … } from './todos.js'`. Vite
  consumes ESM natively. No build-specific syntax is used in `todos.js`, so it is just a
  plain `.js` ESM module.
- **node:test side:** the test files do `import { addTodo, … } from '../src/todos.js'`
  and run under `node --test`. To make Node treat `.js` as ESM, the project's root
  `package.json` declares `"type": "module"`. This is the standard Vite default and
  costs nothing extra.
- **Net:** one physical module, one module system (ESM), imported identically by Vite
  and by Node's test runner. No transpile step, no dual-package hazard, no `.mjs`/`.cjs`
  split. The verifier imports the exact bytes the app ships.

Note for the builder: `todos.js` must contain **only** ESM that Node can execute
directly — no JSX, no `import.meta.env`, no Vite-only globals. That keeps R1's
"Node-importable" guarantee literally true.

## 3. File layout the builder will create

```
package.json            # "type": "module"; scripts: dev, build, preview, test
                        #   test → "node --test tests/"
                        #   deps: react, react-dom ; devDeps: vite, @vitejs/plugin-react
vite.config.js          # @vitejs/plugin-react; nothing exotic
index.html              # Vite entry; <div id="root">; <script type="module" src="/src/main.jsx">
src/
  main.jsx              # ReactDOM.createRoot(...).render(<App />)
  App.jsx               # thin React shell (R13–R18): state, handlers, id gen, render
  todos.js              # PURE core (R1–R12): addTodo, toggleTodo, editTodo, deleteTodo,
                        #   clearCompleted, filterTodos, remainingCount, sanitizeTodos,
                        #   parseStored(raw)  -> list (never throws; bad JSON -> [])   [F6]
                        #   safeSave(writer, list) -> bool (swallows writer throw)     [F9]
                        #   makeId(seq, rand) -> collision-resistant string id          [F7]
                        #   plus a small internal normalizeText helper (trim)
  storage.js            # side-effect boundary: loadTodos(), saveTodos(list)
                        #   wraps localStorage in try/catch; uses sanitizeTodos on load
  index.css            # minimal styling (optional, non-gated)
tests/
  todos.test.js         # node:test suite against src/todos.js (R1–R12, INVs, findings)
```

No other files. No test harness for the DOM (Q4 default). `index.css` is cosmetic and
carries no requirement.

### Shape of each change

- **`src/todos.js`** — exports the eight functions named in R2–R12. Internals:
  - a private `normalizeText(t)` = `String(t).trim()` used by `addTodo`, `editTodo`,
    and `sanitizeTodos` so the trim-then-validate rule lives in exactly one place.
  - `addTodo(list, text, id)`: validate `id` is a non-empty string and not already in
    `list`; normalize text; if id invalid/duplicate or text empty → return `list`
    unchanged; else return `[...list, { id, text, completed: false }]`.
  - `toggleTodo/editTodo/deleteTodo`: map/filter producing a new array; non-matching id
    → return a new array equal to input (or input itself) with no change. `editTodo`
    applies normalize-then-empty-check (no-op on empty).
  - `clearCompleted`: `list.filter(t => !t.completed)`.
  - `filterTodos(list, filter)`: switch on `"active"`/`"completed"`, default → all.
  - `remainingCount`: `list.filter(t => !t.completed).length`.
  - `sanitizeTodos(raw)`: implements R12's exact 5-step ordered pipeline.
  All functions construct new objects/arrays; never mutate inputs (INV3).
- **`src/todos.js` (new pure helpers — the recovery logic moved here):**
  - `parseStored(raw)`: takes the raw string (or `null`) read from storage; returns a
    valid Todo list. Internally `try { return sanitizeTodos(JSON.parse(raw)) } catch
    { return [] }`, with `raw == null` (missing key) → `[]`. **Never throws.** This is
    the INV4 crash-recovery path, now pure and `node:test`-importable (F6).
  - `safeSave(writer, list)`: takes an injected writer function
    `writer(serialized: string)` and the list; does
    `try { writer(JSON.stringify(list)); return true } catch { return false }`. The
    swallow-on-throw behavior (INV6) is now provable by injecting a throwing writer —
    no `localStorage` needed (F9). `safeSave` itself never throws.
  - `makeId(seq, rand)`: returns a collision-resistant string id (see F7 below); pure
    given its `(seq, rand)` arguments, so it is testable for uniqueness/format.
- **`src/storage.js`** (now a trivial adapter):
  - `KEY = 'todo-1.todos'` (single fixed key, R17/Q2).
  - `loadTodos()`: `return parseStored(localStorage.getItem(KEY))`. The only impure
    line is `getItem`; all recovery logic is in the tested `parseStored`.
  - `saveTodos(list)`: `return safeSave((s) => localStorage.setItem(KEY, s), list)`.
    The only impure line is `setItem`; the swallow logic is the tested `safeSave`.
  - This shrinks the untestable surface to two literal `localStorage` calls, which
    carry no branching logic to get wrong.
- **`src/App.jsx`** —
  - state: `todos` (init from `loadTodos()`), `filter` (`'all'` default), `draft` input
    text, and per-row editing state.
  - id generation: `App.jsx` calls the pure, testable `makeId(seq, rand)` from `todos.js`
    (F7). Scheme: prefer `crypto.randomUUID()` when available; otherwise build a
    collision-resistant string from `makeId(seq)`. `makeId` is defined as
    `` `${Date.now().toString(36)}-${seq.toString(36)}-${rand}` `` where `seq` is a
    monotonically-increasing per-session counter App.jsx threads in, and `rand` is a
    short random suffix (e.g. from `crypto.getRandomValues`, or supplied to keep the
    function pure/testable). Combining a per-session counter with a random suffix makes
    same-millisecond and across-reload collisions vanishingly unlikely; `makeId` is
    pure given (`seq`, `rand`) so its format/uniqueness is unit-testable.
    **Residual risk (named):** id generation is best-effort, not a cryptographic
    uniqueness guarantee. The hard backstop is INV2 enforcement in the core — but note
    that `addTodo` *no-ops* on a duplicate id, so a (vanishingly rare) collision would
    silently drop the user's new todo rather than corrupt state. This is the chosen
    fail-safe-but-silent behavior; a louder failure (surface an error to the user) is
    out of scope for this spec and recorded here as the known residual.
  - a single `useEffect([todos])` calls `saveTodos(todos)` on every change (R17).
  - handlers call the core and `setTodos(...)`. Visible list = `filterTodos(todos,
    filter)`; "N items left" = `remainingCount(todos)`.
  - rendering: todo text via `{todo.text}` only; edit uses a controlled `<input>`. No
    `dangerouslySetInnerHTML`; text never placed in href/src/style/event-handler sinks
    (R18/INV5).
- **`src/main.jsx`** — standard Vite React bootstrap; no logic.

## 4. Where each invariant / failure mode is handled

| Spec item | Handled in design at… |
|---|---|
| **INV1 schema integrity** | `todos.js`: `addTodo` rejects empty text; `editTodo` no-ops on empty; `sanitizeTodos` drops malformed/empty-text elements. Only `{id,text,completed}` objects are ever constructed. |
| **INV2 unique ids** | `todos.js`: `addTodo` no-ops when `id` already in `list`; `sanitizeTodos` de-dups keeping first. App generates fresh ids but the core is the enforcement point. |
| **INV3 no mutation** | `todos.js`: every function returns new arrays/objects (spread/map/filter); never assigns into inputs. |
| **INV4 no crash on bad storage** | `todos.js parseStored(raw)` (pure, node:test-covered): try/catch around `JSON.parse` + `sanitizeTodos`, `null`→`[]`; always returns a valid list, never throws. `storage.js loadTodos` is a one-line wrapper over it. (F6) |
| **INV5 XSS sinks** | `App.jsx`: text rendered only as `{todo.text}` text node; ban on `dangerouslySetInnerHTML`; no todo text in url/href/src/style/event-handler. |
| **INV6 best-effort persistence** | `todos.js safeSave(writer, list)` (pure, node:test-covered via injected throwing writer) swallows write failures and returns false; `storage.js saveTodos` wraps it with the real `setItem`. In-memory `todos` is authoritative; the effect serializes the whole list (never a partial op). (F9) |
| **dup-id (F1/F7)** | `todos.js addTodo` duplicate-id no-op (silent fail-safe); `sanitizeTodos` step 5 de-dups; `makeId` gives collision-resistant ids upstream. Residual: a collision silently drops the new todo (named in §3). |
| **trim-then-validate (F3)** | `todos.js normalizeText` used before the empty check in `addTodo`, `editTodo`, and `sanitizeTodos` step 3. |
| **completed coerce (F2)** | `todos.js sanitizeTodos` step 4: `completed === true ? true : false`; element kept regardless. |
| **malformed localStorage** | `storage.js` try/catch (parse) + `sanitizeTodos` (shape). |
| **non-existent id ops** | `todos.js` toggle/edit/delete return list unchanged when no id matches. |
| **empty/whitespace add or edit** | `todos.js addTodo`/`editTodo` no-op via normalize+empty check. |
| **very long text** | no length check anywhere (Q1 default = no limit); stored/rendered verbatim. |
| **localStorage write throws** | `storage.js saveTodos` catch block. |

## 5. Test strategy (what the verifier must prove)

All automated tests are `node:test` in `tests/todos.test.js`, run via `node --test`,
importing `../src/todos.js`. They must fail against a naive implementation and pass
against the spec'd one. UI items R13–R18 are verified manually per Q4 (a manual
checklist is recorded, not automated).

### Core function behavior (R2–R9)
- **addTodo:** fresh id appends (length+1, element last); stored text trimmed
  (`"  hi  "` → `"hi"`); input not mutated.
- **toggleTodo:** matching id flips `completed`; non-matching id is a no-op; only the
  target element differs.
- **editTodo:** text updates and is trimmed; id and `completed` preserved; non-matching
  id no-op.
- **deleteTodo:** length−1 on match, order preserved; no-op on non-match.
- **clearCompleted:** removes all completed, keeps active in order; handles
  empty/all-active/all-completed.
- **filterTodos:** all / active / completed each correct; unknown filter → all.
- **remainingCount:** mixed, all-active, all-completed, empty (0).

### Resolved findings (must each have a dedicated case)
- **F1 dup-id no-op:** `addTodo(list, "x", existingId)` returns same length, no new
  element; also `id = ""`/`id = 42`/`id = null` → no-op.
- **F3 trim-then-validate:** `addTodo(list, "   ", id)` → no-op; `editTodo(list, id,
  "   ")` → target text unchanged; `sanitizeTodos([{id:'a',text:'   '}])` → element
  dropped.
- **F2 completed coerce:** `sanitizeTodos([{id:'a',text:'x',completed:1}])` →
  `completed:false`, element **kept**; same for `"yes"`, `0`, missing; `completed:true`
  stays `true`.
- **(F4/F5 are spec-wording fixes;** their runtime surfaces are INV6/INV5 below.)

### Storage & id helpers (now pure & tested — F6/F7/F9)
- **parseStored (F6 / INV4):** `parseStored(null)` → `[]` (missing key);
  `parseStored("not json{")` → `[]` (bad JSON, no throw);
  `parseStored("[]")` → `[]`; `parseStored(JSON.stringify(validList))` round-trips to a
  sanitized list; `parseStored('{"not":"array"}')` → `[]`. The crash-recovery half of
  INV4 is now proven by the automated suite, not just manual check.
- **safeSave (F9 / INV6):** `safeSave(() => {}, list)` → returns `true` and the writer
  received `JSON.stringify(list)`; `safeSave(() => { throw new Error('quota') }, list)`
  → returns `false` and **does not throw** (swallow proven by injecting a throwing
  writer — no localStorage needed).
- **makeId (F7 / INV2):** format check (non-empty string); generating N ids with
  increasing `seq` (and varied `rand`) yields N distinct ids; two calls with the same
  `(seq, rand)` are deterministic. (This bounds, not eliminates, collision risk — the
  residual is documented in §3.)

### Invariants
- **INV1:** after a mix of add/edit/sanitize, every element matches the
  `{id:string≠"", text:string≠"", completed:boolean}` shape.
- **INV2:** after `addTodo` with a duplicate id and after `sanitizeTodos` on a
  duplicate-id array, no two elements share an id.
- **INV3 (immutability, R11):** for every exported function, pass a structure built
  with `Object.freeze` on the list and each element; assert the call does not throw and
  a pre-call deep snapshot equals the input afterward.
- **INV4 / sanitize hardening (R12):** `sanitizeTodos` on: non-array (`null`, `42`,
  `"x"`, `{}`) → `[]`; array containing non-objects (string/number/null/nested array)
  → those dropped; missing/empty/non-string id → dropped; whitespace-only text →
  dropped; non-boolean completed → coerced+kept; duplicate ids → first kept; output
  order preserved. The bad-JSON crash half of INV4 is additionally covered by the
  `parseStored` cases above (F6).
- **R1 / R10 (purity, behavioral — F8):** purity is proven *behaviorally*, not by
  source-grep. For each exported function: (a) **determinism** — call it twice with the
  same inputs and assert deep-equal outputs; (b) **no-mutation** — covered by the INV3
  frozen-input test below; (c) **importability** — the suite imports `src/todos.js`
  under plain `node --test` with no browser shims, which fails if the module touches a
  browser global at import time. The brittle source-grep for `window`/`Math.random`/etc.
  is **demoted to a non-blocking lint advisory** (a convenience check), NOT a verifier
  exit criterion — false positives/negatives make it unfit to gate on.

### INV5 (UI-layer, manual per Q4) and INV6 residual
- **INV5:** manual check that a todo with text `<img src=x onerror=alert(1)>` renders
  as literal text and fires nothing; plus a repo grep proving no `dangerouslySetInnerHTML`
  and no todo-text interpolation into href/src/style sinks. (Recorded as a manual
  verification note, not an automated test, unless a harness is approved.)
- **INV6:** the write-throw swallow is now **automated** via `safeSave` (above), so the
  no-crash-on-write-failure guarantee no longer rests on manual check. Manual check is
  reduced to the end-to-end wiring: adding todos then reloading restores them; with
  storage disabled the app keeps working in-memory. (The pure halves — parseStored and
  safeSave — carry the INV4/INV6 logic and are unit-proven.)

### Verifier exit criteria
Every R2–R12 requirement and every INV1–INV4 has at least one failing-then-passing
`node:test` case; F1/F2/F3 each have a dedicated case; **`parseStored` (F6),
`safeSave` (F9), and `makeId` (F7) each have dedicated cases**; purity is proven
behaviorally (determinism + frozen-input no-mutation), with the source-grep demoted to
a non-blocking advisory (F8). INV5 and the end-to-end persistence wiring have recorded
manual verification (or automated if Q4 is later approved). A fix without a proving
test does not count.
