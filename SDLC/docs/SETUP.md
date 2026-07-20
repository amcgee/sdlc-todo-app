# Setting up the SDLC routine

The pipeline runs as **one** [Claude Code Routine](https://code.claude.com/docs/en/routines) that
fires on issue events and dispatches to the right workflow: the `sdlc` label starts the **product**
workflow (PRD iteration in the issue), and the session that receives the ratifying
`@claude continue` opens the PR and continues as the **engineering** workflow (spec+build+test on
that PR). The `sdlc-build` label marks the engineering state and is also a direct entry: apply it
by hand to skip product or to restart a dead cycle. Create the routine once.

## The routine

Create it at **[claude.ai/code/routines](https://claude.ai/code/routines)** with exactly these settings:

| Setting | Value |
|---|---|
| **Name** | `sdlc` |
| **Repository** | this repo |
| **Trigger** | GitHub **issue events** (research-preview "All issue events" — label adds AND issue comments must both be delivered; product iteration rides on comment events) |
| **Environment** | Trusted (default) |
| **Prompt** | `Run the SDLC cycle for this repo; read and follow .claude/commands/sdlc.md exactly.` |

Every firing lands in the dispatcher (`.claude/commands/sdlc.md`), which routes to
`sdlc-product.md` or `sdlc-engineering.md` — or stops if the event is not the SDLC's.

## One-time setup

1. **Install the Claude GitHub App** on the repo — required for GitHub-event triggers (the routine
   trigger setup in the claude.ai UI prompts you to install it).
2. **Create the routine** with the settings above.
3. **Create the labels** `sdlc` and `sdlc-build`. Apply `sdlc` to start an issue at the PRD;
   apply `sdlc-build` directly to skip product (the issue body is treated as the ratified PRD)
   or to restart a cycle whose session died. The cycle applies `sdlc-build` itself at
   ratification, as a state marker.
4. **Protect the default branch:** require a PR with **1 approval**, the **`arbiter-gate`** status check,
   and your repo's own application-test check.
5. **(Optional)** set `SDLC_ENFORCE=warn` in `.claude/settings.json` to relax the build-gate hooks to
   advisory (default `block`).

No repo secret is needed — the routine authenticates through your claude.ai account, and it pushes only
to `claude/`-prefixed branches (which is the SDLC branch convention). To drop the framework into another
repository, see [reuse.md](reuse.md).
