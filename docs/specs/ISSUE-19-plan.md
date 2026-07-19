# ISSUE-19 — PLAN — Add end-to-end integration tests

Status: PLAN (draft for the plan gate)
Owner: architect
Work item: ISSUE-19
Spec: [docs/specs/ISSUE-19.md](./ISSUE-19.md) (ratified; spec gate OPEN) — this plan implements it
verbatim; where they conflict, the spec wins and this plan is the bug. The spec already absorbed the
adversary's three accepted findings: F1 (R6 split into R6a shape-rejection / R6b constraint-rollback),
F2 (R10(c) asserts the server GET, not the coalesced call's boolean), F3 (port acquisition must be
race-safe against parallel Vitest workers). This plan makes each concrete.

**Revision note (findings F4-F8 addressed):** This plan was attacked and five real defects were
confirmed. The concrete fixes are folded into sec.4, sec.6, and sec.9 below and summarised here so the
builder does not re-derive them:
- **F4** - undici (the platform `fetch`) silently overrides any user-set `Host` and always sends a
  `Host`; a forged/missing-`Host` request is **unproducible via `fetch`**. R9(c) and the missing-`Host`
  case are now proven with a **raw `node:net` socket** writing a hand-built HTTP/1.1 request (built-in
  module, no dep, INV-G). Lives in a new fixture helper `rawRequest()` (sec.4.7) and drives T7(c) (sec.6).
- **F5** - a declared-over-cap `Content-Length` is **rejected client-side by undici** (length/body
  mismatch) and never reaches the server; the true mid-stream cap (`server/index.js:234`) is
  unreachable via `fetch`. T6 is rebuilt: R8 is proven with **one real >1 MB JSON body via `fetch`**
  (exercises the declared-length branch `server/index.js:222`); the mid-stream cap
  (`server/index.js:234`) is proven **optionally** via the same raw-socket helper, else declared
  out-of-scope for this suite (sec.6 T6).
- **F6** - Vitest 1.6.1's default pool is **`threads`** (verified), not `forks`. All references
  corrected; the option-B fallback knob is `poolOptions.threads.singleThread` (or
  `fileParallelism:false`).
- **F7** - the crash-safety `process.once('exit', ...)` handler is **sync-only** and cannot await the
  async `rm()`; it now uses **`fs.rmSync(dbDir, {recursive:true, force:true})`** (sec.4.5).
- **F8** - the EADDRINUSE-retry readiness poll (`GET .../api/todos`) cannot tell **our** child from a
  foreign parallel-worker server squatting the same port. Readiness is now gated **first** on **our
  child's own stdout readiness marker** (`server/index.js:289`, printed only to our spawned process's
  own stdout), with the `GET` demoted to a **secondary** confirmation after the marker (sec.4.4).

---

## 0. Grounding re-verified before planning

Re-read against the live tree on branch `sdlc/issue-19`, not assumed:

- **`server/index.js` (290 lines)** - the exact server this plan drives as a subprocess. Load-bearing
  facts the tests depend on, cited to line:
  - `PORT = Number(process.env.TODOS_PORT) || 8787` (line 22); `dbPath = process.env.TODOS_DB_PATH ||
    <repo>/data/todos.sqlite` (lines 39-41). Both are read **at module load**, so they MUST be in the
    child's `env` at spawn time - they cannot be changed after the process starts.
  - `db.exec('PRAGMA journal_mode = WAL;')` (line 48) - so a run produces `<dbPath>`, `<dbPath>-wal`,
    and `<dbPath>-shm` sidecars. Teardown MUST remove all three (or delete a whole temp *directory*).
  - Readiness marker printed to **stdout**: `` `todos API listening on http://127.0.0.1:${server.port}` ``
    (line 289). `server.port` is the actually-bound port. **This line is printed by, and only by, the
    Bun process this fixture spawns, on that process's own stdout stream** - it is the F8 liveness proof
    that a foreign server on the same port cannot forge into *our* child's captured stdout.
  - `Bun.serve({ hostname: '127.0.0.1', port: PORT, ... })` (lines 282-286) binds **hard** and Bun
    throws **synchronously on `EADDRINUSE`** (comment lines 280-281). An unhandled throw at module top
    level exits the child **non-zero** - this is the crash F3/R11(f) must survive. Critically, a bind
    failure means our child **never reaches line 289**, so its stdout never carries the marker: the
    absence of our-own-marker + child `exit` is the unambiguous retry trigger (F8).
  - `GET /api/todos` (lines 204-212): `SELECT ... ORDER BY position ASC`, marshals `completed` to a JS
    boolean via `row.completed === 1` (line 209), returns `200 []` on empty DB. Drops `position` from
    the wire shape.
  - `PUT /api/todos` guard order (lines 214-261) is **fixed and MUST be respected by the tests**:
    1. `Content-Length` **absent** -> `411` (lines 217-220);
    2. `Content-Length` non-finite **or** `> 1_048_576` -> `413` (lines 221-224) - the **declared-length**
       branch (server line 222);
    3. Origin/Host guard (`checkWriteGuard`, lines 133-154) -> `403`;
    4. stream body with running cap; over-cap **mid-stream** -> `413` (lines 233-236) - the
       **mid-stream** branch (server line 234), reachable only when `Content-Length` is absent/under-cap
       but the actual streamed bytes exceed the cap;
    5. `JSON.parse` failure -> `400` (lines 240-244);
    6. `isConformingList` false -> `400` (line 245);
    7. `replaceAll` throws with `"constraint"` in the message -> `400`, else `500` (lines 250-259);
    8. success -> `200 {"ok":true}`.
  - `isConformingList` (lines 91-100): array of objects each with **non-empty-string `id`**,
    **non-empty-string `text`**, **boolean `completed`**. This is the F1 dividing line: empty-`id`
    (line 95) / empty-`text` (line 96) fail **here** (step 6, before `replaceAll`); a **duplicate id**
    is shape-valid, passes here, reaches `replaceAll` (line 251), and trips the `id TEXT PRIMARY KEY`
    (server line 55) on the second `INSERT` - `bun:sqlite` throws `"constraint"`, the transaction
    auto-rolls-back the preceding `DELETE`, handler returns `400` (lines 252-256). Only this path
    exercises INV-K.
  - `readCappedBody` (lines 105-128): streams the request body chunk-by-chunk, returning `null` the
    instant the running byte count exceeds `MAX_BODY_BYTES` (line 114). The `null` -> `413` at server
    line 234 is the **mid-stream** cap. **F5 reality:** this branch is only distinct from the
    declared-length branch (line 222) when the client sends a body larger than its declared
    `Content-Length` (or a chunked body with no length). The platform `fetch`/undici **computes an
    accurate `Content-Length` from the body and refuses to send a mismatched one**, so via `fetch` a
    real >1 MB body is caught at line 222 (declared branch), never at line 234. Reaching line 234
    requires a **raw socket** that lies about (or omits) `Content-Length`.
  - `checkWriteGuard` (lines 133-154): **`Host` absent -> 403** (line 139); `Host` hostname not
    `127.0.0.1`/`localhost` -> `403` (lines 142-145); a **present** `Origin` not in `ALLOWED_ORIGINS`
    -> `403` (line 149); a **missing** `Origin` is tolerated (Host already gated it). `ALLOWED_ORIGINS`
    (lines 27-32) is derived from `PORT` + `5173`: `http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`,
    `http://127.0.0.1:5173`, `http://localhost:5173`. **Consequence for the tests:** a `fetch` to
    `http://127.0.0.1:<port>/api/todos` with **no `Origin`** header (the default for a same-origin-style
    request) passes, because Node/Bun `fetch` sends `Host: 127.0.0.1:<port>` automatically and omits
    `Origin`. So the tests' own writes succeed with zero special headers. **F4 reality:** the R9
    *foreign-Origin* negative case (line 149) IS producible via `fetch` (a request-header `Origin` is
    passed through). But the R9 *forged/absent-Host* cases (lines 139/142) are **NOT** producible via
    `fetch`: undici silently overwrites any user-supplied `Host` with the real socket authority and
    always sends one, so a non-loopback or missing `Host` cannot be constructed with `fetch`. Those
    cases require a **raw `node:net` socket** (sec.4.7 / T7(c)).
- **`src/storage.js` (85 lines)** - the seam under test for R10. `API_URL = '/api/todos'` (relative,
  line 15); `loadTodos()` never rejects, returns `sanitizeTodos(data)` (line 34); `saveTodos()` never
  rejects, coalesces (line 56 returns `false` when a drain loop is already running - the F2 fact), and
  the **drain-owning** call returns the last real result. Timeout is `AbortSignal.timeout(3000)` /
  `AbortController` + `setTimeout(3000)`. **Because `API_URL` is relative, the seam test MUST make it
  resolve to the spawned server's origin** (see sec.5).
- **`scripts/dev.mjs` (103 lines)** - the working spawn-and-poll reference: `spawn('bun',
  ['server/index.js'], { env })`, `waitForReady()` polls `GET .../api/todos` until `res.ok` or the
  child exits or a 5 s deadline, and tears children down on exit/signal. The integration fixture mirrors
  this pattern (spawn + reap) **but does NOT copy its readiness poll verbatim**: `dev.mjs` runs one
  server with no port race, so a portable GET is safe for it; the integration fixture runs under
  parallel Vitest workers where a GET can hit a foreign server (F8), so it gates readiness on the
  child's own stdout marker first (sec.4.4), **plus** the EADDRINUSE-retry the dev launcher does not need.
- **Existing tests & runner (verified):**
  - `tests/todos.test.js` (87 cases, node env, imports only `../src/todos.js`) - the INV-A tripwire,
    **byte-for-byte untouched**.
  - `tests/App.a11y.test.jsx`, `tests/App.hydration-f33.test.jsx` - happy-dom, **stub `fetch`**, use the
    per-file `// @vitest-environment happy-dom` pragma, `globals:false` idioms (own `afterEach(cleanup)`,
    import `@testing-library/jest-dom/vitest`). Structure to match: `import { afterEach, beforeEach,
    describe, expect, it, vi } from 'vitest'`.
  - `tests/test_ledger.py` - SDLC tooling, unrelated.
  - **`vitest@1.6.1`** installed (`bun pm ls`). **No `vitest.config.*` and no `test` block in
    `vite.config.js`** (verified) -> Vitest runs its **default `threads` pool** (verified against the
    installed build: `pool: "threads"` - worker_threads, **not** child_process `forks`), **files in
    parallel** (F3/R11(f) is real). `bun run test` == `vitest run`.
  - `package.json` scripts: `server`/`dev`/`build`/`preview`/`test`. `bun` is on `PATH`
    (`/root/.bun/bin/bun`). No heavyweight test deps; this plan adds **none** (R11/N6).
- **`sanitizeTodos` (src/todos.js lines 130-148)** - the seam's load path runs data through it: it
  **drops** malformed elements, **coerces** `completed` to `element.completed === true`, and
  **de-duplicates ids keeping the first**. The R10 round-trip fixtures MUST use already-conforming,
  unique-id lists so `sanitizeTodos` is an identity and the assertion is a clean deep-equal (sec.5, T8a).

---

## 1. Decisions locked (resolving the spec's open questions Q1-Q6)

| # | Decision | Why (grounded) | Spec hook |
|---|----------|----------------|-----------|
| **Q1 -> in default `bun run test` + optional alias** | Integration files live under `tests/integration/` and run in the default `vitest run`; **add** a `package.json` script `"test:integration": "vitest run tests/integration"` for focused runs. | The repo already runs `bun` everywhere and `bun` is on `PATH` (sec.0); one green bar. The alias is a pure `scripts` addition (permitted by N1). | Q1, R11, N1 |
| **Q2 -> `node` env for all integration files** | Every integration file carries `// @vitest-environment node`. Node 22 / the vitest node runtime has global `fetch` + `AbortSignal.timeout` (used by `storage.js`) + `node:net` (raw-socket helper, sec.4.7), so the seam test imports `src/storage.js` directly with **no happy-dom**. | No DOM is needed for pure-HTTP tests, and the seam test needs only a real socket + a base-URL resolver (sec.5), not a document. Smallest env. | Q2, D3 |
| **Q3/D2 -> retry-on-EADDRINUSE spawn loop (option A), NO config file** | The spawn helper picks a candidate port, spawns the child, watches for early exit / an `EADDRINUSE` signal, and on a lost race **re-picks a fresh port and retries**, bounded at **5 attempts**; exhaustion fails loudly. | Option A tolerates the TOCTOU race F3 names **without** a `vitest.config.*` - the smallest change that satisfies R11(f), and the only one that also survives a race with a **non-Vitest** external process (which serialization alone cannot). Keeps existing suites' execution byte-identical (R12/INV-A) since no runner config is added. | Q3, Q6, D2(A), R11(f) |
| **Q4 -> proxy / dist static-serve OUT of scope** | No Vite-proxy hop and no `dist/` static-serve test in this item. | N4: config/ergonomics, not app behavior; `dist/` needs a prior `vite build`. Confirmed out. | Q4, N4 |
| **Q5 -> throwaway DB in OS temp dir, unique per run, dir-scoped cleanup** | `TODOS_DB_PATH` points at `<os-tmpdir>/todos-int-<random>/db.sqlite`; teardown deletes the **whole `todos-int-<random>` directory** (db + `-wal` + `-shm` in one shot). | Zero repo footprint, no `.gitignore` change; deleting the directory guarantees the WAL sidecars go too (INV-B). | Q5, INV-B |
| **Q6 -> no `vitest.config.*` added** | Because Q3 chooses option A, **no** runner config file is created. | Confirms the preferred path; avoids any INV-A/R12 risk to the existing suites. | Q6, N1, R12 |

**Weakest point (named up front):** the EADDRINUSE-retry (sec.4) relies on **detecting** a bind failure
distinctly from a slow-but-healthy start, **and** on binding readiness to *our own* child rather than a
foreign server that won the port race (F8). If the helper accepted a portable `GET` as proof of
readiness it could bind the whole test file to a stranger's server/DB and silently cross-contaminate.
sec.4.4 pins the exact detection contract - **readiness requires our child's own stdout marker
(server line 289) first; the child's `exit` event is the retry trigger; a `GET` is only a secondary
confirmation once the marker has already proven the process is ours** - to close this. The
second-weakest point is that `storage.js`'s relative `/api/todos` has no origin under `node`; sec.5 pins
the base-URL resolver mechanism and forbids stubbing the *response*.

---

## 2. Files to create / touch (summary; details in sec.3-sec.6)

**New (all under `tests/`, so the build-gate `src/` guard is not tripped):**
- `tests/integration/helpers/server.js` - the shared spawn/readiness/reap/temp-DB fixture (sec.4),
  **including the raw-socket `rawRequest()` helper (sec.4.7)** that F4/F5 depend on. Not a `*.test.js`
  file, so Vitest does not treat it as a suite.
- `tests/integration/server.test.js` - pure-HTTP contract tests T1-T5, T9 (node env) (sec.6).
- `tests/integration/guard.test.js` - body-cap + Origin/Host guard tests T6(->R8), T7(->R9) (node env)
  (sec.6). *(Split from `server.test.js` only for readability; may be one file - see sec.6 note.)*
- `tests/integration/storage-seam.test.js` - the R10 seam-against-real-server test T8 (node env) (sec.5/sec.6).

**Edited (additive only, permitted by N1):**
- `package.json` - add one `scripts` line: `"test:integration": "vitest run tests/integration"` (Q1).
  No dependency changes.

**Never touched:** `src/**`, `server/index.js`, `scripts/dev.mjs`, `vite.config.js`,
`tests/todos.test.js`, `tests/App.a11y.test.jsx`, `tests/App.hydration-f33.test.jsx`, `.github/`,
`.claude/`, `SDLC/` (N1/N7/INV-A/INV-D). **No `vitest.config.*` created** (Q6).

---

## 3. Test file layout & conventions (D3)

Each integration `*.test.js` file:
- Begins with `// @vitest-environment node` (Q2).
- Imports Vitest primitives explicitly (`globals:false`): `import { describe, it, expect, beforeAll,
  afterAll } from 'vitest'` (add `beforeEach` only where a per-test DB reset is used - see sec.6).
- Imports the shared fixture from `./helpers/server.js`.
- Uses the platform global `fetch` for all HTTP where `fetch` is *capable* (no client dep, INV-G), and
  the fixture's `rawRequest()` raw-socket helper (sec.4.7) for the cases `fetch` cannot express (forged/
  absent `Host`, and the optional mid-stream cap) - `node:net` is a built-in, so INV-G still holds.
- Structure is `describe('<area>', () => { beforeAll(startServer); afterAll(stopServer); it(...) })`.

**Server lifecycle scope (decision):** each **file** spawns **one** server in `beforeAll` and reaps it
in `afterAll`, and **resets DB state between tests via `PUT`** rather than respawning per test.
Rationale: spawning Bun per `it` would be slow and multiply the port-race surface; one server per file,
reset by writing a known list at the start of each test (or a `PUT []` where the test needs an empty
DB), keeps tests independent without re-paying startup. The **only** test that needs a genuinely fresh
DB is R4 (empty-DB `200 []`); it runs **first** in its file *before any PUT*, or spawns its own
short-lived server against a fresh temp DB - sec.6/T2 pins which.

---

## 4. The spawn/readiness/reap fixture - `tests/integration/helpers/server.js`

This is the load-bearing scaffolding (D1/D2). It exports one primary factory the test files call. Shape
(prose, not code - the builder implements):

### 4.1 `createServerFixture()` -> `{ start, stop, baseUrl, dbDir, dbPath, getTodos, putTodos, rawPut, rawRequest }`
State held per fixture instance: the child process handle, the chosen `baseUrl`
(`http://127.0.0.1:<port>`), the chosen port, the temp DB directory path, and a **buffer of the child's
captured stdout** (needed by the F8 readiness gate, sec.4.4).

### 4.2 Temp DB (Q5/INV-B)
- On `start`, create a unique temp **directory**: `mkdtemp` under `os.tmpdir()` with prefix
  `todos-int-` (e.g. `node:fs/promises` `mkdtemp(join(tmpdir(), 'todos-int-'))`). Set
  `dbPath = join(dbDir, 'db.sqlite')`.
- Pass `TODOS_DB_PATH=<dbPath>` in the child env. The server `mkdirSync`s the parent (already exists)
  and creates the file (server lines 44-47).
- On `stop`, after the child is dead, `rm(dbDir, { recursive: true, force: true })` (async
  `node:fs/promises`) - removes `db.sqlite`, `db.sqlite-wal`, `db.sqlite-shm` in one shot (INV-B).
  **Never** references `data/todos.sqlite`.
- **Crash-path teardown uses the SYNC variant (F7):** the `process.once('exit', ...)` net (sec.4.5) MUST
  call **`fs.rmSync(dbDir, { recursive: true, force: true })`** (from `node:fs`), NOT the async `rm()`
  - exit handlers run synchronously and cannot await a promise, so an async `rm()` scheduled there would
  never run and would leak the temp dir on a hard crash.
- **Assertion hook for R11/T9:** the fixture exposes `dbDir`/`dbPath` so a test can assert the path is
  under `os.tmpdir()` and is **not** the repo `data/` path.

### 4.3 Port acquisition + spawn with EADDRINUSE retry (Q3/D2(A)/R11(f)) - the F3 fix
The core of the fixture. Bounded loop, **max 5 attempts**:
1. **Pick a candidate port.** Open a throwaway TCP server on port `0` (`node:net`), read the
   OS-assigned `.address().port`, then close it. This gives a *likely-free* port for **collision
   avoidance** (INV-C) - but the plan treats it as a hint, **not** a guarantee (the close->bind window
   is the TOCTOU race).
2. **Spawn the child:** `spawn('bun', ['server/index.js'], { env: { ...process.env,
   TODOS_PORT: String(port), TODOS_DB_PATH: dbPath }, stdio: ['ignore', 'pipe', 'pipe'] })`. Capture
   stdout (**append every `data` chunk to the per-fixture stdout buffer** - this is the F8 readiness
   source) and stderr (for diagnostics on failure).
3. **Race the two outcomes** with `Promise.race` / event wiring:
   - **Ready:** the readiness resolves (see 4.4) - which now requires **our child's own stdout marker**,
     not a portable GET. -> success, break the retry loop, keep this child.
   - **Bind failure:** the child emits **`exit`** (or `close`) *before* readiness. **The `exit` event
     is the authoritative retry trigger** (not a stderr regex - that is only used to enrich the error
     message). A bind failure means the child crashed before printing the line-289 marker, so the
     marker will never appear in our stdout buffer (sec.0), making "child `exit` before our marker" the
     clean, unambiguous lost-race signal. On a pre-readiness exit: collect captured stderr, and if
     attempts remain, **go to step 1 with a fresh candidate port**; the dead child needs no kill.
4. **Exhaustion:** after 5 failed attempts, `stop` any stray child and **throw** an Error whose message
   includes the last candidate port and the child's captured stderr (so CI shows *why*), failing the
   suite loudly (R11(f) falsify: it must not silently hang or pass).

Why option A over serialization (B): A survives a race with **any** process (another Vitest worker
*and* an unrelated local server on the OS-picked port), needs **no** `vitest.config.*` (Q6/R12), and is
self-contained in the helper. Serialization (`fileParallelism:false` or, since the installed Vitest 1.6.1
default pool is **`threads`**, `poolOptions.threads.singleThread`) would shrink but not eliminate the
external-process race and would add a runner-config file this plan otherwise avoids. Sources for the
config options are cited at the end.

### 4.4 Readiness (no blind sleep, R11(d)) - F8-hardened
Readiness is a **two-stage gate**, and the ordering is load-bearing (F8):

- **Primary (MUST come first): our child's own stdout marker.** Watch the per-fixture stdout buffer
  (sec.4.3 step 2) for the line the server prints at `server/index.js:289`, matching the fixed prefix
  **`todos API listening on http://127.0.0.1:`**. Because this line is written by our spawned Bun
  process to **its own** stdout pipe (which no other process can write into), matching it proves the
  ready server is **ours** - not a foreign parallel-worker server that won the port race and is
  squatting the same port. Implementation: accumulate `child.stdout` `data` chunks into the buffer and,
  on each chunk (and once immediately, in case the line already arrived), test the buffer for the
  prefix; resolve the "marker seen" promise on first match. This resolution is the **only** thing that
  may mark the child ready.
- **Secondary (optional, AFTER the marker): a `GET` confirmation.** Once - and only once - the marker
  has established the process is ours, the fixture MAY additionally poll `GET ${baseUrl}/api/todos`
  once and assert `res.ok` to confirm the socket accepts requests and the DB opened. Because this GET
  runs strictly *after* the our-own-marker match, a stranger answering the GET cannot be mistaken for
  our server: the marker already proved liveness of the right process. If this secondary GET is used,
  it is bounded by a short (~2 s) deadline and a failure here is a **hard** failure (not a retry) - the
  marker already told us our process bound the port, so a non-answering socket is a genuine bug.
  *(The secondary GET is optional because the stdout marker - emitted at line 289 immediately after a
  successful `Bun.serve` bind - is itself sufficient proof of readiness; the GET only adds a
  belt-and-braces check that the request path works. The builder MAY include it or omit it; the marker
  is mandatory, the GET is not.)*
- **Interlock with 4.3:** the marker-watch and the bind-failure watch run **concurrently** - race
  "marker seen" against "child `exit`", bounded by a **~5 s deadline**. If the child `exit`s before the
  marker appears, abandon the wait immediately and hand control to the retry loop (do **not** wait out
  the full deadline on a dead child). This is the F3/F8 detection contract from sec.1's weakest-point note.
- If the deadline elapses with the child still alive but the **marker never appeared**, treat it as a
  hard failure (throw with captured stderr) - a bound-but-silent child is a genuine bug, not a port
  race, so it does **not** retry.
- **`bun`-missing legibility (R11(e)):** if `spawn` errors with `ENOENT` (the `bun` binary is not on
  `PATH`), the fixture catches the child `error` event and throws a **clear** message like
  `"bun not found on PATH - integration tests require Bun; install it or add it to PATH"`, distinct from
  a bind failure (no retry - retrying a missing binary is pointless).

### 4.5 Reap (INV-E/R11(c))
- `stop`: if the child is alive, `child.kill('SIGTERM')`; await its `exit` (with a short
  `SIGKILL` fallback timer if it does not die), then async `rm(dbDir, { recursive:true, force:true })`
  (4.2).
- **Crash-safety net (F7):** register a `process.once('exit', ...)` (and optionally `SIGINT`) handler in
  the fixture that best-effort-kills any still-live child **and synchronously removes the temp DB dir
  with `fs.rmSync(dbDir, { recursive: true, force: true })`** (NOT the async `rm()` - exit handlers are
  synchronous and cannot await a promise; an async `rm()` scheduled here would never complete, leaking
  the temp dir). This guarantees a thrown assertion inside a test cannot leak a listening Bun process
  **or** a locked/orphaned temp DB even if `afterAll` is skipped. Idempotent with `stop` (guard against
  double-kill / double-remove; `force:true` makes the `rmSync` no-op if already gone).
- Each file's `afterAll` calls `stop`; because state is one-server-per-file, exactly one child is
  reaped per file.

### 4.6 Request helpers (thin, in the fixture)
Small convenience wrappers the tests use, all hitting the **real** `baseUrl` via the platform `fetch`:
- `getTodos()` -> `fetch(baseUrl + '/api/todos')` returning `{ status, body }`.
- `putTodos(list, { headers } = {})` -> `fetch(baseUrl + '/api/todos', { method: 'PUT', headers:
  { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(list) })`. Node `fetch` sets
  `Content-Length` from the string body automatically (so the normal path is `411`-safe) and sends
  `Host: 127.0.0.1:<port>` with **no** `Origin` (so `checkWriteGuard` passes - sec.0). Tests needing a
  foreign **`Origin`** pass explicit `headers` (this works - `Origin` is a passthrough request header).
  **A forged/absent `Host` is NOT expressible here (F4)** - undici silently overrides it - so those
  cases use `rawRequest()` (sec.4.7), never `putTodos`.
- `rawPut(bodyString, headers)` -> same as `putTodos` but with a caller-supplied **string** body (for
  the non-JSON and no-`Content-Type` cases); still subject to undici's `Host`/`Content-Length`
  behavior, so it is used only where `fetch` is capable.

### 4.7 Raw-socket helper `rawRequest(...)` - the F4/F5 fix (`node:net`, built-in, INV-G)
For the cases the platform `fetch`/undici **cannot** express - a forged or absent `Host` header (F4),
and the optional true mid-stream cap where `Content-Length` must lie or be omitted (F5) - the fixture
exposes a raw-socket request helper built on the **built-in `node:net`** module (no new dependency, so
INV-G holds).

**Signature (prose):** `rawRequest({ method, path, headers, body, omitHost, omitContentLength })` ->
resolves to `{ statusCode, headers, body }` parsed from the raw HTTP/1.1 response.

**Mechanism (concrete, so the builder does not re-derive it):**
1. Open a socket to the server: `const socket = net.connect({ host: '127.0.0.1', port })` (the
   fixture's chosen port). Set an idle/connect timeout (~3 s) so a hang fails the test rather than
   dangling.
2. **Build the raw request bytes by hand** (this is the whole point - no library normalizes the
   headers, so `Host` is fully under our control):
   - Request line: `` `${method} ${path} HTTP/1.1\r\n` `` (e.g. `PUT /api/todos HTTP/1.1`).
   - Headers, each `` `${name}: ${value}\r\n` ``. Emit **exactly** the headers the test dictates:
     - For the **forged-Host** case (T7(c)): emit `Host: evil.example` (a non-loopback hostname) and
       **do not** emit a loopback Host. Since we write the bytes ourselves, this reaches the server
       verbatim and `checkWriteGuard` (server line 142) returns `403`.
     - For the **absent-Host** case: pass `omitHost:true` so **no** `Host:` header line is written at
       all. **Verified finding (post-hoc correction):** Bun's HTTP/1.1 parser rejects a Host-less
       request at the *protocol* layer with `400` before `checkWriteGuard`'s `host === null` branch
       (server line 139) ever runs - that branch is effectively unreachable via any real request, over
       raw socket or otherwise. The assertion must therefore be **"the write is blocked (status >= 400)
       and the body is not persisted"**, not "403 at line 139" - the security outcome (hostile write
       rejected) still holds and is what R9 actually requires; only the specific code-path claim was
       wrong. *(HTTP/1.1 nominally requires Host; nothing on the raw socket enforces that client-side,
       but the server-side parser does, which is exactly why this case still proves the guard exists in
       spirit even though it never reaches the JS-level check.)*
   - For a **JSON body** (the normal guard cases): compute `Buffer.byteLength(body)` and emit
     `Content-Length: <that number>` and `Content-Type: application/json`, unless the test overrides:
     - `omitContentLength:true` writes **no** `Content-Length` line -> server line 217 returns `411`
       (this is a raw way to reach the 411 branch deterministically, though `putTodos` already covers
       411 via undici omitting length on a streamed body; either is acceptable - see T6).
     - For the **optional mid-stream cap** (F5): write a *small, under-cap* `Content-Length` (or omit it
       and use chunked transfer) but then stream a body whose actual bytes exceed `MAX_BODY_BYTES`
       (1 MB). This is the only way to reach `readCappedBody` returning `null` at server line 234,
       because undici refuses to send a body that disagrees with `Content-Length`. Expect `413`.
   - Blank line `\r\n` terminating the headers, then the body bytes.
3. `socket.write(rawRequestBytes)` (for a large streamed body, write the header block first, then write
   the body in chunks so the server's streaming reader is genuinely exercised).
4. **Read the response:** accumulate `socket` `data` chunks into a buffer until the socket ends (or a
   deadline). Parse the **status line** (`HTTP/1.1 <code> <reason>`) to get `statusCode`, split the
   header block on `\r\n\r\n` to separate headers from body. A minimal hand-parse is sufficient - the
   tests only assert `statusCode` (403 / 413 / 411) and, where relevant, that the DB was not mutated
   (verified with a follow-up `getTodos()` over normal `fetch`).
5. Resolve with `{ statusCode, headers, body }`; destroy the socket in a `finally`.

**This helper lives in `tests/integration/helpers/server.js`** alongside the fixture (it needs the
fixture's chosen `port`) and is exported on the fixture object as `rawRequest`. It drives T7(c) (forged
Host), the absent-Host case, and - if included - the optional mid-stream-cap case of T6.

---

## 5. The R10 seam test - resolving the relative URL to the real server (F2-aware)

`src/storage.js` posts to the relative `'/api/todos'` (line 15), which has no origin under `node`. The
seam test (`tests/integration/storage-seam.test.js`) MUST make that relative URL reach the spawned
server **over a real socket**, without stubbing the *response* (INV-F).

**Chosen mechanism: a base-URL-prepending `fetch` wrapper, real network underneath.**
- In `beforeAll`, after the fixture is ready, install `globalThis.fetch = (input, init) => realFetch(
  typeof input === 'string' && input.startsWith('/') ? baseUrl + input : input, init)`, capturing the
  original `fetch` as `realFetch` first. This rewrites only root-relative URLs; it performs a **real**
  network call to the spawned server. It does **not** fabricate a `Response` (that would be the
  forbidden stub, INV-F).
- In `afterAll`, restore `globalThis.fetch = realFetch` (before `stop`), so no other file inherits the
  wrapper. (Vitest runs files in separate workers, but restoring is still correct hygiene.)
- Import `loadTodos`, `saveTodos` from `../../src/storage.js` **after** deciding the env is `node` (Q2):
  `AbortSignal.timeout` exists there, so `storage.js` loads without a DOM.

**F2 constraint honored (R10(c)):** the newest-state-wins assertion binds on the **server's final GET
state == v2**, obtained via the fixture's `getTodos()`. The test MUST NOT assert that the coalesced
second `saveTodos(v2)` returned `true` - under `storage.js` line 56 it returns `false` while the
drain loop still commits v2, which is **correct** behavior (F2). The single, non-coalesced save in
R10(a) MAY assert its `true` return.

**`sanitizeTodos` identity (R10(a)):** fixtures use unique-id, non-empty, boolean-`completed` lists so
the load path's `sanitizeTodos` (sec.0) is an identity and `saveTodos(list)` then `loadTodos()` deep-equals
`list` in order.

**R10(b) real dead socket:** the test `stop`s the server (or spawns a fixture then stops it) and then
calls `loadTodos()` (expect `[]`) and `saveTodos([...])` (expect `false`) against the now-refused port,
asserting **no unhandled rejection** (a `process` `unhandledRejection` listener installed for the test,
or simply that the awaited promises resolve rather than throw). This proves totality against a real
closed socket, not a stub.

---

## 6. Requirement -> test mapping (concrete file / describe / it)

All HTTP tests use the fixture (sec.4); all assertions hit the **real** spawned server. `T*` labels match
spec sec.7. Unless noted, each `it` first establishes known DB state via `putTodos(...)` (or `putTodos([])`),
so tests are order-independent within a file (sec.3).

### `tests/integration/server.test.js` - `describe('server contract', ...)`
| Test (spec sec.7) | Requirements | `it(...)` shape & assertions |
|----------------|--------------|------------------------------|
| **T1** | R1, R2, R3 | `it('round-trips a known ordered list with mixed completed')`: `putTodos([{id:'a',text:'A',completed:false},{id:'b',text:'B',completed:true},{id:'c',text:'C',completed:false}])` -> `200`; `getTodos()` -> deep-equal the **same array in the same order** (R1+R2); assert each returned `completed` is `typeof === 'boolean'` and the `true`/`false` values match (R3 - not `0/1`, not `"true"`). |
| **T2** | R4 | `it('a fresh empty DB returns 200 []')`: runs **first**, before any PUT in this file, OR uses a dedicated fixture whose server was just started against a fresh temp DB; `getTodos()` -> `status 200` and `body` deep-equals `[]` (not `404`/`null`/non-empty). To guarantee freshness regardless of file order, this test spawns its **own** fixture in a nested `describe` with its own `beforeAll`/`afterAll` (a second short-lived server on its own temp DB), so no prior PUT can contaminate it. |
| **T3** | R5 | `it('a second PUT fully replaces the first list')`: `putTodos([{id:'a',...},{id:'b',...}])` then `putTodos([{id:'c',...}])`; `getTodos()` -> exactly `[{id:'c',...}]` (no leftover `a`/`b` rows). |
| **T4a** | R6a | `it('empty-id and empty-text PUTs are refused at validation, DB untouched')`: seed `putTodos([valid])`; then `putTodos([{id:'',text:'x',completed:false}])` -> `400`; and separately `putTodos([{id:'x',text:'',completed:false}])` -> `400`; after **each**, `getTodos()` deep-equals the seeded `[valid]` list. **Comment in the test MUST state this is shape-rejection (no `DELETE` runs), NOT rollback** (F1). Assert the server is still responsive with a follow-up `getTodos()` `200`. |
| **T4b** | R6b | `it('a duplicate-id PUT rolls back, leaving the OLD list intact')`: seed `putTodos([{id:'a',text:'A',completed:false}])`; then `putTodos([{id:'d',text:'D1',completed:false},{id:'d',text:'D2',completed:true}])` (shape-valid, duplicate id) -> `400`; `getTodos()` deep-equals the seeded `[{id:'a',...}]` (proving the DELETE-then-rollback restored state, INV-K); server still responsive. **This is the only test that enters `replaceAll`'s rollback path** (F1). |
| **T5** | R7 | `it('malformed / wrong-shape / wrong-method are rejected cleanly')`: (a) `rawPut('not json', {'Content-Type':'application/json'})` -> `400`; (b) `putTodos({not:'an array'})` -> `400`; (c) `putTodos([{id:'a',text:'A',completed:'yes'}])` (non-boolean) -> `400`; (d) `fetch(baseUrl+'/api/todos',{method:'DELETE'})` -> `405` and `POST` -> `405`; after all, `getTodos()` deep-equals the pre-existing seeded list (DB unmutated) and returns `200` (process alive). |

### `tests/integration/guard.test.js` - `describe('body cap & write guard', ...)`
| Test | Requirements | `it(...)` shape & assertions |
|------|--------------|------------------------------|
| **T6** | R8 | Proves "over-cap PUT -> 413, not persisted" via the path `fetch` **can** reach, plus the 411 branch. **(a) Real >1 MB body (F5 - the binding R8 case):** `it('a real over-1MB JSON body is rejected 413 and not persisted')` - build one conforming todo whose `text` is a string > 1 MB (e.g. `'x'.repeat(1_100_000)`), `putTodos([bigTodo])` via the normal `fetch` wrapper. undici computes an accurate `Content-Length` (> 1_048_576) from the real body and sends it, so the server rejects at the **declared-length** branch (`server/index.js:222`) -> `413`. This single real body is sufficient to prove R8's observable requirement (over-cap -> 413). **Do NOT fabricate a mismatched `Content-Length` header via `fetch`** - undici rejects a length/body mismatch client-side and the request never reaches the server (F5); that mechanism is removed from this plan. **(b) 411 branch:** `it('a PUT with no Content-Length is 411')` - either pass a streaming `ReadableStream` body so undici omits `Content-Length` (server line 217 -> `411`), OR use `rawRequest({ method:'PUT', path:'/api/todos', body:'[]', omitContentLength:true })` (sec.4.7) for a deterministic length-less request -> `411`. **(c) Not persisted:** after (a), `getTodos()` still deep-equals the prior seeded list. **(d) OPTIONAL true mid-stream cap (F5, via raw socket):** `it('a body exceeding the cap mid-stream is rejected 413 (raw socket)')` - use `rawRequest` with an under-cap/omitted `Content-Length` but stream > 1 MB of body bytes, reaching `readCappedBody` -> `null` at `server/index.js:234` -> `413`. **This case is OPTIONAL:** R8 requires only the observable "over-cap -> 413, not persisted" behavior, which (a) already proves. If the builder includes (d) it strengthens coverage of the mid-stream branch; if omitted, **the plan explicitly declares the mid-stream branch (server line 234) untestable via `fetch` and out of scope for this suite**, which is acceptable - R8 does not require exercising every code path. Pick one (include or explicitly skip with a code comment citing F5); do not silently drop it. |
| **T7** | R9 | `it('the Origin/Host write guard rejects hostile writes but not our own')`. **(a) Baseline:** seed `putTodos([valid])`. **(b) Foreign Origin (via `fetch` - capable):** `putTodos([{id:'x',...}], { headers:{ Origin:'https://evil.example' } })` -> `403` (server line 149); `getTodos()` unchanged. **(c) Forged/absent Host (via `rawRequest` - F4, `fetch` CANNOT do this):** `rawRequest({ method:'PUT', path:'/api/todos', headers:{ Host:'evil.example' }, body:'[{"id":"x","text":"X","completed":false}]' })` -> `403` (server line 142, non-loopback Host); and `rawRequest({ method:'PUT', path:'/api/todos', omitHost:true, body:'[...]' })` -> **status >= 400, write blocked** (empirically: Bun's HTTP/1.1 parser rejects the Host-less request at the protocol layer with `400` before `checkWriteGuard`'s `host === null` branch at server line 139 ever runs - that branch is unreachable via any real request; assert on the blocked-write outcome, not a specific status code or line). After each, `getTodos()` (normal `fetch`) unchanged. **The test comment MUST state why `rawRequest` is used here: undici silently overrides/forces `Host`, so a forged/missing `Host` is unproducible via `fetch` (F4); the raw `node:net` socket writes the header bytes verbatim.** **(d) Our own write is not self-blocked:** a plain `putTodos([{id:'y',...}])` with **no** `Origin` and undici's real loopback `Host` -> `2xx`, `getTodos()` reflects it. |

### `tests/integration/storage-seam.test.js` - `describe('storage seam vs real server', ...)` (sec.5)
| Test | Requirements | `it(...)` shape & assertions |
|------|--------------|------------------------------|
| **T8a** | R10(a), INV-C | `it('saveTodos then loadTodos round-trips shape and order')`: with the base-URL `fetch` wrapper installed (sec.5), `const ok = await saveTodos([{id:'a',text:'A',completed:false},{id:'b',text:'B',completed:true}])`; MAY `expect(ok).toBe(true)` (single, non-coalesced); `const back = await loadTodos()`; deep-equal the same list, same order; assert shape `Array<{id:string,text:string,completed:boolean}>`. |
| **T8b** | R10(b), INV-F | `it('against a dead server, loadTodos()===[] and saveTodos()===false with no unhandled rejection')`: `stop` the fixture's server (or use a dedicated fixture then stop it); install an `unhandledRejection` listener that fails the test; `expect(await loadTodos()).toEqual([])`; `expect(await saveTodos([{id:'a',text:'A',completed:false}])).toBe(false)`. |
| **T8c** | R10(c), INV-J (F2) | `it('rapid save(v1),save(v2) leaves the server holding v2')`: fire `saveTodos(v1)` and `saveTodos(v2)` back-to-back (await both to settle); assert the **server's** state via the fixture's real `getTodos()` deep-equals `v2`. **MUST NOT assert the second call returned `true`** - a `false` there is expected under coalescing (F2). |

### R11 & R12 - cross-cutting, asserted via fixture + a check
| Test | Requirements | Where / how |
|------|--------------|-------------|
| **T9** | R11(a)-(f) | Partly **structural** (satisfied by the fixture design) and partly asserted: (a) `it('uses a temp DB under os.tmpdir, never data/todos.sqlite')` asserts `fixture.dbPath` starts with `os.tmpdir()` and does not equal the repo `data/todos.sqlite`, and that after `afterAll` the temp dir is gone (a follow-up `existsSync` check in a final `it`/`afterAll`); (b) collision-avoiding port is the OS-`0` pick (sec.4.3); (c) reap is `afterAll` + the `process.exit` sync-`rmSync` net (sec.4.5, F7); (d) readiness is the our-own stdout marker (sec.4.4), asserted by the fact the suite runs at all; (e) `bun`-missing legibility (sec.4.4) - a documented, hard-to-trigger case; may be left as a code-review assertion rather than an executed test (spawning without `bun` on PATH is not reproducible in CI where `bun` exists). (f) **race-safety** is proven by the retry loop existing **and** by the files running under Vitest's default parallel (`threads` pool) execution (three integration files start three servers concurrently) staying green - the suite passing *is* the R11(f) evidence; the verifier may additionally add a stress `it` that starts N fixtures concurrently to force the race. |
| **T10** | R12, INV-A | Not a new test file; a **check**: after adding the suite, `bun run test` reports `tests/todos.test.js (87 tests)` still passing and the two component suites green; `git diff --stat` shows `tests/todos.test.js` = 0 changed lines. Verifier runs this as the final gate. |

**Note on file count:** `server.test.js` and `guard.test.js` MAY be merged into one file if the builder
prefers fewer spawned servers (each file = one server); the mapping above is the binding contract, the
file split is ergonomic. Keeping the seam test separate is required (it installs/restores the global
`fetch` wrapper, sec.5, which must not bleed into the pure-HTTP tests).

---

## 7. Failure modes from the spec & how the design handles each

| Invariant | Design mechanism |
|-----------|------------------|
| **INV-A / R12** - existing suites green & unmodified | No `vitest.config.*` added (Q6); no edit to `tests/todos.test.js` or the component suites; only new files under `tests/integration/` + one `package.json` script. T10 is the tripwire check. |
| **INV-B / R11(a)** - never touch `data/todos.sqlite` | `TODOS_DB_PATH` set to an `os.tmpdir()` temp **dir** per run; whole-dir `rm` (async, `stop`) / `rmSync` (sync, crash net - F7) on teardown removes db + `-wal` + `-shm` (sec.4.2). T9(a) asserts the path and post-teardown removal. |
| **INV-C / R11(b),(f)** - no fixed port / race-safe | OS port-`0` pick for collision avoidance **plus** the 5-attempt EADDRINUSE-retry spawn loop keyed on the child `exit` event and gated on our-own stdout marker (sec.4.3/sec.4.4, F8), which survives a race with parallel Vitest `threads`-pool workers *and* external processes. |
| **INV-D / N1** - test-only, no prod behavior change | Only `tests/**` + an additive `package.json` script; `src/`/`server/`/`scripts/`/`vite.config.js`/`.github`/`.claude`/`SDLC` untouched. If a test can only pass by changing prod code, that is a **finding filed separately**, not patched here (spec N1). |
| **INV-E / R11(c)** - no leaked processes | `afterAll` `stop` (SIGTERM->SIGKILL fallback) + a `process.once('exit')` best-effort kill + **sync `rmSync`** net (sec.4.5, F7), so a thrown assertion cannot leak a listening Bun **or** a locked/orphaned temp DB. |
| **INV-F / R10(b)** - no mock below the test | The seam wrapper rewrites only the URL and calls the **real** `fetch` to the spawned server; it never fabricates a `Response` (sec.5). All other tests use the platform `fetch` - or a raw `node:net` socket (sec.4.7) - directly against the real server. Dead-socket totality is proven against a real closed port. |
| **INV-G / N6** - no heavyweight dep / no framework swap | Runner stays Vitest; client is platform `fetch` **plus the built-in `node:net` raw-socket helper** (sec.4.7) for the cases `fetch` cannot express - both are built-ins, **zero** new deps; server is a `bun` subprocess spawned via `node:child_process`. `package.json` gains **zero** dependencies (only a `scripts` line). |

---

## 8. Build order (for the builder)

1. **Open the build gate** (operator): `touch SDLC/ledger/.build-open` (the `tests/` writes are not
   under `src/`, but open it to be safe with the enforce hook).
2. **`tests/integration/helpers/server.js`** (sec.4) - the fixture first; everything else depends on it.
   Verify manually: `TODOS_PORT`/`TODOS_DB_PATH` set in child env; **readiness via our-own stdout
   marker (server line 289), GET only as a post-marker secondary check (F8)**; EADDRINUSE retry via
   the `exit` event; temp-dir create + whole-dir teardown (async `rm` in `stop`, **sync `rmSync` in the
   `process.exit` net - F7**); `bun`-missing `ENOENT` message; **the `rawRequest()` raw-socket helper
   (sec.4.7) for forged/absent `Host` and the optional mid-stream cap (F4/F5)**.
3. **`tests/integration/server.test.js`** (sec.6) - T1-T5, T2's nested fresh-DB fixture.
4. **`tests/integration/guard.test.js`** (sec.6) - T6 (real >1 MB body -> 413 via `fetch`, 411 branch,
   optional raw-socket mid-stream cap; F5), T7 (foreign `Origin` via `fetch`; forged/absent `Host` via
   `rawRequest`; not-self-blocking; F4).
5. **`tests/integration/storage-seam.test.js`** (sec.5/sec.6) - base-URL `fetch` wrapper install/restore;
   T8a/T8b/T8c honoring the F2 constraint (assert the GET, not the coalesced boolean).
6. **`package.json`** - add `"test:integration": "vitest run tests/integration"` (Q1). No dep changes.
7. **Run `bun run test`** - all integration tests + the 87 core + the two component suites green; run a
   few times to confirm no flake under parallel file execution (`threads` pool, R11(f)). `git diff
   --stat` confirms `tests/todos.test.js` = 0 lines (T10/INV-A).

---

## 9. Weakest points (named for the adversary - attack these)

1. **EADDRINUSE detection vs slow start, and our-child-vs-foreign-server (F8).** The retry loop keys on
   the child `exit` event as the bind-failure signal (sec.4.3/sec.4.4), and readiness is gated on **our
   child's own stdout marker** (server line 289) - printed only to our spawned process's own stdout -
   **before** any `GET`, so a foreign parallel-worker server squatting the same port cannot be mistaken
   for ours (that was the F8 defect: a portable `GET` could bind the suite to a stranger's server/DB).
   The `GET` is demoted to an optional secondary confirmation *after* the marker. Residual risk: if Bun
   ever exited non-zero for a reason *other* than the bind (e.g. a transient DB-open error) the loop
   would retry a fresh port and could mask a real bug; the plan enriches the thrown exhaustion error
   with captured stderr so a masked bug is still visible in CI. The line drawn is "pre-marker `exit` ->
   retry (bounded 5); bound-but-marker-never-printed within deadline -> hard fail."
2. **`Host` header is un-forgeable via `fetch` (F4) - closed with a raw socket.** undici silently
   overrides any user-set `Host` and always sends one, so R9(c) (non-loopback Host) and the absent-Host
   case are **unprovable via `fetch`**. The plan proves them with the built-in `node:net` raw-socket
   helper `rawRequest()` (sec.4.7), which writes the HTTP/1.1 request bytes by hand - the server receives
   the forged/absent `Host` verbatim and returns `403` (server lines 142/139). No new dependency
   (INV-G). Residual: the hand-rolled HTTP parse in `rawRequest` must be robust enough to read a small
   JSON error response; the helper only needs the status line, so the parse surface is tiny.
3. **The declared-vs-mid-stream body cap (F5).** A declared-over-cap `Content-Length` cannot be sent via
   `fetch` (undici rejects the length/body mismatch client-side), and a real >1 MB body sent via `fetch`
   is caught at the **declared** branch (server line 222), never the **mid-stream** branch (server line
   234). R8's observable requirement (over-cap -> 413, not persisted) is proven by **one real >1 MB
   body via `fetch`** (T6(a)). The true mid-stream cap is either exercised via `rawRequest` with a
   lying/omitted `Content-Length` (T6(d), optional) or **explicitly declared out of scope** with a
   code comment citing F5 - R8 does not require exercising every code path.
4. **T8c timing.** The coalescing race in `storage.js` needs `saveTodos(v1)` and `saveTodos(v2)` to
   overlap (v1's PUT still in flight when v2 arrives) for the drain loop to coalesce; against a fast
   loopback server the first PUT may complete before v2 is called, making it two sequential saves (still
   ending in v2 - correct, but not exercising coalescing). The binding assertion (server GET == v2)
   holds either way (F2), so the test is correct regardless; but if the arbiter wants coalescing itself
   proven, the verifier can slow v1 via a large body or assert `saveTodos`'s internal path indirectly.
   Flagged, not hidden.
5. **Parallel-file port-race coverage (R11(f)).** The suite passing under Vitest's default parallel
   (`threads` pool) execution *is* the evidence, but it is probabilistic - three files racing may not
   hit the exact TOCTOU window every run. The retry loop makes a hit non-fatal; a dedicated
   N-concurrent-fixture stress `it` (T9(f)) can raise the hit probability. Named so the adversary can
   demand the stress test if the passive evidence is deemed insufficient.

---

## Sources (Vitest parallelism config, for the D2(A) vs (B) decision)

- Vitest - Parallelism guide: https://vitest.dev/guide/parallelism
- Vitest - `fileParallelism` config: https://vitest.dev/config/fileparallelism
- Vitest 1.6.1 default pool is `threads` (worker_threads); the serialization fallback knob is
  `poolOptions.threads.singleThread` or `fileParallelism:false` (F6).
