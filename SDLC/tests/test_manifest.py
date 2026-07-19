#!/usr/bin/env python3
"""Tests that the root manifest `sdlc.config.json` is a real, single config seam — every
consumer resolves the protected/shipped paths through the ONE reader (SDLC/lib/manifest.py),
so porting is one manifest edit, not a grep across the framework.

Two layers:
  * manifest.py directly — env override > manifest shipped_paths > default, and toolchain().
  * both hooks black-box — gate_guard.py (Edit) and bash_write_guard.py (Bash shell write)
    in a sandbox carrying manifest.py, asserting the block/allow decision follows the
    manifest, and that SDLC_PROTECTED overrides it. The sandbox includes manifest.py so the
    real import path is exercised, not just the inline fallback.

Framework test (Python, stdlib only). Standalone or under pytest.
"""
from __future__ import annotations
import importlib.util, json, os, shutil, subprocess, sys, tempfile
from pathlib import Path

import sandbox

MANIFEST_PY = sandbox.MANIFEST_PY


# --- manifest.py directly ----------------------------------------------------

def _with_manifest(project_json: dict | None, env_protected: str | None, fn):
    """Import manifest.py against a throwaway sdlc.config.json with the env set as given,
    and call fn(module) WHILE the temp tree and env are still live — manifest.py reads both
    lazily at call time, so evaluation must happen before cleanup."""
    d = tempfile.mkdtemp()
    lib = Path(d) / "SDLC" / "lib"
    lib.mkdir(parents=True)
    shutil.copy(MANIFEST_PY, lib / "manifest.py")
    if project_json is not None:
        (Path(d) / "sdlc.config.json").write_text(json.dumps(project_json))
    old = os.environ.get("SDLC_PROTECTED")
    if env_protected is None:
        os.environ.pop("SDLC_PROTECTED", None)
    else:
        os.environ["SDLC_PROTECTED"] = env_protected
    try:
        spec = importlib.util.spec_from_file_location(f"m_{Path(d).name}", lib / "manifest.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return fn(mod)
    finally:
        if old is None:
            os.environ.pop("SDLC_PROTECTED", None)
        else:
            os.environ["SDLC_PROTECTED"] = old
        shutil.rmtree(d, ignore_errors=True)


def test_manifest_resolves_shipped_paths():
    got = _with_manifest({"shipped_paths": ["lib/", "cmd/"]}, None, lambda m: m.shipped_paths())
    assert got == ("lib/", "cmd/"), got


def test_manifest_default_when_absent():
    got = _with_manifest(None, None, lambda m: (m.shipped_paths(), m.DEFAULT_SHIPPED))
    assert got[0] == got[1], got


def test_manifest_env_overrides_manifest():
    got = _with_manifest({"shipped_paths": ["lib/"]}, "pkg/:cmd/", lambda m: m.shipped_paths())
    assert got == ("pkg/", "cmd/"), got


def test_manifest_toolchain_language_agnostic():
    tc = _with_manifest({"toolchain": {"install": "pip install -e .", "test": "pytest"}},
                        None, lambda m: m.toolchain())
    assert tc["test"] == "pytest" and tc["install"] == "pip install -e .", tc


def test_scan_paths_is_additive_over_shipped():
    """scan_paths ALWAYS includes shipped_paths (the security floor can't be narrowed below
    the shipped set) and appends the manifest's extra scan_paths, deduped in order."""
    got = _with_manifest({"shipped_paths": ["src/"], "scan_paths": ["scripts/", "src/"]},
                         None, lambda m: m.scan_paths())
    assert got == ("src/", "scripts/"), got            # shipped first, extra added, dedup
    # no scan_paths key -> exactly the shipped set
    only = _with_manifest({"shipped_paths": ["src/", "lib/"]}, None, lambda m: m.scan_paths())
    assert only == ("src/", "lib/"), only
    # even if scan_paths lists only 'scripts/', the shipped set is still scanned (additive)
    both = _with_manifest({"shipped_paths": ["src/"], "scan_paths": ["scripts/"]},
                          None, lambda m: m.scan_paths())
    assert "src/" in both and "scripts/" in both, both


def test_manifest_ledger_dir_default_and_manifest_key():
    # default: <repo-root>/.sdlc/ledger (outside SDLC/, so the framework stays immutable)
    d = _with_manifest(None, None, lambda m: str(m.ledger_dir()))
    assert d.endswith("/.sdlc/ledger"), d
    # the manifest key relocates it, still anchored at the repo root
    c = _with_manifest({"ledger_dir": "state/led"}, None, lambda m: str(m.ledger_dir()))
    assert c.endswith("/state/led"), c
    # rounds_path is the file inside the resolved dir
    r = _with_manifest(None, None, lambda m: str(m.rounds_path()))
    assert r.endswith("/.sdlc/ledger/rounds.jsonl"), r


def test_manifest_ledger_dir_env_overrides():
    old = os.environ.get("SDLC_LEDGER_DIR")
    os.environ["SDLC_LEDGER_DIR"] = "/tmp/sdlc-led-test"
    try:
        got = _with_manifest({"ledger_dir": "ignored/"}, None, lambda m: str(m.ledger_dir()))
    finally:
        if old is None:
            os.environ.pop("SDLC_LEDGER_DIR", None)
        else:
            os.environ["SDLC_LEDGER_DIR"] = old
    assert got == "/tmp/sdlc-led-test", got            # absolute env path wins, used verbatim


# --- both hooks black-box ----------------------------------------------------

def _sandbox(tmp: Path, shipped, *, with_manifest_py=True):
    """A tree with BOTH hooks + a manifest naming `shipped` as the protected set, and no
    build sentinel (gate shut). With manifest.py present the hooks' real shared-reader
    import is tested; without it, their env-or-default degradation."""
    return sandbox.make_repo(tmp, sdlc_py=False, hooks=True, manifest_py=with_manifest_py,
                             project_manifest={"shipped_paths": shipped})


def _run_hook(repo, hook, payload, env_protected=None):
    env = dict(os.environ)
    env.pop("SDLC_PROTECTED", None)
    if env_protected is not None:
        env["SDLC_PROTECTED"] = env_protected
    env["SDLC_ENFORCE"] = "block"
    return subprocess.run([sys.executable, str(repo / ".claude" / "hooks" / hook)],
                          input=json.dumps(payload), capture_output=True, text=True, env=env, cwd=repo)


def _edit(repo, rel_path, **kw):
    return _run_hook(repo, "gate_guard.py",
                     {"tool_name": "Edit", "tool_input": {"file_path": str(repo / rel_path)}}, **kw)


def _bash(repo, command, **kw):
    return _run_hook(repo, "bash_write_guard.py",
                     {"tool_name": "Bash", "tool_input": {"command": command}}, **kw)


def test_gate_guard_protected_from_manifest():
    with tempfile.TemporaryDirectory() as d:
        repo = _sandbox(Path(d), ["lib/"])            # lib/ protected, src/ not
        assert _edit(repo, "lib/app.py").returncode == 2, "lib/ should be gated per manifest"
        assert _edit(repo, "src/app.py").returncode == 0, "src/ not in manifest; should pass"


def test_bash_write_guard_protected_from_manifest():
    with tempfile.TemporaryDirectory() as d:
        repo = _sandbox(Path(d), ["lib/"])
        # a shell redirect into lib/ while the gate is shut -> blocked (exit 2)
        assert _bash(repo, "echo x > lib/app.py").returncode == 2, "lib/ shell-write should be gated"
        # a shell redirect into src/ (not in this manifest) -> allowed
        assert _bash(repo, "echo x > src/app.py").returncode == 0, "src/ not in manifest; should pass"


def test_both_hooks_honor_env_override():
    with tempfile.TemporaryDirectory() as d:
        repo = _sandbox(Path(d), ["lib/"])            # manifest says lib/, env says pkg/
        # env override wins: pkg/ is now protected, lib/ is not
        assert _edit(repo, "pkg/x.py", env_protected="pkg/").returncode == 2
        assert _edit(repo, "lib/x.py", env_protected="pkg/").returncode == 0
        assert _bash(repo, "echo x > pkg/x.py", env_protected="pkg/").returncode == 2
        assert _bash(repo, "echo x > lib/x.py", env_protected="pkg/").returncode == 0


def test_hooks_degrade_without_manifest_py():
    """A hook must never crash a session. Without the shared reader, the manifest file is
    not consulted: the env override still wins, else the built-in default set is protected —
    even when the manifest names something else."""
    with tempfile.TemporaryDirectory() as d:
        repo = _sandbox(Path(d), ["lib/"], with_manifest_py=False)
        # default set protected (manifest's lib/ is NOT read without its reader)
        assert _edit(repo, "src/x.py").returncode == 2
        assert _edit(repo, "lib/x.py").returncode == 0
        assert _bash(repo, "echo x > src/x.py").returncode == 2
        # env override still works in degraded mode
        assert _edit(repo, "pkg/x.py", env_protected="pkg/").returncode == 2
        assert _bash(repo, "echo x > pkg/x.py", env_protected="pkg/").returncode == 2


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
