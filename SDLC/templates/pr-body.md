# PR body template

The engineering driver (`.claude/commands/sdlc-engineering.md` §6) refreshes the PR body to this
shape on every checkpoint. Fill `<…>` placeholders from the live cycle; `☐`/`☑` mark phase
completion. The **Status** line must always carry the current step **and** the `<session>` link —
that link is the ownership fence (driver §0/§1).

```
Closes #<n>

**Status:** <SPEC|BUILD|TEST round k|MERGE> — <who is working / what's awaited> · [▶ Live session](<session>)
**Phases:** <☐/☑ SPEC ⟨dur⟩> → <☐/☑ BUILD ⟨dur⟩> → <☐/☑ TEST ⟨dur⟩> → <☐/☑ MERGE>

## PRD
<a one-paragraph summary + a link to the canonical PRD file `docs/specs/<n>-<slug>-prd.md` — the
file is the single source of truth (driver §2). The full PRD was ratified in the issue before
engineering began.>

## Open questions
<list, or "none">

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

**Phase durations.** Only a **completed** phase (its gate is open) carries a `⟨dur⟩` — take it from
the `summary:` line of `sdlc.py timing` (active durations, e.g. `☑ SPEC 8m`); an unstarted or
in-progress phase shows no duration.
