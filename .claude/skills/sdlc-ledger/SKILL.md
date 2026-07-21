---
name: sdlc-ledger
description: Read from and append to the adversarial SDLC ledger — open work items, file findings, record rebuttals/fixes/tests/verdicts, and inspect status. Use whenever recording or reviewing the record of an adversarial cycle.
---

# SDLC ledger

The ledger (`.sdlc/ledger/rounds.jsonl`, outside the immutable `SDLC/`) is the **source of
truth** for the adversarial SDLC.
Agents never assert that work is done — they write entries here and the controls compute
the rest. Append-only: correct mistakes by adding a new entry, never by editing history.

## Entry lifecycle
```
open ──▶ finding ──▶ rebut ──▶ verdict(rejected)  ✓ resolved (rebuttal won)
                 ├─▶ defer                        ✓ parked (minor/nit → follow-up issue)
                 └─▶ fix ──▶ test ──▶ [verdict(accepted)]  ✓ resolved (fixed & proven)
                     (a spec-phase finding is resolved by fix alone — no test for a document)
```

## CLI (`python SDLC/sdlc.py <cmd>`)

`sdlc.py --help` is the authoritative command + flag reference; this table is the role map.

| Command | Who | Purpose |
|---------|-----|---------|
| `open --item ID --title "…"` | architect | register a work item |
| `finding --item ID --sev SEV --by adversary --msg "…" [--phase spec]` | adversary, pm | file a defect (blocker/major/minor/nit); mints the item-scoped id `<ITEM>-F<n>` |
| `rebut --ref <ITEM>-F# --by defender --msg "…"` | defender | argue a finding is invalid/out-of-scope |
| `defer --ref <ITEM>-F# --by defender --msg "…"` | defender | park a minor/nit as follow-up (CLI refuses blocker/major) |
| `fix --ref <ITEM>-F# --by builder --msg "…"` | builder, architect | record a code fix (or spec revision) |
| `test --ref <ITEM>-F# --by verifier --test file[::name] --pre-sha … --post-sha … --msg "…"` | verifier | record a proving test — must name its test(s) AND both anchor commits; CI checks the tests exist |
| `attest --ref <ITEM>-F# --by verifier --file path [--kind comment] --msg "…"` | verifier | prove a **non-behavioral** fix (a test oracle, a doc, a comment — no fail→pass test can exist); names every file touched. Files outside `shipped_paths` stand on location; a comment-only change inside product code needs `--kind comment` (flagged for arbiter/human review) |
| `verdict --ref <ITEM>-F# --by arbiter --ruling accepted\|rejected` | arbiter | rule a **rebutted** finding (CLI refuses undisputed refs; `--force` = operator override) |
| `note --item ID --by ROLE --msg "…"` | any | recorded observation (e.g. the pm's "PRD conformance: clean", defer→issue links) |
| `gate --item ID --phase PHASE` | arbiter | compute a gate decision |
| `state --item ID` | any | next enabled engineering step derived from the ledger (resumable driver) |
| `status --item ID` | any | finding table + what's holding the gate |
| `metrics [--item ID]` | any | outcome & cost scorecard: outcomes, adversary precision, escapes, defer debt, phase times |
| `log --item ID` | any | raw ledger entries |

A defect discovered **after** an item shipped is an **escape**: file it with
`finding --phase post-merge` against the shipped item (it never re-blocks that item's released
gates), then fix it through a new work item. Escapes are the pipeline's headline outcome number.

Entry types are **role-checked at append time** against the declared `--by` — the "Who"
column is enforced, not advisory. The check is on the declared role, not an authenticated
identity, so going around it leaves a mark `doctor` surfaces. Full mechanics (role checks,
schema epoch, parallel-workflow merge): [internals.md](../../../SDLC/docs/internals.md).

## Reading `status`
Each finding shows flags `FTRD` (Fixed / Tested / Rebutted / Deferred) and its ruling.
A blocker/major that is neither `rejected` nor `(fixed AND tested)` is **holding the
next gate**.

## Rules
- One fact per entry; let `status`/`gate` derive conclusions.
- Severity is the adversary's; validity is the arbiter's. Don't conflate them.
- Never hand-edit `rounds.jsonl` — writes go through the CLI only (the bash-write-guard
  hook blocks shell writes, and CI rejects any PR whose ledger diff isn't append-only).
  `.sdlc/ledger/gates.json` is a derived cache — safe to delete and rebuild by re-running
  `gate`.
