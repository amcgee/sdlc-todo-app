#!/usr/bin/env python3
"""Tests for check-dispositions.py's spec-anchored gate (the pure evaluate()).

The gate anchors on two precise signals — the architect's spec `visual:`/`docs:` declarations
and a committed baseline changing. These tests are the contract, one per requirement:

  R1 pure refactor (spec declares none, no baseline) -> no disposition required
  R2 changed baseline -> still needs a pm visual: note, whatever the spec says
  R3 spec-declared docs impact -> needs the guide page changed OR a pm docs: note
  R4 spec-declared new scene -> the scene must exist in scenes.json
  R5 impact from a non-src file the spec flagged -> still gated (anchor is the spec)
  R6 a src/lib helper edit the spec calls none -> not gated

Framework test (Python, stdlib only). Standalone or under pytest. The gate logic lives in
a pure function, so no git/tree is needed here.
"""
from __future__ import annotations
import importlib.util
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location(
    "check_dispositions", REPO / "SDLC" / "scripts" / "check-dispositions.py")
cd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cd)

SCENES = {"empty-list", "active-and-done", "list-at-cap"}


def _spec_text(visual: str, docs: str) -> str:
    """A minimal spec carrying the two structured Docs-impact declarations."""
    return f"## Docs impact\n- visual: {visual}\n- docs: {docs}\n"


# R1 — a pure internal refactor requires no disposition.
def test_pure_refactor_needs_no_disposition():
    spec = _spec_text("none — internal rename only", "none — no behavior change")
    fails = cd.evaluate(spec, baseline_changed=[], changed_guide_pages=[], pm_notes=[], scene_ids=SCENES)
    assert fails == [], fails


# R2 — a changed committed baseline still needs a pm visual: note, even if the spec says none.
def test_changed_baseline_needs_visual_note():
    spec = _spec_text("none — none expected", "none — none")
    fails = cd.evaluate(spec, baseline_changed=["active-and-done.png"],
                        changed_guide_pages=[], pm_notes=[], scene_ids=SCENES)
    assert any("visual:" in f for f in fails), fails
    # with the note, it passes
    ok = cd.evaluate(spec, baseline_changed=["active-and-done.png"], changed_guide_pages=[],
                     pm_notes=["visual: active-and-done changed intentionally — new counter"],
                     scene_ids=SCENES)
    assert ok == [], ok


# R3 — a spec-declared docs impact needs the page changed OR a pm docs: note.
def test_declared_docs_impact_needs_page_or_note():
    spec = _spec_text("none — no visual", "managing-todos.md — documents the new limit")
    # neither the page changed nor a note -> fail
    fails = cd.evaluate(spec, baseline_changed=[], changed_guide_pages=[], pm_notes=[], scene_ids=SCENES)
    assert any("docs:" in f for f in fails), fails
    # the named page changed -> satisfied
    ok1 = cd.evaluate(spec, baseline_changed=[],
                      changed_guide_pages=["docs/guide/managing-todos.md"], pm_notes=[], scene_ids=SCENES)
    assert ok1 == [], ok1
    # or a pm docs: note -> satisfied
    ok2 = cd.evaluate(spec, baseline_changed=[], changed_guide_pages=[],
                      pm_notes=["docs: managing-todos.md updated — limit"], scene_ids=SCENES)
    assert ok2 == [], ok2


# R4 — a spec-declared new scene must exist in scenes.json.
def test_declared_new_scene_must_exist():
    spec = _spec_text("bulk-clear added — the new clear-all affordance", "none — no page")
    note = ["visual: bulk-clear added — clear-all button"]
    # scene absent -> fail (even with the note present)
    fails = cd.evaluate(spec, baseline_changed=[], changed_guide_pages=[], pm_notes=note, scene_ids=SCENES)
    assert any("scenes.json" in f for f in fails), fails
    # scene present -> pass
    ok = cd.evaluate(spec, baseline_changed=[], changed_guide_pages=[], pm_notes=note,
                     scene_ids=SCENES | {"bulk-clear"})
    assert ok == [], ok


# R5 — impact from a non-src file the spec flagged is still gated (anchor is the spec, not paths).
def test_non_src_impact_still_gated():
    # a tailwind.config.js theme change: no src/ file, but the spec declares visual+docs impact
    spec = _spec_text("active-and-done changed — new palette", "accessibility.md — contrast note")
    fails = cd.evaluate(spec, baseline_changed=[], changed_guide_pages=[], pm_notes=[], scene_ids=SCENES)
    # both dispositions are demanded despite zero src/ files in the diff
    assert any("visual:" in f for f in fails) and any("docs:" in f for f in fails), fails


# R6 — a src/lib helper edit the spec declares none is NOT gated (the anchor is the spec, not paths).
def test_helper_edit_declared_none_not_gated():
    spec = _spec_text("none — cn() helper, no render change", "none — internal")
    fails = cd.evaluate(spec, baseline_changed=[], changed_guide_pages=[], pm_notes=[], scene_ids=SCENES)
    assert fails == [], fails


# A spec missing a declaration is an architect omission -> fail (default A: two lines required).
def test_missing_declaration_fails():
    fails = cd.evaluate("## Docs impact\n- visual: none — x\n", baseline_changed=[],
                        changed_guide_pages=[], pm_notes=[], scene_ids=SCENES)
    assert any("docs:" in f for f in fails), fails


# A trivial item (no spec file) is exempt from the spec-anchored gates; only a changed
# baseline requires a visual: note.
def test_trivial_item_no_spec():
    assert cd.evaluate(None, [], [], [], SCENES) == []
    fails = cd.evaluate(None, baseline_changed=["empty-list.png"], changed_guide_pages=[],
                        pm_notes=[], scene_ids=SCENES)
    assert any("visual:" in f for f in fails), fails


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"  PASS {t.__name__}")
        except Exception as e:
            failed += 1
            print(f"  FAIL {t.__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
