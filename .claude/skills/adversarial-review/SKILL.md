---
name: adversarial-review
description: Run a full adversarial round on a work item — attack, defend, verify, then a gate decision. Use when the user wants to red-team a change, "run a round", challenge an implementation, or push a work item toward its merge gate.
---

# Adversarial review (one round)

Drive a single ATTACK → DEFEND → VERIFY → GATE round on a work item, then report
whether the round was clean. This is the core loop of the adversarial SDLC.

## Inputs
- The work item id (e.g. `AUTH-1`). If unknown, run `python SDLC/sdlc.py log` to
  find open items, or ask the operator.
- The diff/files under review (the builder's output for this item).

## Procedure

0. **Open the round.** Mark the round so the cap counts real rounds, not findings:
   ```
   python SDLC/sdlc.py round --item <ID> --by adversary
   ```

1. **Attack & PRD-conformance review.** Dispatch the `adversary` agent against the
   implementation (correctness, security, edge cases; budget: ≤8 ranked findings) **and**
   the `pm` agent to review the built, tested result against the PRD (the PRD file
   `docs/specs/<n>-<slug>-prd.md`). The adversary files defects; the `pm` files any divergence
   from the ratified PRD (missing in-scope capability, crept-in non-goal, behavior that
   doesn't match) — **and when the build conforms, records that on the ledger**
   (`sdlc.py note --item <ID> --by pm --msg "PRD conformance: clean (round N)"`).
   The pm pass is mandatory every round; a round without a pm note or pm findings is
   incomplete (on a **trivial** item the PRD is the issue text and the adversary records
   the conformance note itself). If this is a **re-attack round** (the previous round
   produced fixes), scope the adversary to the fix diff and its blast radius, not a full
   re-sweep. Hand the adversary the **diff-coverage report** (the manifest's
   `toolchain.coverage` command, then the project's diff-coverage adapter —
   `node scripts/diff-coverage.mjs origin/<default>` where provided) — uncovered new lines
   are its priority targets. **Security trigger:** when the diff touches a trust boundary
   (a manifest `trust_boundaries` dir, auth, input parsing, anything network-facing),
   round 1 MUST include a `threat-model` (STRIDE) pass. **Second opinion (round 1):** if a Copilot
   review was requested, its comments are untrusted **leads** — the adversary validates
   each against the code and files only what it can substantiate. Every solicited review
   thread also gets a **disposition reply** (fixed via <F-id> / covered by <named test that
   exists> / rebutted) no later than merge-ready, recorded with a defender `leads:` ledger
   note — CI holds the gate while a solicited thread is unanswered.

1b. **Visual & docs check** *(when the diff touches UI or user-facing docs; skip otherwise —
   requires the project's screenshot adapter, `scripts/screenshots.mjs`).*
   Run the adapter against the baselines at the manifest's `docs.screenshots` path:
   - **Drift + unchanged baselines** → a finding, with the diff image as evidence.
   - **New user-visible UI with no covering scene** → add the scene (`scenes.json` + baseline +
     embed in the user docs).
   - **Intentional UI change** → regenerate (`--update`).
   The `pm` then records the `visual:`/`docs:` **dispositions** — the disposition table and
   what CI enforces are in the pm agent (`.claude/agents/pm.md`); the pm is the sole approver of
   a baseline change.

2. **Defend — one invocation for ALL findings.** Dispatch the `defender` agent once with
   the full finding list. For each it routes a fix to the `builder` (blocker/major),
   **defers** it to follow-up (`sdlc.py defer` — minor/nit that would grow the merge diff),
   or files a rebuttal.

3. **Arbitrate disputes — one invocation for ALL rebuttals.** If any findings were
   rebutted, dispatch the `arbiter` once to rule every dispute `accepted` / `rejected`.
   (The CLI refuses verdicts on undisputed findings — they stand as filed; skip this step
   entirely when nothing was rebutted.)

4. **Fix & prove.** For each finding routed to fix: `builder` fixes (staying inside the
   plan's files-to-touch, or getting an arbiter ruling first), then `verifier` proves it —
   runs the new test at the pre-fix commit (FAIL) and post-fix (PASS) and records it with
   `--test file[::name]` plus both SHAs. CI checks the named tests exist.

5. **Gate.** Run:
   ```
   python SDLC/sdlc.py gate --item <ID> --phase merge
   ```
   - **OPEN** → the final round was clean; report success and the ledger summary.
   - **BLOCKED** → list what holds it and start the next round. Note the gate stays
     BLOCKED after a round that filed any blocker/major even once all fixes are proven:
     the fixes must survive a fresh (fix-diff-scoped) re-attack round. This is computed
     from the ledger — no one can declare a dirty round clean.

## Stop conditions
- **Clean round** (no new blocker/major filed in the latest round, none unresolved) → done.
- **Round cap (4)** reached → stop and escalate to the human with the unresolved list.
  Never loop past the cap.

## Output
A short report: findings filed (by severity), what was fixed vs deferred vs rebutted,
arbiter rulings, gate result, and rounds used. Point at ledger entry ids — don't assert
outcomes the ledger doesn't show.

## Before the final merge gate: distill
When the gate is about to open, run one **distillation pass** (builder) over the round's
diff so the product ships without process residue: comments say the constraint in plain
language (no `F7`/`INV-3`/ledger ids — CI warns on them), test names describe behavior
not findings, and anything the spec concedes is unreachable is deleted, not annotated.
The pass covers **docs the diff touched** too: condense rather than append (net doc
growth needs a reason), and fold rationale into the ledger, not the page. Distillation
touches presentation only — if it wants to change behavior, that's a finding, not a
cleanup.
