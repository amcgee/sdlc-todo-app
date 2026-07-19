# SPEC — ISSUE-31: Migrate to cloud (Cloudflare serverless)

Status: SPEC (draft for the spec gate)
Owner: architect
Work item: ISSUE-31
GitHub issue: #31 — "Migrate to cloud"
PR: #32
Ratified design: [docs/specs/ISSUE-31.md](ISSUE-31.md)

---

## 0. Grounding — what is actually in the repo today

Written against the tree at `HEAD` on branch `claude/sdlc-issue-31`, not against assumptions.
Verified facts (file:line):

- **Stack / runtime.** React `^18.3.1` + Vite `^5.4.0`, ESM. Package manager + task runner +
  (via Vitest) test runner is **Bun**. The persistence server is **Bun-only**: it imports
  `bun:sqlite` (`server/index.js:16`) and binds with `Bun.serve` (`server/index.js:282`).
- **Server contract (`server/index.js`).** A single process bound to the literal loopback
  `127.0.0.1` (`server/index.js:283`) that owns one SQLite file (default
  `data/todos.sqlite`, override `TODOS_DB_PATH`, `server/index.js:39-41`) and exposes:
  - `GET /api/todos` → `200 [{id,text,completed}]` in **insertion order** (`ORDER BY position`,
    `server/index.js:64`), with `completed` marshalled INTEGER→**JS boolean**
    (`server/index.js:209`).
  - `PUT /api/todos` → **atomic whole-list replace** inside a `bun:sqlite`
    `db.transaction` (`DELETE FROM todos` then re-INSERT with `position`,
    `server/index.js:70-76`); auto-rolls-back on any throw, so a constraint violation after the
    DELETE leaves the **old list intact** (INV-K).
  - In preview/prod it also serves `dist/` static assets same-origin (`server/index.js:160-183,
    268-271`) so `/api` and the SPA share one origin.
- **Three write-path safety guarantees (the design's binding constraint), as they exist today:**
  1. **Streaming body-size cap, 1 MB (`MAX_BODY_BYTES`, `server/index.js:34`).** A `Content-Length`
     that is absent → **411** (`server/index.js:217-219`); present and over-cap → **413**
     (`server/index.js:222-224`); a body that streams past the cap is aborted mid-read → **413**
     (`readCappedBody`, `server/index.js:105-128, 234-236`). The whole body is never buffered
     first.
  2. **Default-deny Origin/Host guard (`checkWriteGuard`, `server/index.js:133-154`).** On writes:
     **Host must be present and loopback** (`127.0.0.1`/`localhost`, else 403); a **present Origin
     must be in an allowlist** derived from the configured ports (`ALLOWED_ORIGINS`,
     `server/index.js:27-32`); a **missing Origin is tolerated** only because Host was already
     gated. A request missing both is rejected, not vacuously allowed.
  3. **Transactional whole-list replace** (above).
  - Shape validation `isConformingList` (`server/index.js:91-100`) runs at `server/index.js:245`
    **before** the transaction: non-array, empty-`id`, empty-`text`, or non-boolean `completed`
    → **400**, no DB write. A **duplicate id** is shape-valid, reaches `replaceAll`, and trips the
    `PRIMARY KEY` constraint → auto-rollback → **400** (`server/index.js:250-256`). Schema CHECKs
    give the constraints teeth (`server/index.js:53-60`).
- **Client storage seam (`src/storage.js`).** `loadTodos()`/`saveTodos()` talk to the **relative**
  URL `/api/todos` (`src/storage.js:15`) over `fetch`; both are **total** (never reject — every
  failure maps to `[]`/`false`, INV-F), with a 3 s timeout and **newest-state-wins** save
  coalescing (INV-J, `src/storage.js:40-85`). App wiring in `src/App.jsx` (mount-load + persist-on-
  change) is unchanged by this work.
- **Dev + build wiring.** `scripts/dev.mjs` spawns the Bun API, polls it to readiness, then starts
  Vite; `vite.config.js` proxies `/api` → `127.0.0.1:$TODOS_PORT` (`vite.config.js:17-23`).
  `package.json` scripts: `server`, `dev`, `build` (`vite build`), `preview`, `test`,
  `test:integration`.
- **Existing tests.** `tests/todos.test.js` (pure core), two mocked component suites, and the
  **ISSUE-19 integration suite** (`tests/integration/**`): a hardened fixture
  (`tests/integration/helpers/server.js`) that **spawns `bun server/index.js`** on a race-safe
  ephemeral port against a throwaway temp-dir SQLite DB, waits for the **stdout readiness marker**
  `todos API listening on http://127.0.0.1:<port>` (`server/index.js:289`), and drives it over real
  HTTP + raw `node:net` sockets (for Host-forging / 411 cases). It asserts the full server contract
  (round-trip/order/boolean, R5 swap, R6a validation, R6b constraint-rollback, R7 method/shape, R8
  cap, R9 origin/host guard, R10 seam totality). This fixture is **Bun/`bun:sqlite`-specific** and
  intricately hardened — any runtime change must keep it green.
- **CI.** `.github/workflows/tests.yml` runs `bun install --frozen-lockfile && bun run test` on PRs
  and pushes to `main`/`master` (a required check). `.github/workflows/sdlc-arbiter-gate.yml`
  re-derives the ledger merge gate (**protected — must not be touched**).
- **Confirmed absent (verified):** **no** `wrangler.toml`/`wrangler.jsonc`, no `Dockerfile`, no
  `*.tf`, no deploy scripts, no `functions/` or `worker/` directory. This is a greenfield cloud
  migration.

---

## 1. Problem statement

Today the app runs only on a developer's machine: one Bun process bound to loopback owns a local
SQLite file and serves the built UI. It is un-shareable, un-reachable from another device, and has
no path from "works on my laptop" to "running in the cloud." This work makes the app run on
Cloudflare's serverless platform, reachable at a public `*.workers.dev` URL, provisioned
reproducibly from committed configuration, with two standing environments — a stable **Production**
deployment and an **ephemeral per-PR Preview** with its own isolated, empty data — and **deploys
automated from GitHub**. The app's user-facing behavior and its persistence promise
(todos survive reload, cold start, and redeploy) stay identical; the three write-path safety
guarantees are re-derived for a public origin. What changes is *where and how it runs*, not *what it
does*.

---

## 2. Scope

**In scope:**

- A **Cloudflare Worker** (with the **Static Assets** binding) that serves the built SPA and the
  `GET`/`PUT /api/todos` API from **one origin**, backed by **Cloudflare D1** for persistence
  (D-COMPUTE, D-STORE).
- A **runtime seam refactor**: the request-handling contract (routing, guard, body-cap, parse,
  shape-validate, transactional replace) is extracted into a **runtime-agnostic handler** with a
  small **storage-port interface**, so exactly **one** implementation of the HTTP contract backs
  **two** thin adapters — the existing **Bun/`bun:sqlite` adapter** (kept for local dev + the
  ISSUE-19 test oracle) and a new **Worker/D1 adapter** (the deployed cloud runtime) (D-SEAM). No
  contract drift by construction.
- Re-derivation of the three write-path guarantees for the Worker runtime and a public origin
  (D-GUARDS): streaming 1 MB body cap, **default-deny same-origin write guard**, atomic whole-list
  replace via D1 `batch()`.
- **Infrastructure as code** via **Wrangler declarative config** (`wrangler.jsonc`) plus a committed
  **D1 migration** for the schema (D-IAC).
- **GitHub Actions deploy workflow(s)** (D-DEPLOY): push to `main` → Production; PR
  opened/updated → its per-PR Preview (isolated Worker + isolated D1); PR closed → Preview torn down.
  Uses a provided Cloudflare API-token secret. Additive workflow files that **do not touch**
  `sdlc-arbiter-gate.yml`.
- A **cloud-runtime contract test** driving the Worker locally via `wrangler dev` (local D1), proving
  the Worker/D1 adapter honors the same guard/persistence contract as the Bun adapter (D-TESTS).
- Doc updates (`README.md`) describing the new deploy model.

**Out of scope:** see §3.

---

## 3. Non-goals

- **N1 — No new app features / no behavior change to the SPA.** `src/todos.js`, `src/App.jsx`, and
  the *observable* behavior of `src/storage.js` are unchanged. The list stays a **single shared,
  no-auth** list.
- **N2 — No access control / accounts / multi-user / per-preview auth.** Anyone with a URL edits
  that environment's shared list. (Explicit design decision; a security consequence is called out in
  §8/INV-SEC.)
- **N3 — No data migration.** No local data is carried to the cloud; no data crosses between
  environments. Every environment (prod and each preview) **starts empty**.
- **N4 — No custom domain / DNS / TLS management.** Public URL is Cloudflare's `*.workers.dev`.
- **N5 — No multi-region/HA guarantees beyond Cloudflare defaults; no region pinning.**
- **N6 — No Terraform/Pulumi/CDK.** IaC is Wrangler-native config + a D1 migration (D-IAC).
- **N7 — No change to protected pipeline files.** `.github/workflows/sdlc-arbiter-gate.yml`,
  `.claude/**`, and `SDLC/**` are **never** modified by this cycle.
- **N8 — Not removing the Bun server.** The Bun adapter stays as local-dev backend and the ISSUE-19
  contract oracle; deployment (not local dev) is what moves to Cloudflare (D-DEVLOCAL).
- **N9 — No rewrite of the ISSUE-19 integration suite.** It keeps spawning the Bun adapter and stays
  green, byte-for-byte in substance. Cloud-runtime coverage is **additive** (D-TESTS).
- **N10 — No secrets in the repo.** The Cloudflare API token is a GitHub Actions secret supplied at
  deploy time; the account is not provisioned here.

---

## 4. Architectural decisions

### D-COMPUTE — One Cloudflare **Worker with Static Assets** serves both the SPA and the API. (Contestable.)

**Decision.** Deploy a single Worker per environment. It uses the **Static Assets** binding to serve
the Vite `dist/` build for non-`/api` GETs, and runs the Worker `fetch` handler for `/api/todos`.
This mirrors the existing same-origin model (`server/index.js` already serves `dist/` + `/api` from
one origin, `server/index.js:160-183`) with the least conceptual change, and lets `src/storage.js`
keep posting to the **relative** `/api/todos` unchanged.

**Why.** Cloudflare's current guidance is that **Workers Static Assets is the recommended way to
deploy a SPA + API** as one deployable unit; Pages is in maintenance-mode for new feature work. One
Worker = one origin = one deploy = one URL per environment, which makes per-PR isolation and the
same-origin guard trivial to reason about.

**Assets vs Worker routing — made explicit, not left to defaults (addresses ISSUE-31-F5).** Two
failure modes must be foreclosed in config: (a) with SPA fallback on, an unmatched path returns
`index.html` 200 — so a *misrouted* `/api/todos` could return HTML that `loadTodos()` silently coerces
to `[]`; and (b) Static Assets serve **before** the Worker unless configured otherwise, so `/api/*`
could be shadowed by asset resolution. The `wrangler.jsonc` `assets` block MUST therefore be exactly:

```jsonc
"assets": {
  "directory": "./dist",
  "binding": "ASSETS",
  "not_found_handling": "single-page-application",
  "run_worker_first": ["/api/*"]
}
```

`run_worker_first: ["/api/*"]` guarantees the Worker `fetch` handler runs first for every `/api/*`
request (so `/api/todos` always reaches Worker code, never asset resolution); `not_found_handling:
"single-page-application"` gives client-side routes their `index.html` fallback for **non-`/api`**
paths only. **Belt-and-suspenders in code (required, not optional):** the Worker `fetch` handler MUST
branch on `new URL(request.url).pathname.startsWith('/api/')` **first** and fully own those paths —
returning a JSON `404`/`405` for any unknown method/route under `/api/` — and only delegate to
`env.ASSETS.fetch(request)` for non-`/api` requests. So `/api/todos` can **never** fall through to a
200 `index.html`: even if the `run_worker_first` route form is unsupported by the pinned Wrangler
version, the code-level ordering alone still guarantees it. This double guard is tested (R-GUARD-5).

**Alternatives rejected:**
- **Cloudflare Pages + Pages Functions with Pages' native Git previews.** Rejected: Pages' built-in
  preview deployments are driven by Cloudflare's own Git integration, which **bypasses the design's
  "deploy from GitHub Actions using the provided secret" requirement**, and Pages previews do **not**
  cleanly give each PR an *isolated* D1 database (previews share the project's bindings). Also on
  Cloudflare's own de-emphasized path.
- **Pages for static + a separate Worker for the API (two deployables, two origins).** Rejected:
  splits the origin, forcing CORS or a route rule, breaking the seam's relative-URL simplicity, and
  doubling the per-PR provisioning surface.
- **A single Worker returning assets from KV/R2 by hand.** Rejected: reinvents what the Static Assets
  binding does natively.

### D-STORE — Persistence is **Cloudflare D1** (serverless SQLite), keeping the row-per-todo schema. (Contestable.)

**Decision.** Each environment binds one **D1 database** (`env.DB`). The **existing schema ports
essentially verbatim** into a committed migration (`migrations/0001_init.sql`): `todos(id TEXT
PRIMARY KEY, text TEXT NOT NULL CHECK(length(text)>0), completed INTEGER NOT NULL CHECK(completed IN
(0,1)), position INTEGER NOT NULL)` (`server/index.js:53-60`). The atomic whole-list replace becomes
a single **`env.DB.batch([DELETE, INSERT…])`**, which D1 executes as one **atomic transaction**
(all-or-nothing); a `PRIMARY KEY`/CHECK violation rejects the batch and commits nothing, preserving
INV-K.

**Why.** D1 **is** SQLite, so the schema, constraints, `position`-ordered reads, INTEGER↔boolean
marshalling, and the constraint-rollback contract (R6b) survive with minimal change and the *exact
same observable semantics* the ISSUE-19 tests already pin. Per-environment isolation is one binding
to one database. It is on Cloudflare's free tier (§ D-COST).

**Alternatives rejected:**
- **KV (single JSON blob per key).** Rejected: KV is **eventually consistent** (edge reads can be
  stale), weakening the read-after-write the app relies on, and it **cannot enforce PRIMARY
  KEY/CHECK constraints**, so the duplicate-id constraint-rollback guarantee (INV-K/R6b) would be
  lost — a *contract regression*, not just an implementation swap.
- **Durable Objects (with embedded SQLite).** Rejected: correct for strong single-writer consistency,
  but heavier to provision/teardown per PR and overkill for one shared small list; D1 already gives
  the needed atomicity.
- **R2.** Rejected: object storage, no transactions/constraints; wrong primitive for a mutable
  relational list.

**Drift trap — closed, not merely flagged (addresses ISSUE-31-F2).** `bun:sqlite` throws
constraint errors whose message contains the lowercase token `"constraint"` (`server/index.js:255`);
D1 throws a **differently-worded** error (e.g. `D1_ERROR: … UNIQUE constraint failed: todos.id:
SQLITE_CONSTRAINT_PRIMARYKEY`), and **local miniflare D1 and real remote D1 are not guaranteed to
word it identically**. Relying on string-matching one runtime's message is a live drift/500 risk.
This spec removes the dependency in three layers, in priority order:

1. **Primary — deterministic duplicate-id pre-check in the SHARED validation (driver-independent).**
   After `isConformingList` passes, the shared handler rejects a list containing **duplicate `id`s**
   with **400** *before any DB call*, by a pure in-memory check (`ids.length !== new Set(ids).size`).
   Shape validation already rejects every other client-shaped defect, so the duplicate-`id`
   PRIMARY-KEY collision is **the only** constraint a shape-valid list could ever trip — pre-checking
   it makes the duplicate-id→400 outcome **identical in both runtimes with zero dependence on any
   driver's error wording**. Observable contract is preserved exactly: status **400**, DB unmutated
   (no `DELETE`/`batch` issued) — which is what the ISSUE-19 R6b test asserts
   (`tests/integration/server.test.js:89-107` checks only status 400 + old list intact, not the error
   body). The Bun adapter's observable behavior is therefore unchanged (INV-CONTRACT holds).
2. **Backstop — robust, driver-tolerant classifier.** If the DB itself rejects a write (defence in
   depth; e.g. a constraint reachable by a future schema change), `TodoStore.replaceAll` MUST surface
   it so the handler maps it to **400, never 500**. The classifier MUST NOT match a single lowercase
   token; it matches **case-insensitively** against any of `constraint`, `unique`, `primary key`,
   `check`, or `SQLITE_CONSTRAINT` in the error `message`/`cause`. This tolerates both `bun:sqlite`
   and D1 (local *and* remote) wording.
3. **One-time real-remote-D1 verification (recorded in the plan, Phase D step 9a).** Because the
   backstop is the only wording-sensitive layer and local miniflare may differ from production, the
   builder MUST perform a **one-time manual verification against a real remote D1** (a throwaway
   scratch DB) that a raw PRIMARY-KEY collision is classified to 400 there, and record the observed D1
   error text in the PR. This is a checklist item, not a standing CI job; the deterministic pre-check
   (layer 1) is what the automated R-GUARD-3 test proves.

### D-SEAM — One runtime-agnostic handler + a storage-port interface; two thin adapters. (Most contestable — this is where drift would hide.)

**Decision.** Extract the contract logic from `server/index.js` into a **runtime-agnostic module**
(proposed `server/handler.js`, no `bun:sqlite`/`Bun` import) exposing a pure async
`handleRequest(request, { store, config })` that performs routing, the write guard, the streaming
body cap, JSON parse, `isConformingList`, and the transactional-replace call **through a storage
port**. The port interface is minimal:

```
interface TodoStore {
  readAll(): Promise<Array<{id, text, completed:boolean}>>   // position-ordered
  replaceAll(rows): Promise<void>                            // atomic; throws (classified) on constraint
}
```

Two adapters implement/consume it:
- **Bun adapter** — `server/index.js` keeps `Bun.serve` + `bun:sqlite`, builds a `bun:sqlite`-backed
  `TodoStore`, and delegates to `handleRequest`. It keeps its **exact observable behavior and the
  stdout readiness marker** so the ISSUE-19 fixture and `scripts/dev.mjs` are untouched and green.
- **Worker adapter** — new `worker/index.js` (`export default { fetch(request, env) }`) builds a
  **D1-backed `TodoStore`** from `env.DB` and delegates to the **same** `handleRequest`, then falls
  back to the Static Assets binding for non-API requests.

**Why.** Two independent server implementations of one HTTP contract is the classic drift liability
the adversary would (rightly) file. A single shared handler makes the two runtimes **identical on the
contract for every input the shared validation admits** — the only per-runtime code is the storage
adapter, the bind/serve shell, and an explicit **per-adapter guard/body config** (see D-GUARDS: the
guard's allowed-origin source, whether a loopback Host is required, whether an absent `Content-Length`
is a hard 411). The claim is **bounded, not absolute** (addresses ISSUE-31-F6): two runtimes can
still diverge on inputs the handler does **not** normalize — notably a shape-valid but pathologically
large list (~26k rows near the 1 MB body cap) that `bun:sqlite` accepts in-process yet that would
exceed D1's per-`batch()` statement/parameter limits. **D-GUARDS-4 closes that specific gap** by
bounding list length in the **shared** validation so both runtimes reject the same oversized lists
identically. It also means the ISSUE-19 suite (driving the Bun adapter) and the new cloud-contract
test (driving the Worker adapter) are testing the **same handler**, so a pass on either is strong
evidence for both — within that shared, bounded input domain.

**Alternatives rejected:**
- **Two independent servers** (leave Bun as-is; write a from-scratch Worker). Rejected: guaranteed
  drift; every future contract change must be made and re-tested twice.
- **Replace the Bun server entirely; run `wrangler dev` for all local dev and rewrite the ISSUE-19
  fixture to spawn `wrangler dev`.** Rejected as the default: it churns the intricate, adversarially-
  hardened ISSUE-19 fixture (raw-socket Host forging, EADDRINUSE retry keyed on a Bun stdout marker,
  temp-dir SQLite reaping), risks the **binding "existing suite still passes"** criterion, and makes
  the default test lane heavier/slower (workerd boot per run). Kept available *optionally* via
  `wrangler dev` for those who want to exercise the cloud runtime locally (D-DEVLOCAL).

**Constraint on the refactor (binding):** it is a **pure extraction** — the Bun adapter's observable
behavior (status codes, headers, ordering, marker line, loopback bind) MUST be unchanged, proven by
the **unchanged** ISSUE-19 suite staying green (INV-CONTRACT).

### D-GUARDS — Re-deriving the write-path guarantees for the Worker runtime + public origin.

**The guard/body logic is ONE shared function whose decision is a pure function of `(request,
config)`; each adapter passes the config that reproduces its required semantics.** This is what lets
one handler serve two runtimes without drift *and* without regressing the ISSUE-19 contract (which
pins loopback-Host + allowlist behaviour for the Bun adapter). The config carries: the allowed-origin
source, `requireLoopbackHost` (bool), `requireContentLength` (bool), `maxBodyBytes`, `maxListLen`, and
an optional extra `allowedOrigins` allowlist.

1. **Streaming body-size cap (1 MB); the 411 branch is scoped Bun-only (addresses ISSUE-31-F9).** The
   cap is enforced by *streaming* the body under a running byte counter (`readCappedBody`) — the
   authoritative check in both runtimes: a declared `Content-Length` over cap → **413** fast; a body
   that streams past the cap → **413** mid-read; neither persisted.
   - **Bun adapter** keeps `requireContentLength: true` → an **absent `Content-Length` → 411**,
     preserving ISSUE-19's `guard.test.js:41-52` exactly (INV-CONTRACT).
   - **Worker adapter sets `requireContentLength: false` and does NOT emit 411.** Rationale (F9):
     (i) Cloudflare's edge may terminate HTTP/2/3 and **normalize or drop `Content-Length`** before
     the Worker sees the request, so an absent length is not a reliable signal at the edge and a hard
     411 would risk **self-blocking the app's own legitimate writes**; (ii) the `wrangler dev` fixture
     has no raw-socket capability, so a length-less request is not even producible there. The Worker
     relies on the streaming running-cap for the over-size guarantee (413), which **is** producible
     and tested. **The 411 requirement is explicitly dropped from the Worker/cloud contract** and
     documented as such; the handler's 411 branch still exists and stays proven against Bun by
     ISSUE-19. (Cloudflare's own request-body ceiling is far larger, so the app's 1 MB cap stays the
     binding limit.)

2. **Same-origin write guard — allowed origin derived from `new URL(request.url).origin` (addresses
   ISSUE-31-F7).** Loopback-Host has no meaning on a public origin, so the guarantee is re-expressed
   while preserving its *intent* (reject cross-origin writes; default-deny):
   - **The compare-origin MUST be `new URL(request.url).origin`** — which carries the *correct scheme*
     (`https` on `*.workers.dev`) from the live request. It MUST NOT be reconstructed from the `Host`
     header with a hardcoded/assumed scheme. Today's Bun guard builds allowed origins as
     `'http://' + host` (loopback-only assumption, `server/index.js` `ALLOWED_ORIGINS`); **reusing
     that construction on a public origin would compare a `http://…` string against the browser's
     `https://…` `Origin` and 403 the app's own writes.** That is the self-block trap F7 names, and it
     is closed by deriving the origin from `request.url`, not from Host + an assumed scheme.
   - On a write, if an **`Origin` header is present it MUST equal that derived origin** (same-origin
     only); a cross-site `Origin` (e.g. `https://evil.example`) → **403**. A **missing `Origin` is
     tolerated** (parity with today; a non-browser client such as `curl` is not a CSRF vector, and
     browsers attach `Origin` to cross-origin state-changing requests).
   - **Why derive from the request rather than a configured `APP_ORIGIN`:** every preview has a
     *different* `*.workers.dev` URL; a per-environment configured origin would have to be injected
     correctly for N ever-changing preview URLs and a wrong value **self-blocks the whole app**.
     Deriving same-origin from `request.url` needs **zero per-preview config** and cannot self-block.
     On Cloudflare the request `Host` is authoritative (the edge routes to this Worker *by* that
     hostname), so Host-confusion is not a live vector.
   - **Bun adapter is unchanged:** it keeps `requireLoopbackHost: true` and its existing
     `ALLOWED_ORIGINS` allowlist, so ISSUE-19's forged-Host→403 (`guard.test.js:84-118`),
     foreign-Origin→403, and no-Origin-loopback→200 assertions stay green byte-for-byte. The Worker
     adapter sets `requireLoopbackHost: false` and uses the request-derived same-origin rule.
   - *Optional defense-in-depth (Worker):* an `ALLOWED_ORIGINS` var MAY additionally pin an allowlist;
     if unset, the same-origin rule stands alone.
   - Falsifiers (R-GUARD-2): foreign-`Origin` PUT → 403, no mutation; the app's own same-origin PUT
     (correct `https` scheme) → 2xx (guard not self-blocking on any preview URL).

3. **Atomic whole-list replace + constraint handling.** Re-implemented as
   **`env.DB.batch([DELETE, …INSERT])`** (D-STORE), atomic by D1's contract; a rejected batch commits
   nothing, old list intact (INV-K). Duplicate-id → 400 is guaranteed **before** the batch by the
   shared pre-check (D-STORE layer 1); the driver-tolerant classifier (layer 2) maps any DB-level
   constraint error to 400 as backstop, never 500.

4. **Bounded list length in the SHARED validation (addresses ISSUE-31-F6).** `isConformingList` (or a
   sibling shared check) MUST reject a list whose length exceeds **`MAX_LIST_LEN` (default 1000
   items)** with **400**, in **both** runtimes, before any DB call. This forecloses the one known
   place the runtimes could diverge on a shape-valid input: a ~26k-row list that fits under the 1 MB
   body cap and that `bun:sqlite` accepts in-process but that would exceed D1's per-`batch()`
   statement/parameter limits. Bounding length in shared code makes both runtimes reject the same
   oversized lists identically. 1000 is comfortably below any plausible D1 batch ceiling and far above
   any real shared-todo-list use; it is a tunable config constant. Additive and applied to both
   adapters simultaneously (so it cannot itself cause drift); ISSUE-19 sends no >1000-item list, so
   the suite stays green.

5. **`/api/*` never falls back to `index.html` (addresses ISSUE-31-F5).** See D-COMPUTE: the Worker
   `fetch` handler owns every `/api/*` path (returning JSON, incl. 404/405) *before* any
   `env.ASSETS.fetch` delegation, and `run_worker_first: ["/api/*"]` pins the same at the platform
   layer. A misrouted `/api/*` request returns a JSON error, never a 200 `index.html` that
   `loadTodos()` would coerce to `[]`.

### D-IAC — Infrastructure as code via **Wrangler declarative config** (`wrangler.jsonc`) + a committed D1 migration. (Answers design Q1.)

**Decision.** The cloud footprint is defined by committed, reviewable, version-controlled files:
- **`wrangler.jsonc`** — declares the Worker name, `compatibility_date`, the **Static Assets**
  binding (`assets.directory = ./dist`), the **D1 binding** (`d1_databases[].binding = "DB"`), and a
  Production environment. This *is* infrastructure as code: `wrangler deploy` recreates the Worker
  and its bindings from it.
- **`migrations/0001_init.sql`** — the schema, applied idempotently via `wrangler d1 migrations
  apply`. The DB *shape* is code, not console clicks.
- **Per-PR preview provisioning — exact binding-injection mechanism (addresses ISSUE-31-F3).**
  `wrangler.jsonc` commits the **Production** D1 binding, including a concrete production
  `database_id`. New per-PR D1s get **new uuids**, so a preview deploy MUST bind to the PR's *own* D1
  and can **never** inherit the committed production id. The mechanism is a **generated, per-PR config
  file** — the production `wrangler.jsonc` is *not* used for preview deploys:
  1. A committed template **`wrangler.preview.template.jsonc`** carries the assets/D1 shape with
     **placeholders** `${WORKER_NAME}`, `${DB_NAME}`, `${DB_ID}` and **no hardcoded `database_id`**.
  2. CI resolves the PR's D1 uuid at runtime — `wrangler d1 info todo-preview-pr-<n> --json | jq -r
     '.uuid'` (creating the DB first if absent) — into `$DB_ID`, and reads the committed production id
     into `$PROD_DB_ID` (`jq` over `wrangler.jsonc`).
  3. CI **fails hard** if `$DB_ID` is empty or equals `$PROD_DB_ID` (an explicit
     `[ -n "$DB_ID" ] && [ "$DB_ID" != "$PROD_DB_ID" ]` guard), so a resolution failure can never
     silently fall back to the production database.
  4. CI renders `wrangler.preview.jsonc` from the template via `envsubst` (or `jq`), then deploys with
     **`wrangler deploy -c wrangler.preview.jsonc`** — passing `-c/--config` at the generated file and
     **never `--env production`**. The generated file is git-ignored, not committed.
  Because the preview path only ever binds the freshly-resolved per-PR uuid (with a fail-closed guard
  against the production id) and every name is a pure function of the PR number, previews are
  **reproducible from IaC alone** and a builder **cannot** accidentally bind a preview to production.

**Why Wrangler config over Terraform/Pulumi (Q1).** The design's IaC requirement is
"reviewable/versioned/re-creatable reproducibly." Wrangler config + a migration satisfies that with
**no external state backend, no second toolchain, no provider auth beyond the deploy token** — the
smallest thing that meets the bar for a two-environment todo app. Terraform/Pulumi would add a state
store and a whole tool to learn/operate for zero benefit here. (Rejected, but re-openable if the
account grows to many resources — Q-IAC.)

### D-DEPLOY — GitHub Actions deploy workflow(s): triggers, secret, per-PR isolation, teardown.

**Decision.** Two new, additive workflow files under `.github/workflows/` (names illustrative:
`deploy-production.yml`, `deploy-preview.yml`), plus a preview-teardown job. **None touches
`sdlc-arbiter-gate.yml` or `tests.yml`.**

- **Production** — trigger `push` to `main` (and `master`). Steps: checkout → setup Bun → `bun
  install --frozen-lockfile` → `bun run build` (produces `dist/`) → **`wrangler d1 migrations apply DB
  --remote`** (Production DB) → `wrangler deploy` (Production env). Result:
  `https://todo-app.<subdomain>.workers.dev`.
- **Preview** — trigger `pull_request` `[opened, synchronize, reopened]`. Steps: compute
  `PR_N=<number>`, `WORKER=todo-app-pr-$PR_N`, `DB=todo-preview-pr-$PR_N` → build → **ensure the
  per-PR D1 exists** (create if absent — idempotent: query `wrangler d1 info`/`list`, create on miss),
  resolve its uuid and render `wrangler.preview.jsonc` with the **fail-closed production-id guard**
  (D-IAC/F3) → **`wrangler d1 migrations apply $DB --remote -c wrangler.preview.jsonc`** →
  **`wrangler deploy -c wrangler.preview.jsonc`** → post the preview URL as a PR comment. Each PR gets
  an **isolated Worker + isolated D1**, starting **empty** (a freshly-created DB is empty; migrations
  only create the table).
- **Preview teardown** — trigger `pull_request` `[closed]`. Steps: `wrangler delete --name
  todo-app-pr-$PR_N` and `wrangler d1 delete todo-preview-pr-$PR_N` (both tolerant of "already gone").
  This **reclaims the scarce D1 database slots** (see D-COST). Teardown-on-close is best-effort and can
  be skipped by a cancelled/failed run, so it is **not the sole reclaim path** — see the sweep below.
- **Orphan reconciliation sweep (addresses ISSUE-31-F8)** — a **scheduled** workflow
  (`.github/workflows/preview-gc.yml`, `on: schedule` daily `cron`, plus `workflow_dispatch`). It
  lists all `todo-app-pr-*` Workers and `todo-preview-pr-*` D1s, derives each one's PR number, queries
  the GitHub API for that PR's state, and **tears down any whose PR is closed/merged** (same delete
  commands, tolerant of absence). This makes a leaked D1 slot **self-heal** without a manual
  console/CLI fix, so a cancelled teardown can never permanently wedge new preview provisioning at the
  ~10-DB cap (preserves the IaC "no console clicks" requirement, R-IAC). Idempotent; no-ops when
  nothing is orphaned.

**Sharp edge — `--remote` on every CI migration (addresses ISSUE-31-F4).** Wrangler v4 defaults
**every `d1` subcommand to `--local`**, which in CI would migrate an ephemeral local SQLite file and
leave the real remote D1 **unmigrated** (the first real `PUT` then fails on a missing table). Every
`wrangler d1 migrations apply` run in a **CI/deploy** context (Production and Preview) MUST pass
**`--remote` explicitly**. Conversely, local dev (`wrangler dev`, D-DEVLOCAL) is correctly `--local`
and MUST NOT use `--remote`. The builder must not omit this flag.

**Secret(s) required (be explicit):**
- **`CLOUDFLARE_API_TOKEN`** (GitHub Actions **secret**) — a Cloudflare **API token** scoped to the
  account with, at minimum: **Workers Scripts: Edit**, **D1: Edit**, **Account Settings: Read** (to
  resolve the account's `workers.dev` subdomain), and **Workers Assets** upload permission (bundled
  with Workers Scripts: Edit for asset uploads). No Zone/DNS scope (no custom domain, N4).
- **`CLOUDFLARE_ACCOUNT_ID`** — the account id (a repo **variable** or secret; not sensitive but
  required by Wrangler). If Wrangler cannot infer it from the token, set it explicitly.
- The token is consumed only by `wrangler` via the `CLOUDFLARE_API_TOKEN` env var; it is **never**
  written to the repo (N10).

**Security posture (adversary-facing):**
- **`pull_request`, not `pull_request_target`.** The preview workflow uses the `pull_request` trigger.
  This means **GitHub withholds the secret from fork PRs** by default — a fork PR's preview job simply
  **no-ops with a clear message** (guarded on `secrets.CLOUDFLARE_API_TOKEN != ''`), it does **not**
  hard-fail and does **not** leak the token to untrusted code. `pull_request_target` is **explicitly
  rejected**: it would run untrusted PR code with the secret in scope (token-exfiltration vector).
  This repo's SDLC PRs run on same-repo `claude/sdlc-issue-<n>` branches, so previews work for them.
- **Least-privilege token**, scoped as above; no Zone/DNS.
- Deploy workflows request `permissions: contents: read` (plus `pull-requests: write` only on the
  job that comments the preview URL).
- **Interaction with existing CI:** deploy workflows are orthogonal to `tests.yml` (app tests) and
  `sdlc-arbiter-gate.yml` (ledger gate) — different triggers/jobs, no shared files. Deploy is **not**
  wired as a required merge check (a deploy failure should not silently gate the SDLC merge gate,
  which is ledger-derived); making the Production deploy required is Q-DEPLOY-GATE.

### D-DEVLOCAL — Local dev is unchanged; `wrangler dev` is the *optional* local cloud runtime.

**Decision (answers design point 6 explicitly).** `bun run dev` (Bun API + Vite proxy) **stays the
default local workflow** — fast, dependency-light, already wired. The Worker/D1 runtime can be
exercised locally with **`wrangler dev`**, which runs the Worker on `workerd` with a **local,
file-backed D1** (SQLite under `.wrangler/state`) and **requires no Cloudflare credentials** (only
`wrangler deploy` / remote ops need the token). A new script `dev:worker` (`wrangler dev`) is added
for that; for local migrations use **`wrangler d1 migrations apply DB --local`** (the default) —
**never `--remote` locally** (F4). **Local development does not require a Cloudflare account.**

### D-TESTS — ISSUE-19 suite unchanged (Bun oracle); the Worker/D1 contract test is REQUIRED (addresses ISSUE-31-F1).

**Decision.**
- The **ISSUE-19 integration suite is unchanged** and stays green: it spawns the **Bun adapter**,
  which — post-refactor — delegates to the shared handler, so it now *also* exercises the shared
  handler. It remains this repo's fast **contract oracle** (D-SEAM/N9).
- A **new cloud-contract test** drives the **Worker adapter** over `wrangler dev` (local D1) and
  asserts the guard/persistence subset that could differ across runtimes: round-trip + order +
  boolean marshalling, R5 whole-list swap, **R6b duplicate-id → 400 with old list intact**, R8
  over-cap → **413** (declared; **not** 411 — F9/D-GUARDS-1), R-GUARD-4 over-length list → 400,
  R-GUARD-5 misrouted `/api/*` → JSON error (never 200 HTML), and R9 foreign-`Origin` → 403 /
  same-origin → 2xx.
- **This cloud test is a BLOCKING/required check, via a SEPARATE CI job — not the default `bun run
  test` lane (F1).** The two lanes are separated by **two distinct, committed Vitest config files** —
  one per lane, each with its own `include`/`exclude` — because a single config **cannot** serve both:
  a global `exclude` in Vitest is applied unconditionally and **overrides a positional path filter**,
  so a config that excludes `tests/cloud/**` makes `vitest run tests/cloud` resolve **zero** files and
  exit 1 ("No test files found") — the required cloud job would then always fail on *no tests*, leaving
  the Worker/D1 path with no real coverage (this is the exact defect the verifier caught; see §10).
  The corrected, empirically-verified setup:

  1. **Committed `vitest.config.js` — the DEFAULT lane (`bun run test` = `vitest run`).** None exists
     today, so `vitest run` would otherwise use its default glob and drag `tests/cloud/**` into the
     required `bun run test` job (which has no `wrangler`/`workerd`). The config MUST be exactly:
     ```js
     import { defineConfig, configDefaults } from 'vitest/config'
     export default defineConfig({
       test: {
         // Default excludes (node_modules, dist, *.config.*, …) PLUS the cloud dir.
         exclude: [...configDefaults.exclude, 'tests/cloud/**'],
       },
     })
     ```
     No global `environment` override — the per-file `// @vitest-environment` pragmas already in the
     suites keep environments scoped. `bun run test` is invoked with **no path argument** (`vitest run`),
     so `include` stays the Vitest default glob and `exclude` removes `tests/cloud/**`. Result: **`bun
     run test` runs exactly the pre-existing suites — pure core, the two mocked component suites, and
     ISSUE-19 — and never picks up `tests/cloud/**`.**
  2. **Committed `vitest.cloud.config.js` — the CLOUD lane (`bun run test:cloud`).** A *separate* config
     whose `include` targets `tests/cloud/**` and whose `exclude` does **NOT** exclude that directory
     (it keeps only the standard defaults). The cloud lane is invoked as **`vitest run --config
     vitest.cloud.config.js`** (no positional path — the path is expressed via `include`, so there is no
     reliance on the positional-filter-vs-`exclude` interaction that broke the prior spec). The config
     MUST be exactly:
     ```js
     import { defineConfig, configDefaults } from 'vitest/config'
     export default defineConfig({
       test: {
         // ONLY the cloud contract tests; path expressed via include (not a positional CLI arg).
         include: ['tests/cloud/**/*.{test,spec}.{js,jsx,ts,tsx}'],
         // Standard defaults only — deliberately does NOT exclude tests/cloud/**.
         exclude: [...configDefaults.exclude],
       },
     })
     ```
     Both configs' `include`/`exclude` globs resolve relative to the project root (repo root, where both
     config files live), so neither lane depends on the process cwd. Result: **`bun run test:cloud` finds
     and executes only `tests/cloud/**` and exits 0 on success — never "no test files found."**
  3. **Add a separate, additive workflow `.github/workflows/cloud-contract.yml`** (`on: pull_request`
     + `push` to `main`) whose single job installs deps + `wrangler` and runs **`bun run test:cloud`**
     (= `vitest run --config vitest.cloud.config.js`) against `wrangler dev` in **local mode (no
     secret)**. This job is **designated a required status check**, so the Worker/D1 path cannot merge
     unproven. It does **not** touch `tests.yml` or `sdlc-arbiter-gate.yml`.
  So the Worker/D1 contract is covered by a **blocking** check (R-CLOUDTEST) that actually executes the
  cloud tests, the default lane stays fast/Bun-only, and neither job can silently drop the other's
  coverage. (This **resolves** former open question Q-CLOUD-TEST: the cloud job **is** required.)

**Can the *existing* ISSUE-19 tests run against `wrangler dev` unmodified?** **No, not as-is** — the
fixture hard-codes `spawn('bun', ['server/index.js'])`, the Bun stdout marker, and `bun:sqlite` temp
files. Rather than fork that hardened fixture, the cloud runtime gets its own small fixture targeting
`wrangler dev`. This is the deliberate, minimal-blast-radius choice (D-SEAM alternative rejected).

### D-COST — Cloudflare **free tier**, no region pinning; the per-PR D1 database cap is a real ceiling. (Answers design Q2.)

**Decision.** Target the **Workers Free plan**: Workers 100k req/day, **D1 free tier 5 GB total /
500 MB per DB / generous daily read-write rows** — vastly beyond a shared todo list. **No region
pinning** (workers.dev is global; D1 auto-locates its primary). This matches the design's default
assumption.

**Named ceiling (adversary-facing risk).** The Workers **Free plan allows at most ~10 D1 databases
per account.** With **one D1 per open PR** (D-DEPLOY), more than ~9 simultaneously-open PRs (plus the
Production DB) would **exhaust the cap and fail new preview provisioning**. Mitigations designed in:
(a) **teardown on PR close** reclaims slots; (b) preview provisioning **fails loudly** with a legible
"D1 database limit reached" message rather than silently degrading. If concurrent-PR volume is
expected to exceed the cap, the fallback is a **single shared preview D1 with per-PR table
namespacing** (weaker isolation) or a **paid plan** — surfaced as Q-D1-CAP for the operator.

---

## 5. Requirements (verifiable)

Each names how a test would falsify it. "The Worker" = the deployed (or `wrangler dev`-local)
Worker/D1 runtime; "the contract" = the shared handler's HTTP behavior.

- **R1 — Public reachability.** After a Production deploy, `GET https://<worker>.workers.dev/` returns
  the SPA (200 HTML) and the app's capabilities (add/toggle/edit/delete/clear/filter/count) work in a
  browser. *Falsify:* the URL 404s/errors, or a capability is broken.
- **R2 — Persistence survives reload, cold start, and redeploy.** A todo `PUT` to an environment is
  returned by a subsequent `GET` after a page reload, after an idle period (cold start), and **after
  a redeploy of the same environment**. *Falsify:* a todo present before a redeploy is absent after
  it, or a reload loses it.
- **R3 — Round-trip / order / boolean parity in the Worker runtime.** Against the Worker/D1: a `PUT`
  of an ordered list with mixed `completed` → a `GET` returns an **equal** list, **same order**
  (`position`), with `completed` as JSON **booleans**. *Falsify:* mismatch in contents, order, or
  `completed` type.
- **R4 — Fresh environment returns `[]`.** A newly-provisioned environment (prod first deploy, or any
  new preview) answers `GET /api/todos` with `200 []`. *Falsify:* a fresh environment returns
  non-empty, 404, or null.
- **R5 — Atomic whole-list swap in D1.** `PUT([a,b])` then `PUT([c])` → `GET` returns exactly `[c]`
  (no leftover rows). *Falsify:* residue from the first list remains.
- **R-GUARD-1 — Body cap (1 MB) in the Worker.** An over-cap body → **413** (whether declared over by
  `Content-Length` or streamed past the running cap), not persisted. **411 (absent `Content-Length`)
  is NOT part of the Worker contract** (F9/D-GUARDS-1): the edge may normalize away `Content-Length`
  and a hard 411 would risk self-blocking; the 411 branch stays Bun-only, proven by ISSUE-19.
  *Falsify:* an over-cap body is accepted/stored, the Worker 500s instead of 413, or the Worker 411s a
  legitimate length-less write.
- **R-GUARD-2 — Same-origin write guard in the Worker.** A `PUT` with a **foreign `Origin`** →
  **403**, DB unmutated; a **same-origin** `PUT` (the app's own, with the live `https` scheme) →
  **2xx**. The permitted origin is `new URL(request.url).origin` (correct scheme from the live
  request), **not** Host + an assumed scheme (F7). *Falsify:* a foreign-`Origin` PUT overwrites the
  list, or the app's own same-origin `https` PUT is rejected on a `*.workers.dev` URL.
- **R-GUARD-3 — Duplicate-id → 400, old list intact, driver-independently.** A shape-valid `PUT`
  containing a **duplicate id** → **400** (not 500), and the follow-up `GET` returns the **prior list
  unchanged**. Guaranteed by the shared pre-check *before* any DB write (F2/D-STORE), so it holds
  identically in Bun and D1 without depending on either driver's constraint wording; the
  driver-tolerant classifier is the backstop. *Falsify:* duplicate id yields 2xx, or 500, or the
  stored list is emptied/partial in either runtime.
- **R-GUARD-4 — Bounded list length, identical in both runtimes.** A `PUT` of a shape-valid list
  longer than `MAX_LIST_LEN` (default 1000) → **400** in **both** the Bun and Worker runtimes, no DB
  write, prior list intact (F6). *Falsify:* an over-length list is accepted by either runtime, or the
  two runtimes disagree on the same over-length input.
- **R-GUARD-5 — `/api/*` never returns the SPA shell.** A request to an unknown/misrouted `/api/*`
  path (e.g. `POST /api/todos`, `GET /api/nope`) returns a **JSON error** with an `/api` status
  (404/405), **never** a 200 `index.html` (F5). *Falsify:* any `/api/*` request returns HTML, or
  `loadTodos()` receives a 200 non-JSON body that coerces to `[]`.
- **R-ISO — Preview/production data isolation.** A write to a preview environment is **never**
  visible in production or in any *other* preview, and vice-versa. *Falsify:* data written to
  `todo-app-pr-N` appears in production or in `todo-app-pr-M` (M≠N).
- **R-AUTO — Fully automated deploys, no manual CLI step.** A push to `main` deploys Production and a
  PR open/update deploys its Preview **with no human running `wrangler`**. *Falsify:* shipping
  requires a manual local deploy command.
- **R-TEARDOWN — Preview teardown on PR close.** Closing/merging a PR removes its preview Worker and
  its preview D1 (reclaiming the slot). *Falsify:* after a PR closes, its Worker still serves or its
  D1 still exists.
- **R-GC — Orphaned previews self-heal.** The scheduled reconciliation sweep tears down any
  `todo-app-pr-*` Worker / `todo-preview-pr-*` D1 whose PR is closed/merged, so a skipped/failed
  on-close teardown does not permanently leak a D1 slot (F8). *Falsify:* after a PR closes and its
  on-close teardown is skipped, its D1 remains indefinitely with no automated reclaim.
- **R-IAC — Reproducible from committed IaC alone.** Given valid credentials, an environment can be
  destroyed and recreated **solely** from `wrangler.jsonc` + `migrations/**` + the workflows (no
  console clicks, no undocumented state). *Falsify:* recreating an environment needs a manual console
  step not captured in committed files/docs.
- **R-SECRET — No secret in the repo; least-privilege token; forks safe.** The Cloudflare token
  exists only as a GitHub secret; workflows request minimal `permissions`; a **fork PR does not
  expose the secret and its preview job no-ops** rather than failing or leaking. *Falsify:* a token/
  credential is committed, a workflow uses `pull_request_target` with the secret in untrusted scope,
  or a fork PR run exposes the secret.
- **R-SUITE — Existing suite still passes, unchanged in substance.** `bun run test` — the pure core
  (unchanged), the two mocked component suites (unchanged), **and the ISSUE-19 integration suite** —
  stays green after the D-SEAM refactor; the ISSUE-19 fixture and `tests/todos.test.js` are unedited
  in substance. *Falsify:* any existing suite regresses, or the Bun adapter's observable contract
  changed.
- **R-CLOUDTEST — Cloud runtime proven by a REQUIRED check.** The `test:cloud` lane (`vitest run
  --config vitest.cloud.config.js`) drives the Worker via `wrangler dev` and proves R3, R5,
  R-GUARD-1/2/3/4/5 against the **Worker/D1** runtime, and it runs as a **required** CI job
  (`.github/workflows/cloud-contract.yml`), gated so a green merge cannot happen with the Worker/D1 path
  unproven (F1). *Falsify:* the cloud contract test is absent or non-blocking, it passes without
  exercising the Worker/D1 path, **or** the cloud lane exits "no test files found" (a config that
  excludes the very directory it must run) so no cloud assertion actually executes.

---

## 6. Acceptance criteria (concrete "done")

Done when **all** hold:

1. A single Worker (Static Assets + D1) serves the SPA and `/api/todos` from one origin; the shared
   handler backs both the Bun and Worker adapters (D-COMPUTE/D-STORE/D-SEAM).
2. Production is reachable at its `*.workers.dev` URL; every capability works (R1); a todo survives
   reload and **redeploy** (R2).
3. A PR opens/updates → an **isolated** preview Worker + preview D1, starting empty (R4/R-ISO), bound
   via the fail-closed per-PR mechanism so it is never bound to production (F3); closing the PR tears
   both down and a scheduled sweep reclaims any orphan (R-TEARDOWN/R-GC). No manual `wrangler` step
   anywhere (R-AUTO).
4. The write-path guarantees hold in the Worker runtime: 1 MB cap (R-GUARD-1), same-origin
   default-deny guard derived from `request.url` (R-GUARD-2), atomic replace + duplicate-id → 400
   (R-GUARD-3), bounded list length (R-GUARD-4), and `/api/*` never serving the SPA shell (R-GUARD-5).
5. `wrangler.jsonc` + `migrations/**` + committed workflows recreate any environment from scratch
   given credentials (R-IAC); no secret in the repo; least-privilege token; fork PRs safe
   (R-SECRET).
6. `bun run test` stays green with the ISSUE-19 suite unchanged in substance (R-SUITE), scoped by a
   new `vitest.config.js` that excludes `tests/cloud/**`; the new `test:cloud` lane (its own
   `vitest.cloud.config.js`, invoked `vitest run --config vitest.cloud.config.js`) actually finds and
   runs `tests/cloud/**` and proves the Worker/D1 contract as a **required** CI job (R-CLOUDTEST).
7. Protected files untouched: `sdlc-arbiter-gate.yml`, `.claude/**`, `SDLC/**` (N7).

---

## 7. Implementation plan (ordered; a builder can follow this)

**Phase A — Runtime seam refactor (behavior-preserving).**
1. Create **`server/handler.js`** — runtime-agnostic `handleRequest(request, {store, config})`: move
   routing, the write guard (a pure function of `(request, config)`, D-GUARDS-2), `readCappedBody` +
   the size ladder, JSON parse, `isConformingList`, the **duplicate-id pre-check** (F2/D-STORE layer
   1), the **`MAX_LIST_LEN` bound** (F6/D-GUARDS-4), and the `store.replaceAll` call + driver-tolerant
   constraint classifier here. No `bun:sqlite`/`Bun` import. `config` carries `maxBodyBytes`,
   `maxListLen` (default 1000), `requireLoopbackHost`, `requireContentLength`, the allowed-origin
   source (`new URL(request.url).origin` for same-origin), and an optional `allowedOrigins` allowlist.
2. Refactor **`server/index.js`** to build a `bun:sqlite`-backed `TodoStore` and delegate to
   `handleRequest` with **Bun config** (`requireLoopbackHost: true`, `requireContentLength: true`,
   existing `ALLOWED_ORIGINS`), preserving loopback bind, status codes/headers, ordering, and the
   stdout marker (`server/index.js:289`). *Guard:* the unchanged ISSUE-19 suite must stay green
   (INV-CONTRACT) — forged-Host→403, foreign-Origin→403, no-Origin→200, 411, and duplicate-id→400
   (now via the pre-check, same observable status/list).

**Phase B — Worker runtime.**
3. Create **`worker/index.js`** — `export default { async fetch(request, env) }`: branch on
   `new URL(request.url).pathname.startsWith('/api/')` **first**, delegating those to `handleRequest`
   with **Worker config** (`requireLoopbackHost: false`, `requireContentLength: false`, same-origin
   from `request.url`); return JSON 404/405 for unknown `/api` routes/methods; delegate **only**
   non-`/api` requests to `env.ASSETS.fetch(request)` (F5). The D1 `TodoStore.replaceAll` uses
   `env.DB.batch([DELETE, …INSERT])` (atomic) and surfaces DB errors for the classifier (F2 backstop).
4. Create **`migrations/0001_init.sql`** — the `todos` table + CHECKs (port of `server/index.js:53-60`).

**Phase C — IaC config.**
5. Create **`wrangler.jsonc`** — Worker name (`todo-app`), `compatibility_date`, `main =
   worker/index.js`, the **`assets` block exactly as in D-COMPUTE** (`directory: ./dist`, `binding:
   ASSETS`, `not_found_handling: single-page-application`, `run_worker_first: ["/api/*"]`), the D1
   binding (`d1_databases[] {binding:"DB", database_name, database_id}` for Production), a `production`
   env. Also create **`wrangler.preview.template.jsonc`** — same shape with
   `${WORKER_NAME}`/`${DB_NAME}`/`${DB_ID}` placeholders and **no hardcoded `database_id`** (D-IAC/F3).
6. Add scripts to **`package.json`**: `dev:worker` (`wrangler dev`), `deploy` (`wrangler deploy`),
   `test:cloud` (**`vitest run --config vitest.cloud.config.js`** — NOT `vitest run tests/cloud`, which
   the root config's `exclude` would reduce to zero files → exit 1, F1). Add `wrangler` as a
   devDependency; add `.wrangler/`, `dist/`, and `wrangler.preview.jsonc` to `.gitignore` if not already
   ignored. Create **two** Vitest configs at the repo root (D-TESTS): **`vitest.config.js`** — the
   default lane — with `exclude: [...configDefaults.exclude, 'tests/cloud/**']` and no global
   `environment` override, so `bun run test` runs exactly the pre-existing suites, unchanged; and
   **`vitest.cloud.config.js`** — the cloud lane — with `include: ['tests/cloud/**/*.{test,spec}.{js,jsx,ts,tsx}']`
   and `exclude: [...configDefaults.exclude]` (standard defaults only; it MUST NOT exclude `tests/cloud/**`),
   both importing `configDefaults` from `vitest/config`. The cloud lane targets its directory via
   `include`, never a positional CLI path (F1).

**Phase D — GitHub Actions.**
7. Create **`.github/workflows/deploy-production.yml`** (push→main: build → **`wrangler d1 migrations
   apply DB --remote`** → `wrangler deploy`). **Every CI `d1 migrations apply` uses `--remote`** (F4).
8. Create **`.github/workflows/deploy-preview.yml`** (PR opened/sync/reopened: derive names, ensure
   per-PR D1, resolve its uuid and render `wrangler.preview.jsonc` with the **fail-closed
   production-id guard** (F3), **`wrangler d1 migrations apply $DB --remote -c wrangler.preview.jsonc`**
   (F4), `wrangler deploy -c wrangler.preview.jsonc`, comment URL; **guarded to no-op when the secret
   is absent**, i.e. fork PRs).
9. Create the **preview teardown** workflow (PR closed: delete Worker + D1, tolerant of absence) **and
   the scheduled reconciliation sweep `.github/workflows/preview-gc.yml`** (F8: `cron` + list
   `todo-app-pr-*`/`todo-preview-pr-*`, tear down any whose PR is closed/merged per the GitHub API).
   All consume `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`; least-privilege `permissions`.
   **9a. One-time manual verification (F2 backstop):** against a throwaway **real remote** D1, confirm
   a raw PRIMARY-KEY collision is classified to **400** (not 500) and record the observed D1 error
   text in the PR. Not a standing CI job (needs the deploy secret + a real DB).

**Phase E — Cloud contract test + docs.**
10. Create **`tests/cloud/**`** — a small fixture spawning `wrangler dev` (local D1, migrations applied
    **`--local`**, no secret), asserting R3, R5, R-GUARD-1 (413; **no 411**), R-GUARD-2, R-GUARD-3,
    R-GUARD-4, R-GUARD-5 against the Worker. Test files MUST match `tests/cloud/**/*.{test,spec}.…` so
    `vitest.cloud.config.js`'s `include` picks them up. Excluded from the **default** lane by
    `vitest.config.js`; run **only** via `test:cloud` (= `vitest run --config vitest.cloud.config.js`).
    Create **`.github/workflows/cloud-contract.yml`** running `bun run test:cloud` as a **required**
    check (F1).
11. Update **`README.md`** — deploy model, the two environments, the required secret + token scopes,
    `--remote`-in-CI vs `--local`-in-dev note, local-dev-unchanged note.

**Files created:** `server/handler.js`, `worker/index.js`, `migrations/0001_init.sql`,
`wrangler.jsonc`, `wrangler.preview.template.jsonc`, `vitest.config.js`, `vitest.cloud.config.js`,
`.github/workflows/deploy-production.yml`, `.github/workflows/deploy-preview.yml`,
`.github/workflows/preview-gc.yml`, `.github/workflows/cloud-contract.yml`, (preview-teardown
workflow), `tests/cloud/**`.
**Files modified:** `server/index.js` (behavior-preserving delegation), `package.json` (scripts +
`wrangler` dep), `.gitignore`, `README.md`.
**Explicitly NOT touched:** `.github/workflows/sdlc-arbiter-gate.yml`, `.github/workflows/tests.yml`,
`.claude/**`, `SDLC/**`, `tests/integration/**` (ISSUE-19, substance), `tests/todos.test.js`,
`src/**`.

**How each failure mode is handled (map to §8):** INV-CONTRACT — pure-extraction refactor gated by the
unchanged ISSUE-19 suite; per-adapter config reproduces each runtime's exact semantics. INV-ATOMIC —
D1 `batch()` + duplicate-id pre-check + `MAX_LIST_LEN` + tested rollback (R-GUARD-3/4). INV-GUARD —
same-origin derived from `new URL(request.url).origin` (no self-block, F7) + tested foreign-Origin 403.
INV-ISO — one D1 per environment + fail-closed per-PR binding (F3) + teardown + GC. INV-SECRET —
`pull_request` (not `_target`), secret-absent no-op, least-privilege token. INV-CAP — teardown +
scheduled reconciliation sweep (F8) + loud failure at the D1 cap.

---

## 8. Failure modes & invariants (what must never happen)

- **INV-CONTRACT — No silent contract drift.** The Bun and Worker runtimes share one handler; the Bun
  adapter's observable behavior is unchanged (ISSUE-19 suite green, unedited). *Falsify:* the two
  runtimes diverge on any status/shape/order, or the refactor changes the Bun adapter's contract.
- **INV-ATOMIC — Writes are all-or-nothing.** A failed `PUT` (constraint, over-cap, malformed) leaves
  the previously-stored list **exactly** intact; a partial list is never persisted. *Falsify:* any
  rejected write leaves the DB emptied or half-written.
- **INV-GUARD — The write guard defaults deny and never self-blocks.** Cross-origin writes are
  rejected (403); the app's own same-origin writes always succeed on every environment/URL.
  *Falsify:* a foreign origin writes successfully, or the guard rejects the app's own writes on some
  preview URL.
- **INV-ISO — Environments never share data.** Production and each preview bind distinct D1
  databases; no write crosses environments; each preview starts empty. *Falsify:* cross-environment
  data bleed, or a preview starts non-empty.
- **INV-SECRET — Credentials never enter the repo or untrusted execution.** The token lives only as a
  GitHub secret, is consumed only by `wrangler`, never printed/committed; no `pull_request_target`
  with the secret in untrusted scope; fork PRs cannot obtain it. *Falsify:* a token is committed/
  logged, or a fork PR run can read it.
- **INV-CAP — Resource limits fail loud, not silent; orphans self-heal.** Exhausting the D1 database
  cap (or any quota) produces a **legible failure**, never a silent half-provisioned preview; and a
  leaked D1 slot from a skipped on-close teardown self-heals via the scheduled reconciliation sweep
  (R-GC), so orphans cannot silently wedge provisioning. *Falsify:* hitting the cap yields a
  broken-but-"green" preview, or a leaked slot never reclaims.
- **INV-SEC (accepted, from N2) — Public no-auth is a deliberate, bounded exposure.** The list is
  world-readable/writable by URL on purpose (design N2). The same-origin guard blocks *cross-site*
  writes but not a direct client that has the URL; the body cap and shape validation bound abuse.
  This invariant records the accepted risk so the adversary files it as *known/accepted*, not novel:
  anyone with a preview/prod URL can read and overwrite that environment's shared list. (Mitigations
  beyond scope: N2.)

---

## 9. Open questions (need human/arbiter input)

**All open questions are now resolved; see §10 history below for the confirmations.** Every item in
this section is marked **RESOLVED** and retained for the record — there are no outstanding items
blocking the build.

- **Q-D1-CAP — RESOLVED — confirmed by operator (was: per-PR D1 vs the ~10-database free-tier cap).**
  The proposed default stands: **one D1 per PR + teardown-on-close + a scheduled orphan-GC sweep +
  loud failure at the cap** (D-DEPLOY/D-COST/INV-CAP, R-TEARDOWN/R-GC). Full per-PR isolation is kept;
  the fallback (shared preview D1 with per-PR table namespacing) and a paid plan are **not** adopted.
- **Q-IAC — RESOLVED — confirmed by operator (was: Wrangler config vs Terraform/Pulumi, design Q1).**
  The proposed default stands: **Wrangler `wrangler.jsonc` + a committed D1 migration** (D-IAC) — the
  smallest thing that meets the IaC bar. Terraform/Pulumi are **not** mandated.
- **Q-REGION-COST — RESOLVED — confirmed by operator (was: free tier, no region pin, design Q2).**
  The proposed default stands: **Workers Free plan, no region pinning** (D-COST). No plan/region
  override (no D1 location hint, no EU data-residency requirement) is imposed.
- **Q-CONFIG-FORMAT — RESOLVED — confirmed by operator (was: `wrangler.jsonc` vs `wrangler.toml`).**
  The proposed default stands: **`wrangler.jsonc`** (Cloudflare's current default, comment-friendly).
  TOML is **not** required.
- **Q-DEPLOY-GATE — RESOLVED — confirmed by operator (was: should the Production deploy be a required
  status check?).** The proposed default stands: **no** — the deploy stays **orthogonal to the SDLC
  ledger merge gate** so a transient Cloudflare failure can't wedge the gate (D-DEPLOY). A green deploy
  is **not** required before merge.
- **Q-CLOUD-TEST — RESOLVED (was: is `test:cloud` required?).** Now **decided required** (D-TESTS/F1):
  the Worker/D1 contract runs as a **separate, blocking** CI job (`cloud-contract.yml`, `wrangler dev`
  local mode, **no secret**), because the required `bun run test` lane otherwise never exercises the
  Worker/D1 path. No longer open; retained here for history.
- **Q-PROD-NAME — RESOLVED — confirmed by operator (was: fixed production Worker name / URL).** The
  proposed default stands: **`todo-app`**, giving the public URL
  **`https://todo-app.<account-subdomain>.workers.dev`** (D-DEPLOY).

---

## 10. Ratification history

- Drafted by `architect` from ratified design [docs/specs/ISSUE-31.md](ISSUE-31.md), grounded in the
  tree at branch `claude/sdlc-issue-31` (`server/index.js`, `src/storage.js`, `tests/integration/**`,
  CI workflows) and current Cloudflare platform facts (D1 free-tier 10-database cap; Workers Static
  Assets as the recommended SPA+API path).
- Revised by `architect` after the adversary's challenge round, addressing ISSUE-31-F1…F9: cloud test
  made a **required** separate CI job + `vitest.config.js` scoping (F1); duplicate-id 400 moved to a
  driver-independent shared pre-check with a robust classifier + one-time remote verification (F2);
  exact fail-closed per-PR D1 binding via a generated config template (F3); `--remote` mandated on
  every CI migration (F4); explicit `assets` routing + worker-first + code-level `/api/*` ownership
  (F5); `MAX_LIST_LEN` bound in shared validation + softened "identical" claim (F6); same-origin
  derived from `new URL(request.url).origin` with the Bun adapter's guard preserved (F7); scheduled
  orphan-reconciliation sweep (F8); 411 dropped from the Worker/cloud contract, kept Bun-only (F9).
- Operator confirmed on PR #32 ("@claude confirm defaults proposed for open questions") the proposed
  defaults for all six remaining open questions — Q-D1-CAP, Q-IAC, Q-REGION-COST, Q-CONFIG-FORMAT,
  Q-DEPLOY-GATE, and Q-PROD-NAME — as-is; each is marked **RESOLVED** in §9 and no open questions
  remain. No technical content elsewhere in the spec changed: these choices are now ratified rather
  than proposed defaults.
- Revised by `architect` after the **verifier** empirically tested ISSUE-31-F1's original fix and found
  it did not work: the prior spec had the *single* `vitest.config.js` `exclude` `tests/cloud/**` while
  the required `cloud-contract.yml` job ran `test:cloud` = `vitest run tests/cloud`; because Vitest's
  global `exclude` overrides the positional path filter, that command resolved **zero** files and exited
  1 ("No test files found"), so the required cloud lane could never actually execute the Worker/D1
  contract tests — F1's defect was not truly fixed. This revision corrects it with a **separate
  `vitest.cloud.config.js`** (own `include: ['tests/cloud/**/*.{test,spec}.…']`, no exclude of that
  directory), invoked `vitest run --config vitest.cloud.config.js`, leaving the default `bun run test`
  lane (root `vitest.config.js`, no path arg) running only the pre-existing suites. Both lanes were
  verified empirically against this repo's Vitest 1.6.1: default lane runs only the existing suites
  (excludes `tests/cloud/**`), cloud lane finds and runs only `tests/cloud/**` (exit 0).
