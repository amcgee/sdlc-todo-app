#!/usr/bin/env python3
"""check-dispositions.py — verify the pm's visual:/docs: dispositions against the spec's
declared impact.

The gate anchors on the change's SEMANTICS, not on which files a diff touched (a path can't
decide "did rendered output change" / "did behavior change"). Two precise signals:

  1. The architect's spec **Docs-impact** declaration — two structured lines, adversary-
     challengeable at the spec gate:
         visual: none — <why>  |  <scene-id> added — <what>  |  <scene-id> changed — <why>
         docs:   none — <why>  |  <guide-page.md>[, <page2.md>] — <what>
  2. A committed screenshot baseline changing in the diff — the ground-truth "rendered
     output moved" signal, independent of the spec (a regenerated golden always owes pm
     sign-off, else detection becomes ratification).

A pure `evaluate()` holds the whole rule so it is unit-testable without git
(SDLC/tests/test_dispositions.py); `main()` gathers the inputs from the tree + PR diff and
prints the verdict. Exit 1 (with ::error lines) iff a required disposition is missing; exit 0
otherwise.

Usage: check-dispositions.py --item ISSUE-<n> --base <merge-base-sha>
"""
from __future__ import annotations
import argparse, json, re, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

sys.path.insert(0, str(ROOT / "SDLC" / "lib"))
import manifest                                   # the one shared resolver
LEDGER_REL = str(manifest.rounds_path().relative_to(ROOT))   # e.g. .sdlc/ledger/rounds.jsonl

# A declaration line in the spec: an optional markdown bullet / bold, then the key, then
# the value. First match for each key wins. Case-insensitive.
_DECL = {k: re.compile(rf"^\s*(?:[-*]\s*)?(?:\*\*)?\s*{k}\s*:\s*\**\s*(.+?)\s*$", re.I | re.M)
         for k in ("visual", "docs")}
_SCENE = re.compile(r"([A-Za-z0-9][\w-]*)\s+(added|changed)", re.I)


def _decl(spec_text: str, key: str) -> str | None:
    """The declared value for `visual`/`docs`, or None if the spec never declares it."""
    m = _DECL[key].search(spec_text or "")
    return m.group(1).strip() if m else None


def _is_none(value: str | None) -> bool:
    """True if a declaration is the explicit 'none' form (`none — <why>`)."""
    return value is not None and re.match(r"none\b", value.strip(), re.I) is not None


def evaluate(spec_text: str | None, baseline_changed: list[str],
             changed_guide_pages: list[str], pm_notes: list[str],
             scene_ids: set[str]) -> list[str]:
    """The whole gate, as a pure function. Returns a list of failure messages (empty =
    pass). Inputs are already gathered — no git, no filesystem — so a test can drive every
    branch directly.

      spec_text          concatenated text of the item's design+spec docs, or None when
                         there is no spec file (a trivial item whose design is the issue).
      baseline_changed   changed committed baseline filenames (docs/screenshots/*.png/gif).
      changed_guide_pages docs/guide/* paths changed in the diff.
      pm_notes           pm-authored note messages added in THIS PR for THIS item.
      scene_ids          scene ids present in scenes.json.
    """
    fails: list[str] = []
    has_visual = any(n.lower().startswith("visual:") for n in pm_notes)
    has_docs = any(n.lower().startswith("docs:") for n in pm_notes)

    visual_decl = _decl(spec_text, "visual") if spec_text is not None else None
    docs_decl = _decl(spec_text, "docs") if spec_text is not None else None

    # A spec must carry both declarations (default A: two structured lines). A trivial
    # item has no spec file (spec_text is None) and is exempt — only the baseline signal
    # applies there.
    if spec_text is not None and (visual_decl is None or docs_decl is None):
        missing = " and ".join(k for k, v in (("visual:", visual_decl), ("docs:", docs_decl))
                               if v is None)
        fails.append(f"the spec's Docs-impact must declare {missing} "
                     f"(e.g. `visual: none — <why>`, `docs: <guide page> — <what>`)")

    # VISUAL — required when a baseline actually changed OR the spec declares visual impact.
    visual_required = bool(baseline_changed) or (visual_decl is not None and not _is_none(visual_decl))
    if visual_required and not has_visual:
        why = "a committed baseline changed" if baseline_changed else "the spec declares visual impact"
        fails.append(f"visual: disposition required ({why}) but no pm `visual:` note was "
                     f"recorded — the pm must record one "
                     f"(`visual: <scene> added|changed — <why>` or `visual: none — <why>`)")
    # A declared new scene must actually exist in the manifest.
    if visual_decl and not _is_none(visual_decl):
        m = _SCENE.search(visual_decl)
        if m and m.group(2).lower() == "added" and m.group(1) not in scene_ids:
            fails.append(f"the spec declares scene '{m.group(1)}' added, but it is not in "
                         f"docs/screenshots/scenes.json")

    # DOCS — required only when the spec declares user-facing docs impact. Satisfied by the
    # named guide page(s) changing in the diff OR a recorded pm `docs:` note.
    if docs_decl is not None and not _is_none(docs_decl):
        pages = re.findall(r"[\w./-]+\.md", docs_decl)
        pages_changed = bool(pages) and all(
            any(p in c for c in changed_guide_pages) for p in pages)
        if not (has_docs or pages_changed):
            fails.append("docs: disposition required (the spec declares user-facing docs "
                         "impact) but neither the named guide page(s) changed nor a pm "
                         "`docs:` note was recorded")
    return fails


# --- input gathering (git + tree) ----------------------------------------------------

def _run(args) -> str:
    r = subprocess.run(args, cwd=ROOT, capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else ""


def _spec_text(item: str) -> str | None:
    """Concatenated text of the item's design + spec docs, or None if none exist. Covers
    both the `<n>-<slug>[-spec].md` and older `<ITEM>[-*].md` naming."""
    m = re.search(r"(\d+)$", item)
    specs = ROOT / "docs" / "specs"
    if not (m and specs.is_dir()):
        return None
    n = m.group(1)
    pat = re.compile(rf"^(?:{re.escape(n)}-|{re.escape(item)}(?:-|\.md$))")
    files = sorted(f for f in specs.glob("*.md") if pat.match(f.name))
    if not files:
        return None
    return "\n".join(f.read_text() for f in files)


def _changed(base: str, *pathspecs: str) -> list[str]:
    out = _run(["git", "diff", "--name-only", base, "HEAD", "--", *pathspecs])
    return [l for l in out.splitlines() if l.strip()]


def _pm_notes(base: str, item: str) -> list[str]:
    """pm-authored note messages ADDED to the ledger in this PR for this item. Scoped to
    the item so a union-merged note from a parallel branch cannot satisfy the gate."""
    diff = _run(["git", "diff", base, "HEAD", "--", LEDGER_REL])
    notes = []
    for line in diff.splitlines():
        if not line.startswith("+") or line.startswith("+++"):
            continue
        body = line[1:].strip()
        if not body.startswith("{"):
            continue
        try:
            e = json.loads(body)
        except Exception:
            continue
        if e.get("type") == "note" and e.get("by") == "pm" and e.get("item") == item:
            notes.append(str(e.get("msg", "")))
    return notes


def _scene_ids() -> set[str]:
    f = ROOT / "docs" / "screenshots" / "scenes.json"
    try:
        return {s["id"] for s in json.loads(f.read_text()).get("scenes", [])}
    except Exception:
        return set()


def main() -> int:
    p = argparse.ArgumentParser(description="Verify pm dispositions against the spec's declared impact")
    p.add_argument("--item", required=True)
    p.add_argument("--base", required=True, help="merge base sha the PR diffs against")
    a = p.parse_args()

    spec_text = _spec_text(a.item)
    baseline = [Path(x).name for x in
                _changed(a.base, "docs/screenshots/*.png", "docs/screenshots/*.gif")]
    guides = _changed(a.base, "docs/guide/")
    notes = _pm_notes(a.base, a.item)
    scenes = _scene_ids()

    if spec_text is None:
        print(f"dispositions [{a.item}]: no spec file found — trivial item; only a changed "
              f"baseline requires a pm visual: note.")
    fails = evaluate(spec_text, baseline, guides, notes, scenes)
    if fails:
        for f in fails:
            print(f"::error title=arbiter-gate::{f}")
        return 1
    print(f"✅ dispositions [{a.item}]: pm notes match the spec's declared impact "
          f"(baseline changed: {len(baseline)}; pm notes: {len(notes)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
