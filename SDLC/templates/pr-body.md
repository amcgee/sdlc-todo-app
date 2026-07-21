# PR body template

The engineering driver (`.claude/commands/sdlc-engineering.md` §6) refreshes the PR body to this
shape on every checkpoint. Fill `<…>` placeholders from the live cycle; `☐`/`☑` mark phase
completion. The **Status** line must always carry the current step **and** the `<session>` link —
that link is the ownership fence (driver §0/§1).

```
Closes #<n>

**Status:** <SPEC|BUILD|TEST round k|MERGE> — <live detail: the sub-step in progress, or ⏳ the exact thing awaited> · since <ts> · [▶ Live session](<session>)
**Phases:** <☐/☑ SPEC ⟨dur⟩> → <☐/☑ BUILD ⟨dur⟩> → <☐/☑ TEST ⟨dur⟩> → <☐/☑ MERGE>

## Change summary
**Type:** <feat | fix | docs | test | ci | refactor | chore | perf> — match the PR title's
conventional-commit type (driver §1).

<a one-paragraph summary of what this PR changes + a link to the canonical PRD file
`docs/specs/<n>-<slug>-prd.md`, the single source of truth (driver §2). The full PRD was
ratified in the issue before engineering began.>

## Open questions
<list, or "none">

## Artifacts

Every per-cycle document, **always listed and always current** — refreshed at each checkpoint,
so the index is in place even if the session dies before the human merges. The disposable ones
(plan, mockups) are pruned at ship; their links then resolve to a permalink pinned to the commit
before the prune (see the note below). Show every row: link it once the file exists, or say
`— not yet` / `— none (no design facet)` so the reader always knows the full set.

- 📋 **PRD** — <[Product requirements](link to `docs/specs/<n>-<slug>-prd.md`)>
- 🎨 **Design brief** — <[Design & interaction notes](link to `docs/specs/<n>-<slug>-design.md`) · or `none (no design facet)`>
- 📐 **Spec** — <[Technical contract](link to `docs/specs/<n>-<slug>-spec.md`) · or `not yet`>
- 🛠️ **Plan** *(pruned at ship)* — <[Implementation plan](link to `docs/specs/<n>-<slug>-plan.md`) · or `not yet`>
- 🖼️ **Mockups** *(pruned at ship)* — <[Mockup gallery](link to the `docs/specs/<n>-<slug>-design/` dir) · or `none (no design facet)`>

<details><summary>Timing — more info</summary>

<output of `python SDLC/sdlc.py timing --item ISSUE-<n>` — each completed phase's **active** duration,
plus a separate `waiting (operator)` line where the cycle was blocked on `@claude` input. Times are
derived from ledger timestamps; operator wait is excluded from the active numbers and shown on its
own line.>
</details>

<details><summary>Ledger</summary>

<output of `python SDLC/sdlc.py status --item ISSUE-<n>`>
</details>
```

**Status detail — keep it live.** The Status line is the operator's window into a running step,
so it is edited **far more often than a checkpoint commits** (via a plain PR-body edit, no
commit — engineering §6). Beyond the coarse phase, its `<detail>` names the **sub-step actually
in progress or the exact thing awaited**, with a `since <ts>` so lag is visible at a glance —
a multi-minute subagent run or an operator wait should never look like a hung cycle. Shape:
- `TEST round 2 — adversary attacking · since 14:03`
- `TEST round 2 — defending 3 findings · since 14:09` → `verifier proving fixes · since 14:12`
- `SPEC — ⏳ awaiting operator: \`@claude continue\` on the spec · since 14:20`
- `BUILD — builder implementing · since 14:25`

**Phase durations.** Only a **completed** phase (its gate is open) carries a `⟨dur⟩` — take it from
the `summary:` line of `sdlc.py timing` (active durations, e.g. `☑ SPEC 8m`); an unstarted or
in-progress phase shows no duration.

**Artifact links.** Through the run, link each file at the branch (`claude/sdlc-issue-<n>`) so
the index tracks the live tree. At the **merge distillation** checkpoint the plan and mockups
are deleted from the branch, so switch **those two entries to a permalink pinned to the commit
before the prune** — find it with `git log --diff-filter=D --format=%H -1 -- <path>` and take
its parent `^`, where the file still exists — and leave the kept entries on the branch. This is
what makes the pruned-but-findable record durable and correct after merge, with no live session
needed.
