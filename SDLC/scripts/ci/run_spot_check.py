#!/usr/bin/env python3
"""run_spot_check.py — CI wrapper for the pre-fix spot check. Reads the test/install commands
from the manifest (any language), installs this repo's deps at HEAD so the HEAD test run has
them (the pre-fix worktree installs its own inside spot_check.py), then re-executes the
verifier's proving-test claims. Skips cleanly when the manifest declares no test command.

Usage: run_spot_check.py --item ISSUE-<n> --base <base-sha> [--max N]
The project runtime (bun, uv, …) must already be on PATH — that install is the one
stack-specific workflow step; everything here reads the manifest.
"""
from __future__ import annotations
import argparse, shlex, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "SDLC" / "lib"))
try:
    import manifest
    TOOLCHAIN = manifest.toolchain()
except Exception:
    TOOLCHAIN = {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--item", required=True)
    ap.add_argument("--base", default="")
    ap.add_argument("--max", default="3")
    a = ap.parse_args()

    if not TOOLCHAIN.get("test"):
        print("no toolchain.test in sdlc.config.json — nothing to spot-check; skipping")
        return
    # No shell: the manifest's install is one argv, same contract spot_check.py
    # enforces on toolchain commands via shlex.split.
    argv = shlex.split(TOOLCHAIN.get("install") or "")
    if argv:
        print(f"installing deps: {' '.join(argv)}")
        subprocess.run(argv, cwd=ROOT, check=False)
    base = subprocess.run(["git", "merge-base", a.base, "HEAD"], capture_output=True, text=True).stdout.strip() \
        if a.base else ""
    cmd = [sys.executable, str(ROOT / "SDLC" / "lib" / "spot_check.py"), "--item", a.item, "--max", a.max]
    if base:
        cmd += ["--base", base]
    sys.exit(subprocess.run(cmd, cwd=ROOT).returncode)


if __name__ == "__main__":
    main()
