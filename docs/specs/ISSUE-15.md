# SPEC — ISSUE-15: Persist the todo list server-side in SQLite

Status: draft (revised after adversary round 1 — F23–F33)
Owner: architect
Work item: ISSUE-15
GitHub issue: #15 — "Persist list"

---

## 1. Problem statement

Today the TODO app is a **static, frontend-only Vite app**: the browser holds the
list in React state and persists it to the browser's `localStorage` via
`src/storage.js` (the only module that names `localStorage`). There is **no backend
process** in this repository. The issue asks to *"Move the todo list to the
server-side and persist it in a simple SQLite file database"* while *"not changing
anything related to the user interface or features/functionality."*

This work replaces the client-side `localStorage` persistence with a **small local
HTTP API backed by a single SQLite file**. The same list a user builds today must be
the list they see, with the same add / toggle / edit / delete / clear-completed /
filter / remaining-count behavior — only *where the bytes live* changes: from the
browser's `localStorage` to a SQLite file owned by a server process on the same
machine. What changes for the user: **nothing observable** in normal operation
(same UI, same interactions, same results), bounded by an explicit initial-load
latency budget (D2/Q4); todos now survive independently of the browser (clearing
browser storage no longer loses them, and the data file can be inspected/backed up).
What changes for the system: a new server process and a network boundary between the
browser and persistence, which introduces new failure classes (async load, out-of-order
saves, transient unreachability) that this spec must — and does — handle without data
loss (§8, §9).

---

## 2. Scope

**In scope:**

- A new **server process** (Node/Bun HTTP API, see §4/D1) that owns a single local
  SQLite database file and exposes a minimal REST-ish endpoint for loading and
  saving the whole todo list.
- A SQLite **schema** for the todo list derived from the *actual* Todo shape in
  `src/todos.js` (§5).
- Rewiring `src/storage.js` (and the minimum of `src/App.jsx` required to consume an
  async load/save **with a hydration guard**, D2) so the frontend reads/writes the
  list through the new API instead of `localStorage`. This is the **only** part of the
  frontend that changes, and it changes at the persistence seam, not at the UI or logic
  layers.
- First-run behavior: a fresh, empty database when no file exists yet (§7).
- Dev/build/run wiring so the app (frontend + server) can be started **and the API is
  reachable in every run mode the app supports today (dev AND preview/build)** (§4/D3).

**Out of scope:** see §3 Non-goals.

---

## 3. Non-goals (out of scope)

These are deliberate exclusions. The issue's constraint — *no UI or
functionality/feature change* — is the strongest one; N1–N4 make it operational.

- **N1 — No change to the pure logic core (`src/todos.js`).** Its exported functions
  (`addTodo`, `toggleTodo`, `editTodo`, `deleteTodo`, `clearCompleted`,
  `filterTodos`, `remainingCount`, `sanitizeTodos`, `parseStored`, `safeSave`,
  `makeId`) and their contracts are untouched. The **87 existing tests in
  `tests/todos.test.js` must pass byte-for-byte unchanged** (INV-A). If any change to
  `src/todos.js` is contemplated, it is out of scope and a finding, not a silent edit.
- **N2 — No user-visible UI change.** No change to the rendered markup, controls,
  labels, layout, styling, keyboard behavior, filters, or the "N items left" count as
  the user experiences them. Concretely: the DOM the user interacts with, and every
  interaction's *result*, are the same as today. The **only** permitted change inside
  `src/App.jsx` is at the persistence seam — making the initial load and the
  on-change save go through the async API instead of the synchronous `localStorage`
  helpers, plus the internal **hydration guard** that is not itself user-visible (see
  D2 and INV-B/INV-H). No new buttons, spinners, error banners, toasts, or user-facing
  states are added by this spec (adding one would be a functionality change — see Q3).
- **N3 — No change to todo semantics or features.** Same operations, same
  validation/normalization (trim-then-validate, dup-id rejection, empty-text
  rejection), same filter set (All/Active/Completed), same ordering (insertion
  order), same schema `{ id, text, completed }`. No new fields, no timestamps
  surfaced to the user, no sorting, no search, no accounts, no multi-list.
- **N4 — No new persisted data shape observable by the logic layer.** Whatever the
  API returns to the frontend deserializes to **exactly** the same
  `Array<{ id: string, text: string, completed: boolean }>` that
  `loadTodos()` returns today, so `sanitizeTodos`/`parseStored` still see the same
  input shape and the UI still receives the same value from the storage seam.
- **N5 — No auth, no multi-user, no networked/remote deployment.** The server binds
  to the loopback address `127.0.0.1` only (INV-G). Single local user, single file.
  No login, no per-user data, no CORS to foreign origins, no cloud DB. The one
  security control this spec *does* require despite "no auth" is a same-origin/local
  request guard on the write endpoint (§8, F31) — that is anti-CSRF hardening for a
  new local attack surface, not user authentication.
- **N6 — No migration of existing `localStorage` data into SQLite.** See §7 for the
  rationale; a fresh DB starts empty. (If migration is later wanted, it is a separate
  work item — see Q1.)
- **N7 — No ORM / heavy data-access framework, no DB-side business logic.** The
  server stores and returns the list; all list *semantics* remain in the pure core
  and the UI. The DB is a dumb blob/row store, not a rules engine. "No DB-side
  business logic" does **not** mean "accept impossible states": schema-level
  constraints still apply and a violating write fails cleanly (§8, F28).
- **N8 — No change to the SDLC pipeline files** under `.github/`, `.claude/`, or
  `SDLC/`.

---

## 4. Architectural decisions

### D1 — "Server-side" requires a real server process. (Riskiest, most contestable.)

**Decision:** introduce a small **local HTTP API server** (Node or Bun runtime; the
plan picks one, see Q2) that owns the SQLite file. The browser talks to it over
`fetch`.

**Why this is forced, not chosen lightly:** SQLite is a **file-based, server-side
store**. Browser JavaScript has no access to the local filesystem and cannot open a
`.sqlite` file. Therefore "persist the list in a SQLite file" is *impossible* from
the current frontend-only architecture without something running outside the browser
that can open the file. The issue explicitly says "move the todo list to the
**server-side**," which confirms the intent. So a server process is the minimal
thing that satisfies the literal request. This is the single most attackable part of
this spec and it is stated as a deliberate architectural decision, not an
implementation detail.

**Alternatives considered and rejected (named here so the adversary can check them):**

- *WASM SQLite in the browser (e.g. sql.js / wa-sqlite) persisting to IndexedDB/OPFS.*
  Rejected: this is **not** a "SQLite file database" on the server side — it is still
  client-side storage wearing a SQLite API, contradicting the issue's explicit "move
  to the server-side." It also would not produce an inspectable on-disk `.sqlite`
  file owned by a server. It is a different requirement.
- *Keep `localStorage` and merely rename things.* Rejected: does not persist in
  SQLite at all; fails the core request.
- *Embed SQLite access in the Vite dev server via a plugin/middleware only.*
  Rejected as the primary design because it would not exist in `build`/`preview`
  (production) and would tie persistence to dev tooling. The API must be a real
  process usable outside `vite dev` (though the plan may *also* proxy it through Vite
  in dev for convenience — see D3).

### D2 — The persistence seam becomes asynchronous; the UI does not — behind a mandatory hydration guard.

**Decision:** `src/storage.js` keeps its role as the **sole** persistence adapter,
but its two functions become **async (network) calls** to the API:
- `loadTodos()` → `GET` the list, returns a `Promise<Array<Todo>>`. It **never
  rejects**: every failure (network error, non-2xx, non-JSON body, timeout) is caught
  internally and mapped to the empty-list fallback `[]` (§9, F26).
- `saveTodos(list)` → `PUT` the whole list, returns a `Promise<boolean>` (best-effort,
  mirroring today's boolean contract). It **never rejects**: every failure maps to
  `false` (§9, F26).

**Consequence and the one permitted `App.jsx` change:** today `App.jsx` calls
`loadTodos()` **synchronously** inside `useState(() => loadTodos())` and
`saveTodos(todos)` inside a `useEffect(() => saveTodos(todos), [todos])` that fires on
**every** change to `todos`. A network call cannot be synchronous, so the initial-load
path must change from "compute initial state synchronously" to "start empty (`[]`),
then load asynchronously and populate state once the response arrives." This is the
**minimum** structural change that lets the same UI consume a server-backed store.

**The hydration guard (mandatory — closes the mount-vs-save data-loss race, F23/F24).**
With a `[]` initial state, the *existing, unchanged* always-on save effect would fire on
that initial `[]` **before** the `GET` has populated real data, emitting a `PUT []` that
can race ahead of, or independently of, the `GET` and **silently wipe the persisted
list**. This is a new failure class synchronous `localStorage` never had. The spec
therefore **requires** the save effect to be gated behind a hydration flag, specified
precisely so a builder cannot get it wrong and a verifier can test it:

1. `App.jsx` holds a hydration flag that starts **not-hydrated**, implemented as a
   `useRef` boolean (e.g. `hydratedRef`, initialized `false`) so its value is readable
   synchronously inside the save effect. (A `useState` boolean MAY additionally exist if
   a render-time gate is chosen for F25/Q4, but the **ref is the authoritative gate the
   save effect reads**, because a state update is not visible to an effect that runs in
   the same commit.)
2. The mount load effect runs on mount and calls `loadTodos()`. On settlement — whether
   it resolves to server data **or** to the empty-on-failure fallback `[]` (§9, F26) — it
   (a) `setTodos(sanitizeTodos(result))` and then (b) sets `hydratedRef.current = true`.
   The flag is set on **both** the success and the failure/fallback path (so a
   persistently-down server does not permanently disable saving), but **only after the
   GET has settled**, never before.
3. The save effect (`useEffect(() => { … }, [todos])`) **must no-op while
   `hydratedRef.current === false`**: it checks the ref first and returns immediately
   without calling `saveTodos` when not hydrated. Therefore **no `PUT` is ever emitted
   for the initial `[]` state, nor for the `setTodos` that applies the loaded data**. The
   first `PUT` the server can ever receive corresponds to a real, user-initiated mutation
   performed *after* hydration completed. (The load's own `setTodos` re-runs the save
   effect; by the ordering in step 2 the flag is already `true` then. The builder MUST
   suppress that first post-load save so the app does not echo the just-loaded list back
   as a `PUT`: acceptable techniques are (i) set `hydratedRef.current = true` *inside* the
   same `setTodos` updater batch but have the save effect additionally skip when the
   incoming `todos` is reference-equal to the value the load applied — tracked via a
   `lastSavedRef`/`loadedRef`; or (ii) flip a separate "skip next save" ref. The binding
   requirement is: **no `PUT` carrying `[]`-from-mount and no `PUT` merely re-sending the
   loaded list may reach the server; the first `PUT` reflects a genuine user edit.**)
4. **React 18 StrictMode double-invoke robustness (F33).** In dev, StrictMode mounts →
   unmounts → re-mounts, invoking effects twice. The load effect MUST be **abortable**:
   it captures an `AbortController` (passed to `fetch`) and/or an `ignore` flag set in the
   effect's cleanup, so a load belonging to an unmounted instance neither calls
   `setTodos` on a dead instance nor flips hydration for the live one. Combined with the
   save-effect gate (steps 2–3), **even two overlapping mount cycles cannot emit a
   spurious `PUT []`**, because no `PUT` is emitted for `[]` or for the load-applied value
   under any mount ordering. StrictMode may therefore remain enabled; the guard is robust
   to it. The plan MUST state explicitly whether `<React.StrictMode>` wraps the tree and
   confirm the abort/cleanup handling.

This guard is captured as **INV-H** (§9) with a falsifier and proven by **T8** (§10).

**Initial-load transient — explicit budget, decided (F25/Q4).** Because the load is now
async, a **returning** user with N todos will, unlike today's synchronous first paint,
see a brief empty frame (and "0 items left") before real data arrives. This is a genuine,
observable difference for returning users; the previous spec wording that dismissed it as
"not a change" is withdrawn. **Decision:** the empty-then-populated transient is
**accepted** for this local-only demo, bounded by an explicit budget rather than left
unbounded:
- The initial render before hydration MUST NOT block indefinitely. The load carries a
  **hard timeout of 3000 ms** (§9, F26); on timeout it resolves to the `[]` fallback and
  hydrates, so the app never hangs on an empty frame waiting for a dead server.
- Under normal operation the acceptable flash is **≤ 200 ms** on a warm localhost
  round-trip. This is a documented budget, not a UI feature; the spec does **not** add a
  spinner or loading text (that would be an N2 functionality change, Q3). The plan MAY
  render the same empty-list markup during hydration (identical DOM to a real empty list)
  so the transient is indistinguishable from the existing new-user empty state; it MUST
  NOT introduce any new user-facing element.
- Rationale for accepting rather than blocking: SSR/render-blocking hydration or a loading
  indicator would push into UI-change territory (N2). For a single-user localhost app the
  sub-200 ms flash matches the pre-existing new-user empty state and is the smallest design
  that preserves "no new UI." The residual (a returning user perceiving a brief empty
  frame) is explicitly logged and sent to the arbiter as **Q4** for confirmation — a real
  decision (accept, with budget), not a deferral.

**Why not hide the async behind a synchronous shim?** There is no correct way to make a
network read synchronous in the browser without deprecated synchronous XHR (banned,
freezes the UI thread). Pretending otherwise would be worse than a bounded, guarded async
load.

### D3 — Dev, build, and preview wiring (API reachable in ALL run modes — hard requirement).

**Decision:** the server is a standalone process that owns the SQLite file and serves
`/api/todos`. The frontend always reaches it **same-origin via a relative URL**
(`/api/todos`). It is a **hard requirement of this spec — not a deferred plan detail —
that the API is reachable in every run mode the app supports today.** Today
`package.json` exposes three Vite modes: `dev` (`vite`), `build` (`vite build`), and
`preview` (`vite preview`). After this change:
- **Dev (`bun run dev`):** the app MUST come up with a working, persisting API. The Vite
  dev server MUST proxy `/api/*` to the API process (Vite's `server.proxy`), and the API
  process MUST be running for dev to persist. The plan MUST ensure the dev workflow starts
  **both** the API and Vite (single script launching both, or a documented two-process
  procedure) and MUST address startup ordering so the browser's first `GET` does not
  arrive before the API is listening (a not-yet-listening API is handled by the load
  fallback + timeout, D2/§9, so a slow start degrades to the empty-then-populated
  transient, never to data loss).
- **Preview/build (`bun run preview` or the production run):** plain `vite preview` serves
  **only** static assets on a Vite port and knows nothing about the API; a relative
  `fetch('/api/todos')` would `404`, and per F23 a `404` must NOT be allowed to trigger a
  destructive `PUT []` (the hydration guard already prevents that, and `loadTodos` maps
  `404` to the `[]` fallback — but a `404`-persisting-nothing app is still a **broken
  requirement**, not acceptable). Therefore the spec **forbids shipping a run mode where
  `/api/todos` is unreachable**: the plan MUST make the preview/production run serve the
  API and the built static assets from **one origin** (e.g. the API server also serves the
  `dist/` output, or `vite preview` is replaced/augmented with a proxy to the API). The
  bare `vite preview` script, if retained, MUST be wired to reach the API (proxy or
  combined server); a documented command that yields a silently non-persisting app is a
  spec violation captured by **INV-I** and **T9**.

This spec fixes: (a) a real server process exists; (b) the frontend reaches it same-origin
via a relative URL; (c) **dev, preview, and any production run each yield an app whose
`/api/todos` is reachable and persistence actually works** — no run mode may silently
no-op persistence. Exact script names/orchestration are Q2/plan, but the reachability
constraint above is binding.

---

## 5. Data model (SQLite schema)

The schema is derived from the **actual** Todo shape in `src/todos.js`, which is
exactly `{ id: string, text: string, completed: boolean }` and nothing else (verified
against `sanitizeTodos`, which emits objects with exactly those three keys). Two
schema shapes are acceptable; the spec fixes the **contract**, the plan picks the form
(Q5):

- **Form A — one row per todo** (preferred, idiomatic SQLite):

  | Column | SQLite type | Constraint / invariant |
  |---|---|---|
  | `id` | `TEXT` | `PRIMARY KEY`, non-empty. Mirrors INV2 (unique id) at the DB level. |
  | `text` | `TEXT` | `NOT NULL`, non-empty. |
  | `completed` | `INTEGER` | `NOT NULL`, `0` or `1` (SQLite has no boolean; `0`=false, `1`=true). Serialized back to a JS boolean at the API boundary so the frontend still sees `true`/`false` (N4). |
  | `position` | `INTEGER` | Preserves **insertion order** (the list's ordering invariant). Required because SQL row order is otherwise unspecified. The API must return rows ordered by `position`. |

  Note on the `text` constraint: the DB enforces `NOT NULL` and non-empty **as stored**.
  The client is the authority for *trimming* (the pure core trims before persisting);
  the server does NOT re-trim or re-run todo rules (N7). If a client somehow sends a
  row that violates a DB constraint (e.g. an empty `id`, a duplicate `id`, or a `NULL`
  `text`), the write **fails cleanly** per §8/F28 — the server does not silently accept
  an impossible row, and does not attempt to "fix" it.

- **Form B — single-row JSON blob** (a `TEXT` column holding
  `JSON.stringify(list)`). Simpler and trivially order-preserving, but it makes the
  DB an opaque blob (weaker inspection/query story) and less clearly "a SQLite
  database" in spirit. Documented as the fallback if Form A proves heavier than the
  demo warrants. (Form B has no per-row constraints, so the F28 constraint-violation
  path is a Form-A concern; Form B still validates that the body is a JSON array of the
  expected shape before writing, rejecting non-conforming bodies with a non-2xx.)

**Ordering is a first-class invariant** (INV-D): whichever form is chosen, the list
the API returns MUST be in the same insertion order the UI would have produced, since
`filterTodos` and rendering rely on order. Form A therefore *requires* an explicit
order column; Form B gets ordering for free from the serialized array.

**Boolean marshaling** (INV-E): `completed` crosses three representations — JS
boolean in the UI/core, `0/1` `INTEGER` in SQLite (Form A), and JSON `true`/`false`
on the wire. The API is responsible for converting so that what the frontend
receives is byte-for-byte a `boolean`, exactly what `sanitizeTodos` expects.

---

## 6. API / interface boundary (frontend ↔ persistence)

The boundary is deliberately minimal and mirrors today's two-function storage
contract (`loadTodos`, `saveTodos`). Whole-list read and whole-list write — no
per-todo endpoints — because the current app already persists the **entire list on
every change** (`saveTodos(todos)` in the `useEffect`), and matching that keeps the
frontend seam a drop-in swap (N2/N4).

- **`GET /api/todos`** → `200` with body `Array<{ id: string, text: string,
  completed: boolean }>` in insertion order. Empty DB → `[]` (never `404`, never
  null). This is what `loadTodos()` resolves to on success.
- **`PUT /api/todos`** (verb fixed to `PUT`; whole-list idempotent replace) with body
  `Array<{ id, text, completed }>` = the whole list → replaces the stored list
  atomically (§8), returns `2xx` on success. This is what `saveTodos(list)` sends; the
  client resolves it to `true` on `2xx`, `false` otherwise. The write endpoint enforces
  the request guards in §8/F31 (local Origin/Host check, body-size cap).

**Client-side load/save contract (storage.js — closes F26).** Both functions are total
(never reject). Specified outcomes:

| Situation | `loadTodos()` result | `saveTodos()` result |
|---|---|---|
| `2xx` + valid JSON array body | `sanitizeTodos(parsed)` (an `Array<Todo>`) | `true` |
| `2xx` + non-array / malformed JSON body | `[]` (fallback) — logged, no throw | n/a (save response body is ignored) |
| non-2xx (4xx/5xx incl. 404) | `[]` (fallback) | `false` |
| network error (server down, refused) | `[]` (fallback) | `false` |
| body parse (`response.json()`) throws | `[]` (fallback) | `false` (parse of a save response never blocks success — success is decided by status only) |
| **timeout: no response within 3000 ms** | abort the request; `[]` (fallback) | abort; `false` |

- The **timeout budget is 3000 ms** for both calls, implemented via `AbortController`
  (`AbortSignal.timeout(3000)` or equivalent). A server that accepts the socket but never
  responds MUST NOT hang the app; the request is aborted and mapped to the fallback.
- Because `fetch` only rejects on network error (NOT on `4xx`/`5xx`, which resolve with
  `ok === false`), and `response.json()` throws on a non-JSON body, storage.js MUST
  explicitly check `response.ok` **and** wrap `response.json()` in try/catch. Every one of
  the rows above is a caught, defined outcome — **no unhandled promise rejection may
  escape either function** (INV-F falsifier).

**Contract invariants for the boundary:**

- **INV-C — Shape parity.** The value `loadTodos()` resolves to is the **same shape**
  (`Array<Todo>`) it returns today, so nothing downstream in the UI or core observes a
  new shape. The frontend still passes server data through `sanitizeTodos` before use
  (defense in depth against a malformed/partial response), exactly as it does for
  `localStorage` today — the server is not trusted to be perfectly well-formed.
- **INV-F — Best-effort save is preserved.** A failed save (server down, network
  error, non-2xx, timeout) must **not crash the session**; `saveTodos` resolves `false`
  and the app continues in-memory, exactly as `safeSave` swallows a `localStorage` throw
  today (this preserves INV6 from TODO-1). No user-facing error is introduced (N2/Q3),
  and no unhandled rejection escapes.

---

## 7. First-run / migration behavior

- **First run (no DB file yet):** the server creates the SQLite file and the schema
  (idempotent "create if not exists"), and the list starts **empty**. `GET
  /api/todos` on a fresh DB returns `[]`, so the user sees an empty list — identical
  to a brand-new user today.
- **No migration from `localStorage` (N6).** Rationale: this is a local demo app;
  the issue does not ask for migration; and any prior `localStorage` list lives only
  in a specific browser profile that the server process cannot read. Silently
  migrating would require the frontend to detect old data and POST it up, which adds
  UI-adjacent behavior and edge cases (merge/dedupe against server state) that the
  issue neither requests nor scopes. **Simplest defensible answer: start empty.** The
  old `localStorage` key is simply no longer read; it is not actively deleted either
  (harmless, and deleting it is out of scope). If migration is desired, it is Q1.

---

## 8. Concurrency & consistency expectations

Kept deliberately simple to match a **single local user, single file** demo — but the
network boundary introduces ordering hazards that synchronous `localStorage` did not,
so this section is explicit about them.

- **Single writer, whole-list replace.** The frontend is the only intended client, and
  it writes the *entire* list on each change (as today). A `PUT` therefore replaces the
  stored list wholesale. Within a single `PUT`, the replace must be **atomic** — the DB
  is never left in a half-updated state where some todos of the new list are present and
  some of the old remain. **Atomicity requirement (Form A, F32):** the delete+insert MUST
  run inside an **explicit transaction that is rolled back on ANY error mid-`PUT`, not
  just on a crash** — including a constraint violation (e.g. a duplicate-id or empty-id
  INSERT that throws after the DELETE). Relying on autocommit-per-statement is forbidden,
  because a failed INSERT after a committed DELETE would leave the DB empty (total loss).
  On rollback the DB retains the **old** list unchanged, and the API returns non-2xx.
  Form B's single-row update is inherently atomic. This is INV-D's consistency half.

- **Out-of-order / concurrent save guard (F27).** The save effect fires a new `PUT` on
  every `todos` change, so rapid edits issue `PUT(v1)`, `PUT(v2)`, … back-to-back. `fetch`
  does not guarantee send-order == arrival/commit-order (connection reuse, retries), so a
  stale `PUT(v1)` could land after `PUT(v2)` and cause a silent regression on the next
  load. This class did not exist with synchronous, strictly-ordered `localStorage.setItem`.
  The spec **requires** saves to be effectively serialized so a stale response cannot
  clobber a newer state. The plan MUST implement **at least one** of:
  1. **Client-side in-order serialization (preferred):** the save path aborts/cancels any
     in-flight `PUT` before issuing a newer one (`AbortController`), AND/OR chains saves so
     only one is in flight at a time and, when it completes, the latest pending state is
     sent (coalescing). The invariant to satisfy: **the last `PUT` the server commits must
     correspond to the newest `todos` state the client held, never an older one.**
  2. **Monotonic sequence guard (server-side):** the client tags each `PUT` with a
     strictly increasing sequence number; the server persists a `PUT` only if its sequence
     is >= the last applied sequence, ignoring (and returning a defined non-error status
     for) a stale one. The sequence is per-session and need not survive restart (a fresh
     session's first `PUT` after a `GET` reflects newest state).

  Either satisfies the binding invariant **INV-J** (§9). Client serialization alone is
  sufficient for the single-client case; the sequence guard additionally hardens the
  two-tab case. The plan states which it uses and why.

- **Last-write-wins across tabs.** If two *tabs* race, the last `PUT` to commit wins — the
  same coarse semantics as today's `localStorage` "last write wins" (TODO-1 non-goals). No
  optimistic locking, no conflict resolution, no cross-tab live sync. The out-of-order
  guard above ensures "last" means "newest state," not merely "last packet to arrive"
  within a single client's own bursts.

- **No server-side business-logic validation — but no silent acceptance of impossible
  states either (F28).** The server does not re-run `addTodo`-style rules (N7); the
  frontend enforces todo semantics via the pure core before saving and re-sanitizes on
  load (INV-C). The server's integrity job is limited to: (a) validating the request body
  is a JSON array of `{ id, text, completed }` (reject non-conforming bodies with `400`);
  (b) honoring schema constraints — a constraint violation (duplicate/empty `id`, `NULL`
  `text`, non-`0/1` `completed`) causes the transaction to **roll back** and the API to
  return a non-2xx (`400` for a client-shaped violation, `500` only for an unexpected DB
  error); the write then persists **nothing** (old list intact) and `saveTodos` resolves
  `false`. The server MUST NOT throw an unhandled error or leave a partial write. This is
  **not** a contradiction of "no validation": the server is not implementing todo
  semantics, it is refusing to persist rows the schema declares impossible. Captured as
  **INV-K** (§9).

- **Request-origin guard on the write endpoint (F31).** The state-mutating `PUT`
  `/api/todos` is a new, unauthenticated, localhost-bound endpoint — a classic
  "localhost CSRF" / DNS-rebinding target that `localStorage` (origin-scoped, unreachable
  cross-origin) never exposed. The server MUST reject write requests that do not originate
  from the app's own local origin: check the `Origin` header (and/or `Host`) and **reject
  (`403`) any request whose `Origin` is present and not the local app origin, and any
  request whose `Host` is not `127.0.0.1`/`localhost`** (defends against DNS-rebinding to a
  foreign hostname pointing at the loopback). A body-size cap (**≤ 1 MB**, plan may tune)
  MUST be enforced to prevent a giant-body OOM. This is minimal hardening, not auth (N5);
  it is required because the attack surface is new. Captured as **INV-L** (§9). GET MAY be
  similarly guarded but the write guard is mandatory.

---

## 9. Failure modes & invariants

Invariants (the plan and red-team review must respect these):

- **INV-A — Pure core untouched; existing tests unchanged.** `src/todos.js` is not
  modified and all **87 tests in `tests/todos.test.js` pass unchanged**. *Falsify:*
  a diff touches `src/todos.js`, or any existing test is edited/removed/weakened, or
  the suite is not green.
- **INV-B — No user-visible UI/behavior change.** The rendered UI and every
  interaction's result are unchanged from today; the only `App.jsx` changes are the
  async-load/save seam and the internal (non-visible) hydration guard (D2), adding no
  control, message, spinner, or new user-facing state. *Falsify:* any added/removed/
  renamed control or label; any new user-facing message/spinner/banner; any change in the
  result of add/toggle/edit/delete/clear-completed/filter/count as observed by a user.
- **INV-C — Storage-seam shape parity.** `loadTodos()` resolves to
  `Array<{ id: string, text: string, completed: boolean }>` (post-`sanitizeTodos`),
  the same shape it returns today; `saveTodos(list)` accepts that same shape.
  *Falsify:* the frontend receives or is asked to send a different shape from the
  seam, or the server response bypasses `sanitizeTodos`.
- **INV-D — Order + atomic replace.** The API returns the list in insertion order,
  and a save replaces the stored list atomically inside a transaction that rolls back on
  ANY error (never a partial or emptied list). *Falsify:* reload after a save yields a
  different order than before, or a mid-write failure (crash OR constraint violation) can
  leave a mix of old and new todos, or an emptied DB, instead of the intact old list.
- **INV-E — `completed` marshals to a real boolean.** Across JS↔SQLite↔JSON,
  `completed` reaches the frontend as a JS `boolean`. *Falsify:* the frontend ever
  sees `completed` as `0`/`1`/`"true"` from the seam.
- **INV-F — Best-effort, total, non-throwing seam.** `loadTodos()` and `saveTodos()`
  never reject: every failure (network error, non-2xx, non-JSON body, 3000 ms timeout)
  is caught and mapped to the defined fallback (`[]` / `false`); the app continues
  in-memory and does not crash, hang, or surface an error. *Falsify:* a stopped, hanging,
  erroring, or garbage-returning server causes an unhandled rejection, a crash, a UI hang
  beyond the timeout, or a user-facing error dialog.
- **INV-G — Single SQLite file, loopback-only bind, file not committed.** Exactly one
  SQLite file is used. The server binds to the **literal loopback address `127.0.0.1`**
  (NOT `0.0.0.0`, NOT the hostname `localhost` which may resolve to `::1` or be
  intercepted). The DB file lives at the **fixed path `data/todos.sqlite`** (relative to
  repo root; confirmed in Q6) and `.gitignore` contains a line that ignores it —
  specifically the literal line **`data/`** (or the more precise `data/todos.sqlite`).
  *Falsify:* the DB file is committed to the repo; `.gitignore` lacks a rule matching
  `data/todos.sqlite`; the server binds to any address other than `127.0.0.1`; or
  multiple DB files proliferate.
- **INV-H — Hydration guard: no save before load settles.** The save effect emits no
  `PUT` until the initial `loadTodos()` has settled and set the hydration flag, and it
  emits no `PUT` for the mount-time `[]` state nor for the load-applied value; the first
  `PUT` the server receives corresponds to a genuine user mutation after hydration.
  *Falsify:* with the server holding a non-empty list, mounting the app (including under
  StrictMode's double mount) and making no edits results in the server ever receiving a
  `PUT []` or any `PUT` before the `GET` has resolved — i.e. the persisted list is wiped or
  overwritten by mount alone.
- **INV-I — API reachable in every run mode.** In `dev`, `preview`, and any production
  run, `/api/todos` resolves to the real API (persistence works). *Falsify:* a supported
  run command (`bun run dev`, `bun run preview`, the production run) yields an app where
  `GET /api/todos` 404s or otherwise does not reach the API, so edits silently do not
  persist.
- **INV-J — Newest-state-wins save ordering.** Rapid sequential saves from one client can
  never leave the server committing an older `todos` state after a newer one was sent; the
  committed state equals the newest state the client held. *Falsify:* issuing `PUT(v1)`
  then `PUT(v2)` back-to-back can leave the DB holding `v1` after both complete.
- **INV-K — Constraint violations fail cleanly, no silent bad state, no partial write.**
  A `PUT` carrying a row that violates a schema constraint (duplicate/empty `id`, `NULL`/
  empty `text`, non-`0/1` `completed`) or a non-conforming body causes a rolled-back
  transaction, a non-2xx response, `saveTodos → false`, and the previously stored list left
  intact; the server does not crash or persist a partial/impossible list. *Falsify:* such a
  `PUT` yields a `2xx`, an emptied/partial DB, an unhandled server error, or a persisted
  impossible row.
- **INV-L — Local-origin write guard + body cap.** `PUT /api/todos` rejects (`403`) a
  request whose `Origin` is a foreign origin or whose `Host` is not `127.0.0.1`/`localhost`,
  and rejects an over-cap body (`≤ 1 MB`). *Falsify:* a cross-origin `PUT` (foreign
  `Origin`/`Host`) succeeds in overwriting the todo file, or an arbitrarily large body is
  accepted and buffered.

Failure modes and required handling:

| Failure mode | Required behavior | Covered by |
|---|---|---|
| DB file does not exist on first run | server creates file + schema; `GET` returns `[]` | §7, INV-G |
| Mount before any user edit (async load in flight) | save effect no-ops until hydration; **no `PUT` emitted**; server list untouched | D2, INV-H |
| StrictMode double mount (dev) | abortable load; guarded save; no double/spurious `PUT`; no `setState` on dead instance | D2, INV-H |
| API server not running / unreachable when the UI loads | `loadTodos()` resolves to `[]` (fallback, never rejects); app renders empty; hydration still completes; **no destructive `PUT`** | INV-F, INV-H |
| Server accepts socket but never responds | request aborted at 3000 ms; `loadTodos → []`, `saveTodos → false`; app not hung | §6, INV-F |
| Non-2xx (incl. 404 from a mis-wired preview) on load/save | mapped to fallback (`[]` / `false`); no crash; **no `PUT []`** (guard) | §6, INV-F, INV-H |
| Malformed / partial / non-JSON body from server | `response.json()` wrapped in try/catch → `[]` fallback, then `sanitizeTodos`; never a crash | §6, INV-C, INV-F |
| Rapid sequential edits (out-of-order saves) | serialize/coalesce or sequence-guard; newest state wins | §8, INV-J |
| Two tabs / racing writes | last committed `PUT` wins; no partial-list state (atomic replace); sequence guard hardens it | §8, INV-D, INV-J |
| `PUT` body violates a schema constraint | transaction rolled back; non-2xx; `saveTodos → false`; old list intact; no crash | §8, INV-K |
| Cross-origin / DNS-rebinding `PUT` to the local API | rejected `403` (Origin/Host guard) | §8, INV-L |
| Oversized `PUT` body | rejected before buffering the whole body (`≤ 1 MB` cap) | §8, INV-L |
| Todo text containing HTML/JS | still rendered as an inert React text node (unchanged from TODO-1 R18/INV5); persistence stores it verbatim | N2 (UI unchanged) |
| Very long todo text | stored verbatim (subject to the total body cap); no truncation | N3, INV-L |
| Mid-write server crash | transactional replace → DB holds either the old or the new whole list, never a mix | §8, INV-D |

---

## 10. Testing expectations (spec level — what must be verifiable)

- **T1 — The 87 existing `tests/todos.test.js` pass unchanged** (INV-A). The pure core
  did not move, so its suite is untouched and green.
- **T2 — Storage-seam shape parity is provable** (INV-C/INV-E): drive
  `loadTodos()`/`saveTodos()` (against the real or a stubbed API) and assert the
  round-tripped value is `Array<{ id: string, text: string, completed: boolean }>`
  with `completed` a genuine boolean, in insertion order.
- **T3 — Round-trip persistence through SQLite** (INV-D): saving a known list and
  reloading returns an equal list in the same order; a fresh DB returns `[]`.
- **T4 — Atomic replace / no partial list, including constraint-violation rollback**
  (INV-D/INV-K): a save interrupted mid-transaction, **and** a `PUT` carrying a
  duplicate-id (or empty-id / NULL-text) row, each leave the DB holding the **whole prior
  list** (not a mixture, not emptied); the constraint case returns non-2xx and
  `saveTodos → false`.
- **T5 — Total, non-throwing seam** (INV-F): with the API unreachable, returning non-2xx,
  hanging past 3000 ms, and returning a non-JSON body, `saveTodos` resolves `false` and
  `loadTodos` resolves `[]` — each without an unhandled rejection; a timeout aborts within
  the budget.
- **T6 — No UI/behavior regression** (INV-B): a documented manual check (or component
  test if a harness exists) that add/toggle/edit/delete/clear-completed/filter/count
  behave and render exactly as before, and that no new control/message was added.
- **T7 — DB file is git-ignored and loopback-only** (INV-G): a static/config check that
  `.gitignore` contains a rule matching `data/todos.sqlite` (the literal `data/` line
  suffices) and that the server bind address is the literal `127.0.0.1` (assert the
  configured/observed bind address string, reject `0.0.0.0`).
- **T8 — Hydration guard: mount emits no destructive save** (INV-H): pre-seed the server
  with a non-empty list; mount the app (component/integration harness) making **no edits**;
  assert the server received **zero `PUT`s** (and specifically no `PUT []`) and the stored
  list is byte-for-byte intact after the `GET` resolves. Repeat under a simulated StrictMode
  double mount and assert the same (no spurious/duplicate `PUT`, no `setState`-after-unmount
  warning that indicates an unaborted load).
- **T9 — API reachable in dev and preview/build** (INV-I): a check (script/CI) that in the
  `dev` run and the `preview`/production run a `GET /api/todos` reaches the real API (e.g.
  returns the JSON array, not a 404/HTML), proving no run mode silently no-ops persistence.
- **T10 — Newest-state-wins ordering** (INV-J): issue two rapid saves (`v1` then `v2`),
  including a simulated case where `v1`'s response is delayed past `v2`'s; assert the DB
  ends holding `v2`, never `v1`.
- **T11 — Local-origin write guard + body cap** (INV-L): a `PUT` with a foreign `Origin`
  (and/or a non-loopback `Host`) is rejected `403` and does not mutate the DB; an over-cap
  body is rejected without being fully buffered.

The **verifier** must be able to prove each `INV-*` above via at least the mapped `T*`
test. Any INV without a falsifiable test is a spec defect to be fixed before the plan gate.

---

## 11. Open questions (need human/arbiter input)

- **Q1 — `localStorage` → SQLite migration?** This spec chooses **no migration**
  (fresh empty DB, §7/N6). Confirm that losing any existing browser-local todos on
  cutover is acceptable for this demo, or scope a one-time import as a separate item.
- **Q2 — Server runtime & orchestration.** Node vs Bun for the API process, the
  SQLite driver (e.g. `bun:sqlite` vs `node:sqlite`/`better-sqlite3`), and how
  `bun run dev` / `bun run preview` start frontend + server together (Vite proxy vs
  concurrent processes vs the API server serving `dist/`). Plan-level, but the
  runtime/driver choice and the run-mode wiring (bounded by INV-I/D3) are worth
  ratifying early.
- **Q3 — Save-failure UX.** This spec forbids adding any user-facing error/spinner
  (N2/INV-B): a failed save is silent and best-effort. Is a *silent* failure
  acceptable (matching today's `localStorage` best-effort behavior), or is a minimal
  indicator wanted (which would be a functionality change and thus a scope expansion)?
  Default: silent, no UI change.
- **Q4 — Initial-load transient (decided; confirm the accepted budget).** The async load
  (D2) means a **returning** user sees a brief empty frame before real data arrives — a
  genuine difference from today's synchronous first paint. This spec **accepts** it,
  bounded by a **≤ 200 ms** normal-case budget and a **3000 ms** hard load timeout, and
  **without** adding any spinner/loading UI (rendering the identical empty-list DOM during
  hydration). Confirm this accepted trade-off, or require a stronger render-time gate
  (which would push into UI-change territory, N2).
- **Q5 — Schema form.** Form A (row-per-todo, ordered) vs Form B (single JSON blob) per
  §5. The HTTP verb is fixed to `PUT` (§6). This spec fixes the contract (ordered
  `Array<Todo>` in/out, atomic transactional replace with rollback, boolean marshaling,
  constraint-violation → non-2xx) and leaves the schema form to the plan; flag if a
  specific form is mandated.
- **Q6 — DB file location (proposed; confirm).** This spec pins the SQLite file to
  **`data/todos.sqlite`** (repo-root relative) and requires `.gitignore` to ignore it via
  the literal **`data/`** line, so INV-G/T7 are unambiguous and falsifiable. Confirm this
  path/name convention or supply an alternative fixed path.
