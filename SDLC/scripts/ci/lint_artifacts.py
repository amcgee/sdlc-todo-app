#!/usr/bin/env python3
"""lint_artifacts.py — warn (never block) when ledger finding ids or spec labels leak into
shipped code, so the distillation step and the human reviewer can see what to strip. Scans the
manifest's `shipped_paths` (any language, no file-type filter). Always exits 0.
"""
from __future__ import annotations
import os, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]           # repo root (SDLC/scripts/ci/x.py → ../../../)
sys.path.insert(0, str(ROOT / "SDLC" / "lib"))
try:
    import manifest
    SHIPPED = manifest.shipped_paths()
except Exception:
    SHIPPED = ("src/", "server/", "worker/", "migrations/")

# Ledger/spec artifacts: item-scoped finding ids (ISSUE-7-F3), invariant labels (INV-3),
# bare finding ids (F7), and issue ids (ISSUE-31).
PAT = re.compile(r"\b[A-Z]+-\d+-F\d+\b|\bINV-\d+\b|\bF\d+\b|\bISSUE-\d+\b")


def main():
    hits = []
    for d in SHIPPED:
        base = ROOT / d.rstrip("/")
        if not base.is_dir():
            continue
        for p in base.rglob("*"):
            if not p.is_file():
                continue
            try:
                text = p.read_text()
            except (UnicodeDecodeError, OSError):
                continue
            for i, line in enumerate(text.splitlines(), 1):
                if PAT.search(line):
                    hits.append((p.relative_to(ROOT), i, line.strip()))
    if hits:
        for rel, line, text in hits:
            print(f"::warning file={rel},line={line},title=process artifact in shipped code::{text}")
    else:
        print("✅ no ledger/spec ids referenced in shipped code")


if __name__ == "__main__":
    main()
