# The Adversarial Agentic SDLC — methodology

Software here advances only by surviving a deliberate attack. A **blue team** builds, a
**red team** attacks, and a neutral **arbiter** opens each gate strictly from an append-only
**ledger** — never because an agent says the work is done. Quality is *earned*, not asserted.

One agent that builds *and* judges its own work shares blind spots across both roles.
Splitting into opposed incentives — one rewarded for shipping, one for finding what's wrong —
surfaces defects a cooperative reviewer would wave through. The system is **adversarial in
incentives, cooperative in outcome**.

## Two phases, one session

Both phases run in **one long-running session** on the **PR** (triggered once by the `sdlc` issue
label; the design is mirrored back to the issue):

- **Product/design** — lightweight and human-driven. The `pm` agent and the operator refine intent
  through explicit questions. No adversary, arbiter, or ledger; its only bar is that the operator
  approves the design. Advances on `@claude continue`.
- **Engineering** — the adversarial cycle. Two teams and a referee, backed by the ledger.

## Sizing — the pipeline is priced per issue

Before any phase runs, the issue is sized (`open --size …`, recorded on the ledger):

- **trivial** — obvious, contained fix. Fast path: PRODUCT skipped (the issue text is the
  design), a ≤25-line mini-spec instead of a full one, one diff-scoped round. Proof stays
  (real round, proving test, gates); ceremony goes.
- **standard** — fits one reviewable PR. The full cycle below.
- **epic** — too big for one reviewer to hold. **Never builds directly**: the operator
  approves a split into 2–4 independently shippable child issues, each running its own
  cycle sequentially; the parent becomes a tracking checklist.

## Teams & referee (engineering)

| Team | Agent | Wins when… |
|------|-------|------------|
| Blue | `pm` | the design is clear, the operator approves it, and the built result matches it |
| Blue | `architect` | the spec + plan is unambiguous and survives scrutiny |
| Blue | `builder` | the implementation satisfies the ratified spec |
| Blue | `defender` | every finding is fixed or convincingly rebutted |
| Blue | `verifier` | tests exist that *prove* the fix and would catch the regression |
| Red | `adversary` | a real defect, vuln, or unhandled edge case is found and admitted |
| — | `arbiter` | the record is honest and the gate decision is defensible |

The `adversary` is the heart of engineering — graded on the severity and validity of what it
finds, never on being agreeable. The `arbiter` is neutral: it scores rounds and decides whether
a gate opens.

## Phases & gates

**PRODUCT** is human-only (design on the PR, mirrored to the issue); the rest is the adversarial
engineering cycle, where each **gate** is a hard stop owned by the `arbiter`.

```
  PRODUCT ═══(@claude continue)══▶ SPEC ──▶ BUILD ──▶ ATTACK ──▶ DEFEND ──▶ VERIFY ──▶ MERGE
  (PR)                             │                    ▲           │                   │
  human + pm                       gate                 └───────────┘                   gate
  (approve)                      (ratify)          adversarial round loop            (release)
```

1. **PRODUCT** *(PR, human-only)* — `pm` turns the request into a clear design (what & why
   for users, not how), asking the operator until they approve. May embed high-level
   architectural direction only where it's critical to the feature. Gate: `@claude continue`.
2. **SPEC** — `architect` writes the technical spec **and** implementation plan in one document
   from the ratified design. `adversary` attacks it both for correctness (ambiguity, missing
   requirements, untestable claims) **and for economy** — duplication, implementation-transcription,
   design re-derivation, over-budget length — so the loop can *remove* spec, not only add it; the
   `spec economy` ratio (advisory) makes the proportion visible. Gate: spec ratified (the only human
   checkpoint in engineering).
3. **BUILD** — `builder` implements the ratified spec. Nothing else.
4. **ATTACK** — `adversary` red-teams the implementation and files **findings** (severity:
   blocker / major / minor / nit; budget `finding_budget` in `SDLC/constants.json`, ranked — rejected
   findings count against the adversary's record). Its priority targets are the diff's
   **uncovered new lines** (diff coverage — informational, never a threshold). When the diff
   touches a trust boundary, round 1 must include a **STRIDE threat-model pass**; CI's semgrep
   and dependency-audit jobs are the mechanical floor beneath it. In round 1 a **Copilot
   review** supplies second-lineage *leads* the adversary validates before filing. In the
   same round the `pm` re-checks the built result against the **design** — mandatory,
   recorded on the ledger even when clean (`note`) — and files a finding on any divergence.
   The pm also confirms or refutes the spec's **Docs-impact declaration** with a
   `visual:`/`docs:` **disposition** and is the sole approver of a baseline change; a delivered
   change that contradicts the declaration is a finding. Mechanics and the disposition table
   live in [pm.md](../../.claude/agents/pm.md) and are enforced by
   `SDLC/scripts/check-dispositions.py`.
5. **DEFEND** — `defender` resolves each finding: **fix** (change code — blocker/major),
   **defer** (park a minor/nit as follow-up work instead of growing the merge diff), or
   **rebut** (argue it's invalid/out-of-scope, on the record).
6. **VERIFY** — `verifier` proves each fix **mechanically**: runs the new test at the
   pre-fix commit (must fail) and the post-fix tree (must pass), then the full suite. The
   ledger entry names the test and both commits; CI checks the named tests exist **and
   re-executes the claim** (`SDLC/lib/spot_check.py` re-runs them at the recorded pre-fix
   commit — a test that passes there is a disproven claim and fails the gate). A fix
   without a proving test does not count.
7. **MERGE** — `arbiter` opens the gate only when there are **zero unresolved
   blockers/majors**, every fix has a proving test, and the **latest round is clean**.

ATTACK → DEFEND → VERIFY is a **round**. The loop ends on a clean round (no new
blocker/major) — and that is **computed from the ledger**, not declared: a round that filed
any blocker/major keeps the merge gate shut until a fresh round (scoped to the fix diff)
survives with none, so fixes are always themselves attacked before release.

## The ledger

Every consequential event is appended to the append-only record `.sdlc/ledger/rounds.jsonl` — the
single source of truth. It lives outside `SDLC/` (configurable via the manifest's `ledger_dir`)
so the framework directory stays immutable. Agents may not claim a gate is satisfied; they point at ledger entries
that prove it. Entry types: `open`, `finding`, `rebut`, `defer`, `fix`, `test`, `verdict`,
`round`, `note`, `gate`. Because the record is authoritative, the current position in the
cycle is a pure function of it (`sdlc.py state`), which makes the pipeline resumable.

For the record to be worth trusting, the CLI makes its claims **checkable** rather than
honor-system — entries are role-checked at append time, a `verdict` requires a prior `rebut`, a
`test` must name its test(s), and CI rejects any non-additive ledger diff. The check is on the
*declared* role, not an authenticated identity, so its strength is that going around it leaves a
mark the `doctor` and the append-only CI diff surface. Mechanics — entry schema, role checks,
state derivation, and parallel-workflow merge — are in **[internals.md](internals.md)**.

## Stop conditions

- **Round cap:** `round_cap` in `SDLC/constants.json` (4) per item; hitting it escalates to the human.
- **Finding budget:** `finding_budget` in `SDLC/constants.json` (8) per round — the adversary ranks
  and files only what it can defend; rejected findings count against its record.
- **No re-litigation:** a finding the arbiter has ruled on can't be re-filed in the same form.
- **Severity discipline:** nits/minors never block a gate — only blocker/major do — and may
  be **deferred** to follow-up work rather than fixed in the merge round.
- **Human override:** the operator can force any gate open or shut, itself a ledger entry
  (e.g. `verdict --force`).

## Running a cycle

Operator quickstart is in **[../../CLAUDE.md](../../CLAUDE.md)**; the ledger CLI is
`python SDLC/sdlc.py --help`. To set up the routine that runs the whole cycle from GitHub, see
**[SETUP.md](SETUP.md)**.
