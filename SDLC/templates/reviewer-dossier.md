# Reviewer dossier template

The engineering driver (`.claude/commands/sdlc-engineering.md` §7) posts this as the merge-ready PR comment — the human
approval is the gate everything else leans on, and this comment is its map. Assemble these
sections in order:

- **TL;DR** (≤10 lines): what changed, why, and the one or two places a reviewer should spend
  their attention.
- **Review map**: a short table, file → what changed there → what to check.
- **Adversarial record**: `<details><summary>Findings &amp; outcomes</summary>…</details>` — each
  finding one line (id, severity, attack, outcome: fixed+proven / rejected / deferred→#issue).
  "No findings" is one line. Include the pm's PRD-conformance note verbatim.
- **Second-opinion leads**: one line per solicited (Copilot) review thread → its disposition
  (fixed via <F-id> / covered by <test> / rebutted — mirroring the driver's §7.2 replies), or
  "review requested, never delivered" / "no threads". Never a vague "some leads were covered".
- **Docs impact**: which user guide pages (and scenes) this change updated, quoting the pm's
  `visual:` and `docs:` disposition notes — or their explicit "none — <why>".
- **Diff coverage**: run the manifest's `toolchain.coverage` command, then the project's
  diff-coverage adapter (`node scripts/diff-coverage.mjs origin/<default>`, where provided),
  and quote the summary line; list any uncovered new lines the adversary chose not to attack
  and why. (Informational — never a number to chase.)
- **Spec economy**: run `python SDLC/scripts/spec-ratio.py --item ISSUE-<n> --base origin/<default>`
  and quote its line (spec+PRD vs code, the ratio). Record it on the ledger so `metrics` shows
  it: `sdlc.py note --item ISSUE-<n> --by architect --msg "spec economy: <the ratio line>"`. A high
  ratio is a review prompt (duplication / implementation-transcription / PRD re-derivation),
  never a gate.
- **Metrics**: the item's `sdlc.py metrics --item ISSUE-<n>` block, collapsed in `<details>`.
- **How to verify**: 2-4 commands or clicks a human can run to see the change working.
