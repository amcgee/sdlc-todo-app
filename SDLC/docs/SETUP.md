# Setting up the SDLC routine

The whole pipeline runs as **one** [Claude Code Routine](https://code.claude.com/docs/en/routines) that
fires when an issue is labelled `sdlc`, then opens a PR and drives the entire cycle on it. Create it once.

## The routine

Create it at **[claude.ai/code/routines](https://claude.ai/code/routines)** with exactly these settings:

| Setting | Value |
|---|---|
| **Name** | `sdlc` |
| **Repository** | this repo |
| **Trigger** | GitHub **issue events** (research-preview "All issue events") |
| **Environment** | Trusted (default) |
| **Prompt** | `Run the SDLC cycle for this repo; read and follow .claude/commands/sdlc.md exactly.` |

## One-time setup

1. **Install the Claude GitHub App** on the repo — required for GitHub-event triggers (the routine
   trigger setup in the claude.ai UI prompts you to install it).
2. **Create the routine** with the settings above.
3. **Create the label** `sdlc`.
4. **Protect the default branch:** require a PR with **1 approval**, the **`arbiter-gate`** status check,
   and your repo's own application-test check.
5. **(Optional)** set `SDLC_ENFORCE=warn` in `.claude/settings.json` to relax the build-gate hooks to
   advisory (default `block`).

No repo secret is needed — the routine authenticates through your claude.ai account, and it pushes only
to `claude/`-prefixed branches (which is the SDLC branch convention). To drop the framework into another
repository, see [reuse.md](reuse.md).
