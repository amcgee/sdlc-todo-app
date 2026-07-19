<!-- SDLC:BEGIN operator guide (managed by SDLC/install.py) -->
# Adversarial Agentic SDLC — operator guide

This repo develops software with the **Adversarial Agentic SDLC**: a blue team builds, a red
team attacks, and a neutral arbiter opens each gate only on the strength of an append-only
ledger — nothing is "done" because an agent says so, only because the record proves it.

**The framework documents itself under `SDLC/`.** Start at **[SDLC/README.md](SDLC/README.md)**.
The one app-specific file is **`sdlc.config.json`** at the repo root — edit it for your stack
(see [SDLC/docs/reuse.md](SDLC/docs/reuse.md) §2).

## Working rules
- **Keep the PR description up to date.** Whenever the scope, approach, or set of changes on a
  PR shifts, refresh that PR's description in the same turn so it always reflects the current
  state of the branch.
- **Terse, current, useful prose.** Write every comment, docstring, and doc to describe the
  *current* framework — no archaeology, no rejected-alternative asides. State what the code does
  and why it matters, once.

## Where everything is

| I want to… | Go to |
|---|---|
| Understand the flow, teams, phases & gates | [SDLC/docs/methodology.md](SDLC/docs/methodology.md) |
| Use the ledger CLI (the spine) | `python SDLC/sdlc.py --help` |
| Run a full cycle from a GitHub issue | the `/sdlc` driver — [.claude/commands/sdlc.md](.claude/commands/sdlc.md) |
| Set up the GitHub routine | [SDLC/docs/SETUP.md](SDLC/docs/SETUP.md) |
| Tune framework constants | `SDLC/constants.json` (app/stack couplings: `sdlc.config.json` at the repo root) |
<!-- SDLC:END operator guide -->
