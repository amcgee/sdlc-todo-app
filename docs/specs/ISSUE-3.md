# ISSUE-3 — Use Bun instead of npm (and run tests with Vitest)

Status: SPEC (draft for the spec gate)
Owner: architect
Work item: ISSUE-3

---

## 1. Problem statement

The React + Vite TODO app is installed and scripted around **npm** (`package-lock.json`,
`npm install`, `npm run …`) and its test suite runs under the **Node built-in test
runner** (`node --test`, with `node:test` / `node:assert/strict` imports). The suite is
**51 `test(...)` blocks** (top-level `node:test` `test()` calls — *not* 51 assertions, and
not `describe`/`it` blocks; the file contains zero `describe`/`it`). We want to adopt
**Bun** as the package manager and task runner, and migrate the test suite to **Vitest**.
After this change, a contributor (and CI) installs dependencies with Bun, runs every
project task via `bun run …`, and the existing test assertions execute under Vitest with
no loss of coverage. Application behavior and the public API of `src/todos.js` do not
change; only the toolchain (install/lockfile/task runner/test framework) and the
references to it (CI, hooks, editor/launch config, docs) change.

This is a **toolchain migration**, not a feature change. Its success is measured by:
the same logical assertions passing under a different runner, and every former `npm`
invocation in the repo now driving `bun`.

---

## 2. Goals

- Bun is the package manager: install, add, and remove dependencies via Bun.
- Bun is the task runner: `dev`, `build`, `preview`, and `test` all run via `bun run`.
- A Bun lockfile replaces `package-lock.json` and is the single committed lockfile.
- The test suite runs under **Vitest** (`import { test, expect } from 'vitest'` — the file
  uses only top-level `test()` calls, so no `describe`/`it` are imported or introduced),
  invoked through `bun run test`, NOT through Bun's built-in `bun test` runner.
- Every existing assertion is preserved as an equivalent Vitest assertion — same logical
  coverage, adapted syntax. No test is dropped, weakened, or made vacuous.
- All repo references to `npm` that drive install/build/test (CI workflow, SessionStart
  hook, launch config, docs/PR template) are updated to Bun.
- `.gitignore` is updated as needed for the new lockfile and any Bun-specific artifacts.

## 3. Non-goals (out of scope)

- N1. No change to application logic or behavior: `src/todos.js`, `src/storage.js`,
  `src/App.jsx`, `src/main.jsx`, `index.html`, `vite.config.js` runtime behavior are
  untouched. (Editing `vite.config.js` is permitted ONLY if Vitest config must live there;
  see R7 / Open Question Q2 — no behavioral change to the dev/build pipeline either way.)
- N2. No new test cases beyond the migration. Coverage is preserved 1:1, not expanded.
  (Wrapping existing `test()` blocks in `describe` groups, or restructuring into `it`
  blocks, is also out of scope — the migration is assertion-for-assertion and
  block-for-block; see R5/R6.)
- N3. No dependency version upgrades except adding Vitest (and a Vitest-required peer such
  as a DOM environment only if R5 proves one is needed). React/Vite/plugin versions are
  pinned as-is. The Vitest version itself is pinned per R4/R6 to a release compatible with
  the existing `vite ^5.4.0`.
- N4. Not removing or keeping npm-compatibility as a goal either way; we do not commit to
  supporting `npm install` after this change, and we do not actively sabotage it beyond
  removing `package-lock.json`.
- N5. No migration of the Python SDLC tooling, the ledger CLI, or `node --test` references
  that are purely **historical prose** in already-ratified docs (`docs/specs/TODO-1*.md`,
  ledger entries). Those describe TODO-1 as it was built and are not edited. Only
  forward-looking, operative references (things that are executed or instruct the reader to
  run a command now) are updated. See R6 for the exact enumerated set.

---

## 4. Requirements (verifiable)

Each requirement names a falsifying test. "Green suite" means all migrated tests pass.

### Package manager

- **R1 — Bun installs the project.** A clean install from the committed manifest +
  lockfile using Bun (`bun install`) succeeds and produces a working `node_modules`
  sufficient to build and test.
  *Falsify:* on a tree with `node_modules` removed, `bun install` exits non-zero, or a
  subsequent `bun run build` / `bun run test` fails for missing deps.

- **R2 — Bun add/remove works against the manifest.** Adding and removing a dependency
  via Bun (`bun add <pkg>` / `bun remove <pkg>`) updates `package.json` and the Bun
  lockfile consistently.
  *Falsify:* `bun add`/`bun remove` of a throwaway package leaves `package.json` and the
  lockfile out of sync, or errors. (This is exercised at minimum by R4 adding Vitest.)

- **R3 — A Bun lockfile replaces `package-lock.json`.** After the change, the repo
  contains exactly one Bun lockfile (`bun.lock` text format, or `bun.lockb` binary —
  whichever the pinned Bun version produces by default; see Q1), it is committed, and
  `package-lock.json` is **deleted** from the working tree and from git.
  *Falsify:* `package-lock.json` still exists/tracked, OR no Bun lockfile is committed,
  OR both a Bun lockfile and `package-lock.json` are present.

### Task runner / scripts

- **R4 — All four scripts run under Bun.** `bun run dev`, `bun run build`,
  `bun run preview`, and `bun run test` each invoke the correct underlying tool and
  succeed (for `dev`/`preview`, "succeeds" = the server process starts and binds without
  an immediate crash; `build` produces `dist/`; `test` runs Vitest to a green suite).
  Vitest is added as a devDependency (via R2) at a version compatible with the pinned
  `vite ^5.4.0`: **`vitest@^1.6`** (Vitest 1.x is the line that supports Vite 5; do not
  pull Vitest 2.x/3.x, which target newer Vite majors). No DOM-environment peer unless R5
  proves it is needed (N3).
  *Falsify:* any of the four `bun run …` commands errors, or `bun run test` does not
  execute Vitest (e.g. still calls `node --test`, or silently runs `bun test`), OR the
  installed Vitest major is outside the `^1.6` (1.x) line and its peer-deps conflict with
  `vite ^5.4.0`.

- **R4a — `bun run test` runs Vitest, not Bun's native runner.** The `test` script in
  `package.json` is **exactly** `"test": "vitest run"` — the `run` subcommand forces a
  single non-watch pass that exits with the suite's status. No extra glob/path argument is
  needed: Vitest's default include pattern already matches `tests/**/*.test.js` (where
  `tests/todos.test.js` lives). Running `bun test` (Bun's built-in runner) is NOT the
  contract; the documented/CI command is `bun run test`.
  *Falsify:* the `test` script body is not exactly `vitest run` (e.g. it omits `run` and
  defaults to watch mode, or names a different runner), OR `bun run test` enters watch mode
  and never exits in CI, OR it dispatches to `bun test`, OR Vitest's default include fails
  to collect `tests/todos.test.js` and a glob had to be added without updating this spec.

### Test migration

- **R5 — Tests are migrated to Vitest syntax with the exact import contract.**
  `tests/todos.test.js` imports **`import { test, expect } from 'vitest'`** and contains
  no `node:test` or `node:assert/strict` imports. The file's structure is preserved: it
  keeps its **51 top-level `test('…', () => { … })` blocks** and introduces **no
  `describe`/`it` wrapping** (the original uses neither; adding them is out of scope per
  N2). The current Node `test('name', fn)` signature maps directly to Vitest's
  `test('name', fn)` — same call shape, only the import source changes. The Vitest
  environment is configured such that the pure-core suite runs (default `node` environment
  is expected to suffice since the suite touches no DOM; if any case needs a DOM, R5
  requires the environment be set explicitly — see Q2).
  *Falsify:* the test file still imports `node:test` or `node:assert`; OR it imports
  `describe`/`it` (or wraps blocks in them); OR it imports anything other than
  `{ test, expect }` from `vitest` (e.g. a stray `it`/`describe`); OR Vitest cannot
  collect/run the file; OR the block count is not 51.

- **R6 — Existing coverage is preserved 1:1 with strictness-preserving, per-line mapping.**
  Every assertion in the current 51-block suite maps to a Vitest assertion of equivalent
  strictness. The current file (verified by static count) uses exactly:
  **39 `assert.deepEqual`, 29 `assert.equal`, 8 `assert.strictEqual`, 5 `assert.ok`,
  3 `assert.doesNotThrow`, 1 `assert.notEqual`.** Because the import is `node:assert/strict`,
  *all* of these are strict (`equal` is `===`, `deepEqual` is recursive strict). The
  mapping is:

  | Node assertion | Vitest matcher | Notes |
  |---|---|---|
  | `assert.deepEqual(a, b)` | `expect(a).toEqual(b)` | recursive structural equality |
  | `assert.equal(a, b)` | `expect(a).toBe(b)` | `===`; **never** `toEqual` (see below) |
  | `assert.strictEqual(a, b)` | `expect(a).toBe(b)` | `===` |
  | `assert.notEqual(a, b)` | `expect(a).not.toBe(b)` | `!==` (line 274, `makeId` distinctness) |
  | `assert.ok(x)` | `expect(x).toBeTruthy()` | or a stricter intent-preserving matcher (e.g. `expect(arr.length).toBeGreaterThan(0)`) |
  | `assert.doesNotThrow(fn)` | `expect(fn).not.toThrow()` | wrap the IIFE/callback as a function |

  **Critical `assert.equal` disambiguation (F12).** `assert.equal` appears in two distinct
  roles; **both** map to `toBe` (since strict `equal` is `===`), but a translator must not
  silently relax the reference-identity ones to `toEqual`:
  - **Reference-identity (array `===` array) — MUST stay `toBe`:** lines **65, 74, 79, 86,
    311** — `assert.equal(next, list)` / `assert.equal(addTodo(list,'','z'), list)` /
    `assert.equal(editTodo(...), list)`. These prove a no-op returns *the same array
    reference* (catches a needless defensive copy). `toEqual` would pass on a copy and
    silently lose the check.
  - **String/primitive value (`===` on serialized strings) — `toBe`:** lines **241, 248**
    — `assert.equal(received, JSON.stringify(list))` / `assert.equal(received, '[]')`.
    These are value comparisons of strings; `toBe` is correct and sufficient (`toEqual`
    would also pass but `toBe` preserves exact strictness).
  - **Remaining `assert.equal` (numeric/`typeof`/`Set.size` scalars) — `toBe`:** e.g.
    lines 55, 58, 64, 73, 87, 112, 114, 159, 257, 262, 270, 328, 334, 398, 402, 406, 409,
    424, 426, 428, 447, 448. All scalar `===`; `toBe` throughout.

  **Loop-based parameterized assertions retain every iteration** (no reduction of cases):
  the `for (const … of …)` blocks at lines 84–88, 110–115, 175–177, 186–190, 267–270,
  467–472, and the call-array loops at 493–495 must run the same number of iterations after
  migration. The set of behaviors proven (addTodo, sanitizeTodos, parseStored, safeSave,
  makeId, toggleTodo, editTodo, deleteTodo, clearCompleted, filterTodos, remainingCount,
  INV1–INV3, R1/R10/R11/F8 purity & immutability) is unchanged.
  *Falsify:* the migrated suite has fewer passing assertions than the original; OR any of
  the reference-identity no-op checks at lines 65/74/79/86/311 is downgraded to `toEqual`
  (verifier proves this by a known-broken core that returns a *copy* on a no-op — the
  original `toBe` catches it, a downgraded `toEqual` does not); OR a `toThrow`/`not.toThrow`
  is dropped; OR a loop's iteration count is reduced; OR the migrated suite passes against a
  deliberately-broken `src/todos.js` that the original suite caught.

- **R6a — Per-iteration assertion messages are preserved as diagnostics (F13).** Several
  Node assertions carry a 3rd-argument message that gives loop-iteration context, e.g.
  lines **64, 65, 86** (`` `id=${JSON.stringify(badId)} must be a no-op` ``), **112, 113**
  (`completed=…`), **176** (`${bad} -> []`), **188, 189** (`parseStored(${raw}) …`),
  **270** (`all 1000 ids must be distinct`), **311**, and **470, 471**
  (`${name} threw / mutated its input`). Vitest's matchers (`toBe`, `toEqual`, `toThrow`,
  …) do **not** accept a per-assertion message argument, so this diagnostic fidelity must
  be preserved by one of these mechanisms — the migration must pick one and apply it
  consistently to every message-bearing assertion:
  1. Convert the enclosing data-driven loop to `test.each([...])('name with %s / $field', …)`
     so the failing iteration is identified by the generated test name (preferred for the
     loops at 84–88, 110–115, 175–177, 186–190, 467–472), OR
  2. Keep the loop but assert through a helper / add an inline comment that records the
     diagnostic intent where the message cannot be expressed as a test name.
  No message-bearing assertion may be migrated by simply dropping its message with no
  replacement diagnostic.
  *Falsify:* any of the enumerated message-bearing assertions (lines 64, 65, 86, 112, 113,
  176, 188, 189, 270, 311, 470, 471) is migrated such that, when that specific iteration
  fails against a deliberately-broken core, the failure output does **not** identify which
  iteration/case failed (i.e. the diagnostic context was dropped rather than moved to a
  `test.each` name or equivalent).

### Repo references to the toolchain

- **R7 — Operative `npm` references are updated to Bun.** The following executed or
  instructional references are migrated; this is the exhaustive set in scope:
  1. `package.json` `test` script → exactly `"test": "vitest run"` (R4a).
  2. `.github/workflows/sdlc-arbiter-gate.yml` "Run the proving test suite" step
     (currently `npm install --no-audit --no-fund` then `npm test`) → Bun equivalents:
     the install command is exactly **`bun install --frozen-lockfile`** (the `--no-audit`
     / `--no-fund` flags are **npm-only** and must NOT be carried over; Bun rejects them),
     followed by **`bun run test`**. AND the runner must be provisioned with Bun via an
     **`oven-sh/setup-bun` step that appears *before* the install/test step** (GitHub
     runners do not ship Bun). The `--frozen-lockfile` flag enforces INV-E in CI (fail if
     the committed lockfile is stale rather than silently re-resolving).
  3. `.claude/settings.json` `SessionStart` hook (currently
     `[ -f "$CLAUDE_PROJECT_DIR/package.json" ] && cd … && npm install --no-audit --no-fund || true`)
     → a Bun install that (a) drops the npm-only `--no-audit`/`--no-fund` flags, and (b)
     **verifies Bun is on PATH before invoking it and fails *visibly* if Bun is absent**
     rather than silently no-opping. See R7a for the exact contract — the naive
     `… && bun install || true` is explicitly forbidden because the trailing `|| true`
     would swallow a missing-Bun error and leave the session with no dependencies and no
     signal.
  4. `.claude/launch.json`: `"runtimeExecutable": "npm"` → Bun (`bun` with
     `runtimeArgs` adjusted so it runs `bun run dev`).
  5. `README.md` "Run it" block and the test-suite row → `bun install` / `bun run …` /
     `bun run test`, and the "Requires Node 20+" note revised to state the Bun
     requirement (Bun version pinned per Q1). The test-suite description must continue to
     state the correct count — **51 `test()` blocks** — and must not be left claiming
     `node --test` or a wrong count after migration (see R7b / F19).
  6. `.github/pull_request_template.md` line 47: `npm test` → `bun run test`.
  7. `SDLC/cloud-setup.md` and `SDLC/REUSE.md` lines describing the SessionStart hook
     running `npm install` → `bun install`, to stay consistent with R7.3.
  *Falsify:* `grep -rn "npm " --include=<the files above>` still matches an operative
  command after the change; OR CI's test step still calls npm; OR CI carries `--no-audit`
  or `--no-fund` on the `bun install` line; OR the SessionStart hook still calls npm.
  *Explicitly NOT in scope (must remain unchanged):* historical prose in
  `docs/specs/TODO-1.md`, `docs/specs/TODO-1-plan.md`, and any `SDLC/ledger/*` entries;
  `package-lock.json` contents (it is deleted, not edited); registry URLs inside any
  generated lockfile.

- **R7a — SessionStart hook fails loudly when Bun is missing (F14).** The migrated
  `SessionStart` hook must not silently no-op when Bun is unavailable. It must, in order:
  (1) only act when `package.json` exists (preserving the current guard); (2) check Bun is
  on PATH (e.g. `command -v bun`); (3) if Bun is present, run **`bun install`** (no
  npm-only flags) from the project dir; (4) if Bun is **absent**, emit a clear diagnostic
  to stderr (naming Bun as a session prerequisite per Q1) and surface a non-success signal
  for that branch — it must NOT mask the absence behind `|| true`. The `|| true` tail may
  only guard against a *benign* condition (e.g. no `package.json`), never against a missing
  package manager. Alternatively, if the session environment is contractually guaranteed to
  ship Bun, that guarantee must be written into this spec as a named prerequisite (see Q4)
  and the README/cloud-setup; "silently assume Bun" is not acceptable.
  *Falsify:* with Bun removed from PATH in a tree that has `package.json`, the hook exits 0
  with no diagnostic and no dependencies installed (i.e. the failure is silent); OR the
  hook still carries `--no-audit`/`--no-fund`; OR no prerequisite is documented per Q4.

- **R7b — Test-count claims stay accurate (F19).** Any human-readable count of the suite
  in operative docs (README test-suite row, and any comment the migration adds) must refer
  to **51 `test()` blocks**, not "51 assertions" and not a stale runner. The migrated test
  file header comment must no longer instruct `node --test`.
  *Falsify:* README or an added comment states a test count other than 51 blocks, or
  conflates blocks with assertions, or still says `node --test` as the run command.

- **R8 — `.gitignore` is correct for the new toolchain.** `.gitignore` does NOT ignore
  the committed Bun lockfile (it must be tracked), continues to ignore `node_modules/`
  and `dist/`, and ignores any Bun-local artifacts that should not be committed
  (e.g. `.bun/` cache if one appears in-tree). If no new ignore entry is needed, that is
  an acceptable outcome and R8 is satisfied by verifying the lockfile is tracked.
  *Falsify:* the Bun lockfile is gitignored (and thus uncommitted), OR a Bun cache/
  artifact gets committed, OR `node_modules/` stops being ignored.

---

## 5. Failure modes & invariants (what must never happen)

- **INV-A — No dual lockfiles.** The repo never carries both `package-lock.json` and a
  Bun lockfile. Exactly one lockfile, and it is Bun's. (Two lockfiles drift and silently
  re-pin transitive deps.)
- **INV-B — `bun run test` is deterministic and CI-safe.** The test command exits with a
  non-zero status on any failing test and exits at all (no watch mode). CI must be able to
  gate on its exit code. (A watch-mode default that hangs CI is a blocker.)
- **INV-C — No silent coverage loss.** The migration must not turn a strict
  reference-identity assertion into a looser structural one, nor drop a throw/no-throw
  assertion, nor drop a per-iteration diagnostic message (R6a). A migrated suite that goes
  green against a known-broken core (the same defects the original was authored to catch,
  per the test file's header comments) is a failure.
- **INV-D — App behavior unchanged.** `bun run build` produces a working bundle and
  `bun run dev`/`preview` serve the same app; no source file under `src/` changes behavior.
  (Touching `src/` also trips the build-gate guard; this work should not need to.)
- **INV-E — Toolchain is reproducible.** A fresh `bun install` from the committed lockfile
  yields the same resolved dependency versions on a clean checkout (lockfile is committed
  and authoritative). CI enforces this by installing with `bun install --frozen-lockfile`
  (R7.2), which fails rather than silently re-resolving if the lockfile is stale.

---

## 6. Risks and mitigations

- **Risk: `bun run test` accidentally runs Bun's built-in `bun test`.** Bun ships its own
  test runner triggered by `bun test`; a script named `test` plus muscle memory makes this
  easy to conflate. *Mitigation:* R4a pins the `test` script to exactly `vitest run` and the
  verifier proves the runner is Vitest (e.g. by asserting Vitest-specific output/exit
  behavior), and CI uses `bun run test` (which honors the script) — never bare `bun test`.

- **Risk: Lockfile format ambiguity (`bun.lockb` vs `bun.lock`).** The issue text says
  `bun.lockb`, but Bun 1.2+ defaults to a text `bun.lock`. *Mitigation:* Q1 resolves the
  exact format against the pinned Bun version; R3 accepts whichever the pinned version
  produces by default and forbids carrying both lockfiles. `.gitignore` (R8) must track it.

- **Risk: Vitest version incompatible with Vite 5.** Vitest 2.x/3.x target newer Vite
  majors and will conflict with the pinned `vite ^5.4.0`. *Mitigation:* R4 pins
  `vitest@^1.6` (the 1.x line, compatible with Vite 5); the verifier proves `bun install`
  resolves without a peer-dep conflict against `vite ^5.4.0`.

- **Risk: Vitest needs a DOM/jsdom environment.** Vitest defaults to a `node`-like
  environment; the current suite is pure (no DOM), so default should work, but a wrong
  default could fail collection. *Mitigation:* Q2 / R5 — confirm default suffices; only add
  a DOM environment dep if a case proves to need it (kept out of scope otherwise per N3).

- **Risk: Assertion-strictness drift during translation (silent coverage loss).** The
  suite leans on reference-identity no-ops (`assert.equal(next, list)` meaning `next ===
  list`) to catch needless copies; a naive translation to `toEqual` would pass even for a
  regressed core. *Mitigation:* R6's per-line checklist enumerates the reference-identity
  cases (65, 74, 79, 86, 311) vs. the value cases (241, 248) so a translator cannot
  conflate them, and INV-C makes a known-broken-core check the acceptance bar.

- **Risk: Per-iteration diagnostics lost in translation.** Vitest matchers take no message
  arg, so naive translation drops the 3rd-arg loop messages and a future failure won't say
  which case broke. *Mitigation:* R6a requires moving them to `test.each` names (or an
  equivalent) and its falsifier checks the failing-iteration identifier survives.

- **Risk: SessionStart hook silently no-ops without Bun.** The current hook ends in
  `|| true`, which would swallow a missing-Bun error and leave a session with no deps and
  no signal. *Mitigation:* R7a requires a `command -v bun` check and a loud failure (or a
  documented Bun prerequisite per Q4); the `|| true` may only guard the benign
  no-`package.json` case.

- **Risk: CI runner has no Bun, or carries npm-only flags.** GitHub-hosted runners ship
  npm/node, not Bun, and `--no-audit`/`--no-fund` are npm-only. *Mitigation:* R7.2 requires
  an `oven-sh/setup-bun` step *before* the install/test step and pins the exact command to
  `bun install --frozen-lockfile` then `bun run test`; the verifier checks the setup step
  exists and precedes the install, and that no npm-only flags remain.

- **Risk: Stale npm references left behind.** Migrations commonly miss CI/hook/editor/docs
  call sites. *Mitigation:* R7 enumerates the exhaustive in-scope set and its falsifier is
  a `grep` for operative `npm` commands across exactly those files.

- **Risk: Scope creep into historical docs/ledger.** Editing already-ratified TODO-1 specs
  or ledger prose would be an unnecessary, attackable change. *Mitigation:* N5 + R7 draw a
  hard line: historical prose stays; only forward-looking/executed references change.

---

## 7. Open questions (need human/arbiter input)

- **Q1 — Lockfile format & pinned Bun version.** Should we standardize on Bun's text
  `bun.lock` (1.2+) or the binary `bun.lockb`? The issue says `bun.lockb`; the installed
  Bun is 1.3.x which defaults to text `bun.lock`. Proposed default: accept the pinned
  version's default (text `bun.lock` on 1.3.x) and pin a minimum Bun version in README/CI.
  Confirm the intended lockfile format and the Bun version to pin.

- **Q2 — Vitest environment & config location.** Acceptable to rely on Vitest's default
  environment (pure-core suite needs no DOM), and to place any minimal Vitest config inside
  the existing `vite.config.js` (via a `test` block) rather than a new `vitest.config.js`?
  Proposed default: default environment + a `test` block in `vite.config.js`, with no new
  DOM dependency.

- **Q3 — npm compatibility posture.** After deleting `package-lock.json`, do we want to
  keep `npm install` working as a fallback (it would regenerate a lockfile and could drift
  from Bun), or explicitly declare Bun the only supported manager? Proposed default: Bun is
  the only supported manager; do not maintain npm compatibility (N4).

- **Q4 — Bun availability in the SessionStart environment.** Is Bun guaranteed to be on
  PATH in the local/cloud session environment, or must the hook tolerate its absence? This
  decides R7a's posture: if guaranteed, document it as a named prerequisite (README +
  `SDLC/cloud-setup.md`) and the hook may assume Bun; if not guaranteed, the hook must fail
  loudly with a clear "install Bun" diagnostic. Either way, silent no-op via `|| true` is
  forbidden. Proposed default: do NOT assume — `command -v bun` check with a loud failure.
