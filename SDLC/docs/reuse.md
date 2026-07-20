# Reusing the SDLC in another repository

## Quick install (automated)

`SDLC/install.py` does §1–§2 and the ledger reset for you. Obtain the framework — clone,
`git submodule add`, download, or a vendored copy — then run it from the framework checkout
against your repo:

```
python3 SDLC/install.py --target /path/to/your/repo     # --dry-run to preview, --force to refresh
```

It copies `SDLC/` + the `.claude/` wiring + the three framework workflows, merges the
`.claude/settings.json` permission/hook wiring and the ledger `merge=union`
`.gitattributes` line into any existing files, scaffolds a starter `sdlc.config.json` (never
overwriting yours), starts the ledger empty, and smoke-tests the result. Git-submodule recipe:

```
git submodule add <framework-repo-url> vendor/agentic-sdlc
python3 vendor/agentic-sdlc/SDLC/install.py --target .
# upgrade later: git submodule update --remote && python3 vendor/agentic-sdlc/SDLC/install.py --target . --force
```

Then do §2's manifest edits (the installer scaffolds it; you set the values), §3's adapters,
and §4's platform setup. The rest of this doc is the manual playbook the installer automates.

## What ports, and where it lives

The framework lives under `SDLC/` — the CLI (`sdlc.py`), the library (`lib/`), the docs
(`docs/`), the installer (`install.py`), the framework tests and scripts — and copies with
that one directory **unedited**.
The parts that can't live there are the platform-mandated wiring (`.claude/`, several
`.github/workflows/`) and the **one app-specific file**: the adapter manifest `sdlc.config.json`,
which sits at the **repo root** (outside `SDLC/`) precisely so the framework directory ports
without edits. Porting is "copy the wiring + write the root manifest for your stack + reimplement
the app-specific adapter scripts you want" — every app/stack coupling resolves through the single
reader `SDLC/lib/manifest.py`, in any language. The framework version is
`python SDLC/sdlc.py version`.

## 1. Copy the framework

- **`SDLC/`** — the CLI (`sdlc.py`), the installer (`install.py` — automates this doc),
  the framework constants (`constants.json` — version,
  schema epoch, round cap, finding budget), the library `lib/` (the manifest reader
  `manifest.py` + the pre-fix spot-check `spot_check.py`), the docs (`docs/`), the driver output
  templates
  (`templates/`, read by the drivers in `.claude/commands/`), the framework's own test suites
  (`tests/test_*.py`) and framework scripts (`scripts/`, e.g. the doc-link checker and the CI
  check logic under `scripts/ci/`). `SDLC/` carries **no mutable state** — the ledger lives
  outside it (default `.sdlc/ledger/` at the repo root, §2) — so the directory is fully
  immutable and copies (or mounts as a submodule) **unedited**, with no exceptions.
- **`.claude/`** — `agents/`, `skills/`, `commands/` (the `sdlc.md` dispatcher + the
  `sdlc-product.md` / `sdlc-engineering.md` workflow drivers), and the hooks
  `gate_guard.py` + `git_branch_guard.py` + `bash_write_guard.py`. Merge this repo's
  `.claude/settings.json` (the hook wiring, the `ask`/`deny` permission lists, and
  `env.SDLC_ENFORCE`) and the `CLAUDE.md` operator section into the target's.
- **`.github/workflows/`** — three framework workflows, each a **thin orchestrator**: every
  check is one call into an SDLC-owned command (`sdlc.py verify-gate`, `scripts/ci/*`), so the
  logic lives in the framework, not the YAML. Copy them near-verbatim; the **only** repo-specific
  line is the "Install project runtime" step in `sdlc-arbiter-gate.yml` (§2).
  - `sdlc-arbiter-gate.yml` — the required status check: `verify-gate` (merge gate + append-only
    + test-existence + integrity), the pre-fix spot-check, and the disposition / review-thread /
    spec-economy / artifact-lint checks.
  - `framework-tests.yml` — runs the framework's own Python test suites; **app-agnostic,
    copy verbatim.**
  - `security.yml` — the semgrep floor (`scripts/ci/semgrep_floor.py`) + dependency audit.

The cycle itself runs as a single **Routine** created in the claude.ai UI (see
[SETUP.md](SETUP.md)), not a workflow file.

## 2. Point the manifest at your stack — the one config seam

`sdlc.config.json` holds every app/stack coupling; every consumer — both hooks, `sdlc.py`,
`spot_check.py`, and the `security.yml` / arbiter-gate workflows — reads it through the one
reader `SDLC/lib/manifest.py`, so the resolution logic never drifts between them:

- **`shipped_paths`** — the code dirs the build gate protects. Read by both hooks and the
  process-artifact lint through `manifest.shipped_paths()` (env `SDLC_PROTECTED` still
  overrides). Set to your source layout — any language.
- **`scan_paths`** *(optional)* — **additive** extra dirs for the semgrep floor, on top of
  `shipped_paths` (`manifest.scan_paths()` returns the union). Use it for code that runs but
  isn't shipped product — build/dev tooling the build gate deliberately doesn't protect (here:
  `scripts/`). Additive on purpose: the shipped set is *always* scanned, so this can only
  widen coverage, never narrow the security floor below it.
- **`trust_boundaries`** — dirs whose diffs trigger the mandatory STRIDE pass.
- **`toolchain.{install,test,coverage,name_flag}`** — how tests run. `spot_check.py` and the
  arbiter-gate spot-check read these (CLI flags still override), e.g. `pytest` + `name_flag:
  -k`, or `go test`. **Nothing assumes `package.json`/`bun`** — install runs whenever
  `toolchain.install` is set, in any language.
- **`docs.*`** — paths for the screenshot baselines, the architecture map, and the
  **user guide** (`docs.user_guide`, a multi-doc guide the pm keeps current — see below).
  No `ui_paths`/`user_facing_paths` here: the pm `visual:`/`docs:` dispositions are gated on
  the architect's spec **Docs-impact declaration** + a committed baseline changing
  (`SDLC/scripts/check-dispositions.py`), not on a source-dir allowlist — so there is nothing
  stack-specific to port for that gate.
- **`ledger_dir`** *(optional)* — where the mutable ledger lives, relative to the repo root;
  default `.sdlc/ledger/` (`SDLC_LEDGER_DIR` env overrides). Resolved through
  `manifest.ledger_dir()`, so the CLI, both hooks, and CI agree. It sits OUTSIDE `SDLC/` on
  purpose — that is what keeps the framework directory immutable. If you relocate it, update
  the `.gitattributes` union-merge line to match.

The `SessionStart` hook in `.claude/settings.json` runs the manifest's `toolchain.install`
command automatically — set that key and no hook edit is needed. The one **project-runtime**
step in `sdlc-arbiter-gate.yml` ships covering the common JS consumer (Bun, skipped without
a `package.json`); on another stack swap it for your runtime — `python3` is always present,
and everything else reads the manifest, so that's the only stack-specific line in the
workflow.

## 3. Reimplement or drop the adapters

Some framework checks use optional **project adapter** scripts under the consuming repo's
own `scripts/` (distinct from `SDLC/scripts/`, which is framework-owned — the doc-link
checker lives there and copies with `SDLC/`). The adapters a project can provide:
`diff-coverage.mjs` (turns coverage output into the adversary's untested-new-lines target
list), `check-architecture.mjs` (mechanically enforces the architecture map's dependency
rules), and `screenshots.mjs` (captures the visual-regression baselines the pm reviews).
Each encodes the project's own toolchain — write them for your stack or drop the
corresponding optional step (diff coverage and the visual job are non-gating; the
architecture check is worth authoring). The reference implementations live in the
[`sdlc-todo-app`](https://github.com/amcgee/sdlc-todo-app) consumer's `scripts/`.

**Guarantees that degrade quietly if you skip a step:** the pre-fix spot-check needs a
working `toolchain.test`; if the manifest points nowhere runnable it will skip (infra),
not fail — so confirm it actually runs a claim on your stack. The arbiter-gate spot-check
and the process-artifact lint are manifest-driven, so a non-JS port works once the manifest
is right, save for the project-runtime step (Install Bun) you swap for your runtime.

## 4. Platform prerequisites

The drivers assume: the **GitHub MCP** tools (issue/label ops for the product workflow;
branch claim, PR ops, `subscribe_pr_activity` for engineering), optionally **Copilot review**
as the round-1 second opinion (skipped cleanly if absent), and the **claude-code-remote**
`send_later` tool for self check-ins. A port on another platform reimplements these touch
points in the drivers under `.claude/commands/`.

## 5. Start clean and smoke-test

Empty the ledger dir (default `.sdlc/ledger/` — `rounds.jsonl`, `gates.json`, `audit.jsonl`,
any `.build-open`; keep `.gitkeep`), then:

```
python SDLC/sdlc.py version            # confirm the framework version you ported
python SDLC/sdlc.py open --item TEST-1 --title smoke && python SDLC/sdlc.py state --item TEST-1
python SDLC/sdlc.py doctor --exit-code
python3 SDLC/tests/test_ledger.py      # and the other SDLC/tests/test_*.py suites
```

Then reset the ledger and [set up the Routine](SETUP.md).

## 6. The reference consumer

This repository holds only the framework. The demo TODO app it was built around lives in
[`sdlc-todo-app`](https://github.com/amcgee/sdlc-todo-app), which consumes the framework
exactly as §Quick-install describes — vendored as a git submodule and materialized by
`install.py` — and carries the adapter scripts (§3), the app workflows, and the app's own
development ledger. Use it as the worked example of a port.
