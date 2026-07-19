#!/usr/bin/env python3
"""gate_guard.py — PreToolUse control for the adversarial SDLC.

Wired to Edit|Write|MultiEdit. Two jobs:
  1. Append an audit line to the ledger's audit.jsonl for every code-write attempt.
  2. Enforce the BUILD gate: writes under a protected path require the build gate to
     be open, signalled by the sentinel file .build-open in the ledger dir. Protected paths
     cover everything that ships (not just src/); override with a colon-separated
     SDLC_PROTECTED env var when porting to another repo layout.

The ledger dir defaults to `.sdlc/ledger/` at the repo root (outside SDLC/, so the framework
stays immutable); override with SDLC_LEDGER_DIR or the manifest's `ledger_dir`.

Modes (env SDLC_ENFORCE):
  unset / "1" / "block" -> blocking: deny protected writes when the gate is shut (exit 2).
  "0" / "warn"          -> advisory: log + print a warning to stderr, allow the write.

The arbiter opens the build gate by creating the sentinel:
    touch .sdlc/ledger/.build-open     # and removes it to re-lock the tree

Bash-side writes (redirections, sed -i, …) are covered by the companion hook
bash_write_guard.py — this one only sees the Edit/Write/MultiEdit tools.

Hook protocol: reads a JSON event on stdin; exit 2 + stderr blocks the tool call.
"""
import json, os, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent


def _shared():
    """The ONE shared reader (SDLC/lib/manifest.py) that resolves every app/stack coupling,
    or None when it can't be imported. A PreToolUse hook must never crash a session, so with
    no reader the resolvers below degrade to env-or-default — the manifest file is never
    parsed outside its one reader."""
    try:
        sys.path.insert(0, str(ROOT / "SDLC" / "lib"))
        import manifest
        return manifest
    except Exception:
        return None


_M = _shared()


def _protected_paths():
    """Paths that require an open build gate — everything that ships. SDLC_PROTECTED env
    wins, else the manifest's `shipped_paths`, else the built-in default. Both hooks and the
    security floor resolve through the same reader, so the protected set can't drift."""
    if _M:
        return _M.shipped_paths()
    env = os.environ.get("SDLC_PROTECTED")
    if env:
        return tuple(p for p in env.split(":") if p)
    return ("src/", "server/", "worker/", "migrations/")  # mirrors manifest.DEFAULT_SHIPPED


def _ledger_dir():
    """The mutable ledger dir: SDLC_LEDGER_DIR env > manifest `ledger_dir` > default
    `.sdlc/ledger`, anchored at the repo root."""
    if _M:
        return _M.ledger_dir()
    p = Path(os.environ.get("SDLC_LEDGER_DIR") or ".sdlc/ledger")
    return p if p.is_absolute() else (ROOT / p)


PROTECTED = _protected_paths()
LEDGER_DIR = _ledger_dir()
SENTINEL = LEDGER_DIR / ".build-open"
AUDIT = LEDGER_DIR / "audit.jsonl"


def _audit(rec: dict):
    AUDIT.parent.mkdir(parents=True, exist_ok=True)
    with AUDIT.open("a") as f:
        f.write(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **rec}) + "\n")


def main():
    try:
        event = json.load(sys.stdin)
    except Exception:
        sys.exit(0)                        # never break the session on a parse error

    tool = event.get("tool_name", "")
    ti = event.get("tool_input", {}) or {}
    path = ti.get("file_path") or ti.get("path") or ""
    try:
        rel = str(Path(path).resolve().relative_to(ROOT))
    except Exception:
        rel = path

    protected = any(rel.startswith(p) for p in PROTECTED)
    gate_open = SENTINEL.exists()
    mode = os.environ.get("SDLC_ENFORCE", "block").lower()
    enforcing = mode not in ("0", "warn")

    _audit({"tool": tool, "path": rel, "protected": protected,
            "build_gate": "open" if gate_open else "shut",
            "mode": "block" if enforcing else "warn"})

    if protected and not gate_open:
        try:
            sentinel_rel = SENTINEL.relative_to(ROOT)
        except ValueError:
            sentinel_rel = SENTINEL
        msg = (f"[sdlc] BUILD gate is shut — writes to {PROTECTED} are gated.\n"
               f"       The arbiter opens it with:  touch {sentinel_rel}\n"
               f"       (set SDLC_ENFORCE=warn to make this advisory.)")
        if enforcing:
            print(msg, file=sys.stderr)
            sys.exit(2)                    # block the tool call
        print(msg, file=sys.stderr)        # advisory only
    sys.exit(0)


if __name__ == "__main__":
    main()
