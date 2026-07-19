# ISSUE-3 — Implementation Plan: Bun + Vitest toolchain migration

Status: PLAN (draft for the plan gate)
Owner: architect
Work item: ISSUE-3
Implements: docs/specs/ISSUE-3.md (R1–R8, R4a, R6a, R7a, R7b, INV-A–INV-E)

---

## 0. Approach and rejected alternatives

**Chosen approach.** A surgical toolchain swap with zero source-behavior change. We (a)
adopt Bun as package manager + task runner, (b) replace the `node:test` runner with
Vitest pinned to the 1.x line, (c) translate every assertion in `tests/todos.test.js`
1:1 with strictness preserved, and (d) update exactly the operative `npm` references the
spec enumerates in R7 — nothing more. No `src/` file is touched (INV-D), so the
build-gate guard is never tripped by this work.

**Why this approach.** The spec is explicit and adversary-hardened: it pins the test
script (`vitest run`, R4a), the Vitest version (`^1.6`, R4), the CI command shape
(`bun install --frozen-lockfile` then `bun run test` with a `setup-bun` step, R7.2), the
hook contract (loud failure, R7a), and a per-line assertion map (R6). The smallest plan
that satisfies all of these is a literal translation plus the enumerated reference edits.

**Rejected alternatives.**
- *Use Bun's native `bun test` runner instead of Vitest.* Rejected: R4a/INV-B forbid it;
  `bun test` has different matcher/lifecycle semantics and the spec's contract is Vitest
  via `bun run test`.
- *Upgrade to Vitest 2.x/3.x.* Rejected: those target newer Vite majors and conflict with
  the pinned `vite ^5.4.0` (R4, Risk in §6 of spec). Pin `vitest@^1.6`.
- *Add jsdom/happy-dom for a DOM environment.* Rejected: the suite is pure-core, touches
  no DOM; Vitest's default `node` environment suffices (R5, Q2/N3). Only add one if
  collection actually fails for a DOM reason — which it will not for this file.
- *Wrap blocks in `describe`/restructure into `it`, or convert every loop to `test.each`.*
  Rejected as scope creep (N2). We keep 51 top-level `test()` blocks. `test.each` is used
  only where R6a requires per-iteration diagnostics (see Step 3.D).
- *Keep `package-lock.json` for npm fallback.* Rejected: INV-A forbids dual lockfiles;
  Q3 default is "Bun is the only supported manager."

**Weakest point (named, per the adversary mandate).** The single highest-risk edit is the
assertion translation, specifically the **reference-identity `assert.equal(arr, arr)`
checks at lines 65, 74, 79, 86, 311**. A translator who reflexively maps `assert.equal →
toEqual` would silently destroy coverage (INV-C) and the suite would still go green. Step
3.C handles these explicitly and Step 8.E gives the verifier a known-broken-core probe to
prove the strictness survived. The second weakest point is `bun run test` silently
dispatching to `bun test`; Step 2 + Step 8.B pin and prove the runner identity.

---

## 1. Pre-flight and Bun install

**1.1 Verify Bun is present.**
```
bun --version
```
Expect `1.3.11` (the environment's version). If Bun is absent, STOP — the migration
cannot proceed and the SessionStart prerequisite (R7a/Q4) is unmet; report it.

**1.2 Confirm the build gate is open before any tracked-file writes.** This work touches
no `src/` file, so the `gate_guard.py` PreToolUse hook should not block. No `touch
SDLC/ledger/.build-open` is required for this plan. (If a write is unexpectedly blocked,
that is a signal you are editing a protected path you should not be — re-check scope.)

**1.3 Add Vitest as a devDependency via Bun (satisfies R2, R4).**
```
bun add -d vitest@^1.6
```
This both exercises R2 (Bun add updates `package.json` + lockfile consistently) and adds
the pinned runner. It will create a Bun lockfile (`bun.lock`, text format on 1.3.x — see
Q1 resolution below) and a `node_modules`. Confirm `package.json` `devDependencies` now
lists `"vitest": "^1.6.x"` and that no Vitest 2.x/3.x was resolved (check the resolved
version; if a 2.x slipped in, the `^1.6` range was misread — fix the range).

**1.4 Delete `package-lock.json` (R3, INV-A).** Remove it from the working tree AND from
git tracking so exactly one lockfile (Bun's) remains:
```
git rm package-lock.json
```
(If it was already untracked, `rm package-lock.json`.) After this, exactly one lockfile
exists in the tree, and it is Bun's.

**1.5 Regenerate / finalize the lockfile from the manifest.**
```
bun install
```
Must exit 0 and produce a working `node_modules` (R1). The committed Bun lockfile is now
authoritative (INV-E).

**Lockfile-format note (Q1 resolution for the builder).** Bun 1.3.x defaults to the
**text `bun.lock`** file (not the legacy binary `bun.lockb`). Treat whichever file Bun
produces by default as THE lockfile to commit. Do not force the binary format. Do not end
up with both `bun.lock` and `bun.lockb`. Verify with `ls bun.lock*` — expect exactly one.

---

## 2. Update `package.json` (R4a, INV-B)

Change ONLY the `test` script. Leave `dev`, `build`, `preview` exactly as they are (they
already invoke `vite` and run fine under `bun run`, satisfying R4 for those three).

- From: `"test": "node --test \"tests/**/*.test.js\""`
- To:   `"test": "vitest run"`

It must be **exactly** `vitest run` — no glob/path argument. Vitest's default `include`
pattern (`**/*.{test,spec}.?(c|m)[jt]s?(x)`) already collects `tests/todos.test.js`. The
`run` subcommand forces a single non-watch pass that exits with the suite status (INV-B:
CI-safe, deterministic, no watch hang). Do NOT write `bun test` anywhere; the contract is
`bun run test`, which honors this script.

The `devDependencies` block already has `vitest` from Step 1.3. No other `package.json`
edit is in scope (no new DOM dep — N3).

---

## 3. Migrate `tests/todos.test.js` to Vitest (R5, R6, R6a, R7b, INV-C)

This is the highest-risk step. Translate in place; preserve all 51 `test()` blocks, the
call shape `test('name', fn)`, file order, and every iteration of every loop. Do NOT add
`describe`/`it`. Do NOT add new test cases.

### 3.A — Header comment (R7b)

The current header (lines 1–7) says the suite "Runs under Node's built-in runner:
`node --test tests/`." Update that line so it no longer instructs `node --test`. Replace
with a Vitest instruction, e.g. "Runs under Vitest: `bun run test`." Keep the rest of the
header (the description of what the tests are authored to catch) intact — it documents the
known-broken-core intent that INV-C/Step 8.E rely on. Do not introduce a test-count claim
here; if one is added it must say "51 `test()` blocks" (R7b), never "51 assertions."

### 3.B — Import contract (R5)

- REMOVE: `import { test } from 'node:test';`
- REMOVE: `import assert from 'node:assert/strict';`
- ADD (single line):  `import { test, expect } from 'vitest';`

After migration the file must import **only** `{ test, expect }` from `vitest` and contain
zero `node:test` / `node:assert` imports and zero `describe`/`it`. The `import { ... } from
'../src/todos.js'` block (lines 12–24) is unchanged.

### 3.C — Assertion translation table (R6)

Apply this mapping to every assertion. Counts are the authoritative static counts from the
spec (verified: 39 / 29 / 8 / 5 / 3 / 1). All Node assertions here are strict because the
import was `node:assert/strict`.

| Node assertion (count) | Vitest replacement | Strictness note |
|---|---|---|
| `assert.deepEqual(a, b)` (39) | `expect(a).toEqual(b)` | recursive structural equality |
| `assert.equal(a, b)` (29) | `expect(a).toBe(b)` | strict `===`; **never** `toEqual` — see 3.C-identity |
| `assert.strictEqual(a, b)` (8) | `expect(a).toBe(b)` | `===` |
| `assert.ok(x)` (5) | `expect(x).toBeTruthy()` | truthiness; see 3.C-ok for the stricter option |
| `assert.doesNotThrow(fn)` (3) | `expect(fn).not.toThrow()` | `fn` must be a no-arg function — see 3.E |
| `assert.notEqual(a, b)` (1) | `expect(a).not.toBe(b)` | `!==` (line 274, `makeId` distinctness) |

**3.C-identity — reference-identity `assert.equal` (CRITICAL, R6/INV-C).** These compare
an array to an array by reference (`next === list`) to prove a no-op returns the *same*
reference and made no defensive copy. They MUST become `.toBe()`, never `.toEqual()`:

- **Line 65** — `assert.equal(next, list, 'duplicate-id add returns the input list unchanged')`
  → `expect(next).toBe(list)` (message handled per 3.D)
- **Line 74** — `assert.equal(next, list)` → `expect(next).toBe(list)`
- **Line 79** — `assert.equal(addTodo(list, '', 'z'), list)` → `expect(addTodo(list, '', 'z')).toBe(list)`
- **Line 86** — `assert.equal(next, list, ...)` (inside the bad-id loop) → `expect(next).toBe(list)` (message per 3.D)
- **Line 311** — `assert.equal(next, list, 'whitespace-only edit returns list unchanged')`
  → `expect(next).toBe(list)` (message per 3.D)

`toBe` uses `Object.is`, which is reference identity for objects/arrays — exactly the
semantics of strict `assert.equal` here. `toEqual` would pass on a returned *copy* and
silently lose the check (this is the INV-C failure the verifier probes in Step 8.E).

**3.C-string/value `assert.equal` — also `toBe`.** Lines **241** (`assert.equal(received,
JSON.stringify(list))`) and **248** (`assert.equal(received, '[]')`) compare strings by
value; strict `===` on strings is value equality, so `toBe` is correct and preserves exact
strictness. Map to `expect(received).toBe(JSON.stringify(list))` and `expect(received)
.toBe('[]')`.

**3.C-scalar `assert.equal` — `toBe`.** All remaining `assert.equal` are numeric / `typeof`
string / `Set.size` scalars (e.g. lines 55, 58, 64, 73, 87, 112, 114, 159, 257, 262, 270,
328, 334, 398, 402, 406, 409, 424, 426, 428, 447, 448). Each → `expect(actual).toBe
(expected)`. Examples: `assert.equal(next.length, list.length + 1)` →
`expect(next.length).toBe(list.length + 1)`; `assert.equal(typeof id, 'string')` →
`expect(typeof id).toBe('string')`.

**3.C-ok — `assert.ok` (5).** Default mapping is `expect(x).toBeTruthy()`. Two of these
assert on a `.length` and MAY use the stricter intent-preserving form R6 permits, which is
preferred where it reads naturally:
- `assert.ok(id.length > 0)` (line 258) → `expect(id.length).toBeGreaterThan(0)` (or
  `expect(id.length > 0).toBeTruthy()`)
- `assert.ok(t.id.length > 0)` (line 425) and `assert.ok(t.text.length > 0)` (line 427)
  → `expect(t.id.length).toBeGreaterThan(0)` / `expect(t.text.length).toBeGreaterThan(0)`
- `assert.ok(!next.some((t) => t.text === 'should not appear'))` (line 67) →
  `expect(next.some((t) => t.text === 'should not appear')).toBe(false)` (preferred — it
  preserves the exact "no element has this text" intent) or `expect(!next.some(...))
  .toBeTruthy()`.
- `assert.ok(Array.isArray(result), ...)` (line 189) → `expect(Array.isArray(result))
  .toBe(true)` (preferred) — message handled per 3.D.

Whichever form is chosen, it must NOT weaken the check (no `expect(x).toBeDefined()` for an
`ok`, etc.). Do not reduce the number of `ok`-derived assertions.

### 3.D — Per-iteration / message-bearing assertions (R6a, INV-C)

Vitest matchers take no per-assertion message argument, so the 3rd-arg diagnostics at
lines **64, 65, 86, 112, 113, 176, 188, 189, 270, 311, 470, 471** must be preserved by
moving the diagnostic into a place a failure will surface it. **Pick mechanism (1) for the
data-driven loops and mechanism (2) for the single-shot/standalone messages**, and apply
consistently:

**Mechanism (1) — convert the enclosing data-driven loop to `test.each`** so the failing
iteration is named in the test title. Apply to these loops (this REPLACES that one
`test()` block with a `test.each(...)` block — the block count stays 51 because one
`test()` becomes one `test.each(...)` parameterized block; see the count note at the end of
this step).

> **`test.each` row-wrapping rule (CRITICAL — F20).** `test.each` treats each *top-level
> element* of its array as one case, and if that element is itself an array it is **spread**
> into the callback's positional arguments. A single-argument table therefore MUST wrap each
> value in its own one-element array: `[[''], [42], …]`, not `['', 42, …]`. The bare form
> silently mis-handles any element that is itself an array: a literal `[]` row spreads to
> **zero** arguments and the callback receives `undefined` — the case is not run as written
> and the bug is invisible (the test still "passes"). To pass a literal `[]` (or `{}`, or
> any value) as a single argument, the row is `[[]]` (an outer row-array wrapping the one
> value). This applies to BOTH single-arg loops below, each of which contains a `[]` and/or
> `{}` element. Do NOT use the `.map(v => [v])` shorthand — write the wrapped rows out
> literally so the table is unambiguous and reviewable.

> **Title-token rule (F22).** Vitest 1.x documents only `%s`, `%i`, `%f` (and `%#` for the
> index) for `test.each` title interpolation; `%p` is NOT guaranteed in the 1.x line. Use
> `%s` for primitives. For values that are objects/arrays (where `%s` would render the
> unhelpful `[object Object]` / empty string), do NOT rely on a format token — build the
> title from the row using a function-form title or a per-row label column instead (shown
> per loop below). For the mutator loop, the row carries an explicit `name` string and `%s`
> on that column is exact.

- **Loop at 84–88** (`addTodo` invalid ids; messages at 86). The id battery is
  `['', 42, null, undefined, {}, [], true]` (7 cases). Each row is wrapped in its own array;
  the `[]` case becomes `[[]]` so it is passed as one argument, not spread away:
  ```js
  test.each([[''], [42], [null], [undefined], [{}], [[]], [true]])(
    'addTodo: id=%s is a no-op',
    (badId) => {
      const list = sampleList();
      const next = addTodo(list, 'text', badId);
      expect(next).toBe(list);        // same array reference — no defensive copy on a no-op
      expect(next.length).toBe(3);
    },
  );
  ```
  7 rows = 7 cases, matching the original `for`. `%s` renders the primitive ids; for `{}` and
  `[]` it renders `[object Object]` / empty — acceptable here because the case is still run
  and distinguished by index (`%#`); if a clearer label is wanted, use the function-title
  form `test.each(rows)((row) => \`addTodo: id=${JSON.stringify(row[0])} is a no-op\`, ...)`.
  The title carries the former `id=${JSON.stringify(badId)} must be a no-op` diagnostic.
- **Loop at 110–115** (`sanitizeTodos` non-boolean completed; messages 112, 113). The value
  battery is `[1, 'yes', 0, '', null, undefined, {}, []]` (8 cases). Every row wrapped; the
  `[]` case is `[[]]`:
  ```js
  test.each([[1], ['yes'], [0], [''], [null], [undefined], [{}], [[]]])(
    'sanitizeTodos: completed=%s is coerced to false and KEPT',
    (val) => {
      const out = sanitizeTodos([{ id: 'a', text: 'x', completed: val }]);
      expect(out.length).toBe(1);                 // completed=<val> must be KEPT, not dropped
      expect(out[0].completed).toBe(false);       // coerced to false
      expect(typeof out[0].completed).toBe('boolean');
    },
  );
  ```
  8 rows = 8 cases. `%s` on `{}`/`[]` is non-ideal but the case still runs; use a
  function-title with `JSON.stringify(val)` if a sharper label is desired.
- **Loop at 175–177** (`sanitizeTodos` non-array → []; message 176). Battery
  `[null, undefined, 42, 'x', {}, true]` (6 cases). This battery contains `{}` (spread-safe
  as a single arg only when wrapped) but no `[]`; wrap every row regardless for uniformity:
  ```js
  test.each([[null], [undefined], [42], ['x'], [{}], [true]])(
    'sanitizeTodos: non-array %s -> []',
    (bad) => {
      expect(sanitizeTodos(bad)).toEqual([]);     // <bad> -> []
    },
  );
  ```
  6 rows = 6 cases.
- **Loop at 186–190** (`parseStored` battery; messages 188, 189). Battery
  `['null', 'false', '123', '{}', '[1,2,3]', 'not json{', '[', null, undefined, '', '"a string"']`
  (11 cases) — all strings, `null`, `undefined` (no array element), but wrap every row:
  ```js
  test.each([
    ['null'], ['false'], ['123'], ['{}'], ['[1,2,3]'], ['not json{'],
    ['['], [null], [undefined], [''], ['"a string"'],
  ])(
    'parseStored: raw=%s never throws and returns an array',
    (raw) => {
      let result;
      expect(() => { result = parseStored(raw); }).not.toThrow();   // parseStored(<raw>) threw
      expect(Array.isArray(result)).toBe(true);                     // must return an array
    },
  );
  ```
  11 rows = 11 cases. Preserves both the `doesNotThrow` (188) and the `Array.isArray` (189)
  per input; `%s` names the failing `raw`.
- **Loop at 467–472** (INV3/R11 frozen-input mutators; messages 470, 471). Here the existing
  `mutators` array (lines 456–466) is ALREADY a list of `[name, fn]` rows — each element is a
  2-element array, which is exactly the multi-argument row shape `test.each` expects, so pass
  it directly (do NOT re-wrap; re-wrapping would give `[[name, fn]]` rows that spread to a
  single array argument). The `name` column is a string, so `%s` on it is exact:
  ```js
  const mutators = [
    ['addTodo', (l) => addTodo(l, 'new', 'newid')],
    ['addTodo-dup', (l) => addTodo(l, 'new', 'a')],
    ['toggleTodo', (l) => toggleTodo(l, 'a')],
    ['editTodo', (l) => editTodo(l, 'a', 'changed')],
    ['deleteTodo', (l) => deleteTodo(l, 'a')],
    ['clearCompleted', (l) => clearCompleted(l)],
    ['filterTodos', (l) => filterTodos(l, 'active')],
    ['remainingCount', (l) => remainingCount(l)],
    ['sanitizeTodos', (l) => sanitizeTodos(l)],
  ];
  test.each(mutators)(
    'INV3/R11: %s leaves a deep-frozen input unchanged and does not throw',
    (name, fn) => {
      const list = deepFreeze(sampleList());
      const snapshot = sampleList();
      expect(() => fn(list)).not.toThrow();       // <name> threw on a frozen input
      expect(list).toEqual(snapshot);             // <name> mutated its input
    },
  );
  ```
  9 rows = 9 cases. `%s` prints `name`, carrying both `${name} threw on a frozen input` and
  `${name} mutated its input`. The `mutators` array literal stays exactly as in the source
  (lines 456–466); only the `for` wrapper is replaced by the `test.each` head.

**Mechanism (2) — preserve the diagnostic as an inline comment / descriptive name** where
the message is on a one-off assertion not inside a data-driven battery:

- **Lines 64, 65** are inside the single `test('addTodo: F1 duplicate id is a NO-OP...')`
  block (not a loop). They become `expect(next.length).toBe(list.length)` and
  `expect(next).toBe(list)`. The test name already says "duplicate id is a NO-OP (same
  length, no new element, same ref)", which carries the diagnostic. Add an inline comment
  `// same array reference — no defensive copy on a no-op` above the `toBe(list)` line to
  retain the intent of the dropped message.
- **Line 270** (`assert.equal(ids.size, 1000, 'all 1000 ids must be distinct')`) is the
  only assertion in `test('makeId: many calls ... yield distinct ids')`. Becomes
  `expect(ids.size).toBe(1000)`; the test name already states the intent. Add inline
  comment `// all 1000 ids must be distinct`.
- **Line 311** (`assert.equal(next, list, 'whitespace-only edit returns list unchanged')`)
  is in `test('editTodo: F3/Q3 empty-after-trim text is a no-op...')`. Becomes
  `expect(next).toBe(list)` with inline comment `// same reference — no-op edit returns the
  input list unchanged`.

The loops at lines 84–88 / 110–115 / 175–177 / 186–190 / 467–472 that the `test.each`
conversions replace ALSO satisfy R6's "every iteration retained" requirement: `test.each`
runs one case per array element, matching the original `for` iteration count exactly. Count
the array lengths against the original arrays to confirm no case is dropped (e.g. invalid
ids: 7 cases; completed values: 8; non-array: 6; parseStored battery: 11; mutators: 9).

**Loops NOT requiring `test.each` (no per-iteration message; keep as a plain `for` inside
the one `test()` block):**
- 267–270 (`makeId` 1000-id Set fill) — the loop builds the Set; the single assertion is
  outside it. Keep the `for`; translate line 270 per Mechanism (2).
- 388–391 (`filterTodos` empty list per filter, line 389 `assert.deepEqual(...)`) — no
  message; keep the `for` and translate to `expect(filterTodos([], f)).toEqual([])`.
- 423–429 (INV1 per-element schema checks) — no per-iteration message; keep the `for`,
  translate each assertion per 3.C.
- 493–495 (R1/R10/F8 determinism `for (const call of calls)`) — no message; keep the `for`,
  translate line 494 `assert.deepEqual(call(), call())` → `expect(call()).toEqual(call())`.

**Block-count invariant (R5).** After migration the file has 51 top-level blocks counted as
`test(` + `test.each(`. The five `test.each` conversions replace five former `test(` blocks
one-for-one (one parameterized block each), so the total stays 51. Verify with a grep in
Step 8 that `test(` plus `test.each(` openings total 51 and that there are zero `describe`/
`it`.

### 3.E — `doesNotThrow` specifics (3 occurrences: lines 188, 230, 470)

In `node:test`, `assert.doesNotThrow(fn)` passes iff `fn()` does not throw. The Vitest
equivalent is `expect(fn).not.toThrow()`, where `fn` is passed as a function (NOT called).

- **Line 188** (inside the parseStored battery, handled by `test.each` in 3.D):
  `assert.doesNotThrow(() => { result = parseStored(raw); }, '...')` →
  `expect(() => { result = parseStored(raw); }).not.toThrow()`. The assignment side-effect
  still populates `result` for the following `Array.isArray` check, exactly as before.
- **Line 230** (`safeSave` swallows a throwing writer):
  `assert.doesNotThrow(() => { result = safeSave(() => { throw new Error('quota exceeded'); }, sampleList()); })`
  → `expect(() => { result = safeSave(() => { throw new Error('quota exceeded'); }, sampleList()); }).not.toThrow()`.
  The subsequent `expect(result).toBe(false)` (was line 233 `assert.strictEqual`) is
  unchanged in intent.
- **Line 470** (frozen-input mutator, handled by `test.each` in 3.D):
  `assert.doesNotThrow(() => fn(list), '...')` → `expect(() => fn(list)).not.toThrow()`.

Pass the arrow function to `expect(...)`; do NOT invoke it (`expect(fn())` would call it
before Vitest can capture a throw — a correctness bug). This preserves all 3 no-throw
assertions (INV-C forbids dropping any).

---

## 4. Update CI workflow `.github/workflows/sdlc-arbiter-gate.yml` (R7.2, INV-E)

Edit only the "Run the proving test suite" step (lines 83–91) and add a Bun setup step
before it. Do not touch the scoping/gate steps.

**4.1 Add a `setup-bun` step BEFORE the test step.** Insert after the "Compute MERGE gate
from the ledger" step (after line 81) and before "Run the proving test suite", guarded by
the same `if:` condition the other work steps use:

```yaml
      - name: Install Bun
        if: steps.scope.outputs.is_sdlc == 'true' && steps.scope.outputs.item != ''
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
```

GitHub-hosted runners do not ship Bun, so this step is mandatory and MUST precede any
`bun` invocation (R7.2 falsifier checks ordering). (Optionally pin `bun-version` to a
fixed `1.x` to match Q1's pinned minimum; `latest` is acceptable and simplest.)

**4.2 Replace the install/test commands.** In the "Run the proving test suite" step, change
the `if [ -f package.json ]` block body:

- From:
  ```
  npm install --no-audit --no-fund
  npm test
  ```
- To:
  ```
  bun install --frozen-lockfile
  bun run test
  ```

`--no-audit` / `--no-fund` are npm-only and MUST NOT be carried over (Bun rejects them).
`--frozen-lockfile` enforces INV-E (CI fails if the committed lockfile is stale rather than
silently re-resolving). The runner is `bun run test` (honors the `vitest run` script), never
bare `bun test` (INV-B / R4a). Keep the `else` branch ("no package.json — skipping test
suite") as-is.

---

## 5. Update SessionStart hook `.claude/settings.json` (R7.3, R7a, INV — fail-loud)

Replace the `command` string at line 31. The current value is:
```
[ -f "$CLAUDE_PROJECT_DIR/package.json" ] && cd "$CLAUDE_PROJECT_DIR" && npm install --no-audit --no-fund || true
```

Replace with a contract that satisfies R7a's ordered requirements: (1) act only when
`package.json` exists; (2) check Bun is on PATH; (3) if present, `bun install` (no npm-only
flags) from the project dir; (4) if Bun is ABSENT in a tree that has `package.json`, emit a
clear stderr diagnostic naming Bun as a prerequisite and surface a non-success signal —
never mask it behind `|| true`. The `|| true` may ONLY guard the benign no-`package.json`
case.

Recommended command string (JSON-escaped as a single line in the file):
```
if [ -f "$CLAUDE_PROJECT_DIR/package.json" ]; then if command -v bun >/dev/null 2>&1; then cd "$CLAUDE_PROJECT_DIR" && bun install; else echo "ERROR: bun not found on PATH; install Bun (https://bun.sh) — it is a session prerequisite for this repo." >&2; exit 1; fi; fi
```

This guarantees: no `package.json` → silent benign no-op (exit 0); `package.json` + Bun →
`bun install`; `package.json` + no Bun → loud stderr error + non-zero exit (R7a falsifier:
removing Bun from PATH must NOT exit 0 silently). No `--no-audit`/`--no-fund`. The literal
naive form `... && bun install || true` is FORBIDDEN (it would swallow a missing-Bun
error).

**Note (the task brief's shorter guard).** The brief suggests
`command -v bun && bun install || echo "WARNING: bun not found, skipping install"`. That
variant prints a warning but exits 0 (the `echo` succeeds), which the spec's R7a falsifier
treats as a SILENT no-op failure ("exits 0 with no [non-success] signal"). Prefer the
`exit 1` form above so a missing Bun is a hard, visible failure per R7a. If the arbiter
later rules the warning-only form acceptable, switch the trailing branch to the `echo`
warning — but default to fail-loud.

**Prerequisite documentation (Q4 / R7a).** Because we do NOT assume Bun is guaranteed on
PATH (Q4 proposed default), record "Bun 1.x is a session prerequisite" in README (Step 6)
and `SDLC/cloud-setup.md` (Step 6), so the loud-failure posture is backed by a documented
requirement.

---

## 6. Update operative prose references (R7.4–R7.7, R7b)

Apply only to forward-looking/executed references in these files. Do NOT touch historical
docs (`docs/specs/TODO-1*.md`) or ledger entries (N5).

**6.1 `.claude/launch.json` (R7.4).** Change the run config to launch via Bun:
- `"runtimeExecutable": "npm"` → `"runtimeExecutable": "bun"`
- `"runtimeArgs": ["run", "dev"]` stays `["run", "dev"]` so it runs `bun run dev`.

**6.2 `README.md` (R7.5, R7b).**
- "Run it" block (lines 9–15): `npm install` → `bun install`; `npm run dev` →
  `bun run dev`; `npm run build` → `bun run build`; `npm run preview` →
  `bun run preview`; `npm test          # node:test suite (51 tests)` →
  `bun run test     # Vitest suite (51 test() blocks)`. Keep the trailing comments
  accurate; the count is **51 `test()` blocks** (R7b — not "assertions").
- Line 17 "Requires Node 20+." → "Requires Bun 1.x." (Q1 pin). Optionally:
  "Requires Bun 1.x (the package manager, task runner, and — via Vitest — test runner)."
- Architecture table row for `tests/todos.test.js` (line 29): change "`node:test` suite
  exercising the pure core." → "Vitest suite exercising the pure core."

**6.3 `SDLC/cloud-setup.md` (R7.7).** The "Build bootstrap" table row (line 19) describes
the SessionStart hook as "`npm install` at session start" → "`bun install` at session start
(Bun is a session prerequisite)." This keeps the doc consistent with R7.3/R7a.

**6.4 `SDLC/REUSE.md` (R7.7).** §3 item 2 (lines 39–41) describes the SessionStart hook
running `npm install`. Update the example to reflect Bun: change "the `SessionStart` hook
runs `npm install`" → "the `SessionStart` hook runs `bun install`". The surrounding
guidance ("Swap it for the target's setup ... if its tests need one") stays — it is generic
reuse advice, not a TODO-app-specific command. Do not over-edit; only the concrete
`npm install` mention is operative.

**6.5 `.github/pull_request_template.md` (R7.6).** Line 47 reviewer-checklist item: change
"`npm test` is green." → "`bun run test` is green."

**Scope guard.** Do NOT edit `docs/specs/TODO-1.md`, `docs/specs/TODO-1-plan.md`, any
`SDLC/ledger/*`, or `package-lock.json` contents (it is deleted in Step 1.4, not edited) —
these are historical/derived per N5 and the R7 "NOT in scope" list.

---

## 7. Update `.gitignore` (R8, INV-A)

The Bun lockfile MUST be tracked (committed) — it must NOT be ignored. `node_modules/` and
`dist/` must remain ignored (they already are, lines 17–18).

- Confirm no rule ignores `bun.lock` / `bun.lockb`. (None currently does.)
- Add, under the "node / vite build artifacts" section, an entry to ignore the Bun cache if
  one ever materializes in-tree:
  ```
  .bun/
  ```
  This is defensive (R8 allows "no new ignore entry is needed" as acceptable); add `.bun/`
  to be safe since R8 calls it out. Do NOT add `bun.lock`/`bun.lockb` to `.gitignore` —
  that would un-track the lockfile and violate R3/INV-E.

After editing, `git status` must show the Bun lockfile as tracked/staged and
`package-lock.json` as deleted.

---

## 8. Verification (the builder runs these; mirrors what the verifier will prove)

Run after the corresponding steps; all must pass before the plan is "built."

**8.A — Install (R1, INV-E).**
```
bun install --frozen-lockfile
```
Exit 0. (Plain `bun install` also exits 0; `--frozen-lockfile` additionally proves the
committed lockfile is in sync — the CI contract.)

**8.B — Test suite runs under Vitest, green, non-watch (R4a, R5, R6, INV-B).**
```
bun run test
```
Must exit 0, print Vitest's reporter output (confirming the runner is Vitest, not
`node --test` and not `bun test`), report all tests passing, and TERMINATE (no watch
prompt). Confirm the passing count covers all 51 blocks (the five `test.each` blocks expand
to multiple named cases — total reported tests will be > 51, which is expected; the BLOCK
count is 51).

**8.C — Block/import structure (R5).**
- `grep -cE "^test\(|^test\.each" tests/todos.test.js` → 51.
- `grep -n "node:test\|node:assert" tests/todos.test.js` → no matches.
- `grep -n "describe\|\\bit(" tests/todos.test.js` → no matches.
- `grep -n "from 'vitest'" tests/todos.test.js` → exactly one import of `{ test, expect }`.

**8.D — No stray npm in operative files (R7 falsifier).**
```
grep -rn "npm " .github/workflows/sdlc-arbiter-gate.yml .claude/settings.json \
  .claude/launch.json README.md SDLC/cloud-setup.md SDLC/REUSE.md \
  .github/pull_request_template.md package.json
```
Must return no operative `npm` command. Also confirm `--no-audit` / `--no-fund` appear
nowhere on a `bun install` line. Confirm `node --test` no longer appears in README or the
test file header.

**8.E — Strictness / coverage probe (R6, INV-C) — the key adversary defense.** Prove the
reference-identity checks survived as `toBe`:
1. Temporarily edit a COPY of `src/todos.js` in the scratchpad (NOT the tracked file —
   touching tracked `src/` trips the build gate and is out of scope) so a no-op returns a
   *copy* instead of the same reference (e.g. `addTodo` on a duplicate id returns
   `[...list]`). Point a throwaway test run at it, OR reason through it statically: the
   migrated lines 65/74/79/86/311 use `.toBe(list)`, which fails on a copy. If any of those
   were written as `.toEqual(list)`, this probe passes against the broken core — a
   migration bug to fix. Do NOT commit the broken core.
2. Confirm all 3 `not.toThrow()` and the 1 `not.toBe()` are present
   (`grep -c "not.toThrow" tests/todos.test.js` → 3; `grep -c "not.toBe" tests/todos.test.js`
   → at least 1).

**8.F — Lockfile / dual-lockfile (R3, INV-A).**
- `ls bun.lock*` → exactly one Bun lockfile.
- `test ! -e package-lock.json && echo "deleted"` → "deleted".
- `git status` shows `package-lock.json` deleted and the Bun lockfile tracked.

**8.G — App build unaffected (INV-D, R4).**
```
bun run build
```
Produces `dist/`; exit 0. (`bun run dev` / `bun run preview` start and bind without an
immediate crash if spot-checked, but `build` is the non-interactive proof for CI.)

---

## 9. Failure-mode → design-handling map

| Spec invariant / failure mode | How this plan handles it |
|---|---|
| INV-A no dual lockfiles | Step 1.4 `git rm package-lock.json`; Step 7 keeps lockfile tracked, not ignored; 8.F asserts exactly one Bun lockfile and `package-lock.json` gone. |
| INV-B `bun run test` deterministic/CI-safe | Step 2 pins `vitest run` (non-watch, exits with status); 8.B proves termination + exit code; CI uses `bun run test` (4.2). |
| INV-C no silent coverage loss | Step 3.C-identity forces `.toBe` on lines 65/74/79/86/311; 3.D preserves all per-iteration diagnostics via `test.each`/comments; 3.E keeps all 3 no-throw; 8.E probes a broken core. |
| INV-D app behavior unchanged | No `src/` edit anywhere; only `package.json` `test` script + tests + CI/hook/docs touched; 8.G proves `bun run build`. |
| INV-E reproducible toolchain | Step 1.5 commits an authoritative lockfile; CI `--frozen-lockfile` (4.2) fails on drift; 8.A proves frozen install. |
| R4a runner identity | `"test": "vitest run"` exactly (Step 2); 8.B confirms Vitest reporter, never `bun test`. |
| R6a diagnostics | Step 3.D mechanism (1)/(2) for every enumerated message line; 8.E spot-checks. |
| R7a fail-loud hook | Step 5 `command -v bun` + `exit 1` on absence; never `|| true` over a missing PM. |
| R7b counts | Step 3.A + 6.2 say "51 `test()` blocks", never "assertions"; header no longer says `node --test`. |

---

## 10. What the verifier must prove (test strategy)

1. `bun install --frozen-lockfile` exits 0 on a clean tree; no `package-lock.json`; exactly
   one Bun lockfile, tracked (R1, R3, INV-A, INV-E).
2. `bun run test` runs **Vitest** (not `node --test`, not `bun test`), goes green, exits
   non-zero on a deliberately-failing test, and never enters watch mode (R4a, R5, INV-B).
3. A deliberately-broken `src/todos.js` (a no-op that returns a copy; a `completed`
   truthiness shortcut; a throwing `parseStored`) makes the MIGRATED suite RED — proving the
   reference-identity `toBe` checks, the coercion checks, and the no-throw checks survived
   translation (R6, INV-C). The same defects the original header documents.
4. Each enumerated message-bearing iteration (64, 65, 86, 112, 113, 176, 188, 189, 270,
   311, 470, 471), when failed against a broken core, names the failing case in the Vitest
   output (R6a).
5. The CI workflow has a `setup-bun` step BEFORE the install step, installs with
   `bun install --frozen-lockfile` (no npm-only flags), and runs `bun run test` (R7.2).
6. The SessionStart hook, with Bun removed from PATH in a tree that has `package.json`,
   fails visibly (non-zero, stderr diagnostic) — not a silent `|| true` no-op (R7a).
7. `grep` for operative `npm`/`node --test`/`--no-audit`/`--no-fund` across the R7 file set
   returns nothing; README/launch/PR-template/cloud-setup/REUSE all reference Bun; counts
   say "51 `test()` blocks" (R7, R7b).
8. `bun run build` produces `dist/`; no `src/` file changed (INV-D).
