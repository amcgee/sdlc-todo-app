#!/usr/bin/env python3
"""manifest.py — the SINGLE reader for the project adapter manifest `sdlc.config.json`.

Every framework component that needs an app/stack coupling — the protected/shipped paths,
the test/install toolchain, trust boundaries, doc paths — resolves it HERE, so the logic
lives in one place and cannot drift between callers. Values are resolved dynamically at call
time; nothing bakes a project's layout into code.

Portability: the manifest lives at the REPO ROOT (`sdlc.config.json`), outside `SDLC/`, so the
framework directory copies into another repo without edits — a port writes the root manifest
only. The one built-in fallback (DEFAULT_SHIPPED) exists so a missing or corrupt manifest fails
*safe* — the build gate still protects something. Set `shipped_paths` in the manifest (or the
SDLC_PROTECTED env override) for your stack, in any language.

Stdlib only, no import side effects — safe to import from the PreToolUse hooks, which must
never crash a session (they import it behind a try/except and degrade to the same fallback).
"""
from __future__ import annotations
import json, os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]        # the repo root (SDLC/lib/manifest.py → ../../)
MANIFEST = ROOT / "sdlc.config.json"

# Last-resort fallback ONLY: the reference app's shipped layout, used when the manifest is
# absent/unreadable AND no SDLC_PROTECTED override is set. A real port never relies on this.
DEFAULT_SHIPPED = ("src/", "server/", "worker/", "migrations/")

# The mutable ledger lives OUTSIDE SDLC/ so the framework directory is fully immutable — a
# submodule works as-is and a copy needs no exceptions. This is its default location,
# relative to the repo root; override with the `SDLC_LEDGER_DIR` env or the manifest's
# `ledger_dir` key.
DEFAULT_LEDGER_DIR = ".sdlc/ledger"


def load() -> dict:
    """The manifest as a dict, or {} when it's missing/unreadable so the framework still
    runs on its defaults."""
    try:
        return json.loads(MANIFEST.read_text())
    except Exception:
        return {}


def shipped_paths() -> tuple[str, ...]:
    """The code paths the build gate protects, resolved dynamically and language-agnostically:
    the SDLC_PROTECTED env var (colon-separated) overrides everything; else the manifest's
    `shipped_paths`; else DEFAULT_SHIPPED. Both hooks and the security floor read this one
    resolver, so they can never disagree about what 'shipped' means."""
    env = os.environ.get("SDLC_PROTECTED")
    if env:
        return tuple(p for p in env.split(":") if p)
    paths = load().get("shipped_paths")
    if paths:
        return tuple(paths)
    return DEFAULT_SHIPPED


def trust_boundaries() -> tuple[str, ...]:
    """Dirs whose diffs trigger the mandatory STRIDE pass (empty tuple if unset)."""
    return tuple(load().get("trust_boundaries") or ())


def scan_paths() -> tuple[str, ...]:
    """The full set of dirs the security floor scans, deduplicated in order: ALWAYS
    `shipped_paths`, PLUS the manifest's optional `scan_paths` (extra dirs like build/dev
    tooling that runs but isn't shipped product). Additive: the shipped code is always
    scanned and `scan_paths` can only widen coverage, never narrow it below the shipped set.
    The build gate reads `shipped_paths`; the scanner reads this."""
    seen: set[str] = set()
    out: list[str] = []
    for p in (*shipped_paths(), *(load().get("scan_paths") or ())):
        if p not in seen:
            seen.add(p)
            out.append(p)
    return tuple(out)


def ledger_dir() -> Path:
    """Absolute path to the mutable ledger directory (`rounds.jsonl` + the derived
    `gates.json`/`audit.jsonl`/`.build-open`). Resolved dynamically: the `SDLC_LEDGER_DIR`
    env var overrides everything; else the manifest's `ledger_dir`; else DEFAULT_LEDGER_DIR.
    A relative value is anchored at the repo root, so it lands OUTSIDE SDLC/ and the framework
    directory stays immutable. Every consumer — the CLI, both hooks, the CI checks — resolves
    the path here, so they can never disagree about where the record lives."""
    raw = os.environ.get("SDLC_LEDGER_DIR") or load().get("ledger_dir") or DEFAULT_LEDGER_DIR
    p = Path(raw)
    return p if p.is_absolute() else (ROOT / p)


def rounds_path() -> Path:
    """The append-only ledger file itself — `<ledger_dir>/rounds.jsonl`."""
    return ledger_dir() / "rounds.jsonl"


def toolchain() -> dict:
    """The install/test/coverage commands from the manifest (empty dict if unset). This is
    how the framework stays language-agnostic: spot_check.py and CI read the *commands* here
    instead of assuming `bun`/`package.json`. CLI flags still override where exposed."""
    return load().get("toolchain", {})


if __name__ == "__main__":
    # `python SDLC/lib/manifest.py` prints the resolved couplings — handy when porting.
    print(f"shipped_paths   : {list(shipped_paths())}")
    print(f"scan_paths      : {list(scan_paths())}")
    print(f"trust_boundaries: {list(trust_boundaries())}")
    print(f"ledger_dir      : {ledger_dir()}")
    print(f"toolchain       : {toolchain()}")
