---
description: ENGINEERING workflow — entered by continuation from the product workflow at PRD ratification (or by the `sdlc-build` label as manual entry / dead-session restart), it claims the issue, opens the PR, snapshots the ratified PRD, and drives SPEC → BUILD → TEST → MERGE on that PR in ONE long-running session. State is derived from the ledger (resumable).
argument-hint: "[issue number] (optional — inferred from the triggering issue/PR)"
allowed-tools: Read, Grep, Glob, Edit, Write, Bash, Task, mcp__github
---

# ENGINEERING — one session, lived on the PR

Engineering runs in **one long-running session**. It is entered **once** per issue — normally
by **continuation**: the product session that handles `@claude continue` claims the branch,
opens the PR, and carries on as this driver ([sdlc-product.md](sdlc-product.md) §4). The
**`sdlc-build`** label is the state marker and the event-based entry for the other two cases —
a human skipping product (the issue body is then the ratified PRD) and restarting a cycle
whose session died. From the claim on, the session **follows the PR itself** using Claude
Code's built-in PR-activity subscription (`subscribe_pr_activity`). All operator interaction
happens **on the PR**; the issue holds the ratified PRD and is touched again only to link the
PR and report the outcome. Routing, operator authorization, the untrusted-text envelope, and
the 👀-claim rule are in [sdlc.md](sdlc.md) and apply throughout.

**One session per issue is guaranteed by a branch mutex:** on kickoff the session claims the issue by
atomically creating `claude/sdlc-issue-<n>` through the GitHub API; any other session for the same
issue finds the branch already there and **closes immediately** (§1). The one owning session then stays
alive by following the PR, and within it the cycle is a **resumable state machine** — the next step is
recomputed every turn from the ledger (`sdlc.py state`) plus the PR/issue state, so each webhook wake-up
and self-check-in picks up from the same authoritative place with no step redone. Methodology:
`SDLC/docs/methodology.md`. Ledger CLI: `SDLC/sdlc.py`. Subagents: `pm`, `architect`, `adversary`,
`defender`, `builder`, `verifier`, `arbiter`.

## 0. Entry — figure out what woke you, and acknowledge it FIRST

Every run begins one of four ways. Identify which, then **acknowledge before doing any real work**:

- **Continuation from the product workflow** — the normal entry: you arrive here from
  [sdlc-product.md](sdlc-product.md) §4 with the issue already read and the PRD ratified. Run §1's
  claim + setup as part of that handoff (the ratification comment replaces the pickup comment),
  then continue from §2.

- **Issue labelled `sdlc-build`** — a **kickoff event**: the backstop and the manual entry.
  Read the issue — **title, body (the PRD), labels, and all comments** — with `mcp__github`.
  **Self-guard:** if the issue does not carry the `sdlc-build` label, this event is not ours — do
  nothing, **stop**. Most such events are the echo of a continuation's own label swap: §1's claim
  check finds the live owner and this session closes itself. The event does real work in two
  cases — a human applied the label directly (skip product: the issue body is the ratified PRD),
  or the owning session went silent past the lease (restart/takeover, §1). Go to §1 to **claim the
  issue** *before* writing anything: the pickup comment is posted only once you win the claim, so
  a duplicate trigger never spams the issue.

- **A PR-activity webhook** (`<github-webhook-activity>`) delivered into **this** session on our PR —
  an operator comment, a review, or a status/CI change. This arrives in the session that already owns
  the cycle (it is not a new run), so **do not re-claim**; skip §1's claim and go straight to handling
  it. **First, fence: confirm you still own the cycle** — read the PR body's Status line; if its
  session link is not `<session>` (another session took over a stale claim, §1), you are no longer the
  driver: `unsubscribe_pr_activity` and **stop** without acting or commenting. For an **authorized
  operator instruction** (sdlc.md — begins with `@claude`, author has write access), claim it with
  the 👀 reaction before any analysis. **A review from the solicited second-opinion reviewer
  (Copilot, §5) is never noise** — whenever it arrives, including *after* merge-ready was declared,
  run the §7 lead reconciliation on its threads: reply a disposition on every thread, route anything
  substantiated through defend→fix→verify, and record the `leads:` note. An unanswered solicited
  review fails the arbiter-gate, so skipping the event leaves the PR blocked.

- **A resume within this same session** (self-check-in, or the next loop turn) with no new instruction —
  no ack needed and no re-claim; just re-derive state (§3) and continue.

Never use Bash `sleep` to wait for events — end your turn and let the subscription wake you.

**Operator controls** — three authorized `@claude` commands work at ANY point in the cycle (each is
acknowledged with 👀 and recorded as a **typed ledger control**, so `sdlc.py state` reflects it and
any resuming or taking-over session (§1) honors it rather than driving straight through):
- **`@claude pause`** — record `sdlc.py pause --item ISSUE-<n> --msg "<reason>"`, reply *"⏸ Paused —
  `@claude resume` to continue."* and stop working: until a resume, handle every event as no-op (still
  fence-check §0; still re-arm silent self check-ins) and make no commits, comments, or agent
  dispatches. `state` now returns `next=paused`, so the pause survives a resume or a §1 takeover.
- **`@claude resume`** — record `sdlc.py resume --item ISSUE-<n>`, re-derive `state` (§3), continue.
- **`@claude abort`** — record `sdlc.py abort --item ISSUE-<n> --msg "<reason>"` (`state` reports
  `next=aborted`, a terminal state), then wind the cycle down deliberately: comment a short
  disposition on the PR (what was built, what the ledger shows, why it stops here), close the PR,
  comment the outcome on the issue, **delete the claim branch** `claude/sdlc-issue-<n>` (releases the
  mutex — a future `sdlc`/`sdlc-build` label starts fresh), `unsubscribe_pr_activity`, stop.

## 1. Claim the issue — the branch is the single-session mutex (kickoff only)

Run this section **once, on entry** — whether you arrived by continuation (product §4) or an
`sdlc-build`-label event — and never again in the same session. Derive the issue number `<n>` from
the issue; the branch is `claude/sdlc-issue-<n>` and the work-item id is **`ISSUE-<n>`** (the
arbiter-gate check keys on this form).

- **Atomically claim the branch via the GitHub API.** Call `mcp__github__create_branch` for
  `claude/sdlc-issue-<n>` from the default branch. GitHub's create-ref is server-side atomic, so exactly
  one racing session can create it:
  - **The call fails because the branch exists but no open PR has it as head →** the branch is a
    leftover, not a rival: the product workflow's own artifact commits (a crashed handoff, or
    design-facet mockups pushed before ratification). **Adopt it** and continue with the setup below —
    opening the PR is then the atomic claim: if `create_pull_request` fails because a PR for this head
    already exists, another session just won the race; re-read that PR and fall through to the
    owner-liveness check.
  - **The call fails and an open PR exists →** another session claimed this issue's cycle.
    **The claim is a lease, not a tombstone** — check whether that owner is alive before standing down:
    read the branch's last commit timestamp and the PR body's Status line. If the last checkpoint is
    **less than 24 hours old, or the cycle is legitimately parked on an operator checkpoint** (Status
    says it awaits `@claude continue`), the owner is live — do not start a second driver. Do not
    comment, do not open a PR, do not subscribe — **close this session immediately**. If the last
    checkpoint is **over 24 hours old with no awaited operator input** (the owning session's container
    is gone — ephemeral sessions die), **take over**: comment on the PR *"Previous session went silent;
    taking over from the last checkpoint. Follow along: `<session>`"*, rewrite the PR body's Status
    line so its session link is `<session>` (this fences the old owner out — every session verifies
    that link on wake, §0), subscribe to the PR, and resume from `sdlc.py state` (§3). Never redo
    completed steps — the ledger is the same authoritative record the dead session left.
  - **The call succeeds →** you own the cycle. Continue below.
- **You won the claim — now set up, in order:**
  1. **Label-entry only:** post the pickup comment on the issue (`add_issue_comment`), verbatim shape:
     *"👀 Engineering picked up — opening the PR now; all further interaction happens there. Follow
     along: `<session>`."* (On a continuation, product §4's ratification comment serves this purpose —
     posted after the PR exists so it can carry the link.)
  2. Put one stub commit on the branch so the PR has a diff — `git fetch origin claude/sdlc-issue-<n>`,
     check it out, `git commit --allow-empty -m "sdlc(ISSUE-<n>): open cycle"`, push. (Skip if the
     adopted branch already carries commits.)
  3. Open a **draft** PR (`create_pull_request`): body `Closes #<n>` plus the status block from §6, and a
     **conventional-commit title** (see below).
  4. **Subscribe to the PR** with `subscribe_pr_activity` — the built-in mechanism that makes this one
     session follow the PR's comments and status changes. Winning the claim already guarantees
     you're the sole owner, so this just starts the feed.
  5. **Make the labels current:** ensure `sdlc-build` is present and `sdlc` removed — add before
     remove, and only once the PR exists, so the state marker never points at nothing. (On a label
     entry they're usually right already; also comment on the **issue** linking the PR:
     *"Engineering PR opened: <PR link>."*)
  6. **Refresh the PR body** (§6) so Status + phase checklist + `<session>` link are current.
- Then go to §2 to open the ledger item — do **not** stop here.

**PR title — always conventional-commit form `type(scope): summary`.** Never `SDLC: …`. Pick `type` from
what the issue actually is — `feat` (new capability), `fix` (bug), `chore`/`docs`/`refactor`/`test`/`perf`
as appropriate — and make `scope` the affected sub-module when there's an obvious one (e.g.
`feat(auth): login throttling`, `fix(todo): drop duplicate ids`); omit the scope when nothing fits. The
summary is imperative and lower-case. At kickoff infer the best title from the PRD; if the spec later
changes what's really being built, **update the PR title** in the same turn so it stays an accurate
conventional-commit label for the branch.

## 2. Open the item & snapshot the PRD (kickoff only, right after §1)

- **Read the size** from the PRD's `**Size:**` line. If absent (a human labelled `sdlc-build`
  directly), apply the sizing rubric in [sdlc-product.md](sdlc-product.md) §2 yourself — but an
  **epic never builds**: comment on the issue that it needs a product split (remove `sdlc-build`,
  add `sdlc`), release the claim (delete the branch, close the PR) and stop.
- `sdlc.py open --item ISSUE-<n> --title "<issue title>" --size <size>`, then **snapshot the
  ratified PRD** from the issue body into the **PRD file** (naming below) — the PRD text only, minus
  the collapsed original-request block. On a **trivial** item the issue text is the PRD; snapshot it
  verbatim. **The PRD file is what every other agent references by path** (architect, builder, pm).
  Leave the issue body alone — it already holds the ratified PRD verbatim, and nothing edits it
  again until the final outcome comment (§7). Give the PR body's `## PRD` section a one-paragraph
  summary + a link to the file.
- Checkpoint (§6), then fall through to §3.

**Spec file naming — descriptive, not opaque.** Name the two spec files with a short human-readable
slug, not a bare `ISSUE-<n>`:
- PRD: **`docs/specs/<n>-<slug>-prd.md`**
- technical spec: **`docs/specs/<n>-<slug>-spec.md`**

where `<slug>` is the issue title kebab-cased — lower-case, non-alphanumerics collapsed to single
hyphens, trimmed, and capped at ~6 words (e.g. issue #31 "Migrate to cloud" →
`docs/specs/31-migrate-to-cloud-prd.md` and `docs/specs/31-migrate-to-cloud-spec.md`). The `<n>-`
prefix keeps the file traceable to its issue and stable across resumes: **on any later turn, locate
the existing file by its `docs/specs/<n>-*` prefix rather than recomputing the slug**, and pass its
exact path to every agent you invoke.

**Design-facet artifacts ride along.** If the product loop ratified a design
(sdlc-product.md §3b), the brief `docs/specs/<n>-<slug>-design.md` and the mockup dir are
already committed on the adopted branch — pass the brief's path to the `architect` (its
binding states are spec requirements) and to the `pm` at TEST (its design-conformance leg)
alongside the PRD path.

## 3. Derive the current step (every turn — do not guess from context)

Run `python SDLC/sdlc.py state --item ISSUE-<n>` and act on
`next=<spec|build|test|merge|done|blocked:*|paused|aborted>` per §§4–5. If `next=paused`, the operator
paused the cycle — do no work (handle events as no-op until `@claude resume`); if `next=aborted`, the
cycle is over — do nothing. These override the engineering state, so a takeover session never resumes
through a pause or abort. (No ledger item yet means §2 hasn't run — a kickoff in progress.)

## 4. SPEC — the only human checkpoint (state = spec)

- **Kickoff of spec, or `@claude <feedback>` → author/refine the spec, then stop.** `architect` writes
  the technical-spec file `docs/specs/<n>-<slug>-spec.md` (technical spec **+** plan from the PRD);
  `adversary` challenges it for ambiguity / missing requirements / untestable claims; `architect`
  revises. Do **not** open the spec gate. Checkpoint (§6), comment the spec + open questions on the PR,
  and — as the **last** ledger action before stopping — mark the wait:
  `python SDLC/sdlc.py await --item ISSUE-<n> --for "spec continue"`
  (this keeps the operator's think-time out of the phase's active timing, §6). Then **stop** — end
  verbatim: *To advance, comment `@claude continue`. To iterate on the spec instead, reply `@claude`
  with the changes you want.*
  - **Trivial fast path:** no architect dispatch — YOU write a **mini-spec** (≤25 lines) into the
    `-spec.md` file: diagnosis (root cause, exact location), the planned fix, and the proving test
    you expect the verifier to write. One quick `adversary` pass over it (wrong-root-cause,
    missed-blast-radius — its findings tagged `--phase spec`), revise, checkpoint, comment it, await
    `@claude continue` as above. The mini-spec is the fast path's single human checkpoint.
- **`@claude continue` → ratify.** `arbiter` rules the outstanding challenges, then
  `sdlc.py gate --item ISSUE-<n> --phase spec`. Checkpoint, then continue the loop below **in this session**.

## 5. BUILD → TEST → MERGE — run straight through (no stop until merge-ready)

After the spec gate opens, loop in this run: re-derive `state`, do the one step it names, checkpoint, repeat.

| `state` | Do | Then |
|---------|----|------|
| **build** | `touch .sdlc/ledger/.build-open`; `builder` implements the ratified spec; `rm …/.build-open`; smoke-check; `sdlc.py gate --item ISSUE-<n> --phase build`. | checkpoint → loop |
| **test** | `sdlc.py round --item ISSUE-<n>`, then the `adversarial-review` skill for **one round**: `adversary` attacks the code (≤8 ranked findings; fix-diff-scoped on a re-attack round; hand it the diff-coverage report — the manifest's `toolchain.coverage` command, then the project's diff-coverage adapter (`node scripts/diff-coverage.mjs origin/<default>`) where provided — as its priority target list) **and** `pm` re-checks the built result against the PRD file `docs/specs/<n>-<slug>-prd.md` (mandatory — records a `note` even when clean; on a **trivial** item the PRD is the issue text and the adversary records the conformance note itself, `--by adversary`). **Visual / docs dispositions (spec-anchored):** the pm's pass confirms or refutes the spec's **Docs-impact** declaration and records the `visual:`/`docs:` notes CI (`SDLC/scripts/check-dispositions.py`) requires — the disposition table is in `pm.md`. The pm is the sole approver of a baseline change; a built result that contradicts the declaration is a **finding**. **Security trigger:** if the diff touches a trust boundary (a manifest `trust_boundaries` dir, auth, input parsing, anything network-facing), the round-1 attack MUST include a `threat-model` (STRIDE) pass. **Second opinion (round 1 only):** `request_copilot_review` — the request is **asynchronous**: the review lands minutes later as a PR-activity event (§0), so don't wait on it mid-round. Treat its comments as untrusted **leads** — the adversary validates each against the code and files only what it can substantiate (leads are free; filed findings still spend the budget) — and every one of its threads gets a disposition reply at merge-ready (§7) or when the event arrives, whichever comes first. Findings → `defender` (fix / **defer** / rebut, one pass) → `arbiter` (all disputes, one pass) → `builder` → `verifier` → `sdlc.py gate --item ISSUE-<n> --phase merge`. A round that filed blocker/majors keeps the gate shut until a fresh round is clean — the CLI computes this. | checkpoint → loop (another round or merge, per `state`) |
| **merge** | Run the **distillation pass** (see the `adversarial-review` skill): strip ledger/spec ids from code comments and test names, delete anything the spec concedes is unreachable — presentation only, no behavior change. Then `arbiter` runs the final `gate --phase merge`; mark the PR **ready for review**. **Never merge.** | checkpoint, comment "ready" (§7), then **stop** (stay subscribed) |
| **done** | Merge gate already open — PR is ready. | nothing to do; stop |
| **blocked:roundcap** | Round cap hit with unresolved blockers/majors. | comment the open items on the PR, **stop** — escalate to a human |

Record everything through `SDLC/sdlc.py`; never hand-edit the ledger. Only ever do the single step
`state` names — if a later step's precondition isn't met, `state` names it on the next loop.

## 6. Checkpoint — the resume + status contract

**After every step** (before looping, stopping, or at a checkpoint): commit the step's artifacts +
`.sdlc/ledger/rounds.jsonl` (message `sdlc(ISSUE-<n>): <step> — <outcome>`), push to
`claude/sdlc-issue-<n>` (with `-u origin`), and **refresh the PR body** to the template in
`SDLC/templates/pr-body.md` (read it) so it always reflects live state — Status line, phase checklist
with per-phase durations, PRD summary + link, Open questions, and the Timing + Ledger detail blocks.

The Status line **must always** carry the current step **and** the `<session>` link — that link is also
the **ownership fence** (§0/§1): whichever session the Status line names is the one driver, and every
session verifies it on wake. This checkpoint is the resume contract: because state is a pure function of
the committed ledger, the owning session re-derives `state` on every turn — each webhook wake-up and
self-check-in picks up exactly here, with no step redone, and a §1 takeover resumes from the same
committed checkpoint losslessly.

Because webhook events don't cover everything (CI success, a human's push, a merge-conflict transition
can be silent), before ending a turn where you're waiting, schedule a self check-in ~1 hour out
(`send_later`, claude-code-remote MCP — fires back into **this** same session, not a new one); when it
fires, re-read the PR's state/CI/mergeability, act on anything actionable, else re-arm silently. Stop the
check-ins once the PR is **merged or closed**.

## 7. Comment

On the **PR**, comment after the spec checkpoint (prose summary of the spec + open questions) and at
merge-ready.

**At merge-ready, three obligations, in order:**

1. **Close the defer debt.** For every finding deferred this cycle, create a follow-up issue
   (`issue_write`; one rollup issue is fine when the defers are small and related) and record the link
   on the ledger: `sdlc.py note --item ISSUE-<n> --by defender --msg "deferred <F-ids> → issue #<m>"`.
   A defer with no tracked follow-up is scope creep's quiet exit — `doctor` flags it.

2. **Reconcile solicited review threads.** List the PR's review threads (`pull_request_read` →
   `get_review_comments`). Every thread from the solicited second-opinion reviewer (Copilot, §5)
   must carry a **disposition reply** before merge-ready is declared:
   - **fixed** — name the finding id / commit that landed it;
   - **covered** — name the exact test (`file::name`), which must exist in the tree — the same bar
     as a ledger `test` entry: "already covered" with no named test is an assertion, not a
     disposition;
   - **rebutted** — a reasoned explanation of why the lead doesn't hold.
   A lead that needs a code change goes through defend→fix→verify like any finding *first* — the
   item is not merge-ready while a substantiated lead dangles. Then put it on the record:
   `sdlc.py note --item ISSUE-<n> --by defender --msg "leads: <k> copilot thread(s) reconciled —
   <thread → disposition, one line>"`. If the round-1 request never produced a review, record the
   absence instead (`leads: copilot review requested, never delivered`) — don't silently proceed.
   CI fails the arbiter-gate while any Copilot thread has no reply, and a review that lands *after*
   merge-ready arrives as an event you must reconcile the same way (§0).

3. **Post the reviewer dossier** — the human approval is the gate everything else leans on; this
   comment is its map. Assemble it per the template in `SDLC/templates/reviewer-dossier.md` (read
   it): TL;DR, review map, adversarial record, second-opinion leads, docs impact, diff coverage,
   spec economy, metrics, and how-to-verify.

When a human merges, `Closes #<n>` auto-closes the issue; comment the outcome on the **issue**
(`✅ Shipped in #<pr> (merged).` / `❌ Closed without merging #<pr>.`). **If this issue is a child of
an epic split (sdlc-product.md §5):** tick its box on the parent issue's tracking checklist and, if an
unstarted sibling is next in the recorded order, apply the `sdlc` label to it — that is what chains the
sequential children (each child runs its own product pass; a child whose PRD seed is already ratified
goes straight through). Then `unsubscribe_pr_activity` and stop.

**Escapes & the incident lane (post-merge defects).** If a defect traced to a shipped item surfaces
later, record it as `sdlc.py finding --item <shipped-item> --sev <sev> --by adversary
--phase post-merge --msg "…"` — escapes never re-block the released item's gates; they are the outcome
number (`sdlc.py metrics`) that says whether this pipeline is actually working. Then route the fix
through the **incident lane**: create a fresh issue describing the escape (link the finding id and the
shipped PR), size it per the product rubric — an escape is usually **trivial** (diagnosis + contained
fix + proving test on the fast path); a revert is always trivial — and label it `sdlc` so a new cycle
picks it up.

## Guardrails
- **One issue, one session, one PR — enforced by the branch mutex, recovered by the lease.** Entry is
  the product continuation or the `sdlc-build` label; both funnel through §1's claim: you own the cycle
  by atomically creating `claude/sdlc-issue-<n>` via the GitHub API (or, adopting a PR-less leftover
  branch, by winning the PR creation); if a live owner holds the claim, you **close immediately**; if
  the owner has been silent past the 24-hour lease, you **take over** and fence the old owner out via
  the PR-body session link (§1). The 24-hour lease is a driver constant — a prose convention in this
  file, not a code-enforced value. Everything after is the PR-activity subscription feeding the one
  owning session. Idempotency backs it up inside that session: before any action, check it isn't
  already done (ledger item opened? gate already open? round already recorded?) so a duplicated
  webhook is safe.
- **Flaky tests: retry once, then quarantine — never delete, never loop.** A test that fails then
  passes untouched gets ONE retry across the cycle. On the second flake, quarantine it (`.skip` with a
  comment), record an operator-visible ledger note, and open a follow-up issue — CI's quarantine watch
  keeps the list loud. Green-by-retry is not green; a suite the agents learn to distrust corrupts
  every gate downstream.
- **The PRD is ratified input — engineering never rewrites product intent.** The spec builds on the
  snapshot PRD file; if the spec or build reveals the PRD is wrong or the size was misjudged (a
  "standard" item turns epic), say so on the PR and resolve it with the operator — a real product
  change goes back through the product workflow (relabel `sdlc`), never a silent self-rewrite.
- **Spec is the only human stop inside engineering.** After `@claude continue` ratifies it,
  build → test → merge run straight through in this session. Claude marks the PR ready but **never merges**
  — a human merges (needs their approval **and** a green arbiter-gate).
- **Protected directories — do not modify `.github/`, `.claude/`, or `SDLC/` while running the cycle**
  (unless a manifest `shipped_paths` entry names one of them as the product under development —
  then the build gate governs it like any shipped code). Cycle work writes the PRD/spec files
  (`docs/specs/`), the manifest's `shipped_paths`, and tests only; the ledger is updated
  solely through `SDLC/sdlc.py`. If a step genuinely needs a change to one of these,
  **stop**, comment on the PR with the exact file(s) and reason, and wait for the operator to make it a
  deliberate, approved change — never a silent self-rewrite.
