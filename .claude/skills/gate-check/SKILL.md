---
name: gate-check
description: Decide whether a phase gate may open for a work item, strictly from the ledger. Use to check if a spec or merge gate passes, whether a change is clear to advance, or what's blocking progress.
---

# Gate check

Compute a phase gate decision for a work item from the append-only ledger. Gates are
the hard stops of the adversarial SDLC — this never opens one on assertion, only on
record. Normally run as the `arbiter`.

## Run it
```
python SDLC/sdlc.py gate --item <ID> --phase <spec|build|attack|defend|verify|merge>
```
The CLI is the source of truth for the rule — do not re-derive it by hand. In brief: a gate is
**OPEN** only when every blocker/major finding is **rejected** by the arbiter or **fixed + proven**
(spec-phase findings: fixed by the spec revision alone); nits/minors never hold a gate. The
**merge** gate also requires the spec/build gates open, ≥1 round, and a clean latest round. Full
statement: [methodology.md](../../../SDLC/docs/methodology.md) "Phases & gates".

## Reading the result
- `✅ OPEN` → the item may advance to the next phase.
- `⛔ BLOCKED` → each line says why (`awaiting arbiter ruling` vs `accepted, awaiting fix+test`),
  or the latest round is dirty (re-attack required), or a prior phase hasn't passed.
- `⚠ round cap reached` → escalate to the human operator; do not start another round.

## Before claiming a gate
- Inspect state first: `python SDLC/sdlc.py status --item <ID>`.
- If something looks resolved but the gate still blocks, the *record* is incomplete — a missing
  `verdict`, `fix`, or `test` entry. Add the missing entry; do not bypass the computation.

## Human override
The operator may force a gate. Log it in the ledger so the override is on the record.
