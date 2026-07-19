#!/usr/bin/env python3
"""spec-ratio.py — surface the spec-to-code proportion for a work item (advisory).

A spec several times longer than the code it produces is the process failure the
architect's ~150-line budget guards against. This makes the proportion a *visible number*
the pm/arbiter and operator can manage. It is deliberately **never a gate**: a hard cap
breeds gaming and would block a dense spec that legitimately earned its length (e.g. one
that caught a design bug before a line of code was written). The number is a prompt to
review the spec for duplication / implementation-transcription / design re-derivation — not
a target.

Counts, between --base and HEAD:
  spec+design  lines of docs/specs/<n>-*.md (the design + the spec/plan)
  code         net-added lines under the manifest's `shipped_paths` (else the built-in
               default) — production code only
  tests        net-added lines under tests/ (reported for context, not in the ratio)

Usage: python SDLC/scripts/spec-ratio.py --item ISSUE-39 [--base <sha>]
Always exits 0 (advisory). Prints a machine-readable `ratio=<x>` last line for CI/dossier.
"""
from __future__ import annotations
import argparse, re, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

sys.path.insert(0, str(ROOT / "SDLC" / "lib"))
import manifest                                   # the one shared resolver (CI always has the full tree)


def _shipped_paths() -> tuple[str, ...]:
    """Production-code dirs — the same `manifest.shipped_paths()` seam the hooks read."""
    return manifest.shipped_paths()


def _added(base: str, paths) -> int | None:
    """Net-added lines (added − deleted) under `paths` between base and HEAD, or None if
    the diff can't be computed (unknown base) — advisory, so a failure is not fatal."""
    try:
        r = subprocess.run(["git", "diff", "--numstat", base, "HEAD", "--", *paths],
                           cwd=ROOT, capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            return None
    except Exception:
        return None
    net = 0
    for line in r.stdout.splitlines():
        cols = line.split("\t")
        if len(cols) >= 2 and cols[0].isdigit() and cols[1].isdigit():
            net += int(cols[0]) - int(cols[1])
    return net


def _spec_lines(item: str) -> tuple[int, list[str]]:
    """Total lines of the item's design + spec docs under docs/specs/ (spec+design LOC).
    Matches both naming conventions in the tree — `<n>-<slug>.md` / `<n>-<slug>-spec.md`
    and `<ITEM>.md` / `<ITEM>-*.md` — anchored on a trailing `-` or `.md` so `ISSUE-3`
    never picks up `ISSUE-31`'s files and `9-` never matches `39-…`."""
    m = re.search(r"(\d+)$", item)
    specs = ROOT / "docs" / "specs"
    if not (m and specs.is_dir()):
        return 0, []
    pat = re.compile(rf"^(?:{re.escape(m.group(1))}-|{re.escape(item)}(?:-|\.md$))")
    files = sorted(f for f in specs.glob("*.md") if pat.match(f.name))
    total = sum(len(f.read_text().splitlines()) for f in files)
    return total, [f.name for f in files]


def main():
    p = argparse.ArgumentParser(description="Advisory spec-to-code ratio for a work item")
    p.add_argument("--item", required=True)
    p.add_argument("--base", default="origin/main", help="diff base (CI passes the merge base)")
    p.add_argument("--warn-threshold", type=float, default=None,
                   help="emit a ::warning annotation when the ratio is at or above this (CI); still exits 0")
    a = p.parse_args()

    spec, files = _spec_lines(a.item)
    code = _added(a.base, _shipped_paths())
    tests = _added(a.base, ("tests/",))

    if not files:
        print(f"spec economy [{a.item}]: no design/spec docs under docs/specs/ for {a.item} "
              f"(looked for '<n>-*.md' and '{a.item}*.md') — nothing to measure.")
        print("ratio=n/a")
        return 0
    if not code or code <= 0:
        print(f"spec economy [{a.item}]: spec+design {spec} lines"
              f" ({', '.join(files)}); code delta unavailable vs {a.base} — ratio not computed.")
        print("ratio=n/a")
        return 0

    ratio = spec / code
    tail = f"  · tests +{tests}" if tests and tests > 0 else ""
    print(f"spec economy [{a.item}]: spec+design {spec} lines / code +{code} (net) "
          f"= {ratio:.1f}:1{tail}")
    print(f"  ({', '.join(files)}; architect budget ~150 spec lines. Advisory — a high "
          f"ratio prompts a spec review for duplication / implementation-transcription / "
          f"design re-derivation, never a gate.)")
    print(f"ratio={ratio:.1f}")
    if a.warn_threshold is not None and ratio >= a.warn_threshold:
        print(f"::warning title=spec economy::spec-to-code ratio is {ratio:.1f}:1 for {a.item} — "
              f"review the spec for duplication / implementation-transcription / design "
              f"re-derivation (advisory, never blocks)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
