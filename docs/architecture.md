# Architecture — one page, mechanically checked

The map every cycle loads before touching code. Keep it one page: every claim here is
either **checked by CI** (`scripts/check-architecture.mjs` enforces the dependency rules
below) or recorded as a dated decision in [`docs/adr/`](adr/). Anything else rots.

## Containers

```
 browser SPA (src/)                    one shared HTTP contract          storage adapters
 ┌──────────────────┐                 ┌─────────────────────────┐      ┌─────────────────────┐
 │ React UI          │  GET/PUT       │ server/handler.js        │      │ server/index.js      │
 │  App.jsx          │  /api/todos    │  runtime-portable core:  │─────▶│  Bun + bun:sqlite    │
 │  storage.js (fetch)│───────────────▶│  validation, limits,     │      │  (dev/preview)       │
 │  todos.js (pure)   │                │  storage-port interface  │      ├─────────────────────┤
 │  limits.js (pure)  │                └─────────────────────────┘      │ worker/index.js       │
 └──────────────────┘                        ▲                         │  Cloudflare + D1      │
                                             │ imports handler          │  (deployed)           │
                                             └─────────────────────────┴─ migrations/ (D1 DDL)
```

- **`src/`** — the SPA. Pure logic (`todos.js`, `limits.js`) is separated from the UI and
  from the one side-effect boundary (`storage.js`, fetch-only). The client talks to the
  backend **only over HTTP**.
- **`server/handler.js`** — the runtime-portable request handler: one HTTP contract for
  both runtimes. It uses Web-platform primitives only, and receives its storage as a port.
- **`server/index.js`** — Bun adapter: binds the port, owns `bun:sqlite`, serves `dist/`.
- **`worker/index.js`** — Cloudflare adapter: same handler, D1 storage, `migrations/` DDL.
- **`scripts/`** — dev/CI tooling (not shipped).

## Dependency rules (CI-enforced)

1. `src/**` never imports from `server/` or `worker/` — the client's only backend
   interface is HTTP.
2. `worker/**` imports nothing outside its own directory except `server/handler.js` —
   the shared-handler seam is the single cross-runtime joint.
3. `server/handler.js` stays runtime-portable: no `bun:sqlite`, no `node:*`, no Bun
   globals; from `src/` it may import only the pure shared modules `src/limits.js` and
   `src/todos.js`.
4. Only `server/index.js` may import `bun:sqlite`.

Changing a rule is an architecture decision: update this file, the check script, and add
an ADR in the same PR.

## Decisions

Durable decisions live in [`docs/adr/`](adr/) — one short file each, dated, immutable
(supersede, don't edit). Start with
[ADR-0001: one shared handler across runtimes](adr/0001-shared-handler-across-runtimes.md).
