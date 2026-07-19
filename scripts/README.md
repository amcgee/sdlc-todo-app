# `scripts/` — project-adapter scripts (app-specific)

Everything in **this** `scripts/` directory is **project adapter** code: the SDLC
framework's *method* references some of it by name (agent prompts, the driver, CI), but
the *implementation* is specific to this demo app (bun/vitest, the todo server, this
import graph). Framework-owned scripts live under **`SDLC/scripts/`** and copy with the
framework; the doc-link checker (`SDLC/scripts/check-doc-links.mjs`) moved there for
exactly that reason. When porting, reimplement these adapters (or drop the optional check).

| Script | Layer | On port |
|--------|-------|---------|
| `diff-coverage.mjs` | **project adapter** — reads this app's vitest/istanbul coverage output | reimplement against your coverage tool, or drop it (diff coverage is informational, never a gate) |
| `check-architecture.mjs` | **project adapter** — encodes THIS app's dependency rules (client↛server, single sqlite owner, …) | rewrite the rules for your architecture (keep the pattern: a checked `docs/architecture.md`) |
| `screenshots.mjs` | **project adapter** — spawns `bun server/index.js`, seeds a todos API, drives a browser | rewrite for your app's run/seed, or drop the visual pipeline |
| `dev.mjs` | **app tooling** — not framework, not referenced by the SDLC method | do not copy |

The single place the framework reads app/stack couplings (test/install/coverage
commands, shipped paths, trust boundaries, doc paths) is **`sdlc.config.json`** — see
[`SDLC/docs/reuse.md`](../SDLC/docs/reuse.md). Prompts and workflows that name a command line
(`bun run test:coverage`, `node scripts/…`) are the couplings a port must edit; the
manifest is where the framework itself resolves them, and the goal over time is to move
every hardcoded command behind it.
