# Ledger internals

The ledger `.sdlc/ledger/rounds.jsonl` is the source of truth for the engineering cycle — kept
outside `SDLC/` (default `.sdlc/ledger/`, set by the manifest's `ledger_dir`) so the framework
directory is immutable. See `SDLC/sdlc.py` for the schema and CLI; this doc covers the two
properties that make it more than a log: it is a **resumable state machine** and it is
**conflict-free under parallel branches**.

## Entry types

Each line is a self-contained, timestamped record. Types: `open` (work item; carries `size`
trivial/standard/epic, which drives the driver's path but never the gate math), `finding`, `rebut`,
`defer` (a minor/nit parked as follow-up work), `fix`, `test`, `verdict`, `round`, `note` (a recorded
observation, e.g. the pm's design-conformance result), `gate`, and `await` (a marker that the cycle is
blocked on operator input, so `sdlc.py timing` can keep that wait out of a phase's active duration).

A gate opens only when every blocker/major is either **rejected** by the arbiter or **fixed + proven**
by a test; nits/minors never block. Two refinements keep the record honest:

- **Spec-phase findings** (tagged `--phase spec`, or filed before the spec gate first opened) are
  proven by the spec revision alone — no proving test exists for a document.
- **Post-merge findings** (tagged `--phase post-merge`) are **escapes** — defects that shipped. They
  never re-block the released item's gates; they feed `sdlc.py metrics` (the pipeline's headline
  outcome number) and are fixed through a new work item.
- **The merge gate requires a clean final round**, computed from timestamps: if any blocker/major was
  filed at-or-after the latest `round` marker, the gate stays shut until a fresh round attacks the
  fixes and files none.

Appends are **role-checked** (`verdict` only by the arbiter, `test` only by the verifier — see
`ENTRY_ROLES` in `sdlc.py`), a `verdict` requires a prior `rebut` (`--force` records an operator
override), and a `test` entry must name its test(s) via `--test file[::name]` (CI verifies they exist,
and the repo's test check runs them). Entries before the `schema_epoch` cutoff are grandfathered —
`doctor` reports them as non-fatal schema notes.

## The ledger as a resumable state machine

Because the record is authoritative, the *current position* in the cycle is a pure function of the
ledger — not of any live session. `sdlc.py state --item <id>` derives the one enabled next step
(`spec → build → test → merge`, or `done` / `blocked:roundcap`) from the recorded gates and rounds.
Operator lifecycle controls are part of that record too: `pause`/`resume`/`abort` are typed ledger
entries, so a paused cycle derives `paused` and an aborted one derives `aborted` (terminal) — a
resuming or taking-over session honors them instead of driving through, keeping the "state is a pure
function of the ledger" invariant true at the operator-override point.

This is what lets the cloud pipeline run as **short, ephemeral steps** instead of one long-lived
session: each step is done, checkpointed to the ledger, and the next is recomputed from scratch — so
a crashed or re-triggered run always resumes from the same authoritative state, and automatic steps
chain one bounded run at a time. Continuity lives in the record, not in memory.

## Parallel workflows

Two cycles running at once (two issues → two branches) would ordinarily collide on the single
ledger file. The record is engineered to merge instead:

- **Item-scoped ids.** Finding ids are namespaced by their work item (`ISSUE-7-F3`, not a global
  `F3`), so two branches numbering their own findings can never mint the same id.
- **Union merge.** `rounds.jsonl` is marked `merge=union` (`.gitattributes`). Every line is
  self-contained and gate/status recompute state by scanning the whole file regardless of order, so
  git safely concatenates both branches' appends instead of conflicting.

Parallel cycles on distinct items therefore append independently and merge with no conflict. Run
`python SDLC/sdlc.py doctor` after a merge to assert integrity (no duplicate ids, no dangling refs).
The one unmergeable case is two cycles on the **same** item at once — don't split one work item
across parallel branches.
