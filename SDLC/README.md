# The Adversarial Agentic SDLC

This directory is a self-contained development framework in which **no artifact advances until
it survives a deliberate attack**. A **blue team** builds, a **red team** attacks, and a
neutral **arbiter** opens each gate strictly from an append-only **ledger** — never because an
agent says the work is done. Quality is *earned*, not asserted.

Work flows through two workflows: a lightweight, human-driven **product** workflow that iterates
a PRD in the GitHub issue, then the adversarial **engineering** workflow on a PR
(`PRODUCT → SPEC → BUILD → (ATTACK → DEFEND → VERIFY)* → MERGE`, each arrow an arbiter gate).
See [docs/methodology.md](docs/methodology.md) for the gated diagram and what each phase does.

## Documentation map

| Doc | What it covers |
|-----|----------------|
| **[docs/methodology.md](docs/methodology.md)** | The full methodology — teams, phases & gates, the ledger, stop conditions |
| **[docs/SETUP.md](docs/SETUP.md)** | Setting up the one routine that runs the pipeline from GitHub |
| **[docs/reuse.md](docs/reuse.md)** | Dropping the framework into another repository (`install.py` automates it) |
| **[docs/internals.md](docs/internals.md)** | Ledger mechanics — entry schema, resumable state, parallel-workflow merge |
| **[../CLAUDE.md](../CLAUDE.md)** | Operator quickstart for running a cycle locally |

The ledger CLI is `python SDLC/sdlc.py --help`.
