# ADR-0001: one shared handler across runtimes

- **Date:** 2026-07-04 · **Status:** accepted (records the existing design)

## Decision

The HTTP contract (`/api/todos` validation, limits, error shapes) lives in exactly one
runtime-portable module, `server/handler.js`, written against Web-platform primitives
only. Each runtime is a thin adapter that supplies storage as a port: `server/index.js`
(Bun + `bun:sqlite`) for dev/preview, `worker/index.js` (Cloudflare + D1) for production.
Pure domain logic the client and handler both need (`src/todos.js`, `src/limits.js`) is
dependency-free and imported by both sides.

## Why

One contract, two runtimes: any behavior implemented twice will drift, and the drift
lands exactly where it's least visible (prod-only). Keeping the handler platform-free
makes "identical on Bun and Workers" testable (`tests/cloud/` runs the same contract
against workerd) instead of aspirational.

## Consequences

- The handler can never grow a runtime import — CI enforces this
  (`scripts/check-architecture.mjs`, rule 3).
- New backend capability lands as: extend the handler + extend each adapter's port, never
  as runtime-specific request handling.
- Shared client/server rules (e.g. item limits) go in the pure `src/` modules, defined
  once for all three environments.
