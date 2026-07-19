# SPEC — ISSUE-19: Add end-to-end integration tests

Status: SPEC (draft for the spec gate)
Owner: architect
Work item: ISSUE-19
GitHub issue: #19 — "Add end-to-end integration tests" (title only; no body — scope
inferred from the tree, §0)

---

## 0. Grounding — what is actually in the repo today

This spec is written against the tree at commit `81776ca` on branch `sdlc/issue-19`,
not against assumptions. Verified facts:

- **Stack:** React `^18.3.1` + Vite `^5.4.0`, ESM. Package manager + runtime is **Bun
  1.3.11** (`which bun` -> `/root/.bun/bin/bun`). The persistence server uses Bun-only
  APIs (`bun:sqlite`, `Bun.serve`).
- **Layers that exist after ISSUE-15 merged (PR #16):**
  1. **Pure core** — `src/todos.js` (list logic; no I/O).
  2. **React shell** — `src/App.jsx` (holds list state, hydration guard, routes events
     to the core, renders shadcn/Tailwind UI).
  3. **Storage seam** — `src/storage.js`: `loadTodos()` / `saveTodos()` talk to
     `/api/todos` over `fetch`; both are total (never reject); newest-state-wins save
     serialization (INV-J).
  4. **HTTP + persistence server** — `server/index.js`: a `Bun.serve` app bound to the
     literal `127.0.0.1` that owns `data/todos.sqlite` via `bun:sqlite`, exposing
     `GET /api/todos` and `PUT /api/todos` (transactional whole-list replace, Origin/Host
     write guard, 1 MB body cap), and in preview/prod also serving `dist/`.
  5. **Dev launcher** — `scripts/dev.mjs`: spawns the API, polls it to readiness, then
     starts Vite; fails loud (non-zero, no Vite) if the API dies or never becomes ready.
  6. **Vite proxy** — `vite.config.js`: `server.proxy` routes `/api` -> `127.0.0.1:$TODOS_PORT`,
     `strictPort: true`, and preserves the `@` -> `./src` alias.
- **Test affordances already built for exactly this purpose:** the server reads
  **`TODOS_PORT`** (default `8787`) and **`TODOS_DB_PATH`** (default `data/todos.sqlite`)
  from the environment, and prints a readiness line `todos API listening on
  http://127.0.0.1:<port>` on stdout. These overrides were added in ISSUE-15 as explicit
  test hooks (plan §7). `scripts/dev.mjs` already demonstrates the spawn-and-poll pattern
  against the real server.
- **Existing tests (`bun run test` -> `vitest run`, no `vitest.config.*`):**
  - `tests/todos.test.js` — 87 pure-core cases, **node** environment. Imports only
    `../src/todos.js`.
  - `tests/App.a11y.test.jsx` — component/a11y, **happy-dom** env, **stubs `fetch`**.
  - `tests/App.hydration-f33.test.jsx` — hydration-race regression, **happy-dom** env,
    **stubs `fetch`**.
  - `tests/test_ledger.py` — SDLC tooling; unrelated.
  - Environment is selected **per-file** via a `// @vitest-environment <env>` pragma;
    globals are **off** (`globals:false`), so each DOM file does its own
    `afterEach(cleanup)` and imports `@testing-library/jest-dom/vitest`.
  - **Parallelism default (verified, decisive for F3):** there is **no `vitest.config.*`**
    and **no `test` block in `vite.config.js`**, so Vitest runs with its default pool —
    it executes **test files in parallel across worker processes**. Two integration files
    (or one file re-run by a worker) can therefore have their servers coming up
    **simultaneously**, racing for ports. Any port strategy MUST survive that (R11(f)/D2).
- **The gap this issue targets (verified):** **every** existing test either exercises the
  pure core in isolation *or* stubs `fetch` at the storage boundary. There is **no test
  anywhere that exercises the real wired system** — `App`/`storage.js` -> real HTTP -> the
  real `Bun.serve` handler -> real `bun:sqlite`. Concretely: `grep` for `bun:sqlite`,
  `Bun.serve`, `spawn`, `TODOS_DB_PATH`, `TODOS_PORT` across `tests/` returns **nothing**.
  The server's request handler, its transactional replace, its Origin/Host guard, its body
  cap, boolean marshaling across the JS<->SQLite<->JSON boundary, and insertion-order
  round-tripping have **zero executable coverage** today. That is the hole "end-to-end
  integration tests" fills for *this* codebase.
- **Hard runtime constraint (decisive for the framework choice, §4/D1):** `vitest`'s
  binary is `#!/usr/bin/env node` — the suite runs on **Node**, and `require('bun:sqlite')`
  in Node fails `MODULE_NOT_FOUND` (verified). Therefore a test process running under
  `vitest` **cannot import `server/index.js`** (it imports `bun:sqlite` at module load and
  binds a port as a top-level side effect). The real server must be exercised as a
  **spawned `bun server/index.js` subprocess driven over real HTTP**, not imported.

---

## 1. Problem statement

The app is now a genuinely multi-layer system — a React UI, an async storage seam, a Bun
HTTP API, and a SQLite file — but the automated test suite still only covers the two ends
in isolation: the pure core (`tests/todos.test.js`) and the UI with the **network mocked
out** (`App.a11y`, `App.hydration-f33` stub `fetch`). No test proves the layers actually
work **when wired together**: that a real `PUT` from the storage seam lands in real SQLite,
comes back through a real `GET` in insertion order with `completed` as a real boolean, that
the transactional replace and its rollback behave against a real DB, and that the server's
security guards (Origin/Host, body cap) actually reject hostile requests. Issue #19 asks to
**add end-to-end integration tests** that close this gap. After this change, a suite of
integration tests drives the **real** server process (spawned as `bun server/index.js`
against a throwaway SQLite file) over **real HTTP**, asserting the contract at the seams that
the unit/mocked tests cannot reach. What changes: a new category of tests and the minimal
scaffolding to run them; **no production code (`src/`, `server/`, `scripts/`) behavior
changes** — this is test-only work (N1).

---

## 2. Scope

**In scope:**

- A new **integration test layer** (files under `tests/`, e.g. `tests/integration/**`)
  that spawns the **real `server/index.js` as a Bun subprocess** on an ephemeral
  `TODOS_PORT`, pointed at a **throwaway `TODOS_DB_PATH`** (a temp file, unique per run,
  deleted on teardown), waits for its readiness line/health probe, and drives it over
  **real `fetch` HTTP** — no mocking of the network, the server, or SQLite (§4/D1, D2).
- Coverage of the **server contract** end-to-end (§3 requirement list R1–R9): GET/PUT
  round-trip, insertion order, boolean marshaling, empty-DB/first-run, atomic
  transactional replace, **shape-rejection at validation** (empty-id/empty-text, R6a) and
  **true constraint-violation rollback** (duplicate-id, old list intact, R6b),
  malformed/oversized/wrong-method requests, and the **Origin/Host write guard**.
- Coverage of the **storage seam against the real server** (R10): `loadTodos()` /
  `saveTodos()` run against the live API and satisfy their totality/shape/ordering
  invariants (INV-C/INV-F/INV-J) with a *real* backend rather than a `fetch` stub.
- The **test-run wiring** so these tests execute in the project's existing runner
  (`bun run test` / `vitest run`) without breaking the current suites or requiring a new
  test framework (§4/D3), and so the throwaway DB never touches the real
  `data/todos.sqlite` (INV-B) and no port collides with a developer's running dev server
  or a parallel Vitest worker (INV-C).

**Out of scope:** see §3 Non-goals.

---

## 3. Non-goals (out of scope)

- **N1 — No production-code behavior change.** `src/**`, `server/index.js`,
  `scripts/dev.mjs`, `vite.config.js` are **not modified for behavior**. This is
  test-only work. The one *permitted* touch to non-test files is additive and optional:
  IF a script alias is wanted (e.g. `test:integration`) it is a `package.json` `scripts`
  addition only (Q1); no source logic changes. **One further exception, mechanical not
  behavioral (F3/Q6):** if the chosen fix for the parallel-worker port race is to
  serialize the integration files via Vitest config, a **new `vitest.config.*`** (or a
  `test` block in `vite.config.js`) may be added purely to set the pool/serialization
  option. That file changes *test-runner configuration*, not `src/`/`server/` logic, and
  is the only config addition permitted; the retry-loop alternative needs no config change
  at all. If an integration test can only pass by changing server/app behavior, that is a
  **finding against the code**, filed separately — not silently patched under this item.
- **N2 — Not a browser/UI E2E tool.** This spec does **not** introduce Playwright,
  Cypress, Puppeteer, WebDriver, or a headless Chromium. Justification is in D1: the
  app's "end to end" for *this* codebase is UI-state -> storage seam -> HTTP -> SQLite, and
  every layer except pixel rendering is reachable from a Node/happy-dom test driving the
  real server over HTTP. A real browser would add a heavy new toolchain, a new binary
  download, and flakiness for no coverage this issue needs. Rejected alternatives are
  named in D1 so the adversary can check them.
- **N3 — Not re-testing the pure core or re-running the mocked component tests
  differently.** `tests/todos.test.js` (87 cases) stays exactly as is; the mocked
  `App.a11y` / `App.hydration-f33` suites stay as is (they cover UI/hydration logic that
  does **not** need a real server). Integration tests are **additive**; they do not
  replace, duplicate, or weaken existing coverage.
- **N4 — No full Vite dev-server / proxy E2E.** The tests hit the API server **directly**
  on its own port (same as the seam's relative `/api/todos`, but resolved to the spawned
  server's origin). They do **not** boot Vite and exercise the `server.proxy` hop. The
  proxy is dev-ergonomics config, not app behavior; booting Vite per test is slow and
  flaky. (If proxy reachability is later wanted as a smoke test, it is a separate item —
  Q4.) The preview/prod same-origin `dist/` serving is likewise **not** built into a run
  here (it needs a prior `vite build`); a minimal static-serve check is optional and
  gated behind Q4.
- **N5 — No coverage-percentage gate, no mutation testing, no load/perf/soak testing.**
  "Coverage" here means **the enumerated flows in §3 each have a passing, falsifiable
  test** (§6), not a line/branch % threshold (which would need a coverage tool this repo
  doesn't have and would be an arbitrary bar). No `--coverage` requirement.
- **N6 — No new heavyweight test dependency.** No supertest/msw/testcontainers/etc. The
  real server is a subprocess and the client is the platform `fetch`; the runner stays
  Vitest. At most, the closed dep list may add nothing (preferred) — see R11/Q2.
- **N7 — No change to the SDLC pipeline files** under `.github/`, `.claude/`, or `SDLC/`.
- **N8 — No concurrency/multi-tab stress beyond the seam's single-client ordering.** The
  seam's newest-state-wins (INV-J) is tested at the storage layer (R10); this spec does
  **not** add multi-process concurrent-writer torture tests (the server is single-writer
  by design per ISSUE-15 §8).

---

## 4. Architectural decisions

### D1 — "End-to-end integration test" here means: the real server subprocess driven over real HTTP, NOT a headless browser. (Most contestable decision.)

**Decision:** each integration test spawns the **actual `server/index.js`** via
`bun server/index.js` as a child process (with `TODOS_PORT` + `TODOS_DB_PATH` set to
ephemeral values), waits until it is listening, and drives it with the platform `fetch`
(and, for seam tests, the real `src/storage.js`). Nothing is mocked below the test: real
HTTP, real `Bun.serve` handler, real `bun:sqlite`, real file.

**Why this is the right altitude for *this* repo (not chosen lightly):**
- The system's layers are React-state -> `storage.js` -> HTTP -> `Bun.serve` -> SQLite. The
  only layer a real browser would add over this approach is **pixel/DOM rendering**, which
  is already covered by the happy-dom component tests (`App.a11y`, `App.hydration-f33`).
  The **untested** integration is everything *below* the `fetch` boundary — and that is
  fully reachable by driving the real server over HTTP.
- The repo already **ships the exact hooks** for this: `TODOS_PORT`, `TODOS_DB_PATH`, and a
  stdout readiness line, all added in ISSUE-15 explicitly as test affordances, plus
  `scripts/dev.mjs` as a working spawn-and-poll reference. Using them is the smallest design.
- **The import route is impossible (§0):** `server/index.js` uses `bun:sqlite`/`Bun.serve`
  and binds a port at module load; under Node-hosted Vitest, importing it throws
  `MODULE_NOT_FOUND`. So the server MUST be a spawned Bun subprocess regardless — this is a
  forced constraint, not a preference.

**Alternatives considered and rejected (named for the adversary to check):**
- *Playwright / Cypress / headless-browser E2E.* Rejected (N2): adds a large toolchain +
  browser binary and flaky UI timing to cover a rendering layer already covered by
  happy-dom, while the *actual* gap (server <-> SQLite wiring) needs no browser. Disproportionate
  to a single-user localhost todo demo.
- *`import`ing the server handler and calling it in-process.* Rejected: `bun:sqlite`/`Bun.serve`
  are unavailable in Node-hosted Vitest (§0), and the module has bind-on-import side effects —
  importing it is not even possible in the current runner. Even under `bun test`, the
  bind-on-import + fixed-default-path side effects make in-process import fragile; a subprocess
  with env overrides is cleaner and matches how the server actually runs.
- *Mocking SQLite / using an in-memory shim.* Rejected: that reintroduces the very mock
  boundary this issue exists to eliminate; the point is to prove the **real** DB round-trip.
- *Booting the full Vite dev server + proxy per test.* Rejected as the default (N4): slow,
  flaky, and tests proxy config rather than app behavior. Optional smoke-test only (Q4).

### D2 — Test isolation: ephemeral port + throwaway DB, spawned and reaped per suite; port acquisition MUST be race-safe.

**Decision, made precise so a builder can't get it wrong and a verifier can falsify it:**
- **Throwaway DB (INV-B).** Every integration run sets `TODOS_DB_PATH` to a **unique temp
  file** (e.g. under the OS temp dir or a git-ignored `tmp/`, with a random suffix), created
  fresh and **removed on teardown**. The tests MUST NOT read, write, or depend on the real
  `data/todos.sqlite`. (The server also writes WAL sidecars `-wal`/`-shm`; teardown removes
  those too, or uses a temp *directory* it deletes wholesale.)
- **Ephemeral port, race-safe (INV-C) — F3 hardened.** `TODOS_PORT` is set to a port chosen
  to avoid collision with a developer's running server (default `8787`) and Vite (`5173`).
  The tests MUST NOT assume `8787` is free. The naive "grab an OS-assigned free port, close
  it, then pass the number to the child" pattern has a **TOCTOU race**: between the probe
  socket closing and `Bun.serve` binding, **another process — or a parallel Vitest worker
  starting its own server (§0: Vitest parallelizes files by default)** — can take that port,
  and `Bun.serve` **throws synchronously on `EADDRINUSE`** (`server/index.js:282-286`),
  crashing the spawned child and failing the test spuriously. The design MUST eliminate this
  race by **one of** the following, and the plan MUST state which is chosen:
  - **(A) Retry-on-EADDRINUSE spawn loop (preferred, no config change).** The spawn helper
    picks a candidate port, spawns the child, and **watches for a bind failure**: if the
    child exits early / its stderr reports `EADDRINUSE` (or readiness never arrives and the
    child is dead), the helper **picks a fresh candidate port and retries**, up to a
    **bounded attempt count** (e.g. 5). Exhausting the attempts fails the test loudly with a
    clear diagnostic. This tolerates the race instead of pretending it can't happen.
  - **(B) Serialize the integration test files.** Configure Vitest to run the integration
    files **non-concurrently** (e.g. `poolOptions.forks.singleFork` / a single fork, or an
    equivalent serialization), and/or share **one** server fixture across the integration
    files so at most one server is coming up at a time. This shrinks (but, for external
    processes, does not fully remove) the race window; if (B) is chosen it SHOULD still bind
    with at least a minimal retry, or the plan must justify why a single serialized binder is
    safe in the target CI. Per N1/Q6, adding a `vitest.config.*` (or `test` block) purely to
    set this option is the one permitted test-runner config change.
  - Because the server's write guard's Origin allowlist is **derived from `PORT`** (server
    config), a same-origin `PUT` from the test to `http://127.0.0.1:<port>` is allowed with
    **no `Origin` header** (Host is loopback) — the guard's default-deny still passes for a
    headerless same-origin request; the negative guard test (R9) supplies a *foreign* `Origin`.
- **Readiness (no fixed sleep).** Startup is awaited by **polling `GET /api/todos` until it
  responds** (or matching the stdout readiness line), with a bounded timeout that **fails the
  test loudly** if the server never comes up — never a blind `sleep`. Mirrors
  `scripts/dev.mjs`'s `waitForReady`. Readiness-polling and the EADDRINUSE retry (A) are
  distinct concerns: a dead child (bind failure) must be detected as a **retry/failure**
  trigger, not merely waited out until the readiness timeout.
- **Reaping.** The subprocess is **killed on suite teardown and on failure** (afterAll +
  process-exit safety), so a crashed assertion cannot leak a listening Bun process or lock
  the temp DB. Spawn/teardown live in a shared helper, not copy-pasted per test.

### D3 — The integration tests run inside the existing runner; the default `test` script keeps working.

**Decision:** integration tests are Vitest files under `tests/` (e.g.
`tests/integration/*.test.js`) selected by the current `// @vitest-environment` +
`globals:false` conventions (a `node`-env file suffices; no DOM needed for pure-HTTP tests,
happy-dom for the seam-through-`storage.js` file only if it needs a DOM global — `fetch`
and `AbortSignal.timeout` both exist in Node 22, so `node` env is fine either way). They MUST:
- Run under **`bun run test`** (`vitest run`) alongside the existing suites **without
  breaking them** — the existing 87 core cases and the mocked component suites stay green
  and unchanged (INV-A).
- **Not** require the Bun runtime for the *test process itself* (Vitest still runs on Node);
  only the **spawned server child** uses Bun, invoked as `bun server/index.js`. The tests
  therefore assume `bun` is on `PATH` (it is — §0). A test MUST fail with a **clear
  diagnostic** (not a cryptic spawn error) if `bun` is missing, so CI misconfig is legible
  (R11). Whether integration tests run by default in `bun run test` or behind a separate
  script (`test:integration`) is Q1; the spec's binding requirement is only that they are
  runnable in this repo's runner and do not break the default suite.
- If the port-race fix is (B) serialization (D2), the added `vitest.config.*`/`test` block
  MUST NOT change how the **existing** suites run (they stay green, same env-per-file,
  `globals:false`); it may only add pool/serialization behavior scoped so the existing
  suites are unaffected (INV-A).

---

## 5. Requirements (verifiable)

Each requirement names how a test would falsify it. "The API" below is the **spawned real
server** on the ephemeral port with the throwaway DB (D2).

- **R1 — Round-trip persistence through real SQLite.** A `PUT /api/todos` of a known list
  followed by a `GET /api/todos` returns an **equal** list. *Falsify:* the GET after a PUT
  returns a different list (missing/extra/mutated todos) than was written.

- **R2 — Insertion order preserved (INV-D half).** For a list whose items are in a specific
  order, the `GET` returns them in **that same order** (not id/text-sorted, not arbitrary).
  *Falsify:* a PUT of `[a,b,c]` yields a GET ordering other than `a,b,c`.

- **R3 — `completed` marshals to a real JSON boolean (INV-E).** After persisting todos with
  `completed:true` and `completed:false`, the `GET` body has `completed` as JSON `true`/`false`
  (not `0`/`1`, not `"true"`). *Falsify:* any returned `completed` is a number or string.

- **R4 — First-run / empty DB returns `[]` (not 404/null).** Against a **fresh** throwaway DB
  (no prior PUT), `GET /api/todos` responds `200` with body `[]`. *Falsify:* a fresh DB GET
  returns `404`, `null`, an error, or a non-empty list.

- **R5 — Atomic transactional replace: whole-list swap.** A second `PUT` **fully replaces**
  the first list (no leftover rows from the prior list). *Falsify:* after
  `PUT([a,b]) -> PUT([c])`, the GET returns anything other than exactly `[c]`.

  R6 is deliberately **split into R6a and R6b** because the server rejects bad PUTs at **two
  different stages** with **two different guarantees**, and conflating them (the original R6
  did) would let a test claim it "proved rollback" when it never ran the rollback path (F1).
  The dividing line is `isConformingList` (`server/index.js:91-100`), which runs at
  `server/index.js:245` **before** `replaceAll` at `server/index.js:251`:
  - An **empty-string `id`** (line 95) or **empty-string `text`** (line 96) **fails shape
    validation** and is rejected `400` **before `replaceAll`/the `DELETE` ever runs** — the
    transaction never begins, so there is *nothing to roll back*; the DB is untouched by
    construction, not by rollback.
  - A **duplicate `id`** is **shape-valid** (each element is a non-empty-string id /
    non-empty-string text / boolean), so it **passes `isConformingList`, reaches
    `replaceAll`**, executes `DELETE FROM todos`, then trips the `id TEXT PRIMARY KEY`
    constraint on insert; `bun:sqlite` throws, the transaction **auto-rolls-back** (the
    handler catches the "constraint" error and returns `400`, `server/index.js:250-256`).
    This is the *only* case that exercises the DELETE-then-rollback path (INV-K).

- **R6a — Shape-rejection (empty-id / empty-text) is refused at VALIDATION, before any DB
  write.** After a successful `PUT` of a valid non-empty list, a subsequent `PUT` whose body
  is an array containing an element with an **empty-string `id`** (and, as a separate case,
  an **empty-string `text`**) is rejected `400` by `isConformingList` **before the
  transactional replace runs** — this is validation, **not** rollback: `replaceAll`/`DELETE`
  is never reached, so the stored list is untouched. A follow-up `GET` returns the
  **original list unchanged**. *Falsify:* such a PUT returns `2xx`; OR the follow-up GET
  shows the list emptied/partial/modified; OR the server `500`s/crashes. **Verifier note:**
  because no `DELETE` occurs, this case *cannot by itself distinguish* "validation blocked
  it" from "rollback restored it" — that distinction is R6b's job. R6a asserts only
  shape-rejection (`400`) + DB-untouched; a test that presents an empty-id/empty-text PUT as
  a *rollback* proof is itself a defect.

- **R6b — Constraint-rollback (duplicate-id) rolls the transaction back, leaving the OLD list
  intact (INV-K).** After a successful `PUT` of a valid non-empty list, a subsequent `PUT` of
  a **shape-valid** list containing a **duplicate `id`** (two elements sharing one non-empty
  id) is rejected `400`. This body **passes `isConformingList` and reaches `replaceAll`**, so
  the `DELETE FROM todos` executes and is then **rolled back** when the PRIMARY KEY constraint
  throws on insert; the follow-up `GET` returns the **original list unchanged** (not emptied,
  not partially written), proving the DELETE-then-rollback path (`server/index.js:250-256`)
  actually restores state. *Falsify:* the duplicate-id PUT returns `2xx`; OR the follow-up GET
  returns anything other than the exact original list (emptied, partial, or the attempted new
  list); OR the server `500`s/crashes instead of returning `400`.

- **R7 — Malformed / wrong-shape / wrong-method requests are rejected cleanly.** A `PUT` with
  a non-JSON body, or a JSON body that is not an array of `{id:string!="", text:string!="",
  completed:boolean}`, returns `400` and does not mutate the stored list; an unsupported method
  on `/api/todos` (e.g. `DELETE`/`POST`) returns `405`; the server never throws an unhandled
  error (no crash, process stays up for the next request). *Falsify:* any of these yields a
  `2xx`, mutates the DB, or takes the server process down. (Note: the empty-id/empty-text
  wrong-shape rejections of R6a are a *subset* of R7's "wrong-shape -> 400"; R6a additionally
  pins that they occur at validation, before any DB write.)

- **R8 — Body-size cap enforced (INV-L).** A `PUT` declaring or streaming a body over the
  1 MB cap is rejected (`413`; a length-absent/chunked PUT is `411` per the server) **without**
  persisting it. *Falsify:* an over-cap body is accepted (`2xx`) and stored, or the server OOMs
  instead of rejecting.

- **R9 — Origin/Host write guard rejects hostile writes (INV-L).** A `PUT` carrying a
  **foreign `Origin`** header (e.g. `https://evil.example`) is rejected `403` and does **not**
  mutate the DB, while a same-origin/loopback `PUT` (the tests' own requests) succeeds — proving
  the guard is active but not self-blocking. A `PUT` with a **non-loopback `Host`** header is
  likewise `403`. *Falsify:* a foreign-`Origin` or non-loopback-`Host` PUT succeeds in
  overwriting the list, OR the guard rejects the tests' legitimate same-origin PUTs (guard too
  strict -> the whole suite can't write).

- **R10 — The storage seam satisfies its invariants against the REAL server (INV-C/F/J).**
  Driving the actual `src/storage.js` `loadTodos()`/`saveTodos()` against the spawned server:
  (a) `saveTodos(list)` then `loadTodos()` round-trips to the same list, shape
  `Array<{id:string,text:string,completed:boolean}>`, in order (INV-C); (b) with the server
  **stopped/unreachable**, `loadTodos()` resolves `[]` and `saveTodos()` resolves `false`
  with **no unhandled rejection** (INV-F) — proving totality against a *real* dead socket, not a
  stub; (c) two rapid `saveTodos(v1)` then `saveTodos(v2)` leave the server **holding v2**
  (newest-state-wins, INV-J), asserted **by a real `GET` of the server's final state**.
  *Falsify:* the real round-trip changes shape/order; a real unreachable server produces a
  throw/unhandled rejection or a non-`[]`/non-`false` result; or a real `GET` after the two
  saves settle shows `v1` (or anything other than `v2`) persisted.

  *Constraint on R10(c) — save-coalescing return values (F2).* The seam **coalesces** racing
  saves (`src/storage.js:54-57`): the first `saveTodos` call owns the drain loop; a second
  call that arrives while a drain is already running sets `pending` and **returns `false`
  immediately** (`src/storage.js:56`) even though the drain loop will subsequently `PUT` v2
  and the server will correctly end up holding v2. Only the **drain-owning** call's return
  reflects the actual final `PUT` result. Therefore the R10(c)/INV-J binding assertion is the
  **server's final GET state (== v2)**, and it MUST NOT assert on the coalesced (second)
  call's boolean return. A **`false` return from the coalesced call is expected, correct
  behavior — not a failure**, and a test that fails when the second call returns `false`
  is itself a defect. (The round-trip in R10(a), by contrast, awaits a single non-coalesced
  save and MAY assert its `true` return, since no race coalesces it.)

  *Constraint on this test (D3):* `src/storage.js` posts to the **relative** URL `/api/todos`,
  which has no origin under `node`/happy-dom. The seam test MUST make that relative URL resolve
  to the spawned server (e.g. by stubbing a base URL / `fetch` wrapper that prepends
  `http://127.0.0.1:<port>` while still performing a **real** network call, or by driving through
  a real HTTP origin). It MUST NOT stub the *response* — the call goes to the live server. The
  plan states the exact mechanism; the binding rule is "real network to the real server," not
  "no wrapper at all."

- **R11 — The suite is self-contained, isolated, and CI-legible.** The integration suite
  (a) never touches the real `data/todos.sqlite` (uses `TODOS_DB_PATH` temp, INV-B); (b) uses a
  non-fixed/collision-avoiding port (INV-C); (c) reaps the server subprocess on pass, fail, and
  teardown (no leaked process/locked file); (d) waits for readiness by polling, never a blind
  sleep; (e) fails with a **clear message** if `bun` is not on `PATH`; (f) **survives a
  port-acquisition race** — if the chosen candidate port is taken between probe and bind
  (another process, or a **parallel Vitest worker** spinning up its own server; §0: Vitest
  parallelizes files by default), the suite MUST NOT crash spuriously on `Bun.serve`'s
  synchronous `EADDRINUSE` (`server/index.js:282-286`); it retries a fresh port up to a bounded
  count, or the integration files are serialized (D2 (A)/(B)). *Falsify:* running the suite
  creates/modifies `data/todos.sqlite`; a hardcoded port makes it fail when `8787` is in use;
  a failed assertion leaks a listening process or a temp DB; a fixed `sleep` is used for
  readiness; a missing `bun` produces an inscrutable error; **or** running the integration
  files in parallel (Vitest's default) makes the suite flake with an `EADDRINUSE`/bind crash
  because two servers raced for the same port.

- **R12 — Existing suites remain green and unmodified in substance (INV-A).** After adding the
  integration suite, `bun run test` still reports the **87 pure-core cases** passing and the
  existing `App.a11y` / `App.hydration-f33` suites passing; `tests/todos.test.js` is untouched.
  Any `vitest.config.*`/`test` block added for serialization (D2 (B)/Q6) MUST leave the existing
  suites' behavior unchanged. *Falsify:* `bun run test` shows any regression in count/pass state
  of the existing suites, or `tests/todos.test.js` is edited, or a serialization config changes
  how the existing suites run.

---

## 6. Acceptance criteria (concrete "done")

Done when **all** hold:

1. A new integration suite exists under `tests/` (e.g. `tests/integration/`) that spawns
   `bun server/index.js` with a **race-safe** ephemeral `TODOS_PORT` + throwaway
   `TODOS_DB_PATH`, polls it to readiness, and drives it over real HTTP (D1/D2).
2. Each of **R1–R5, R6a, R6b, R7–R10** has at least one passing, independently-falsifiable
   test (§7 maps them).
3. `bun run test` passes: the new integration tests **and** the existing suites (87 core +
   the two mocked component suites) are green; `tests/todos.test.js` is byte-for-byte unchanged
   (R12/INV-A).
4. Running the suite leaves **no** change to `data/todos.sqlite`, **no** leaked Bun process, and
   **no** stray temp DB after teardown (R11/INV-B), and does **not** flake under Vitest's default
   parallel file execution due to a port race (R11(f)/D2).
5. No production-code behavior changed (`src/**`, `server/index.js`, `scripts/dev.mjs`,
   `vite.config.js` behavior unchanged; permitted additions are an optional `package.json`
   script (Q1) and, only if serialization is chosen for the port-race fix, a `vitest.config.*`
   or `test` block that sets pool options without altering existing suites (Q6/N1)) (N1/INV-D).
6. No new heavyweight test dependency added (no Playwright/supertest/etc.); the runner is still
   Vitest and the HTTP client is platform `fetch` (N6/R11).

---

## 7. Testing expectations (spec level — the verifier's target)

The verifier must be able to prove each `R*`/`INV-*` via at least the mapped test. Suggested
shape (plan fixes file layout):

- **T1 -> R1/R2/R3** — round-trip: PUT a known ordered list with mixed `completed`; GET; assert
  deep-equal, same order, booleans real.
- **T2 -> R4** — fresh throwaway DB: GET returns `200 []`.
- **T3 -> R5** — PUT `[a,b]` then PUT `[c]`; GET returns exactly `[c]`.
- **T4a -> R6a** — PUT a valid list; then PUT a shape-invalid list containing an
  **empty-id** element (and, separately, an **empty-text** element) -> `400`; GET returns the
  original list intact; server still responsive. This is **validation/shape-rejection**: the
  test asserts `400` + DB-untouched, and MUST NOT be framed as exercising rollback (no `DELETE`
  runs on this path). (empty-id -> `isConformingList` line 95; empty-text -> line 96; both
  short-circuit at `server/index.js:245` before `replaceAll`.)
- **T4b -> R6b** — PUT a valid list; then PUT a **shape-valid** list containing a
  **duplicate id** -> `400`; GET returns the original list **intact**, proving the
  DELETE-then-rollback path (`server/index.js:250-256`) restored state; server still responsive.
  This is the test that actually exercises constraint-rollback (INV-K).
- **T5 -> R7** — non-JSON body -> `400`; wrong-shape body -> `400`; `DELETE`/`POST` /api/todos ->
  `405`; DB unchanged; process alive.
- **T6 -> R8** — over-cap body -> `413` (and length-absent -> `411`); not persisted.
- **T7 -> R9** — foreign-`Origin` PUT -> `403`, DB unchanged; non-loopback-`Host` PUT -> `403`;
  same-origin PUT (no/local Origin) -> `2xx` (guard not self-blocking).
- **T8 -> R10** — via real `src/storage.js`: (a) save->load round-trip shape/order (single,
  non-coalesced save MAY assert `true`); (b) server killed -> `loadTodos()===[]`,
  `saveTodos()===false`, no unhandled rejection; (c) rapid `save(v1)`,`save(v2)` -> assert the
  **server's final GET state === v2** (newest-state-wins, INV-J). T8(c) MUST assert on the real
  GET, **not** on the coalesced second call's boolean: under save-coalescing
  (`src/storage.js:56`) the second call returns `false` while the drain loop still commits v2,
  so a `false` return there is **expected/correct** and must not fail the test (F2).
- **T9 -> R11** — assertions/guards that the temp DB (not `data/todos.sqlite`) is used, the
  subprocess is reaped (afterAll), readiness is polled, a missing `bun` yields a clear error,
  and the port-acquisition is **race-safe**: exercise/ensure that a taken candidate port does
  not crash the suite (bind-retry succeeds, or the integration files are serialized), so the
  suite stays green under Vitest's default parallel file execution (R11(f)/D2).
- **T10 -> R12** — the full `bun run test` run reports the existing suites green; a CI/script
  check that `tests/todos.test.js` is unmodified.

Any `INV-*`/`R*` without a falsifiable test is a spec defect to fix before the plan gate.

---

## 8. Failure modes & invariants (what must never happen)

- **INV-A — Existing coverage preserved.** The 87 pure-core cases and the two mocked component
  suites stay green and substantively unmodified; `tests/todos.test.js` is untouched; any
  added serialization config (Q6) does not change how they run. *Falsify:* any existing suite
  regresses or `tests/todos.test.js` is edited.
- **INV-B — Never touch the real data file.** No integration test reads/writes/relies on
  `data/todos.sqlite`; all persistence goes to a throwaway `TODOS_DB_PATH`, removed on teardown
  (WAL sidecars included). *Falsify:* a test run creates or mutates `data/todos.sqlite`, or leaves
  a stray temp DB.
- **INV-C — No fixed-port assumption / no port collision / race-safe acquisition.** The suite
  uses a collision-avoiding (ideally OS-assigned) port, not a hardcoded `8787`, **and** acquires
  it in a way that survives a TOCTOU race with another process or a parallel Vitest worker
  (retry-on-EADDRINUSE or serialized files; D2/R11(f)). *Falsify:* the suite fails or misbehaves
  when `8787`/`5173` is already bound, or flakes with an `EADDRINUSE` bind crash when its files
  run in parallel.
- **INV-D — Test-only; no production behavior change.** Only files under `tests/` (and, at most,
  an additive `package.json` script and — only for serialization — a `vitest.config.*`/`test`
  block that adds pool options without altering existing suites) change; `src/**`,
  `server/index.js`, `scripts/dev.mjs`, `vite.config.js` *behavior* is unchanged. *Falsify:* the
  diff alters production logic, or an integration test only passes because production code was
  changed to suit it.
- **INV-E — No leaked processes / deterministic teardown.** Every spawned server is reaped on
  pass, fail, and teardown; the suite does not hang or leave a listening Bun process or a locked
  DB. *Falsify:* a failing assertion leaves a live server or the runner hangs on exit.
- **INV-F — No mock below the test.** Integration tests do not stub the *response* of `fetch`, the
  server, or SQLite; they exercise the real chain over a real socket. (The *existing* mocked
  suites remain, separately — that is N3, not a violation. A relative-URL base-resolver that still
  performs a real network call, R10, is permitted; a stubbed response is not.) *Falsify:* an
  "integration" test stubs the network response/server/DB and thus proves nothing about the real
  wiring.
- **INV-G — No new heavyweight test dependency / no framework swap.** Runner stays Vitest; client
  is platform `fetch`; server is a `bun` subprocess. *Falsify:* Playwright/Cypress/supertest/msw or
  a framework change appears in `package.json`.

---

## 9. Open questions (need human/arbiter input)

- **Q1 — Do integration tests run in the default `bun run test`, or behind a separate
  `test:integration` script?** Running by default gives one green bar but makes every `test` run
  spawn Bun subprocesses (slower; requires `bun` on `PATH` in every CI lane). *Proposed default:*
  include them in `bun run test` (the repo already runs `bun` everywhere and `bun` is on `PATH`);
  add an optional `test:integration` alias for focused runs. Confirm, or require separation.
- **Q2 — Test env for the seam test (R10).** Node 22 has global `fetch`/`AbortSignal.timeout`, so a
  `// @vitest-environment node` file can import `src/storage.js` directly. *Proposed default:* `node`
  env for pure-HTTP + seam tests (no happy-dom needed); reserve happy-dom for the existing component
  suites. Confirm, or mandate happy-dom for uniformity.
- **Q3 — Port selection mechanism (race-safe).** The naive "OS-assigned free port: grab, close,
  pass" pattern has a TOCTOU race that `Bun.serve` turns into a synchronous `EADDRINUSE` crash
  (F3/D2). *Proposed default:* still start from an OS-assigned ephemeral port for collision
  *avoidance*, but wrap the spawn in a **retry-on-EADDRINUSE loop** (D2 (A)) so a lost race
  re-picks a port instead of failing; alternatively serialize the integration files (D2 (B)).
  Confirm the retry-loop default, or require serialization.
- **Q4 — Should any test exercise the Vite proxy hop or the preview/prod `dist/` static-serve
  path?** This spec scopes those **out** (N4) as config/ergonomics, not app behavior, and because
  the `dist/` path needs a prior `vite build`. Confirm out-of-scope, or scope a minimal smoke test
  (e.g. a post-`build` check that `/api/todos` is reachable same-origin) as a follow-up item.
- **Q5 — Temp-DB location & git-ignore.** Options: OS temp dir (no repo footprint) vs a git-ignored
  `tmp/` in-repo (easier to inspect on failure). *Proposed default:* OS temp dir with a random suffix,
  removed on teardown — zero repo footprint, no `.gitignore` change needed. Confirm, or prefer an
  in-repo ignored dir.
- **Q6 — If serialization (D2 (B)) is chosen for the port-race fix, is adding a `vitest.config.*`
  (or a `test` block in `vite.config.js`) acceptable?** It is the one test-runner config change
  N1 permits (it sets pool/serialization options only, no `src/`/`server/` logic), and it MUST
  leave the existing suites' behavior unchanged (INV-A/R12). *Proposed default:* prefer the
  retry-loop (D2 (A)) which needs **no** config file; add config only if serialization is
  chosen. Confirm.
