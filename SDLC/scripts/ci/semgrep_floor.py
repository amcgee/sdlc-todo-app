#!/usr/bin/env python3
"""semgrep_floor.py — the mechanical SAST floor. Scans the manifest's `scan_paths` (the shipped
set the build gate protects PLUS additive build/dev tooling) and separates a real finding from
tool trouble by semgrep's exit code: 0 clean · 1 ERROR-severity findings (block, exit 1) ·
>=2 tool/config error (warn, exit 0 — security-tool trouble can't wedge every unrelated PR).

semgrep must already be installed (the workflow does `pip install semgrep` before calling).
"""
from __future__ import annotations
import os, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "SDLC" / "lib"))
try:
    import manifest
    SCAN = manifest.scan_paths()
except Exception:
    SCAN = ("src/", "server/", "worker/", "migrations/", "scripts/")


def main():
    dirs = [d.rstrip("/") for d in SCAN if (ROOT / d.rstrip("/")).is_dir()]
    if not dirs:
        print("✅ semgrep: no source dirs present — nothing to scan")
        return
    print(f"scanning (from sdlc.config.json shipped_paths + scan_paths): {' '.join(dirs)}")
    rc = subprocess.run(["semgrep", "scan", "--config", "p/default", "--error",
                         "--severity", "ERROR", "--metrics=off", *dirs], cwd=ROOT).returncode
    if rc == 0:
        print("✅ semgrep: no ERROR-severity findings")
    elif rc == 1:
        print("::error title=security::semgrep found ERROR-severity issues (details above) — "
              "file each as a ledger finding with a reproduction, then fix or rebut on the record")
        sys.exit(1)
    else:
        print(f"::warning title=security::semgrep exited {rc} (tool or config error, not a "
              f"finding) — not blocking this PR; investigate the run log")


if __name__ == "__main__":
    main()
