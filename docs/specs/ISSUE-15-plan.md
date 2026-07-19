# ISSUE-15 — PLAN — Persist the todo list server-side in SQLite

Status: PLAN (revised after adversary round on F61–F70)
Owner: architect
Revision changelog (this round): F61 vite.config merge preserves `resolve.alias` (§0, §3.1, §6); F62 harness-already-installed corrected + `tests/App.a11y.test.jsx` fetch-stub plan (§0, §4.3, §7); F63 streaming body cap + reject-chunked-411 (§1, §2.4); F64 pre-hydration lost-update fix (§4.2, §9); F65 fail-loud dev/preview via `scripts/dev.mjs` (§2.3, §3.2, §9); F66 `strictPort` + port-derived allowlist (§1, §2.4, §3.1); F67 `TODOS_PORT` single source of truth (§1, §2.3, §3.1, §7); F68 no App.jsx import, drop redundant sanitize (§0, §4.2); F69 T8 wraps `<React.StrictMode>` (§7); F70 Origin/Host guard default-deny (§2.4).
Work item: ISSUE-15
Spec: [docs/specs/ISSUE-15.md](./ISSUE-15.md) (ratified) — this plan implements it verbatim; where they
conflict, the spec wins and this plan is the bug.

---

## 0. Grounding re-verified before planning

Re-read against the live tree, not assumed:

- `src/App.jsx` (229 lines — resynced after merging in #13's design-system rewrite; the
  load/save seam is structurally unchanged, only shifted): line **53**
  `const [todos, setTodos] = useState(() => loadTodos());`
  (synchronous initializer to replace, D2); lines **62–64** the always-on save effect
  `useEffect(() => { saveTodos(todos); }, [todos]);` (to gate behind the hydration flag, INV-H).
  `useRef` is already imported (line 11); `seqRef` (line 58) shows the ref idiom already in use.
  The import block (lines 12–21) imports `{ addTodo, toggleTodo, editTodo, deleteTodo,
  clearCompleted, filterTodos, remainingCount, makeId }` from `./todos.js` — **`sanitizeTodos`
  is NOT among them** (verified by grep). This drives the §4.2 fix for F68: the load path
  re-sanitizes **inside `storage.js`** (not inside App.jsx), so **App.jsx adds no new import**.
  App.jsx also imports `@/lib/utils` and `@/components/ui/{button,input,checkbox}` (lines 23–26),
  which depend on the `@` → `./src` alias in `vite.config.js`; the proxy change MUST preserve that
  alias (F61 — see §3.1).
  The UI markup (lines 107–227, now shadcn/Tailwind components per #13) MUST NOT change (N2/INV-B).
- `src/storage.js` (28 lines): `loadTodos()` and `saveTodos(list)` — the **sole** module naming
  `localStorage`. Both currently **synchronous** and total (`parseStored`/`safeSave` never throw).
  This is the only file that becomes async network I/O (D2).
- `src/todos.js` (203 lines): pure core. **Not touched** (N1/INV-A). `sanitizeTodos` emits objects
  with **exactly** `{ id, text, completed }` (lines 146) — confirms the §5 schema shape and that the
  frontend re-sanitizes server data (INV-C).
- `src/main.jsx`: **`<React.StrictMode>` DOES wrap `<App/>`** (lines 7–9). It stays enabled; the load
  effect MUST be abort/ignore-safe (D2 step 4, INV-H).
- `tests/todos.test.js`: **87 tests**, node environment, `bun run test` (`vitest run`). Imports only
  from `../src/todos.js`. Untouched (INV-A/T1).
- **A DOM test harness IS already installed** (correcting an earlier draft that claimed otherwise):
  `package.json` devDeps include `happy-dom` **15.11.7**, `@testing-library/react` **16.3.2**,
  `@testing-library/dom` **10.4.1**, `@testing-library/jest-dom` **6.9.1** (all verified). No new
  test dependency is needed for component-level tests.
- **`tests/App.a11y.test.jsx` already exists and renders `<App/>` ~14 times** (`render(<App/>)` at
  lines 45, 54, 64, 78, 90, 99, 108, 118, 131, 159, plus the `addTodo()` helper firing `submit`).
  It runs under `@vitest-environment happy-dom`, `beforeEach(() => localStorage.clear())`, and
  synchronous `fireEvent` assertions. **Once `storage.js` becomes async `fetch`, every one of those
  renders fires `loadTodos()` → `fetch('/api/todos')` on mount and `saveTodos()` → `PUT` on each
  add, with no server in the test env.** This file is therefore in scope for this change and MUST be
  handled (F62) — see §4.3 (a `fetch` stub in its setup) and §7. It is **not** part of the INV-A/T1
  "87 tests untouched" tripwire (that clause covers `tests/todos.test.js` only); a minimal setup
  addition here is expected, not a violation.
- `package.json`: scripts `dev`=`vite`, `build`=`vite build`, `preview`=`vite preview`,
  `test`=`vitest run`. Deps: react/react-dom `^18.3.1`; devDeps vite `^5.4.0`, vitest `^1.6`,
  `@vitejs/plugin-react`. **No server dep, no `concurrently`.**
- `vite.config.js`: has `plugins: [react()]` **and a `resolve.alias` mapping `@` → `fileURLToPath(new
  URL('./src', import.meta.url))`** (verified, lines 5–12); it also imports `fileURLToPath, URL` from
  `node:url`. There is **no `server.proxy` and no `server.strictPort` today.** The alias is
  load-bearing (shadcn imports) and MUST survive the proxy addition (F61).
- `.gitignore`: has `dist/`, `node_modules/`, `.bun/` — **no `data/` line today** (to add, INV-G).
- Toolchain: **Bun 1.3.11** present; `require('bun:sqlite')` verified working in this environment
  (in-memory `CREATE TABLE` succeeded). Zero new native dependency needed.

---

## 1. Decisions locked (resolving the spec's Q2/Q5 and every deferred plan detail)

| # | Decision | Why | Spec hook |
|---|----------|-----|-----------|
| **Q2 → Runtime = Bun** | The API process runs under **Bun** (`bun server/index.js`). | Project toolchain is already Bun (`bun.lock`, README "Requires Bun 1.x"); no second runtime introduced. | D1, Q2 |
| **Q2 → Driver = `bun:sqlite`** | Import `Database` from **`bun:sqlite`** (built in). | Zero new dependency, no native build step, best fit for "simple SQLite file database"; verified working here. **Rejected:** `better-sqlite3` (adds a native dep + build), `node:sqlite` (would force Node runtime, still experimental on some versions). | D1, Q2 |
| **Q2 → HTTP server** | Use **`Bun.serve`** (built in) for both the API and static-file serving; no Express/Fastify. | Smallest design; matches "no heavy framework" (N7). | D1, D3 |
| **Q5 → Schema = Form A** | **Row-per-todo** with an explicit `position` column, exactly the four columns the spec fixes. | Spec-preferred, idiomatic, inspectable; ordering via `position`; per-row constraints give INV-K teeth. | §5, INV-D |
| **Q2 → Dev wiring = Vite proxy (alias-preserving) + readiness-gated launcher** | `vite.config.js` **merges** a `server.proxy` for `/api` → `http://127.0.0.1:${TODOS_PORT}` **into the existing config, preserving `resolve.alias`** (F61) and setting `server.strictPort: true` (F66); a single `dev` script starts the API and **verifies it is listening before starting Vite** via `scripts/wait-for-server.mjs` (F65), not a bare `&`. | Same-origin relative `fetch('/api/todos')` works in dev; one `bun run dev` brings up both (INV-I) with **no new runtime dependency**. A server startup failure (e.g. port clash) **fails loud, non-zero** rather than degrading to a silently non-persisting app (F65). | D3, INV-I |
| **Q2 → Preview/prod wiring = API server serves `dist/`** | `bun run build` runs `vite build`; the **Bun server itself serves the static `dist/` output AND `/api/*` from one origin** on `127.0.0.1:${TODOS_PORT}` (default `8787`, single source of truth per §2.3/F67). The `preview` script builds then runs the Bun server (NOT `vite preview`), which fails loud on a bind error (F65). | Kills the "bare `vite preview` 404s `/api`" spec violation (D3/INV-I): one origin, API always reachable. `vite preview` is **replaced**, not retained-and-proxied. | D3, INV-I |
| **INV-J → save ordering = client in-order serialization + coalescing** | storage.js aborts any in-flight `PUT` and coalesces to the latest pending state (option 1). | Single-client case is fully covered client-side; smallest design, no server session state. **Not** the server sequence guard (option 2) — unnecessary for the single-user demo; noted as the residual weak point in §9. | §8, INV-J |
| **Port = single source of truth** | The API port is read from **`TODOS_PORT` (default `8787`)** in **one place**, and *every* consumer (server bind, Vite proxy target, preview) derives from that same value — no duplicated literal (F67). Vite's dev port is **pinned to `5173` via `server.strictPort: true`** so it never silently shifts to 5174 (F66). | A fixed, non-drifting port keeps INV-G/T7 falsifiable, keeps the proxy target and the Origin allowlist valid, and lets integration tests move the port without breaking the proxy. `127.0.0.1` literal for the bind, never `0.0.0.0`/`localhost`. | INV-G, INV-I |
| **Body cap = 1 MB, enforced before buffering** | Reject `PUT` bodies > `1_048_576` bytes with `413`, enforced by **requiring a valid `Content-Length` ≤ cap AND streaming the body through a `getReader()` loop that aborts once the running byte count exceeds the cap** — the whole body is never buffered (F63). A chunked/absent-`Content-Length` request is **rejected `411 Length Required`** for this endpoint. | Spec cap (INV-L) says "rejected *before* buffering"; `await req.json()`/`req.text()` buffer the entire body first and do not satisfy that. See §2.4 step 1 for the exact mechanism. | §8, INV-L |

---

## 2. Server structure — `server/index.js`

New file **`server/index.js`** (single file; no `server/` subtree). Run by Bun. Responsibilities,
in order:

### 2.1 Open/create the DB at the pinned path
- Resolve the DB path to the repo-root-relative literal **`data/todos.sqlite`** (Q6/INV-G). Compute it
  from the file location (e.g. `new URL('../data/todos.sqlite', import.meta.url)`), NOT from
  `process.cwd()`, so the path is stable regardless of launch directory.
- Ensure the **`data/`** directory exists (`mkdir` recursive/idempotent) before opening.
- `const db = new Database(dbPath)` (creates the file if absent — first-run behavior, §7).
- Set `db.exec('PRAGMA journal_mode = WAL;')` (optional, safe) and **`PRAGMA foreign_keys = ON;`** is
  N/A (no FKs). Not required by spec; WAL is a nicety, may be omitted if it complicates the demo.

### 2.2 Create schema idempotently (first run, §7, Form A)
Run once at startup:
```
CREATE TABLE IF NOT EXISTS todos (
  id       TEXT    PRIMARY KEY,
  text     TEXT    NOT NULL,
  completed INTEGER NOT NULL CHECK (completed IN (0,1)),
  position INTEGER NOT NULL
);
```
- `PRIMARY KEY` on `id` enforces uniqueness (rejects duplicate id → INV-K).
- `text TEXT NOT NULL` — DB rejects `NULL` text. Non-empty is enforced additionally at the app layer
  in the row-shape validation (§2.4) since SQLite `NOT NULL` alone allows `''`; the plan adds a
  `CHECK (length(text) > 0)`-equivalent via the **body validator** (a `''` text is a non-conforming
  body → `400`, per §2.4) to match the spec's "non-empty as stored." (Adding `CHECK(length(text)>0)`
  to the DDL is also acceptable and preferred — include it: `text TEXT NOT NULL CHECK (length(text) > 0)`.)
- `completed INTEGER NOT NULL CHECK (completed IN (0,1))` — enforces INV-E's storage form; a non-0/1
  write violates the CHECK and rolls back (INV-K).
- `position INTEGER NOT NULL` — insertion order (INV-D). The API assigns `position` = the array index
  of each todo in the incoming `PUT` body (0-based), and `GET` returns `ORDER BY position ASC`.

### 2.3 Bind (INV-G) — port is the single source of truth (F67)
`server/index.js` defines **one** port constant at the top:
`const PORT = Number(process.env.TODOS_PORT) || 8787;` and binds with it:
`Bun.serve({ hostname: '127.0.0.1', port: PORT, fetch: handler })`. **Literal `127.0.0.1`**, never
`0.0.0.0`/`localhost`. This `PORT` value is the **only** place `8787` is written; the Vite proxy
target and the preview flow derive from the same `TODOS_PORT` env (§3.1/§3.2), so the three consumers
can never drift (F67).
- **Fail loud on bind error (F65):** `Bun.serve` throws synchronously on `EADDRINUSE`. The startup
  code MUST NOT swallow this — let it propagate so the process exits **non-zero** with the error
  printed. On success, **log the bound address** (`http://127.0.0.1:${PORT}`) to stdout as a
  readiness marker the dev launcher (`scripts/dev.mjs`) can poll for (§3.2). A silently-dead API is the INV-I hole F65
  describes; a loud crash makes a port clash obvious instead of degrading to a no-op app.

### 2.4 Routes and exact contracts
The `fetch` handler dispatches on method + pathname. **Only** `/api/todos` (both verbs) and
static-file serving (preview/prod mode) are handled; everything else → `404`.

**`GET /api/todos`**
- Query `SELECT id, text, completed, position FROM todos ORDER BY position ASC`.
- Map each row to `{ id: row.id, text: row.text, completed: row.completed === 1 }` — marshal the
  `INTEGER` back to a **JS boolean** (INV-E). Drop `position` from the wire shape (N4: exactly
  `{ id, text, completed }`).
- Respond `200` `application/json` with the array (empty DB → `[]`, never `404`/`null`).

**`PUT /api/todos`** — guards run **before** any DB work, in this order:
1. **Body-size cap (INV-L) — enforced *before* buffering (F63):**
   - Require a `Content-Length` header. If **absent** (chunked / `Transfer-Encoding: chunked`), reject
     **`411 Length Required`** — this endpoint only accepts a length-declared whole-list PUT from the
     controlled frontend, so refusing chunked bodies outright is defensible and closes the
     "`Content-Length` is `null` on chunked requests" bypass F63 verified on Bun 1.3.11.
   - If `Content-Length` parses to a number **> `1_048_576`** → `413` immediately, before reading.
   - Then read the body via a **streaming reader** (`for await (const chunk of req.body)` / a
     `req.body.getReader()` loop), maintaining a **running byte total**; the instant the total exceeds
     `1_048_576`, **abort the read and return `413`** — do NOT call `await req.json()`/`req.text()`,
     which buffer the *entire* body into memory first and therefore do not prevent the OOM/DoS INV-L
     exists to stop (F63). Only after the full body is confirmed ≤ cap is it decoded and JSON-parsed
     (step 3). This makes "rejected before buffering the whole body" a real property, not an
     after-the-fact status.
2. **Origin/Host guard (INV-L) — default-DENY, port-derived allowlist (F66, F70):**
   let `origin = req.headers.get('Origin')`, `host = req.headers.get('Host')`.
   - **The allowlist is derived from the configured ports, not hardcoded literals (F66).** Build it at
     startup from `PORT` (§2.3, the API/preview port) and the **pinned** dev port `5173` (guaranteed
     stable by `server.strictPort: true`, §3.1): the allowed origins are
     `http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, `http://127.0.0.1:5173`,
     `http://localhost:5173`. Because `TODOS_PORT` and `strictPort` fix both ports, a test/dev run on a
     temp `TODOS_PORT` gets a matching allowlist entry automatically, and a busy-5173 Vite fallback can
     no longer occur — closing the "self-inflicted 403 on the legit app" hole F66 describes.
   - **`Host` MUST be present AND loopback (default-deny, F70).** Reject `403` if `host` is **absent**,
     or if its hostname is NOT `127.0.0.1` or `localhost`. A request with **no `Host` at all** is
     **rejected**, not vacuously allowed — a non-browser client (crafted socket, `curl --http1.0`,
     header-stripping proxy) that omits both `Host` and `Origin` must not slip through the guard the
     way the earlier draft allowed.
   - Reject `403` if `origin` is **present** and NOT in the allowlist above. A **missing `Origin`**
     (same-origin non-CORS requests legitimately omit it) is tolerated **only because the mandatory
     `Host`-present-and-loopback check above already gates the request** — Origin-absent alone never
     opens the door.
3. **Parse + shape-validate the body:** decode the byte buffer accumulated in step 1 (already
   confirmed ≤ cap) to a UTF-8 string and `JSON.parse` it inside try/catch — **never** `await
   req.json()` (which re-reads/buffers the body unbounded, defeating step 1). Require the parsed value
   to be an **array**; require **every** element to be an object with `id` a non-empty string, `text` a
   non-empty string, `completed` a boolean (`true`/`false`). Any non-conformance → `400`
   (non-conforming body, INV-K) — the server does NOT re-run todo rules (N7), it only refuses shapes
   the schema declares impossible. **No DB write occurs** on a `400`.
4. **Transactional replace (INV-D/INV-K):** run inside **one explicit transaction**:
   ```
   const replace = db.transaction((rows) => {
     db.run('DELETE FROM todos');
     const insert = db.prepare(
       'INSERT INTO todos (id, text, completed, position) VALUES (?, ?, ?, ?)'
     );
     rows.forEach((t, i) => insert.run(t.id, t.text, t.completed ? 1 : 0, i));
   });
   ```
   Call `replace(rows)` inside try/catch. `bun:sqlite`'s `db.transaction()` **auto-rolls-back if the
   function throws** — so a duplicate-id INSERT (PRIMARY KEY violation) or a CHECK violation thrown
   **after** the DELETE rolls the DELETE back too; the DB retains the **old** list intact (INV-K, the
   core anti-total-loss guarantee). Autocommit-per-statement is **forbidden** (§8).
5. **Responses:** success → `200` (empty JSON body or `{"ok":true}`; storage.js only reads status).
   A caught constraint/shape error attributable to the client → `400`; an unexpected DB error → `500`.
   In **all** error cases the transaction has rolled back and nothing partial persisted. The handler
   MUST NOT let an error escape unhandled (wrap the whole handler body in try/catch → `500`).

### 2.5 Static serving (preview/prod only)
When launched in serve-`dist` mode (see §3), the same `Bun.serve` handler, for any non-`/api` GET,
serves the corresponding file from `dist/` (falling back to `dist/index.html` for SPA routes). In dev
this branch is unused (Vite serves assets; the API process only answers `/api`). A single env flag or
a `dist/` existence check selects the behavior; the plan uses **one server file** for both modes.

---

## 3. Dev + build/preview wiring (INV-I) — exact `package.json` + `vite.config.js` changes

### 3.1 `vite.config.js` — **merge** the proxy into the existing config (do NOT replace the file, F61)
The live file already defines `resolve.alias` (`@` → `./src`) that **every shadcn import in App.jsx
depends on** (`@/lib/utils`, `@/components/ui/*`). The proxy is **added alongside** the existing
`plugins` and `resolve` keys — the alias, the `node:url` imports, and `plugins: [react()]` are all
**preserved verbatim** (F61). The full merged file, which the builder writes in place, is:
```
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// Single source of truth for the API port — must match server/index.js's TODOS_PORT default (§2.3, F67).
const API_PORT = Number(process.env.TODOS_PORT) || 8787;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),   // PRESERVED — shadcn imports depend on it (F61)
    },
  },
  server: {
    strictPort: true,                        // pin dev to 5173; never silently shift to 5174 (F66)
    proxy: {
      '/api': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: false },  // target derives from TODOS_PORT (F67)
    },
  },
});
```
- **F61:** the `resolve.alias` block is retained unchanged. A builder who "applies §3 verbatim" now
  writes a config that still resolves `@/...`, so the app compiles in every run mode. The build order
  (§6 step 3) is updated to say "**merge** these keys, preserving `resolve.alias`," not "replace."
- **F66:** `server.strictPort: true` guarantees the dev origin is always `:5173`, so the §2.4 Origin
  allowlist entry for `5173` is always valid and Vite fails fast (rather than shifting port and
  self-403'ing the legit app) if `5173` is busy.
- **F67:** the proxy `target` reads the **same** `TODOS_PORT` env the server binds to, so moving the
  port for a test/dev run moves the proxy target with it — no `8787` literal duplicated here.
- `changeOrigin: false` keeps the browser's `Origin`/`Host` intact so the API's INV-L guard sees the
  real local origin (a proxied dev request presents `Host: 127.0.0.1:5173` / `Origin:
  http://localhost:5173`, both derived into the allowlist in §2.4).

### 3.2 `package.json` scripts — exact new set
```
"scripts": {
  "server": "bun server/index.js",
  "dev": "node scripts/dev.mjs",
  "build": "vite build",
  "preview": "vite build && bun server/index.js",
  "test": "vitest run"
}
```
- **`dev` — starts the API, *verifies it is listening*, then starts Vite (F65).** The naive
  `bun server/index.js & vite` is **rejected**: `&` discards the API's exit status, so a port clash
  (`EADDRINUSE`) kills the backgrounded API while Vite still comes up, yielding an app that proxies
  `/api` to a dead port and silently persists nothing (the exact INV-I hole F65 describes; the
  load/save fallbacks swallow the connection-refused). Instead the single dev entry is a small
  dev-only launcher **`scripts/dev.mjs`** (new, not under `src/`) that:
  1. spawns `bun server/index.js` as a child (inheriting stdio so its logs/errors are visible);
  2. **polls readiness** — `GET http://127.0.0.1:${TODOS_PORT||8787}/api/todos` — until it responds
     **or** the child exits **or** a timeout (e.g. 5 s) elapses;
  3. if the child exited (bind error, `EADDRINUSE`) or readiness timed out, it **prints the error and
     exits non-zero WITHOUT starting Vite** — a port clash is a visible, hard failure, never a silent
     no-op;
  4. only on confirmed readiness does it spawn `vite` as a second child, and it wires signal handling
     so **Ctrl-C tears down BOTH** children and propagates their exit status.

  Uses only Node/Bun built-ins (`node:child_process`, global `fetch`) — **no new dependency**. This
  replaces the fragile shell `&`; it is a small orchestration file, not application logic.
  - **Two-terminal fallback (documented, equivalent):** `bun run server` in one terminal (which now
    fails loudly on bind error per §2.3) and `vite` in another. Because the server fails loud, a dead
    API is obvious in its own terminal. The single `bun run dev` MUST still bring up a persisting app
    or abort visibly — never come up half-working.
- **`preview`**: builds `dist/` then runs the **Bun server**, which serves `dist/` **and** `/api`
  from `127.0.0.1:${TODOS_PORT||8787}` — one origin, API always reachable (INV-I in preview/prod). The
  server reads the **same `TODOS_PORT`** as the bind (§2.3), so preview honors the single port source
  of truth (F67). **`vite preview` is removed**, closing the D3 404 hole; and because the server fails
  loud on a bind error (§2.3), a preview port clash is a visible crash, not a silent no-op (F65).
- **`build`**: unchanged (`vite build`) — pure static build; not a run mode, so INV-I does not apply.
- **`server`**: convenience to run the API alone (used by the two-terminal fallback and by
  integration tests); fails loud on bind error (§2.3).

*(If the arbiter prefers to avoid the `scripts/dev.mjs` helper, the acceptable minimal
alternative is `concurrently` + `wait-on` as devDeps — deliberately avoided to keep zero new runtime
deps, but the binding requirement is: a dev/preview startup failure of the API MUST surface as a loud,
non-zero failure, not a silently non-persisting app.)*

README's "Run it" block should be updated to reflect that `bun run preview` now serves via the Bun
server (documentation only; not a spec requirement, but keeps INV-I honest).

---

## 4. Frontend changes

### 4.1 `src/storage.js` — full rewrite (async, total, timeout, save-serialized)
Replaces the two `localStorage` calls. Imports `sanitizeTodos` from `./todos.js` (already exported).
Uses a relative URL `'/api/todos'` (same-origin in every mode, D3). Pseudocode-level shape:

```
import { sanitizeTodos } from './todos.js';
const URL = '/api/todos';
const TIMEOUT = 3000;

// --- loadTodos: Promise<Array<Todo>>, NEVER rejects (INV-F) ---
export async function loadTodos() {
  try {
    const res = await fetch(URL, { signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) return [];                 // non-2xx incl. 404 → fallback (§6)
    let data;
    try { data = await res.json(); }        // non-JSON body → catch → fallback
    catch { return []; }
    return sanitizeTodos(data);             // shape parity + array guard (INV-C)
  } catch {                                  // network error / timeout / abort
    return [];
  }
}

// --- save serialization state (module-scoped, INV-J) ---
let inFlight = null;        // AbortController of the current PUT
let pending = null;         // latest list awaiting send while one is in flight
let sending = false;

// saveTodos: Promise<boolean>, NEVER rejects (INV-F), newest-state-wins (INV-J)
export async function saveTodos(list) {
  pending = list;                          // coalesce: remember the newest state
  if (inFlight) inFlight.abort();          // cancel a now-stale in-flight PUT
  if (sending) return false;               // a drain loop is already running; it will pick up `pending`
  sending = true;
  let lastResult = false;
  try {
    while (pending !== null) {
      const body = pending; pending = null;
      const ctrl = new AbortController();
      inFlight = ctrl;
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
      try {
        const res = await fetch(URL, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        lastResult = res.ok;               // success decided by status only (§6)
      } catch {
        lastResult = false;                // network/timeout/abort → false
      } finally {
        clearTimeout(timer);
        if (inFlight === ctrl) inFlight = null;
      }
    }
  } finally {
    sending = false;
  }
  return lastResult;
}
```
Notes binding on the builder:
- **INV-F:** neither function ever rejects; every branch returns `[]`/`false`. `res.json()` is wrapped
  (fetch does not reject on 4xx/5xx). Timeout via `AbortSignal.timeout`/`AbortController` at 3000 ms.
- **INV-J:** the coalescing drain guarantees the **last** body sent is the newest `todos` the client
  held; a stale in-flight PUT is aborted before a newer one starts, so it cannot commit after the
  newer state. (Residual: two browser tabs are not coordinated — see §9 weak point.)
- The exact boolean return of a coalesced call (when `sending` was already true) is `false` by
  convention; App.jsx ignores the boolean (best-effort, INV-F), so this is contract-safe.

### 4.2 `src/App.jsx` — the persistence seam only (D2 hydration guard; F64 + F68 fixed)
The changes are confined to the persistence seam: the **line-53 initializer**, the **new refs**, the
**mount load effect**, and the **gated save effect (lines 62–64 region)**. **No markup, no event
handler, and — importantly — no import line changes** (N2/INV-B). In particular the load path does
**not** reference `sanitizeTodos`, so the App.jsx import block (lines 12–21) is **untouched** (F68);
`storage.js.loadTodos()` already returns `sanitizeTodos(data)` (§4.1), so re-sanitizing in App.jsx
would be both a `ReferenceError` (the symbol is not imported) and redundant. The fix is to **drop the
extra call**, not to add an import.

Replace the synchronous initializer and add the seam refs:
```
// was: const [todos, setTodos] = useState(() => loadTodos());
const [todos, setTodos] = useState([]);           // start empty; async load populates
const hydratedRef = useRef(false);                // authoritative gate (read sync in effect)
const skipNextSaveRef = useRef(false);            // suppress the load-applied echo (D2 step 3)
const editedBeforeHydrationRef = useRef(false);   // a user mutation landed pre-hydration (F64)
```

Mount load effect (abortable for StrictMode, D2 step 4) and the gated save effect:
```
// Mount load — runs once; abort/ignore-safe under StrictMode double-invoke.
useEffect(() => {
  let ignore = false;
  loadTodos().then((result) => {          // loadTodos never rejects; already sanitized (INV-F/§4.1)
    if (ignore) return;                    // stale (unmounted) instance → no setState, no flip

    if (editedBeforeHydrationRef.current) {
      // F64: the user already added/edited a todo during the pre-hydration flash.
      // Do NOT clobber that edit with the server list. Keep the user's in-memory
      // state authoritative, hydrate, and let the save effect flush it as the first PUT.
      hydratedRef.current = true;          // NOTE: skipNextSaveRef stays false here on purpose…
      // …but state did not change, so no save effect runs from this branch. Force a flush
      // of the user's current list by re-committing it (identity-preserving) so the now-
      // hydrated save effect emits exactly one PUT carrying the user's edit:
      setTodos((current) => current.slice());   // new array ref → save effect runs, hydrated=true, PUT sent
      return;
    }

    skipNextSaveRef.current = true;        // the setTodos below must NOT emit a PUT (load echo)
    setTodos(result);                      // apply loaded (or []-fallback) data — already sanitized
    hydratedRef.current = true;            // hydrate AFTER settle, on success OR fallback
  });
  return () => { ignore = true; };         // cleanup marks this instance stale
}, []);

// Save effect — no-op until hydrated; skip the load-applied echo (INV-H).
useEffect(() => {
  if (!hydratedRef.current) {
    // Pre-hydration: the user interacted (todos changed from the mount []). Record it so the
    // load resolver (above) preserves this edit instead of overwriting it. No PUT yet.
    if (todos.length > 0) editedBeforeHydrationRef.current = true;
    return;                                // no PUT for mount [] nor for a pre-hydration edit
  }
  if (skipNextSaveRef.current) {           // no PUT merely re-sending the loaded list
    skipNextSaveRef.current = false;
    return;
  }
  saveTodos(todos);                        // genuine user mutation → PUT (best-effort, INV-J)
}, [todos]);
```
Why this satisfies **INV-H** and closes **F64**:
- **No `PUT []` from mount (INV-H).** Initial `[]` triggers the save effect with
  `hydratedRef.current === false` → returns without a PUT. Under any wire ordering, the mount `[]` is
  never persisted.
- **No load-echo PUT (INV-H).** On the normal (no pre-hydration edit) path, `skipNextSaveRef` is set
  before `setTodos(result)`; the resulting save-effect run consumes the flag and returns → no PUT. The
  first PUT the server ever sees is a genuine post-hydration user edit.
- **No lost update (F64).** If the user adds/edits during the pre-hydration flash, the pre-hydration
  save-effect run sets `editedBeforeHydrationRef = true` (it can only be set when `todos` became
  non-empty from mount, i.e. a real user action, since nothing else mutates `todos` before hydration).
  When the load resolves, the resolver sees the flag and **does not** `setTodos(serverResult)` —
  the user's visible todo is **not** clobbered on screen — then re-commits the user's own list
  (`current.slice()`) so the now-hydrated save effect emits **one** PUT persisting the user's edit.
  Net: the todo the user added survives in both the UI and the DB. This trades the server's stale
  list for the user's fresher intent, which is the correct whole-list "last edit wins" resolution and
  adds **no** spinner, disabled state, or other UI affordance (N2/INV-B respected; the alternative of
  disabling the input during hydration was rejected precisely because it *is* a visible affordance).
- **StrictMode (INV-H).** The cleanup sets `ignore = true`; a load resolving for an unmounted instance
  neither `setTodos` nor flips `hydratedRef`. The `editedBeforeHydrationRef` is a per-App-instance ref,
  reset to `false` on each fresh mount, so the double-invoke does not leak a stale flag.
  `AbortSignal.timeout` inside `loadTodos` makes the discarded fetch harmless. `<React.StrictMode>` in
  `main.jsx` **stays enabled**.

Ordering note (D2 step 2): on the normal path, setting `skipNextSaveRef` **before** `setTodos`, and
`hydratedRef` after, is deliberate — the save effect React runs for that `setTodos` sees both flags in
the intended state within the same commit. On the pre-hydration-edit path, `hydratedRef` is set before
the `slice()` re-commit so that the save effect it triggers is already in the hydrated branch.

Edge note (empty user intent): the pre-hydration-edit detection keys on `todos.length > 0`. A user who,
pre-hydration, only opens then closes an edit (no net list change) leaves `todos` at `[]` and the flag
false — the normal load path applies, correctly. The one behavior this deliberately does not attempt:
distinguishing "user cleared the (empty) list" pre-hydration, which is indistinguishable from mount `[]`
and has no data to lose.


### 4.3 `tests/App.a11y.test.jsx` — keep the existing App-render harness green (F62)
This file **already exists** and renders `<App/>` ~14 times under `@vitest-environment happy-dom`,
asserting synchronously via `fireEvent`. It currently relies on synchronous `localStorage`
(`beforeEach(() => localStorage.clear())`). Once `storage.js` becomes async `fetch`, **every**
`render(<App/>)` fires `loadTodos()` → `fetch('/api/todos')` on mount and `saveTodos()` → `PUT` on each
add — with **no server** in the test env — producing rejected/pending fetches and `setTodos`
resolving **after** the synchronous assertions (out-of-`act` warnings, and in strict configs,
failures). This file is therefore **in scope** and MUST be updated (it is *not* covered by the
INV-A/T1 "87 tests untouched" tripwire, which is `tests/todos.test.js` only).

**Required change (minimal, setup-only): stub `fetch` in this test file's setup so no real network
call occurs and the async seam settles deterministically.** Concretely, add to the existing
`beforeEach`/`afterEach`:
- In `beforeEach`, install a `globalThis.fetch` stub (via `vi.fn`/`vi.stubGlobal`) that:
  - for `GET /api/todos` resolves `{ ok: true, json: async () => [] }` (empty list — matches these
    tests' pre-#15 assumption that each render starts from a clean list, formerly given by
    `localStorage.clear()`);
  - for `PUT /api/todos` resolves `{ ok: true, json: async () => ({}) }` (best-effort save, ignored).
- In `afterEach`, restore the stub (`vi.unstubAllGlobals()` / restore the saved original) alongside the
  existing `cleanup()`.
- Because the seam is now async, each test that renders and then reads the list MUST let hydration
  settle: wrap the initial assertion (or the `addTodo` helper's post-submit read) in
  **`await waitFor(...)`** / `await screen.findBy...` from `@testing-library/react` so the load
  resolves inside `act` before assertions run. The `addTodo` helper becomes `async` and its call sites
  `await` it. This is a **test-harness** change only — it does not touch `src/`.

This is a real, bounded edit to one test file; the plan **owns** it rather than pretending the file is
untouched. The `localStorage.clear()` line may remain (harmless) or be removed since the app no longer
uses `localStorage`. No production behavior depends on this file.

The stale claim that "no DOM harness is installed / T6/T8 require *adding* `happy-dom` +
`@testing-library/react`" is **withdrawn** — those devDeps are already present (§0). §7 is corrected
accordingly.

---

## 5. `.gitignore` change (INV-G)

Append the literal line (a new section, matching the file's comment style):
```
# sqlite data file (ISSUE-15)
data/
```
The `data/` line matches `data/todos.sqlite` and any WAL/`-shm`/`-journal` sidecars. Satisfies INV-G/T7.

---

## 6. Step-by-step build order (execute literally)

1. **`.gitignore`** — add the `data/` line (§5). Do this **first** so the DB file can never be
   accidentally staged once the server creates it.
2. **`server/index.js`** — write per §2: `const PORT = Number(process.env.TODOS_PORT) || 8787` (single
   source of truth, F67), path resolve + `mkdir data/`, open DB, `CREATE TABLE IF NOT EXISTS`,
   `Bun.serve` on `127.0.0.1:PORT` (fail loud on bind error, §2.3/F65), `GET`/`PUT` handlers with the
   streaming body cap + default-deny Origin/Host guard (§2.4/F63/F66/F70) + transactional replace,
   static `dist/` serving branch. `touch SDLC/ledger/.build-open` before writing under `src/`/`server/`
   if the enforce hook is active.
3. **`scripts/dev.mjs`** — write the dev launcher/readiness helper (§3.2/F65): spawn the server, poll
   `GET /api/todos`, exit non-zero (with the error printed) if the child exits or readiness times out,
   otherwise spawn Vite and tear both down on Ctrl-C. Dev-only, outside `src/`.
4. **`package.json` scripts + `vite.config.js`** — apply §3. **F61: `vite.config.js` is a MERGE, not a
   replacement** — write the full merged file from §3.1 that **keeps `resolve.alias` (`@` → `./src`)
   and the `node:url` imports** and **adds** `server.strictPort: true` + the `TODOS_PORT`-derived proxy
   target. Do NOT emit a config that drops `resolve.alias` (that breaks every `@/...` import and fails
   the build in all modes). After writing, confirm `resolve.alias` is present.
5. **`src/storage.js`** — replace with the async rewrite (§4.1). Verify no remaining reference to
   `localStorage`/`parseStored`/`safeSave` in this file.
6. **`src/App.jsx`** — apply **only** the seam changes (§4.2): line 53 initializer, the new refs
   (including `editedBeforeHydrationRef`), the mount load effect, the gated save effect. **Do NOT add
   any import** — the load path does not call `sanitizeTodos` in App.jsx (F68). Diff must show **no**
   change to the import block, markup, or handlers.
7. **`tests/App.a11y.test.jsx`** — apply the fetch-stub + async-settle updates (§4.3/F62) so the ~14
   existing `<App/>` renders do not make real network calls under the async seam.
8. **Manual smoke test** (dev): `bun run dev`; verify it **aborts loudly** if port `8787` is busy
   (F65), otherwise in the browser add/toggle/edit/delete/clear/filter; confirm data survives a full
   reload (INV-D round-trip) and that `data/todos.sqlite` appears. Then `bun run preview`; confirm the
   same at `http://127.0.0.1:${TODOS_PORT||8787}` (INV-I preview). Confirm a cold start with the server
   stopped renders an empty list and does not hang (>3 s) or emit a destructive PUT (INV-F/INV-H) —
   check the server received **no** PUT on mount. Also add a todo **during** the load flash (throttle
   the server) and confirm it is **not** lost (F64).
9. **Existing pure-core suite** — `bun run test`; confirm `tests/todos.test.js`'s **87 passed**
   unchanged (INV-A/T1) **and** `tests/App.a11y.test.jsx` passes under its new fetch stub (§4.3). Any
   change to `tests/todos.test.js` is a stop-the-line defect.

---

## 7. Test-writing responsibilities for the TEST phase (guidance for the verifier)

Each spec T maps to a concrete test/check kind. **Integration tests hit the real Bun server against a
temp SQLite file** (open the DB at a temp path via an env override the server reads, so tests never
touch `data/todos.sqlite`). **Unit tests** drive `storage.js` with a stubbed `fetch`. **A DOM harness
is ALREADY installed** (`happy-dom` 15.11.7 + `@testing-library/react` 16.3.2 + `@testing-library/dom`
+ `@testing-library/jest-dom`, per §0) — the earlier "no harness; must add it" note is **withdrawn**
(F62). Component-level checks (T6/T8) are therefore real automated tests wrapped in
`@vitest-environment happy-dom` with a `fetch` stub (as `tests/App.a11y.test.jsx` will use per §4.3),
not "add a devDep or fall back to manual." Component tests that render `<App/>` MUST stub `fetch` and
`await waitFor(...)` for hydration, exactly as §4.3 specifies for the existing harness.

| T | Kind | What it proves |
|---|------|----------------|
| **T1** | existing unit suite, unchanged | 87 `todos.test.js` green (INV-A). |
| **T2** | unit on `storage.js` (stubbed fetch) + integration round-trip | `loadTodos`/`saveTodos` round-trip yields `Array<{id,text,completed:boolean}>`, `completed` a real boolean, in order (INV-C/E). |
| **T3** | integration (real server + temp DB) | save a known list, reload → equal + same order; fresh DB → `[]` (INV-D). |
| **T4** | integration | a `PUT` with a duplicate-id (and empty-id / NULL-text) row → non-2xx, `saveTodos → false`, **prior list intact** (rollback, INV-D/INV-K). |
| **T5** | unit on `storage.js` (stub: unreachable / non-2xx / hang>3s / non-JSON) | each maps to `[]`/`false`, **no unhandled rejection**, timeout aborts within budget (INV-F). |
| **T6** | component test (harness already installed) + fetch stub | add/toggle/edit/delete/clear/filter/count unchanged; no new control/message; input is **not** disabled during hydration (INV-B). |
| **T7** | static/config check | `.gitignore` matches `data/todos.sqlite`; server bind string is literal `127.0.0.1` (reject `0.0.0.0`) (INV-G). |
| **T8** | component test (harness installed) + fetch spy | pre-seed the GET stub with a non-empty list; mount making no edits → the PUT-spy records **zero** calls (no `PUT []`), stored list intact after the GET resolves (INV-H). **StrictMode mechanism (F69):** the double-invoke only occurs when the tree is wrapped, so this test MUST render **`render(<React.StrictMode><App/></React.StrictMode>)`** (a bare `render(<App/>)` does NOT double-invoke effects and would falsely pass) and assert (a) still zero PUTs and (b) no `setState`-after-unmount warning (proving the abort/`ignore` guard). Add a companion case for F64: pre-seed the GET stub to resolve *slowly*, fire an add during the flash, and assert the added todo survives (exactly one PUT carrying it, not a `PUT` of the server list). |
| **T9** | script/CI check | in `dev` and `preview` runs, `GET /api/todos` returns the JSON array (not 404/HTML) (INV-I). |
| **T10** | unit on `storage.js` (stub delaying v1's response past v2) + integration | `PUT(v1)` then `PUT(v2)` → DB ends holding **v2**, never v1 (INV-J). |
| **T11** | integration | `PUT` with foreign `Origin` → `403`; `PUT` with a non-loopback `Host` → `403`; **`PUT` with NO `Host` and NO `Origin` → `403` (default-deny, F70)**; a **chunked** `PUT` (no `Content-Length`) → `411` (F63); an over-1MB `Content-Length` → `413` **before** reading; a body that streams past 1MB → `413` with the read aborted (not fully buffered), asserted e.g. by capping peak memory / confirming `req.json()` is never called (F63). Every rejection leaves the DB unmutated (INV-L). |

The server MUST expose the DB path via an env var (e.g. `TODOS_DB_PATH`) defaulting to
`data/todos.sqlite` and the port via **`TODOS_PORT`** defaulting to `8787`, **solely** so integration
tests can point at a temp file/port. `TODOS_PORT` is the **single source of truth** consumed by the
server bind (§2.3), the Vite proxy target (§3.1), the preview flow (§3.2), and the readiness helper
(§3.2) — so a test/dev run on a temp port moves **all** of them together and the Origin allowlist
derives a matching entry (§2.4/F66/F67). T9's dev-reachability check therefore sets `TODOS_PORT` once
and both the server and the proxy follow. This is a test-affordance, not a feature; it does not change
the pinned production path/bind (INV-G still asserts the default literals `127.0.0.1`/`8787`).

---

## 8. Non-goals reaffirmed (belt-and-suspenders against scope creep)

- **`src/todos.js` — zero changes** (N1/INV-A). The 87 tests are the tripwire.
- **`src/App.jsx` — only the persistence seam** (line-53 initializer, the new refs incl.
  `editedBeforeHydrationRef`, the mount load effect, and the 62–64 save-effect region): **no import
  change**, no markup, handler, label, filter, count, spinner, banner, disabled-input, or new
  user-facing state (N2/INV-B). The hydration guard and its lost-update fix (F64) are internal and
  invisible.
- **`tests/App.a11y.test.jsx` — in scope, setup-only** (§4.3/F62): a `fetch` stub + `await waitFor`
  so its existing `<App/>` renders survive the async seam. This is **not** a violation of the "87
  tests untouched" tripwire, which covers `tests/todos.test.js` only.
- **No migration** from `localStorage` (N6): fresh empty DB; the old key is simply no longer read (not
  deleted).
- **No ORM / server-side business logic** (N7): the server stores/returns rows and enforces only
  schema constraints + body shape; all todo semantics stay in the pure core and UI.
- **No auth / multi-user / remote bind** (N5): loopback-only; the sole security control is the INV-L
  write guard + body cap.
- **No SDLC/`.github`/`.claude` changes** (N8).

---

## 9. Weakest points (named for the adversary — attack these)

1. **Two-tab save ordering (INV-J residual).** Client-side serialization coalesces one client's bursts
   but does **not** coordinate across browser tabs; two tabs still race with last-committed-PUT-wins
   (explicitly the accepted §8 "last-write-wins across tabs" semantics). If the arbiter wants the tab
   case hardened, the server-side monotonic sequence guard (§8 option 2) is the addition — flagged, not
   silently omitted.
2. **`dev`/`preview` startup-failure surfacing.** The naive `bun server/index.js & vite` was
   **rejected** (F65) because `&` swallows an `EADDRINUSE` and yields a silently non-persisting app;
   the plan now (§2.3) makes the server **fail loud (non-zero) on bind error** and (§3.2) gates Vite
   behind `scripts/dev.mjs`, which polls readiness and exits non-zero (before starting Vite) if the API dies. The
   residual worth ratifying: this adds a small dev-only helper script (or, alternatively,
   `concurrently` + `wait-on` devDeps) rather than a bare `&`. The binding requirement — a startup
   failure MUST be loud, never a working-looking no-op — is met either way; the exact helper vs devDep
   is the arbiter's call.
3. **Empty-`text` enforcement location.** The spec says text is "non-empty as stored." This plan
   enforces non-empty at **both** the DDL `CHECK(length(text) > 0)` and the body validator. If a builder
   omits the DDL CHECK and relies only on the validator, an empty-text row could slip past the schema —
   so the DDL CHECK is **required**, not optional. Called out to prevent that shortcut.
4. **`Origin`-absent requests.** Same-origin non-CORS `fetch` may omit `Origin`; the guard therefore
   falls back to the `Host` check when `Origin` is absent. An attacker who can forge `Host` to
   `127.0.0.1` from a foreign page generally cannot (browsers set `Host` from the URL authority), but
   this is the subtlest part of INV-L and the spot to probe.
5. **`AbortSignal.timeout` availability.** Requires a modern runtime; Bun 1.3.11 and current browsers
   have it. If a target browser lacks it, the `AbortController` + `setTimeout` pattern used in
   `saveTodos` is the portable fallback and can be used in `loadTodos` too. Noted so a builder does not
   assume one form everywhere.
6. **Pre-hydration edit heuristic (F64 fix, our current weakest point).** The lost-update fix keys the
   "user edited before hydration" signal on `todos.length > 0` in the pre-hydration save-effect run.
   This is correct for the only pre-hydration mutations the UI can produce (an *add* — the only way to
   grow the list from mount `[]`; toggle/edit/delete/clear are no-ops on an empty list, so they cannot
   fire before the user has added something). It deliberately does **not** try to preserve a
   pre-hydration sequence that returns the list to empty (indistinguishable from mount `[]`, and it has
   no user data to lose). If the arbiter wants a stricter signal, the alternative is a dedicated
   `didUserInteractRef` flipped by the actual event handlers — rejected here because it would require
   editing handlers (N2/INV-B risk) for a case the length heuristic already covers. This is the spot to
   probe: construct a pre-hydration interaction the length heuristic misclassifies.
