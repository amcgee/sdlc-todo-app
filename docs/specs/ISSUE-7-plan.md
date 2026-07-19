# ISSUE-7 — PLAN — Adopt a standard design system (Tailwind CSS + shadcn/ui)

Status: PLAN (draft for the plan gate)
Owner: architect
Work item: ISSUE-7
Spec: [docs/specs/ISSUE-7.md](./ISSUE-7.md) (ratified) — this plan implements it verbatim; where they
conflict, the spec wins and this plan is the bug.

---

## 0. Grounding re-verified before planning

Re-read against the live tree, not assumed:

- `src/App.jsx` (190 lines) is the entire UI; classes used: `.app`, `.add-form`, `.todo-list`,
  `.todo-item`, `.text` / `.text.completed`, `.footer`, `.count` (line 159, **no CSS rule today**),
  `.filters`, and the attribute selector `.filters button[aria-pressed='true']` (line 81 of
  `index.css`).
- `src/index.css` (89 lines) is the only stylesheet; imported once by `src/main.jsx` line 4.
- `vite.config.js` has only `@vitejs/plugin-react` — **no alias, no PostCSS block, no test block**.
- `package.json`: React `^18.3.1`, Vite `^5.4.0`, Vitest `^1.6`; scripts `dev/build/preview/test`.
  **No `vitest.config`/`vitest.workspace`, no `jsconfig.json`, no `tsconfig.json`, no
  `postcss.config`, no `tailwind.config`, no `components.json`.** Confirmed by `ls` — all absent.
- `bun run test` today prints **`Tests 87 passed (87)`**, one file `tests/todos.test.js`, default
  **node** environment (Vitest reports `environment 0ms`). Re-run and confirmed live before writing.
- `postcss@8.5.16` is present in `bun.lock` transitively (via Vite/`@vitejs/plugin-react`), with **no
  configured pipeline**.
- `@vitejs/plugin-react` resolves to `4.7.0`; `react`/`react-dom` resolve to the `^18.3.1` line.

---

## 1. Decisions locked (resolving the spec's open questions)

| # | Decision | Why | Spec hook |
|---|----------|-----|-----------|
| **Q2 -> Tailwind v3** | Pin **`tailwindcss@3.4.19`** (latest v3) + **`postcss`** + **`autoprefixer`** with a classic `tailwind.config.js` + `postcss.config.js`. | v3 is the version shadcn/ui's Vite guide primarily targets; v4 reworks config + the PostCSS plugin model (`@tailwindcss/vite`/`@tailwindcss/postcss`) and shadcn's v4 wiring differs — v3 is the lower-churn, best-documented pairing with Vite `^5` (Risk-1). | R1, R2, Risk-1 |
| **PostCSS plumbing** | Use the **PostCSS-plugin** path (`postcss.config.js` with `tailwindcss` + `autoprefixer`), **not** a Tailwind Vite plugin. | Standard v3 approach; Vite auto-detects `postcss.config.js` with zero `vite.config.js` change for CSS. `autoprefixer` **must** be present (R2 requires it for v3). | R2 |
| **Alias** | Add **`@` -> `/src`** in **both** `vite.config.js` (`resolve.alias`) **and** a new **`jsconfig.json`** (`compilerOptions.paths`). Not relative paths. | shadcn's generated `cn` import (`@/lib/utils`) and component imports (`@/components/ui/*`) assume it; doing both keeps build + editor coherent (R8, Risk-3). | R3, R8 |
| **Q5 -> Radix checkbox** | shadcn/ui **checkbox** (wraps `@radix-ui/react-checkbox`). | Ratified R10. | R4, R10 |
| **Q4 -> render harness** | **happy-dom** + `@testing-library/react` + `@testing-library/jest-dom`, run via a **per-file `// @vitest-environment happy-dom` pragma** on the new a11y test only. | Vitest 1.6 ships no DOM env; the pragma keeps the existing node run of `todos.test.js` byte-identical (R7) with **no** `vitest.config`/workspace file required. **happy-dom over jsdom**: single self-contained package, no jsdom-version-vs-Vitest coupling ambiguity, lighter (Risk-2). | R11, R7 |
| **Q3 -> `.dark` block** | **Keep** shadcn's generated `.dark` variable block inert (no toggle, no `darkMode` class wiring exercised). | Stay on the stock template (N2); no dark-mode claim. | R5, N2 |
| **Theme base (R5)** | shadcn **Slate** neutral, `--radius: 0.5rem`, system font stack retained. | One stock neutral, no custom palette; see section 4. | R5, A1 |

**Weakest point (named up front):** two, honestly stated.
(1) *Contrast margins.* `--muted-foreground` `#64748b` = **4.76:1** on white — it clears AA 4.5:1 but
only by 0.26, and `destructive-foreground`/`destructive` clears only at the retuned `#ffffff`/`#dc2626`
= **4.83:1** (stock `#f8fafc`/`#ef4444` = 3.60, **fails**). The harness now reads the **shipped** `:root`
custom properties (not §4's copied hex) and asserts all four AA pairs, so drift on either fails a test.
(2) *A2 focus-ring visibility.* happy-dom does no paint, so the harness can only prove the
`focus-visible:ring-*` **class is present**, not that a >=3:1 ring actually renders — A2's true bar is
closed by a **required manual keyboard pass** (§9 item 5), documented as such rather than overclaimed.
See sections 4, 8, and 9.

---

## 2. Exact dependency list (Bun)

`class-variance-authority`, `clsx`, `tailwind-merge`, `@radix-ui/react-checkbox`, and
`@radix-ui/react-slot` are imported by shipped `src/` code (the `cn` helper, the checkbox primitive,
and the stock button's `Slot`/`asChild` support), so they are **dependencies**. Tailwind,
PostCSS, the test harness, and types are **devDependencies**.

### `bun add` (runtime — imported by shipped src/)
```
bun add class-variance-authority@0.7.1 clsx@2.1.1 tailwind-merge@3.6.0 @radix-ui/react-checkbox@1.3.6 @radix-ui/react-slot@1.2.4
```

### `bun add -d` (build + test tooling only)
```
bun add -d tailwindcss@3.4.19 postcss@8.5.16 autoprefixer@10.5.2 tailwindcss-animate@1.0.7 \
           happy-dom@15.11.7 @testing-library/react@16.3.2 @testing-library/dom@10.4.1 \
           @testing-library/jest-dom@6.9.1 @types/react@18.3.31 @types/react-dom@18.3.7
```

Notes / rationale per package (adversary-facing):
- **`tailwindcss-animate`** — shadcn's default `tailwind.config.js` lists it in `plugins`. It is part
  of the stock template (not a new feature); dropping it means hand-editing the generated config
  (invites an R5/"deviated from stock" finding). It ships no runtime JS into the app unless an
  `animate-*` class is used (we use none of consequence; A7/N3 keep motion minimal). Kept as a
  **devDependency** because it is a Tailwind build plugin, not app code.
- **`@testing-library/dom@10.4.1`** — `@testing-library/react@16` declares it a **peer**, not a
  bundled dep. Pinning it explicitly avoids an unmet-peer warning / non-deterministic hoist (R2/INV-4:
  "no peer-dep conflict", clean resolve).
- **`@types/react` / `@types/react-dom`** — `@testing-library/react@16` lists them as peers. The app
  is JS (N5), but the peer is declared regardless; adding them silences the peer warning and costs
  nothing at runtime. If `bun install` proves it does not warn without them, they may be dropped — but
  the default is to include them for a clean resolve.
- **`postcss@8.5.16`** — already the resolved transitive version; naming it as a direct devDep makes
  the pipeline explicit (R1) and matches the lockfile, avoiding a version bump.
- **`autoprefixer@10.5.2`** — **required present for v3** (R2). Would be forbidden for v4; we are v4-free.
- **`@radix-ui/react-slot`** — shadcn's **stock `button.jsx` imports `{ Slot } from "@radix-ui/react-slot"`**
  for its `asChild` prop (verified against the current stock template). The plan ships the stock button
  (section 5), so this dep is required on **both** paths: the CLI (`bunx shadcn add button`) auto-installs
  it, and the hand-create path (§5 fallback) must add it or `import { Slot }` is unresolvable and
  `bun run build` breaks (R3/INV-4). App.jsx uses no `asChild` today, but keeping the stock button verbatim
  (rather than hand-stripping `Slot`) avoids an R5/"deviated from stock" finding — so we keep `Slot` and
  pin its dep. **Correction of an earlier draft claim:** it is NOT true that button needs no Radix dep.
- **No `@radix-ui/react-*`** beyond `react-checkbox` and `react-slot` — `input` is plain shadcn (no Radix dep).
- **No `lucide-react`** — shadcn's `init` may suggest an icon lib, but we add **no icons** (Edit/Delete
  stay text buttons, A5). Omitting it keeps R4's closed list and Risk-2 weight down. If the builder
  finds a scaffolded component imports it, replace that import — do **not** add the dep.

**Exact-pin policy:** `bun add` writes carets by default; the builder MUST edit `package.json` to
**exact pins** (strip the `^`) for `tailwindcss`, `autoprefixer`, `postcss`, `@radix-ui/react-checkbox`,
`@radix-ui/react-slot`, `happy-dom`, and the `@testing-library/*` set, then re-run `bun install` so `bun.lock` matches. This
satisfies R2/INV-4 "no dual/loose pinning" and makes the resolve reproducible.

---

## 3. Build / config changes (files to create or touch)

### 3.1 `vite.config.js` (edit)
Add a `resolve.alias` mapping `@` -> the absolute `/src` dir. Shape:
- import `path` (or `fileURLToPath`/`URL` for ESM) and set `resolve: { alias: { '@': <abs src> } }`.
- **No** PostCSS block here — Vite auto-loads `postcss.config.js`.
- **No** Tailwind Vite plugin (that is the v4 path we rejected).
- Leave `plugins: [react()]` intact.

### 3.2 `postcss.config.js` (new)
Standard v3 export: `plugins: { tailwindcss: {}, autoprefixer: {} }`. Presence of this file is what
processes `@tailwind` directives at build time (R1/R2 falsifier: build fails to process directives).

### 3.3 `tailwind.config.js` (new)
shadcn v3 stock config:
- `darkMode: ['class']` (inert; Q3 — no toggle wired).
- **`content: ['./index.html', './src/**/*.{js,jsx}']`** — MUST include `src/**/*.{js,jsx}` or classes
  are purged (R1 falsifier). No `.ts/.tsx` needed (N5), but harmless to include.
- `theme.extend` with the shadcn CSS-variable color mappings (`background`, `foreground`, `primary`,
  `muted`, `border`, `ring`, `destructive`, ... each `hsl(var(--...))`), `borderRadius` keyed off
  `var(--radius)`, and `container` defaults from the template.
- `plugins: [require('tailwindcss-animate')]`.
- **No custom color literals, no custom fontFamily, no extra radius knobs** (R5 caps).

### 3.4 `jsconfig.json` (new)
`compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } }`. Mirrors the Vite alias so editor
tooling resolves `@/...` (R8). No `tsconfig.json` (N5).

### 3.5 `components.json` (new)
shadcn config for a **JS**, non-TS, Vite project:
- `"tsx": false`, `"rsc": false`, style `"default"`, `tailwind.config` -> `tailwind.config.js`,
  `tailwind.css` -> `src/index.css` (our Tailwind entry — see section 6), `baseColor: "slate"`,
  `cssVariables: true`.
- `aliases`: `{ "components": "@/components", "utils": "@/lib/utils", "ui": "@/components/ui" }`.
This file is what R3 checks for presence; the aliases here MUST match 3.1/3.4.

### 3.6 Vitest DOM environment (R11) — **no config file by default**
The new a11y test file (section 8) carries a **top-of-file pragma**:
```
// @vitest-environment happy-dom
```
Vitest 1.6 honors this per-file, running *only that file* in happy-dom while `tests/todos.test.js`
stays in the default **node** env, untouched. This is the mechanism that keeps R7's `87 passed` exact.
- **Alternative considered & rejected as default:** a `vitest.workspace.js` with two projects
  (node-env `tests/**` + happy-dom-env `src/**/*.a11y.test.jsx`). Rejected because it is a larger,
  more attackable change to the test runner for a single a11y file, and any misconfiguration risks the
  node run (R7). It remains the documented fallback **iff** the pragma proves insufficient (e.g. a
  global test setup for `jest-dom` matchers is wanted repo-wide) — in which case the workspace MUST
  scope the node project to exclude `src/**` so `todos.test.js` still runs in node with the same 87.
- `@testing-library/jest-dom` matchers are pulled in via an `import '@testing-library/jest-dom'` at the
  top of the a11y test file (not a global setup), keeping the change contained to one file.

### 3.7 `package.json` (edit)
- Add the deps of section 2 (with exact pins).
- **Do not change** the `test` script (`vitest run`) — it must keep discovering both files and print
  `87` for the pure core plus the new a11y cases (counted in a separate file; section 8 explains the
  count bookkeeping). R7 falsifier is specifically about the *pure-core* 87, which the pragma preserves.

---

## 4. Theme tokens (concrete values the builder ships)

**Base:** shadcn **Slate**, `cssVariables: true`, light theme authored in `:root`, the generated
`.dark` block left inert (Q3). Values below are shadcn Slate's stock HSL tokens — the builder pastes
the stock block; the load-bearing ones this plan pins for the a11y contrast check (A1) are below.
Two token pairs are **adjusted off stock so they clear the AA/AA-boundary bar** (still within R5 — they
are shadcn's *standard* semantic tokens, only revalued, not new custom tokens): `--destructive` /
`--destructive-foreground` (stock `#ef4444`/`#f8fafc` = 3.60:1, **fails** AA 4.5:1) is retuned to
red-600 on white = **4.83:1** (F33); and the general `--border` is documented as a **decorative**
boundary, **not** a 1.4.11 "sole means of identifying a control," so it is **not** held to 3:1 (F31).

| Token | HSL (`:root`) | Approx hex | Used for | Contrast vs pair |
|-------|---------------|-----------|----------|------------------|
| `--background` | `0 0% 100%` | `#ffffff` | page/card bg | — |
| `--foreground` | `222.2 84% 4.9%` | `#020817` | body text | ~19:1 on bg (pass) |
| `--primary` | `222.2 47.4% 11.2%` | `#0f172a` | Add button bg | fg-on-primary below |
| `--primary-foreground` | `210 40% 98%` | `#f8fafc` | Add button text | ~17:1 on primary (pass) |
| `--muted-foreground` | `215.4 16.3% 46.9%` | `#64748b` | **completed text**, count, filters | **~4.6:1 on white (pass; was `#999`~=2.85 FAIL)** |
| `--border` | `214.3 31.8% 91.4%` | `#e2e8f0` | row/input borders | **1.23:1 on white — decorative only, NOT a 1.4.11 boundary; not held to 3:1 (F31)** |
| `--ring` | `222.2 84% 4.9%` | `#020817` | focus ring | >=3:1 vs adjacent (A2) |
| `--destructive` | `0 72.2% 50.6%` | `#dc2626` | Delete bg *iff* `variant="destructive"` used | pairs with destructive-fg below (F33) |
| `--destructive-foreground` | `0 0% 100%` | `#ffffff` | Delete text on destructive | **4.83:1 on `#dc2626` (pass AA 4.5; retuned off stock `#f8fafc`/`#ef4444`=3.60 FAIL) (F33)** |
| `--radius` | `0.5rem` | — | single geometry knob (R5) | — |

- **Typography:** system font stack retained. Tailwind v3's Preflight sets a system-ui-based
  `font-family` on `html`; we do **not** add a `fontFamily` override and load **no** webfont (R5, N3).
  The old `:root { font-family: system-ui, -apple-system, sans-serif }` intent survives via Preflight.
- **Radius:** the single `--radius: 0.5rem`; all rounding uses `rounded-md`/`rounded-lg` mapped to it
  (R5 — no second geometry knob).
- **INV-3 guard:** the muted token (`#64748b`) is the pre-existing `#999` failure's replacement and is
  the value the A1 assertion pins. If shadcn's chosen style ships a lighter muted, the builder MUST use
  the Slate `215.4 16.3% 46.9%` value above (still stock — it is Slate's, not custom) so A1 passes.

---

## 5. shadcn/ui primitives to scaffold (R4 closed list)

Add **exactly** three, via `bunx shadcn@latest add button input checkbox` (or hand-create matching the
stock source if the CLI misbehaves under Bun). Locations (per 3.5 aliases):

| Primitive | File | Notes |
|-----------|------|-------|
| button | `src/components/ui/button.jsx` | cva variants (`default`, `outline`, `ghost`, `destructive`, `secondary`) + sizes. Stock template **imports `{ Slot } from "@radix-ui/react-slot"`** (asChild) — dep pinned in §2 (F36). Used for Add / Edit / Delete / filters / Clear-completed. |
| input | `src/components/ui/input.jsx` | Used for the add-input and the inline-edit input. |
| checkbox | `src/components/ui/checkbox.jsx` | Wraps `@radix-ui/react-checkbox`; renders `<button role="checkbox" aria-checked>`. Used for the completed-toggle (R10). |

Plus the shadcn util **`src/lib/utils.js`** exporting `cn` (`clsx` + `twMerge`). This is the only
non-`ui` addition and is required by every primitive (R3). **No** `label` or visually-hidden helper is
added: every control already has an `aria-label`, and no icon-only control is introduced (A5), so R4's
"justify any extra" clause is satisfied by adding **nothing** extra.

**R4 falsifier guard:** after scaffolding, `src/components/ui/` MUST contain only
`{button,input,checkbox}.jsx`. If the CLI adds extras, delete anything not on the list.

---

## 6. CSS migration (`src/index.css` -> Tailwind entry)

`src/index.css` is **rewritten** (stays the single imported stylesheet; `main.jsx` import unchanged so
no `src/main.jsx` edit — keeping the diff minimal, though touching main.jsx is permitted by INV-1 if
needed). New contents, in order:

1. `@tailwind base;` `@tailwind components;` `@tailwind utilities;`
2. `@layer base { :root { <the Slate token block from section 4> } .dark { <inert stock block> } }`
3. `@layer base { * { @apply border-border; } body { @apply bg-background text-foreground; } }`
   (shadcn's stock base — replaces the old `body { background:#f5f5f5 }` and `:root` color).

**Removed** (R6 — must leave no dead bespoke CSS): every rule from today's file — `.app`, `h1`
(bespoke sizing moves to utilities), `.add-form` + `.add-form input`, `.todo-list`, `.todo-item` +
its `.text`/`.text.completed`/`input[type=text]` descendants, `.footer`, `.filters`, the
`.filters button[aria-pressed='true']` selector (its **visual** effect is recreated in JSX per
section 7/A5), and `button { cursor: pointer }` (shadcn button handles cursor). The old `#f5f5f5` page
bg and `#222` text are replaced by `bg-background`/`text-foreground`.

**`.count` (App.jsx:159):** had no rule today; after migration the element is styled with Tailwind
utilities inline in JSX and the `count` class is **removed** from the JSX (R6 falsifier: no stray
`count`/bespoke class references remain).

**R6 audit step:** after migration, grep `src/index.css` for any of the old selectors -> must be zero;
grep `src/App.jsx` for `className="app"|"add-form"|"todo-list"|"todo-item"|"text"|"footer"|"filters"|"count"`
-> must be zero.

---

## 7. `src/App.jsx` migration — ordered, element by element

Behavior is frozen (INV-1): all handlers (`handleAdd`, `handleToggle`, `commitEdit`, `cancelEdit`,
`handleDelete`, `handleClearCompleted`, `setFilter`) and all state stay **exactly** as-is. Only markup
+ classes + the checkbox element change. Imports added: `cn` (if used), `Button`, `Input`, `Checkbox`
from the `@/components/ui/*` paths.

| Region | Today | After |
|--------|-------|-------|
| Wrapper `div.app` | bespoke card | `div` with utilities: `max-w-[480px] mx-auto my-8 p-4 bg-card rounded-lg shadow-sm` (card look preserved). |
| `<h1>TODO` | `.h1` centered | keep `<h1>` (A4), `className="text-2xl font-semibold text-center mb-4"`. |
| `form.add-form` | flex row | keep `<form onSubmit={handleAdd}>` (A4), `className="flex gap-2 mb-4"`. |
| add `<input>` | native | shadcn **`<Input>`** — keep `value/onChange/placeholder/aria-label="New todo"` unchanged; `className="flex-1"`. |
| Add `<button>` | native submit | shadcn **`<Button type="submit">Add</Button>`** (keeps submit semantics). |
| `ul.todo-list` | list | keep `<ul>` (A4), `className="list-none p-0 m-0"`. |
| `li.todo-item` | flex row | keep `<li>` (A4), `className="flex items-center gap-2 py-2 border-b border-border"`. |
| **checkbox** | `<input type=checkbox checked onChange aria-label>` | shadcn **`<Checkbox>`** (Radix). **Mapping (R10/Risk-5):** `checked={todo.completed}` -> Radix `checked`; `onChange={() => handleToggle(id)}` -> **`onCheckedChange={() => handleToggle(todo.id)}`** (ignore the boolean arg — `toggleTodo` flips, so we call the same handler); keep `aria-label="Toggle complete"`. Space-to-toggle (A3) and `role="checkbox"`/`aria-checked` (A4) come from Radix for free. **Do not** pass `onChange`. |
| edit `<input>` (edit mode) | native text | shadcn **`<Input type="text">`** — keep `value/onChange/onBlur={() => commitEdit(id)}/onKeyDown` (Enter->commit, Escape->cancel)/`aria-label="Edit todo"`/`autoFocus` **byte-for-byte** (A3 — the three edit paths MUST survive). `className="flex-1"`. |
| text `<span>` | `.text`/`.text.completed`, `onDoubleClick` | keep `<span onDoubleClick={() => startEdit(todo)}>{todo.text}</span>` (R9: still `{todo.text}` text node, no attr sink). Class via `cn`: base `flex-1`; when completed add `line-through text-muted-foreground` (A6 strikethrough + AA muted, A1). |
| Edit `<button>` | native | shadcn **`<Button variant="ghost" size="sm">Edit</Button>`**, keep `onClick={() => startEdit(todo)}` (A3 keyboard edit entry preserved). |
| Delete `<button>` | native | shadcn **`<Button variant="ghost" size="sm">Delete</Button>`** (default; neutral). `variant="destructive"` is permitted **only** with the retuned §4 tokens (`--destructive` `#dc2626`, `--destructive-foreground` `#ffffff` = **4.83:1**); the stock `#ef4444`/`#f8fafc` pair (3.60:1) is **forbidden** (F33). Text label kept (A5 — no icon-only). |
| `div.footer` | flex space-between | `className="flex items-center justify-between mt-4 text-sm"`. |
| `span.count` | unstyled | `className="text-muted-foreground"` (styled per R6; AA muted per A1). Text `{remaining} items left` unchanged. |
| `div.filters` | flex | `className="flex gap-1"`. |
| filter buttons x3 | native + `aria-pressed` + bold/underline via CSS | shadcn **`<Button>`**, keep `aria-pressed={filter===...}` and `onClick` (A5 programmatic state). **Recreate the visual active cue (A5/F24):** variant chosen by pressed state, e.g. `variant={filter===x ? 'default' : 'ghost'}` (a filled vs. ghost button is a non-color-alone cue — fill/weight differ), meeting A1 contrast and A6's not-color-alone rule. |
| Clear `<button>` | native | shadcn **`<Button variant="outline" size="sm">Clear completed</Button>`**, `onClick={handleClearCompleted}`. |

**R9 audit:** no `dangerouslySetInnerHTML`; `todo.text`/`todo.id` never enter `className`, `style`,
`href`, or `src` — `id` is only used as React `key` and in handler closures (unchanged from today).

---

## 8. Render-test harness (R11) test plan

**New file:** `tests/App.a11y.test.jsx` (in `tests/`, alongside — but separate from —
`todos.test.js`; NOT under `src/`, so the build-gate `src/` guard is not tripped for tests, and
`todos.test.js` is untouched). Top of file:
```
// @vitest-environment happy-dom
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';

afterEach(cleanup);   // REQUIRED — see below (F32)
```
**Test isolation (F32) — mandatory.** The repo runs `vitest run` with **no config** and Vitest's
default **`globals: false`**, so `@testing-library/react`'s auto-cleanup (which only registers when a
global `afterEach` exists) does **not** fire. Without the explicit `afterEach(cleanup)` above, each
`render(<App/>)` accumulates in the shared happy-dom document and single-element queries like
`getByRole('heading', {level:1})` throw "found multiple elements", failing A4/A5. The plan therefore
pins an **explicit `afterEach(cleanup)` imported in this file** (no `vitest.config`/`globals:true`
needed — keeping R7's node run of `todos.test.js` untouched, and avoiding the config churn the §3.6
workspace alternative would add). Each assertion row below runs after a fresh render.

It renders `<App />` with `@testing-library/react` and asserts (each mapped to a spec falsifier):

| Assert | Covers |
|--------|--------|
| exactly one `getByRole('heading', {level:1})` with name `TODO`; list is `<ul>`>`<li>`; add control is a `<form>` (submit adds a todo) | A4 |
| toggle control has `role="checkbox"` + `aria-checked`; clicking / `keyboard(' ')` on it flips `aria-checked` and the completed styling; `aria-label="Toggle complete"` present | A3, A4, A5, A6, R10 |
| `getByLabelText('New todo')`, and in edit mode `getByLabelText('Edit todo')` exist; Add/Edit/Delete/filters/Clear are `getByRole('button')` with accessible names | A5, A4 |
| enter edit (click Edit), type, **Enter commits**; re-enter, **Escape cancels**; re-enter, **blur commits** (all three edit paths) | A3 |
| filter buttons expose `aria-pressed`; the active one is visually distinguished by a **non-color** class difference (assert the pressed button carries the active-variant class the JSX applies), not merely a color | A5 |
| completed row has `line-through` (class present) in addition to the checked box | A6 |
| focusable: each interactive element can receive focus (`.focus()` -> `toHaveFocus()`); each primitive carries a `focus-visible:ring-*` utility in its className and **no** element sets bare `outline:none` without a ring utility. **Limitation (F35):** happy-dom does no layout/paint and does not resolve `:focus-visible` or Tailwind utilities to computed styles, so this proves the ring **class/attribute is present**, NOT that a ring renders at >=3:1. Actual focus-ring *visibility/contrast* (A2's real bar) is confirmed by the **manual keyboard pass** (§9 item 5), which the plan lists as required, not optional, for A2. | A2 (class-presence machine-checked; visible contrast manual) |
| **token-contrast assertion (reads the SHIPPED tokens, F34):** the test reads the actual CSS custom properties off the rendered root via `getComputedStyle(document.documentElement).getPropertyValue('--...')`, parses each `H S% L%` triplet to RGB, and computes the WCAG ratio with a ~15-line relative-luminance helper in the test file — it does **not** hardcode §4's hex, so any drift between §4 and the shipped `:root` fails the test (INV-3 is about what *ships*). **Pairs & thresholds asserted:** `foreground`/`background` (>=4.5), `primary-foreground`/`primary` (>=4.5), `muted-foreground`/`background` (>=4.5, the weakest at 4.76:1), and `destructive-foreground`/`destructive` (>=4.5 — added per F33, catches the 3.60:1 stock pair). **`border`/`background` is NOT asserted at 3:1** (F31): `#e2e8f0` on white is 1.23:1, and per spec these borders are decorative (bg + layout also separate rows), **not** the sole means of identifying a control, so WCAG 1.4.11 does not require 3:1 — asserting it would be a false requirement that fails the harness. Focus ring vs adjacent (A2 3:1) is **not** machine-checked here (F35, manual). | A1, INV-3, A2(partial) |

**Count bookkeeping (R7):** these new cases live only in `tests/App.a11y.test.jsx` and run in
happy-dom. `tests/todos.test.js` keeps running in node and MUST still report its **87** (the aggregate
`vitest run` total rises by the number of new a11y cases, but the *pure-core file* is unchanged — R7's
falsifier is scoped to the 87 pure-core cases and to `todos.js`/`storage.js` being unmodified). The
verifier checks the per-file line `tests/todos.test.js (87 tests)` remains, not just the grand total.

---

## 9. Acceptance-criteria mapping (spec section 6, items 1-7)

| Item | How BUILD/TEST proves it |
|---------|---------------------------|
| 1 — clean install, deps present at pinned versions, v3-consistent | `bun install` exits 0 with no peer-conflict; `package.json` + `bun.lock` show `tailwindcss@3.4.19`, `postcss`, **`autoprefixer`** (present = v3), `clsx`, `tailwind-merge`, `@radix-ui/react-checkbox`, `@radix-ui/react-slot`, happy-dom + testing-library set, all exact-pinned. `@tailwindcss/vite` / `@tailwindcss/postcss` **absent**. |
| 2 — build emits used utilities | `bun run build` exits 0; grep the emitted `dist/assets/*.css` for a class actually used in App.jsx (e.g. `max-w-[480px]` or `text-muted-foreground`) -> present (proves `content` glob, R1). |
| 3 — `87 tests passed`, core files untouched | `bun run test` shows `tests/todos.test.js (87 tests)` passing; `git diff --stat` shows `src/todos.js` + `src/storage.js` = 0 changed lines. |
| 4 — fully themed, no bespoke classes | Manual load of `bun run preview` shows styled UI; section-6 grep audits (index.css old selectors = 0; App.jsx old classes incl. `count` = 0). |
| 5 — A1-A7 | `tests/App.a11y.test.jsx` passes: contrast asserted against the **shipped** `:root` custom props (not hardcoded hex, F34) for the four AA pairs incl. `destructive-fg`/`destructive`; roles/names; Enter/Escape/blur edit; focus **class-presence**. **A2 visible-focus-ring contrast is NOT machine-provable in happy-dom (F35)** — a **required manual keyboard pass** (tab through every control, confirm a visible >=3:1 ring) completes A2. `border`/`bg` is intentionally not a 3:1 gate (F31). |
| 6 — only {button,input,checkbox}, Radix checkbox, theme within caps | `ls src/components/ui` = exactly those three; `components.json` `baseColor:"slate"`, single `--radius`, no custom color/fontFamily in `tailwind.config.js`; checkbox imports `@radix-ui/react-checkbox`. |
| 7 — no XSS sinks | `git diff` shows no `dangerouslySetInnerHTML`; no `todo.text`/`todo.id` in `style`/`href`/`src`/`className` (R9 audit section 7). |

---

## 10. Build order (keeps app working where possible)

1. **Open the build gate** (operator): `touch SDLC/ledger/.build-open` (Risk-7). Builder starts.
2. **Deps** (section 2): `bun add` runtime + `bun add -d` tooling; exact-pin edit; `bun install`. App
   still builds/runs (nothing imports the new deps yet). (working)
3. **Config** (section 3): `postcss.config.js`, `tailwind.config.js`, `vite.config.js` alias,
   `jsconfig.json`, `components.json`. Do **not** yet rewrite `index.css`. `bun run build` still
   succeeds (Tailwind present but directives not yet in the entry CSS = no-op). (working)
4. **Tailwind entry CSS** (section 6): rewrite `src/index.css` to the `@tailwind` layers + token block.
   At this instant the old bespoke classes in App.jsx lose their styles -> **transient unstyled state**
   (unavoidable: the same file holds both the removed rules and the new layers). Minimize the window by
   doing steps 4+5+6 back-to-back in one build cycle. (transient)
5. **`cn` util + primitives** (section 5): create `src/lib/utils.js`, scaffold `button/input/checkbox`.
   (compiles)
6. **App.jsx migration** (section 7): apply the table top-to-bottom (wrapper -> header -> add-form ->
   list/rows incl. checkbox mapping -> footer/filters/clear). After this, UI is fully themed.
   (working & styled)
7. **a11y harness** (section 8): add `tests/App.a11y.test.jsx`. Run `bun run test` -> 87 core + new
   a11y pass.
8. **Audits** (section 6/9): grep for stray classes, XSS sinks, extra primitives; `bun run build` +
   `preview`.

**Why a transient unstyled window is acceptable:** it exists only *between* commits within the single
BUILD phase; no released/tested state is broken, and step 6 closes it immediately. The alternative
(dual-styling with both systems live) would leave dead bespoke CSS mid-flight, directly violating R6's
"no dead bespoke CSS" and inviting a finding — so the clean cutover is preferred.

---

## 11. Risks carried from spec section 8 -> concrete mitigations

| Risk | Mitigation in this plan |
|------|--------------------------|
| **Risk-1 Tailwind v3/v4 churn** | Locked **v3.4.19** + `postcss`/`autoprefixer` + classic `tailwind.config.js`/`postcss.config.js` (sections 1, 3.2-3.3); no v4 plugin anywhere. R2 falsifier (config/plugin mismatch, autoprefixer present/absent) is closed by consistency. |
| **Risk-2 Bundle size** | Runtime additions limited to `clsx`+`tailwind-merge`+`cva`+`@radix-ui/react-checkbox`+`@radix-ui/react-slot` (the last is the stock button's `asChild` primitive, F36; `input` adds no Radix); `tailwindcss-animate` is build-time; Tailwind purges via the `content` glob. happy-dom/testing-library are **dev**-only. No `lucide-react`. Accepted, minimized, no hard byte budget (per spec). |
| **Risk-3 `@/` alias** | Alias added in **both** `vite.config.js` and `jsconfig.json`, values matching `components.json` (3.1/3.4/3.5); section-9 item 1/2 build proves resolution. R8 falsifier (one-sided alias / stray config) closed. |
| **Risk-4 No UI regression net** | The R11 harness (section 8) is that net — roles/names/focus/edit-semantics + contrast are all asserted, so a silent markup break turns a test red. |
| **Risk-5 Radix checkbox contract** | Explicit `checked<->checked`, `onChange->onCheckedChange` mapping (section 7 row + R10); harness asserts `role="checkbox"`/`aria-checked` and that toggling flips completion (section 8). |
| **Risk-6 "Simple theme" subjective** | R5 caps enforced concretely: Slate base only, no custom colors/fonts, single `--radius` (section 4); section-9 item 6 checks it. |
| **Risk-7 build-gate guard on `src/`** | Operator opens the gate (step 1); INV-1 keeps `todos.js`/`storage.js` untouched; a11y test lives in `tests/`, not `src/`. |

---

## 12. Files touched (summary for the builder)

**New:** `postcss.config.js`, `tailwind.config.js`, `jsconfig.json`, `components.json`,
`src/lib/utils.js`, `src/components/ui/button.jsx`, `src/components/ui/input.jsx`,
`src/components/ui/checkbox.jsx`, `tests/App.a11y.test.jsx`.
**Edited:** `vite.config.js` (alias), `src/index.css` (full rewrite to Tailwind entry + tokens),
`src/App.jsx` (markup/class migration + checkbox mapping), `package.json`/`bun.lock` (deps + pins).
**Never touched:** `src/todos.js`, `src/storage.js`, `tests/todos.test.js`, `.github/`, `.claude/`,
`SDLC/` (INV-1, INV-6).
