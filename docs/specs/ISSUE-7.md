# ISSUE-7 — Adopt a standard design system (Tailwind CSS + shadcn/ui)

Status: SPEC (draft for the spec gate)
Owner: architect
Work item: ISSUE-7

---

## 0. Grounding — what is actually in the repo today

This spec is written against the tree as it exists, not against assumptions. Verified facts:

- **Stack:** React `^18.3.1` + `react-dom`, built and served by **Vite `^5.4.0`** (`vite.config.js`
  has only `@vitejs/plugin-react`). ESM (`"type": "module"`). Package manager + task runner is
  **Bun** (`bun.lock` committed; scripts run via `bun run …`, per ratified ISSUE-3). Tests run under
  **Vitest `^1.6`** (`bun run test` → `vitest run`).
- **UI surface is a single component:** `src/App.jsx` (~190 lines) renders the *entire* UI — the
  `<h1>`, the add-form, the `<ul>` todo list with per-row checkbox / inline-edit `<input>` / text
  `<span>` / Edit + Delete buttons, and a footer with an items-left count, three filter buttons
  (All / Active / Completed), and a Clear-completed button. There are **no other presentational
  components** and no component directory.
- **Styling today is plain hand-written CSS:** `src/index.css` (~89 lines), imported once in
  `src/main.jsx`. It uses class selectors (`.app`, `.add-form`, `.todo-list`, `.todo-item`,
  `.text.completed`, `.footer`, `.filters`) and one attribute selector
  (`.filters button[aria-pressed='true']`). **No CSS framework, no PostCSS config, no Tailwind, no
  shadcn/ui, no Radix, no clsx/cva** are present. `postcss@8.5.16` exists in `bun.lock` **only as a
  transitive dependency of Vite**, not as a configured pipeline (there is no `postcss.config.*`).
- **No path alias:** there is no `@/` → `src/` alias in `vite.config.js` or any `jsconfig.json`/
  `tsconfig.json`. shadcn/ui's default generator assumes `@/components` and `@/lib/utils`; this is a
  real integration cost called out below (R8, Risk-3).
- **No component/DOM tests exist.** `tests/todos.test.js` covers only the pure core (`src/todos.js`)
  and runs in Vitest's **default `node` environment** — there is **no jsdom/happy-dom installed** and
  **no render/snapshot test of `App.jsx`**. So this work does **not** break existing tests by
  changing markup (there is nothing asserting on the DOM), but it also cannot lean on existing tests
  to prove the UI still works — see §6 acceptance criteria and Risk-4.
- **Accessibility already partly present in `App.jsx`:** `aria-label` on inputs/checkboxes,
  `aria-pressed` on filter buttons, `lang="en"` and a viewport meta in `index.html`. The bar is to
  *preserve and extend* this, not to claim it from zero.
- **The issue says "ShadCDN"** — treated as **shadcn/ui** (the Tailwind-based component library);
  no repo evidence points to any other tool. If the human means something else, that invalidates the
  whole approach — see Q1.

---

## 1. Problem statement

The TODO app's UI is styled with ~89 lines of ad-hoc plain CSS in a single stylesheet, with no
shared design language: colors, spacing, type sizes, and component states (hover/focus/disabled) are
one-off literals scattered through `index.css`, and there is no systematic, auditable approach to
accessibility. Issue #7 asks to **adopt a standard design system** — **Tailwind CSS** for utility-
driven styling plus **shadcn/ui** for a small set of accessible, pre-built components — and to define
a **simple, restrained theme** (a token set for color, typography, spacing) applied consistently
across the existing UI, while *explicitly avoiding heavy customization*. After this change, the same
TODO app (identical features and behavior) is rendered through a consistent token-based theme and
accessible component primitives; a contributor styles UI by composing tokens/utilities and shadcn/ui
components rather than writing bespoke CSS, and the UI meets a defined accessibility bar (§4). This is
a **presentation-layer migration**: no todo behavior, data model, storage, or pure-core logic changes.

---

## 2. Goals

- **G1.** Tailwind CSS is installed and wired into the Vite build (PostCSS/Tailwind pipeline), with a
  Tailwind config and a single CSS entry that pulls in Tailwind's layers.
- **G2.** shadcn/ui is initialized in the project (its config + the small `cn`/utils helper it
  generates), and the **specific** primitives the existing UI needs are added — the text input and
  button, plus the shadcn/ui (Radix) checkbox for the completed-toggle (R10). The exact closed list is fixed in R4.
- **G3.** A **simple theme** is defined as **design tokens** — a constrained palette, typography
  scale, and spacing/radius scale — expressed the idiomatic shadcn/ui way (CSS custom properties in
  the base layer, surfaced through `tailwind.config`). "Simple" is made concrete in R5 (bounded
  counts), so "don't go overboard" is testable, not a matter of taste.
- **G4.** The **entire existing UI in `src/App.jsx`** is restyled to use Tailwind utilities + the
  shadcn/ui primitives and the theme tokens — header, add-form, todo rows (checkbox, text, inline
  edit, Edit/Delete), and footer (count, filters, clear-completed). No part of the visible UI keeps
  using the old bespoke class-based CSS.
- **G5.** The UI meets the **accessibility bar in §4** (contrast, visible focus, semantic HTML,
  necessary ARIA, full keyboard operability), and that bar is **measurably preserved or improved**
  relative to today — no existing `aria-*`/label/`lang` affordance is lost.
- **G6.** All existing behavior and tests are untouched: `bun run build` produces a working bundle,
  `bun run test` stays green, and every todo interaction behaves exactly as before.

## 3. Non-goals (out of scope) — capturing "don't go overboard"

- **N1. No new features or behavior changes.** No new todo capabilities (no due dates, priorities,
  drag-reorder, multi-list, undo, animations beyond default component transitions). `src/todos.js`,
  `src/storage.js`, the public API, the data model, and the localStorage key are untouched.
- **N2. No dark mode / theme switcher.** A single light theme only. (shadcn/ui scaffolds dark-mode
  CSS variables by default; we may *leave the generated `.dark` block in the stylesheet* but we do
  **not** build a toggle, persist a preference, or claim dark mode as delivered. See R5/Q3.)
- **N3. No bespoke/elaborate visual design.** No custom font files or webfont loading (system font
  stack stays), no brand illustrations, no custom iconography beyond what a chosen primitive ships,
  no animation library, no gradient/shadow-heavy "designed" look. The theme is restrained by R5's
  bounded token counts.
- **N4. No component proliferation.** Only the shadcn/ui primitives enumerated in R4 are added. We do
  **not** pull in dialogs, dropdowns, toasts, tooltips, command palettes, forms libraries, etc.
- **N5. No TypeScript migration.** The project is JS/JSX; shadcn/ui is configured for JS (its CLI
  supports a non-TS setup). Converting the codebase to TS is out of scope.
- **N6. No build-tooling overhaul.** We stay on Vite + Bun + Vitest. No switch to Next.js, no CSS-in-JS
  runtime, no migration off Vite. Tailwind/PostCSS are added *alongside* the existing build.
- **N7. No restructuring of `src/App.jsx` into many components.** Extracting presentational
  sub-components is *permitted only if needed* to use a shadcn/ui primitive cleanly, but a wholesale
  component-architecture refactor (splitting list/row/footer into separate files as an end in itself)
  is out of scope; the diff stays presentation-focused.
- **N8. No accessibility work beyond the §4 bar.** We meet a defined WCAG-AA-aligned bar for *this
  UI*; we do not commit to a full external audit, screen-reader certification across all AT, or
  i18n/RTL.

---

## 4. Accessibility requirements (the bar — each verifiable)

These are the concrete a11y best practices in scope. Each names how it is falsified.

- **A1 — Color contrast meets WCAG 2.1 AA.** All text/icon foregrounds in the themed UI meet a
  contrast ratio of **>= 4.5:1** for normal text and **>= 3:1** for large text (>= 24px / 18pt, or >= 18.66px / 14pt
  bold) and for meaningful UI-component boundaries/focus indicators (1.4.11). This includes the
  **completed-todo "muted" text** (today `#999` on white ~= 2.85:1, which **fails** — the new theme's
  muted token must clear 4.5:1) and filter/secondary button text.
  *Falsify:* any in-scope text/UI token pair, including muted completed-text and disabled-but-readable
  states, computes below its threshold in a contrast check against the ratified token values.

- **A2 — Visible, non-color-only focus indicator on every interactive element.** Inputs, checkboxes,
  and all buttons (add, edit, delete, the three filters, clear-completed) show a clearly visible
  focus ring/outline on keyboard focus, with >= 3:1 contrast against adjacent colors, and focus is
  **never** removed without an equivalent replacement (no bare `outline: none`).
  *Falsify:* tabbing to any interactive element produces no visible focus change, or a rule sets
  `outline: none`/`outline: 0` without an equally-visible substitute.

- **A3 — Full keyboard operability, preserving today's behavior.** Every action is reachable and
  operable by keyboard alone in a logical tab order: add a todo (type + Enter/Add), toggle
  (Space on checkbox), enter edit mode, **commit edit on Enter, commit edit on blur, and cancel on
  Escape** (all three exist today in `App.jsx` — `onKeyDown` Enter/Escape and `onBlur` commit at
  line 132 — and MUST survive), delete, switch filters, clear completed.
  No interactive control becomes mouse-only (note: today's double-click-to-edit is a *mouse*
  affordance with an Edit-button keyboard equivalent — the Edit button MUST remain).
  *Falsify:* any listed action cannot be performed via keyboard after the change, OR Enter/Escape in
  the edit field stop committing/cancelling, OR blurring the edit field no longer commits the edit (or
  double-fires the commit).

- **A4 — Semantic HTML preserved or strengthened.** The page keeps a single top-level `<h1>`, the
  list stays a real `<ul>`/`<li>`, the add control stays a `<form>` that submits, the toggle is a
  shadcn/ui (Radix) checkbox that renders an equivalent accessible role — a `<button role="checkbox">`
  with `aria-checked` (R10, Risk-5) — not a non-semantic `<div>`/`<span>`, and buttons stay `<button>`.
  No interactive control is downgraded to a non-semantic `<div>`/`<span>` with click handlers.
  *Falsify:* the rendered output drops the `<h1>`/`<ul>`/`<li>`/`<form>` structure, or any
  `<button>` is replaced by a non-button clickable element.

- **A5 — Accessible names on all controls; no regression.** Every existing accessible name is kept:
  `aria-label="New todo"` (add input), `aria-label="Toggle complete"` (checkbox),
  `aria-label="Edit todo"` (edit input), and the filter buttons' `aria-pressed` state. Icon-only
  controls (if any are introduced, e.g. an icon Delete) MUST carry an accessible name
  (`aria-label`/visually-hidden text). The filter buttons MUST continue to expose selected state
  programmatically (`aria-pressed` or `role="tab"`+`aria-selected`).
  The active filter MUST **also** remain *visually* distinguished for sighted users by a cue that is
  **not color alone** (today: bold + underline via `.filters button[aria-pressed='true']`). R6 removes
  that bespoke rule, so the migration MUST recreate an equivalent visible selected-state cue (e.g. a
  Tailwind/shadcn-styled active/pressed variant) meeting A1 contrast and A6 (not color-alone).
  *Falsify:* any control listed above loses its accessible name, OR selected-filter state is conveyed
  by styling alone with no programmatic equivalent, OR the active filter is no longer *visually*
  distinguishable from inactive filters (or is distinguished by color alone) after the migration.

- **A6 — Visual completed-state is not conveyed by color alone.** A completed todo is distinguished by
  more than color (today: line-through + muted). The non-color cue (e.g. strikethrough and the
  checked checkbox) MUST remain.
  *Falsify:* completed vs. active todos differ only by text color after the change.

- **A7 — No new motion/contrast accessibility hazards.** Any transition introduced respects
  `prefers-reduced-motion` (or is subtle/non-essential), and no themed state relies on a
  color combination failing A1. (Bounded by N3 — minimal motion anyway.)
  *Falsify:* a non-trivial animation ignores `prefers-reduced-motion`.

---

## 5. Functional requirements (verifiable)

- **R1 — Tailwind is installed and active in the build.** `tailwindcss` (and the PostCSS plumbing it
  needs for Vite) are added as devDependencies via Bun; a Tailwind config exists with a `content`
  glob that includes `index.html` and `src/**/*.{js,jsx}`; the CSS entry imports Tailwind's layers.
  *Falsify:* a Tailwind utility class used in `App.jsx` produces no styling in a `bun run build`
  output (class purged/not generated), or `tailwindcss` is absent from `package.json`/`bun.lock`, or
  the `content` glob omits `src/**/*.{js,jsx}` so classes are tree-shaken away.

- **R2 — Tailwind/PostCSS version compatibility is pinned and resolves cleanly.** The Tailwind major
  and its required build plumbing are pinned to versions compatible with **Vite `^5.4.0`** and Bun;
  `bun install` resolves with no peer-dependency conflict. The exact plumbing depends on the Q2
  decision: **Tailwind v3** requires `postcss` + `autoprefixer` + a `postcss.config` (or the
  `@tailwindcss/...` Vite integration) and `autoprefixer` MUST then appear in `package.json`;
  **Tailwind v4** uses `@tailwindcss/vite` (or `@tailwindcss/postcss`) and needs **no** separate
  `autoprefixer`, which MUST then be **absent**. The plan states the pin and the matching plumbing.
  *Falsify:* `bun install` reports a peer-dep conflict, OR `bun run build` fails to process the
  Tailwind directives, OR the chosen Tailwind major mismatches its config style (e.g. a v3 config
  file shipped with a v4 plugin), OR `autoprefixer` is present/absent inconsistently with the Q2
  major (required for v3, forbidden as unnecessary for v4).

- **R3 — shadcn/ui is initialized for this JS/Vite project.** shadcn/ui's config (`components.json`)
  and its `cn` utility (the `clsx` + `tailwind-merge` helper) are present and importable; the import
  path it generates resolves at build time. Because there is **no `@/` alias today (see §0/R8)**, the
  setup MUST either (a) add the `@` → `src` alias to `vite.config.js` *and* a `jsconfig.json` so both
  Vite and the editor resolve it, or (b) configure shadcn/ui to use relative paths — and whichever is
  chosen MUST actually resolve in `bun run build`.
  *Falsify:* `components.json` is absent, or the `cn` util / any added component imports an
  unresolvable path, or `bun run build` fails on a shadcn/ui import.

- **R4 — Exactly the needed primitives are added (closed list).** The shadcn/ui components added are
  **only**: **button**, **input**, and **checkbox** (the Radix-based checkbox for the completed-toggle,
  R10). Any additional primitive (e.g. a `label`, a visually-hidden helper) MUST be justified by a §4
  requirement and named in the plan; nothing beyond that is added (N4).
  *Falsify:* the components directory contains a primitive not in {button, input, checkbox} (plus any
  plan-justified a11y helper) — i.e. scope creep into dialogs/dropdowns/etc.

- **R5 — The theme is "simple" — bounded token set (makes N3 testable).** The theme defines design
  tokens within these caps, so "don't go overboard" is enforced, not aspirational:
  - **Color:** uses shadcn/ui's standard semantic token names (`background`, `foreground`, `primary`,
    `primary-foreground`, `muted`, `muted-foreground`, `border`, `ring`, `destructive`,
    `destructive-foreground`, and the small standard remainder). **No custom color tokens beyond
    shadcn/ui's standard set**, and the chosen base palette is **one** shadcn/ui base (e.g. one of its
    stock neutrals) — not a hand-rolled palette.
  - **Typography:** the system font stack is kept (N3); at most the standard Tailwind type scale is
    used. **No custom font families and no webfont loading.**
  - **Radius:** a single `--radius` value (shadcn/ui's standard knob).
  *Falsify:* the theme introduces custom color tokens beyond shadcn/ui's standard semantic set, OR
  loads a webfont / adds a custom font family, OR defines more than the single `--radius` knob's worth
  of custom geometry — any of which exceeds the "simple theme" cap.

- **R6 — The whole visible UI is migrated; the old bespoke CSS is removed.** Every element rendered by
  `src/App.jsx` (header, add-form, list rows incl. inline edit, footer/filters/clear) is styled via
  Tailwind utilities + shadcn/ui primitives + theme tokens. The old hand-written rules in
  `src/index.css` (`.app`, `.add-form`, `.todo-list`, `.todo-item`, `.text.completed`, `.footer`,
  `.filters`, the `.filters button[aria-pressed='true']` selector) are **removed** (replaced by
  Tailwind's base layer + utilities), leaving no dead bespoke CSS. Because that `aria-pressed`
  selector is today's **only visual** active-filter cue, its visual selected-state effect MUST be
  recreated in the new styling (per A5), not merely deleted.
  Note the items-left count element carries `className="count"` (`App.jsx` line 159) but has **no**
  `.count` rule in `index.css` today — the migration MUST style it via Tailwind and leave no
  references to the (un-styled) `count` class behind.
  *Falsify:* any visible region of `App.jsx` still depends on a removed bespoke class for its styling,
  OR `index.css` still contains the old `.app`/`.todo-item`/etc. rules after migration, OR a
  previously-styled element renders unstyled.

- **R7 — Behavior and the pure-core test suite are unchanged.** `bun run build` succeeds and produces
  a working bundle; `bun run test` passes with the **same result `bun` reports today — `87 tests passed`
  across `tests/todos.test.js`** (51 `test`/`test.each` statements expand to 87 individual cases),
  unchanged; every
  todo interaction (add/toggle/edit-commit/edit-cancel/delete/filter/clear) works exactly as before.
  No file under the pure-core boundary (`src/todos.js`, `src/storage.js`) is modified.
  *Falsify:* `bun run test` reports anything other than `87 tests passed` (count or pass/fail changes),
  OR `src/todos.js`/`src/storage.js` is edited, OR any
  interaction regresses, OR `bun run build` fails.

- **R8 — Path-alias integration is coherent (or absent by choice).** If an `@/` alias is introduced
  for shadcn/ui (R3), it is added consistently to **both** `vite.config.js` (so the build resolves it)
  **and** a `jsconfig.json` (so editors/`bun run dev` IntelliSense resolve it); if relative paths are
  chosen instead, **no** half-configured alias is left behind.
  *Falsify:* an `@/...` import resolves in the build but breaks editor tooling (alias in only one
  place), OR a `jsconfig.json` declares an alias the build does not honor, OR a stray alias config is
  committed while imports use relative paths.

- **R9 — XSS posture preserved (INV from App.jsx header).** The migration MUST NOT introduce
  `dangerouslySetInnerHTML`, nor place user-controlled todo text/id into an `href`/`src`/`style`
  attribute or any non-text sink. Todo text continues to reach the DOM only via React's escaped
  `{todo.text}` text interpolation (the existing R18/INV5 posture documented in `App.jsx`).
  *Falsify:* the diff adds `dangerouslySetInnerHTML`, or routes `todo.text`/`todo.id` into an
  attribute sink (e.g. a dynamically-built `style`/`className` from raw text).

- **R10 — Checkbox uses the shadcn/ui (Radix) primitive (Q5 resolved).** The completed-toggle control
  is the shadcn/ui **Radix** checkbox (which renders a `<button role="checkbox">` with `aria-checked`,
  Risk-5), added to R4's closed list as a shadcn/ui primitive. The existing toggle contract in
  `App.jsx` (`checked` boolean + a handler that flips completion) is preserved *behaviorally* by mapping
  it onto Radix's API: the current `checked` value drives Radix's `checked` prop, and the current
  `onChange` toggle handler is invoked from Radix's `onCheckedChange` callback — so the completion
  semantics, `aria-label="Toggle complete"` (A5), Space-to-toggle (A3), and the checked/unchecked
  visual state (A6) are unchanged from the user's perspective. The plan MUST specify this
  `onChange`↔`onCheckedChange` and `checked`↔`checked` mapping (Risk-5).
  *Falsify:* the toggle control is rendered by a native `<input type="checkbox">` instead of the
  shadcn/ui (Radix) checkbox, OR the completion behavior/accessible name/Space-to-toggle regresses,
  OR the Radix `onCheckedChange`/`checked` props are not wired to the existing toggle contract.

- **R11 — A11y verification harness is introduced (Q4 resolved).** A minimal render-test harness is
  added: a DOM environment (`jsdom` or `happy-dom`) + `@testing-library/react`, run under a Vitest
  `jsdom` (or `happy-dom`) test environment, **scoped to A1–A7 structure/role/name/focus/edit-semantics
  assertions plus a static token-contrast check** — it does **not** re-test pure-core logic and does
  **not** change the existing `node`-environment run of `tests/todos.test.js`. Adding it MUST keep R7
  intact (`87 tests passed` for the pure core; new a11y tests are additive and counted separately or
  in a separate file the plan names).
  *Falsify:* A2 (focus ring) / A3 (keyboard Enter/Escape/blur edit) / A4 (semantic roles) / A5
  (accessible names) have no runnable assertion, OR adding the DOM environment changes the
  pure-core run so `tests/todos.test.js` no longer reports `87 tests passed`, OR no static
  token-contrast assertion exists for A1.

---

## 6. Acceptance criteria (concrete "done")

Done when **all** hold:

1. `bun install` resolves cleanly; `tailwindcss`, the Q2-appropriate build plumbing
   (`postcss` + `autoprefixer` for v3, or `@tailwindcss/vite`/`@tailwindcss/postcss` with **no**
   `autoprefixer` for v4), `clsx`, and `tailwind-merge` (shadcn/ui's `cn` deps) appear in
   `package.json` + `bun.lock` at the pinned versions, consistent with the Q2 major (R1, R2, R3).
2. `bun run build` succeeds and the built CSS contains the Tailwind-generated utilities actually used
   by `App.jsx` (proves the `content` glob is right — R1).
3. `bun run test` reports **`87 tests passed`** (the count `bun` prints today — 51 `test`/`test.each`
   statements expanding to 87 cases) unchanged, and `src/todos.js` /
   `src/storage.js` are byte-for-byte unmodified (R7).
4. Loading the built app shows the TODO UI fully styled via the theme, with **no** element relying on
   the removed bespoke classes; `src/index.css`'s old `.app`/`.todo-item`/`.footer`/etc. rules are
   gone, and the previously-unstyled `count` class (`App.jsx:159`) is styled via Tailwind with no
   stray `count`/bespoke class references remaining (R6).
5. A manual/automated a11y check confirms **A1–A7**: a contrast check on the ratified token pairs
   passes AA (incl. the previously-failing muted/completed text), every interactive control shows a
   visible focus ring, and every action is keyboard-operable with Enter/Escape edit semantics intact.
6. The shadcn/ui components directory contains **only** {button, input, checkbox} (+ any
   plan-justified a11y helper) — the checkbox is the shadcn/ui (Radix) primitive (R10), no other extra
   primitives (R4) — and the theme stays within R5's caps
   (no custom palette beyond shadcn's standard tokens, no webfont, single `--radius`).
7. No `dangerouslySetInnerHTML` and no user-text-in-attribute sinks appear in the diff (R9).

**Note on a11y verification mechanism (resolved — R11):** there are currently **no DOM/render tests**
and no jsdom, so the acceptance of A1–A7 is pinned to a concrete mechanism the verifier runs: a minimal
**render-test harness** (jsdom or happy-dom + `@testing-library/react` under a Vitest `jsdom`
environment), scoped to **a11y/structure assertions only** (roles, accessible names, semantic
elements, focusability, Enter/Escape/blur edit semantics), **plus a static token-contrast assertion**
over the ratified token pairs for A1. The harness does **not** re-test pure-core behavior. See R11.

---

## 7. Failure modes & invariants (what must never happen)

- **INV-1 — Behavior immutability.** No change to todo logic, data model, storage key, or the public
  pure-core API. The build-gate guard covers `src/`; the only `src/` edits permitted are presentation
  (`App.jsx`, `index.css`/new CSS entry, possibly a new `src/components/**` and `src/lib/utils`). The
  pure-core files (`todos.js`, `storage.js`) MUST NOT be touched (R7/INV-1).
- **INV-2 — No a11y regression.** Every accessible affordance present today (labels, `aria-pressed`,
  `lang`, semantic elements, keyboard edit Enter/Escape) is preserved or improved; none is dropped
  (§4). A change that trades a passing affordance for a prettier look is a blocker.
- **INV-3 — No silent contrast failure.** The theme tokens MUST NOT ship a foreground/background pair
  used for real text below AA. The current `#999` muted text is a known pre-existing failure that this
  work MUST fix, not propagate (A1).
- **INV-4 — Build determinism preserved.** `bun run build`/`dev`/`preview` keep working; the
  Tailwind/PostCSS pipeline is added without breaking Vite's existing pipeline; `bun install` stays
  reproducible from the committed lockfile (no dual/loose pinning). (Aligns with ISSUE-3 INV-E.)
- **INV-5 — XSS posture preserved.** No `dangerouslySetInnerHTML`; no user text/id into attribute
  sinks (R9).
- **INV-6 — Scope containment.** No edits to `.github/`, `.claude/`, or `SDLC/` as part of this work
  (per CLAUDE.md cloud rules), and no expansion beyond the enumerated primitives/tokens.

---

## 8. Risks and tradeoffs

- **Risk-1 — Tailwind v3 vs v4 churn.** Tailwind v4 (2025) changed config + the PostCSS plugin model
  significantly vs v3, and shadcn/ui's setup differs between them. Picking the wrong pairing yields a
  build that won't process directives. *Mitigation:* Q2 forces the plan to pin one major and match
  shadcn/ui's setup to it; R2 falsifies a mismatch.
- **Risk-2 — Bundle-size increase.** Tailwind + `clsx`/`tailwind-merge` + Radix primitives (which some
  shadcn/ui components depend on, e.g. checkbox) add JS/CSS weight to a tiny app. *Mitigation:* keep
  the primitive list minimal (R4); Tailwind purges unused utilities via the `content` glob (R1). This
  is an accepted cost of adopting the system; the spec does not set a hard byte budget (would be
  arbitrary) but flags it for the plan to note. *Tradeoff acknowledged, not eliminated.*
- **Risk-3 — `@/` alias integration.** shadcn/ui assumes an `@/` alias the repo lacks; a half-applied
  alias breaks either the build or editor tooling. *Mitigation:* R8 requires alias in both
  Vite + jsconfig, or relative paths with no stray config.
- **Risk-4 — No existing UI tests to catch regressions.** Because only the pure core is tested, a
  markup/styling change could silently break the rendered UI without any red test. *Mitigation:* the
  §6 Q4 note forces the plan to choose a verification mechanism (render-test harness or documented
  manual checklist + static contrast assertion) so "done" is provable, not asserted.
- **Risk-5 — shadcn/ui checkbox is not a native `<input>`.** The Radix-based checkbox renders a
  `<button role="checkbox">` (with `aria-checked`) rather than a native `<input type="checkbox">`, and
  exposes `checked`/`onCheckedChange` rather than `checked`/`onChange`. This is now the **chosen** path
  (R10, per the repo owner's review): the plan MUST map the existing `App.jsx` toggle contract onto
  Radix's API — the current `checked` boolean drives Radix's `checked` prop and the existing toggle
  handler is called from `onCheckedChange` — and MUST keep the `aria-label="Toggle complete"`
  accessible name (A5), Space-to-toggle operability (A3), and the non-color checked cue (A6). The
  render-test harness (R11) MUST assert the `role="checkbox"`/`aria-checked` semantics and that
  toggling still flips completion. *Tradeoff accepted:* slightly more wiring than a native input, in
  exchange for consistency with the adopted design system.
- **Risk-6 — "Simple theme" is subjective.** Without bounds, the adversary can attack either over- or
  under-customization. *Mitigation:* R5 converts "simple" into counted caps (standard token set only,
  no webfont, single radius).
- **Risk-7 — Touching `src/` trips the build-gate guard.** This work edits presentation files under
  `src/`. *Mitigation:* the build gate (`SDLC/ledger/.build-open`) is opened by the operator before
  the builder starts (per CLAUDE.md flow); INV-1 keeps the pure core untouched so the guard's intent
  (protect proven logic) is respected.

---

## 9. Open questions (need human/arbiter input)

- **Q1 — Confirm "ShadCDN" = shadcn/ui.** The issue's "ShadCDN" is read as **shadcn/ui**. If the human
  meant a CDN-delivered framework or a different library, the whole approach (R3/R4) changes. *Proposed
  default:* shadcn/ui (Tailwind component library).
- **Q2 — Tailwind major (v3 vs v4) to pin.** v4 is current but reworks config/PostCSS; v3 is the
  version most shadcn/ui guides target. *Proposed default:* pin the version pairing that shadcn/ui's
  official Vite guide currently recommends, matched consistently (R2). The plan must state the exact
  pin.
- **Q3 — Keep or strip shadcn/ui's generated `.dark` CSS variables?** We ship light-only (N2), but
  shadcn/ui scaffolds dark-mode variables. *Proposed default:* leave the generated `.dark` block in
  place (inert, no toggle) to stay on the standard template rather than hand-editing it out — but make
  no claim of dark-mode support. Confirm acceptable.
- **Q4 — A11y verification mechanism. RESOLVED (R11): render-test harness.** Decision: introduce a
  minimal render-test harness (jsdom/happy-dom + `@testing-library/react`, Vitest `jsdom` environment)
  scoped to A1–A7 structure/role/name/focus/edit-semantics assertions, plus a static token-contrast
  assertion — chosen over a manual checklist because A2/A3 (focus ring, Enter/Escape/blur edit) are
  otherwise unverifiable and Risk-4 (no UI regression net) stays open. The harness is a11y-only,
  additive, and leaves the pure-core run untouched. See R11 / §6.5.
- **Q5 — Native checkbox vs shadcn/ui (Radix) checkbox. RESOLVED (R10): shadcn/ui (Radix) checkbox.**
  Decision (per the repo owner's PR review): adopt the shadcn/ui (Radix) checkbox for the
  completed-toggle, added to R4's closed list. It renders a `<button role="checkbox">` with
  `aria-checked` (Risk-5); the plan MUST map the existing `App.jsx` toggle contract onto Radix's API
  (`checked`↔`checked`, `onChange`↔`onCheckedChange`) and preserve A3 (Space-to-toggle), A4 (the
  equivalent accessible checkbox role), A5 (`aria-label="Toggle complete"`), and A6 (non-color checked
  cue). This aligns the toggle with the adopted design system at the cost of slightly more wiring.
