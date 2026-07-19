#!/usr/bin/env python3
"""bash_write_guard.py — PreToolUse guard for Bash: protected paths are not writable
through shell side-channels.

The Edit/Write tools are covered by gate_guard.py (build gate) and by the ask/deny
permission lists in .claude/settings.json (framework dirs, the ledger). A shell
command can bypass all of that with a redirection or an in-place edit — this hook
closes that hole. Per shell segment (split on &&, ||, ;, |, newline):

  * a write that targets the ledger rounds.jsonl is ALWAYS blocked — the ledger is
    append-only and written only through `python SDLC/sdlc.py …`;
  * a write that targets .github/, .claude/, SDLC/, or the ledger dir (default
    `.sdlc/ledger/`, resolved via SDLC_LEDGER_DIR / the manifest) is ALWAYS blocked —
    those must go through the Edit/Write tools, where the permission system can ask the
    operator. Only the sanctioned sentinel commands `touch`/`rm <ledger-dir>/.build-open`
    are allowlisted — deliberately NOT the sdlc.py CLI: a blanket exemption would also
    exempt a redirection riding the same segment (`python SDLC/sdlc.py … > <ledger>`).
    Plain CLI calls pass anyway (no write target), and the ledger-mention rule below
    already recognizes sdlc.py invocations as legitimate;
  * a write that targets a gated code path (SDLC_PROTECTED, default
    src/:server/:worker/:migrations/) while the build gate is shut follows
    SDLC_ENFORCE: block (default), or warn and allow.

Detection is deliberately conservative: it only acts when a redirection or a known
write command clearly targets a protected path, and a segment that cannot be parsed
is allowed — this guard must never break a session on a false positive. Heredoc
bodies are stripped before analysis (they are data for the receiving command, not
shell commands — a commit message that *mentions* the ledger must not be blocked),
which also means an interpreter fed a ledger-writing script via heredoc slips
through. That is accepted: this guard raises the cost of a bypass rather than
claiming to be a jail; the Edit/Write-layer controls, the CI append-only diff
check, and human review still stand behind it.

Hook protocol: reads a JSON event on stdin; exit 2 + stderr blocks the tool call.
"""
import json, os, re, shlex, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
LEDGER_NAME = "rounds.jsonl"


def _shared():
    """The ONE shared reader (SDLC/lib/manifest.py), or None when it can't be imported. A
    PreToolUse hook must never crash a session, so with no reader the resolvers below degrade
    to env-or-default — the manifest file is never parsed outside its one reader."""
    try:
        sys.path.insert(0, str(ROOT / "SDLC" / "lib"))
        import manifest
        return manifest
    except Exception:
        return None


_M = _shared()


def _ledger_dir():
    """The mutable ledger dir: SDLC_LEDGER_DIR env > manifest `ledger_dir` > default
    `.sdlc/ledger`, anchored at the repo root."""
    if _M:
        return _M.ledger_dir()
    p = Path(os.environ.get("SDLC_LEDGER_DIR") or ".sdlc/ledger")
    return p if p.is_absolute() else (ROOT / p)


LEDGER_DIR = _ledger_dir()
try:
    LEDGER_REL = str(LEDGER_DIR.relative_to(ROOT)).replace(os.sep, "/") + "/"
except ValueError:
    LEDGER_REL = str(LEDGER_DIR) + "/"
# Framework dirs + the ledger dir: shell writes here are always blocked (the sanctioned
# sentinel below is the one exemption). SDLC/ itself is now fully immutable.
FRAMEWORK = (".github/", ".claude/", "SDLC/", LEDGER_REL)


def _gated_paths():
    """Gated code paths — the same resolution gate_guard.py makes, so both hooks agree:
    SDLC_PROTECTED env wins, else the manifest's `shipped_paths`, else the default."""
    if _M:
        return _M.shipped_paths()
    env = os.environ.get("SDLC_PROTECTED")
    if env:
        return tuple(p for p in env.split(":") if p)
    return ("src/", "server/", "worker/", "migrations/")  # mirrors manifest.DEFAULT_SHIPPED


GATED = _gated_paths()
SENTINEL = LEDGER_DIR / ".build-open"
SENTINEL_REL = LEDGER_REL + ".build-open"        # repo-relative, e.g. .sdlc/ledger/.build-open
SEGMENT_SPLIT = re.compile(r"&&|\|\||;|\||\n")
REDIRECT_TARGET = re.compile(r">>?\s*([^\s;|&]+)")
# sanctioned framework writes: ONLY the build-gate sentinel (anchored to end-of-segment
# so nothing can ride along). The sdlc.py CLI is deliberately not exempted — see docstring.
_S = re.escape(SENTINEL_REL)
ALLOWED_SEGMENT = re.compile(
    rf"^\s*(touch\s+(\./)?{_S}\s*$"
    rf"|rm\s+(-f\s+)?(\./)?{_S}\s*$)")
# commands that may MENTION the ledger path without shell-writing it: read-only tools,
# git, and the sdlc.py CLI itself (whose --msg text may name the file). This exemption
# applies only to the mention rule — redirect/write TARGETS are checked before it, so
# `python SDLC/sdlc.py … > <ledger>` is still blocked by the target rule.
READ_ONLY = re.compile(
    r"^\s*(cat|head|tail|wc|grep|rg|jq|awk|cut|sort|uniq|less|diff|md5sum|sha\d*sum|git"
    r"|python3?\s+\S*sdlc\.py)\b")
# commands whose path arguments are (or include) write targets
WRITE_CMDS = {"tee", "truncate", "rm", "mv", "cp", "touch", "install",
              "rsync", "ln", "dd", "sed", "patch", "mkdir"}
# for these, only the LAST path argument is the destination
DEST_LAST = {"cp", "mv", "install", "rsync", "ln"}


HEREDOC = re.compile(r"<<-?\s*(['\"]?)(\w+)\1")


def _strip_heredocs(cmd: str) -> str:
    """Drop heredoc bodies: lines after `<<WORD` up to (and including) the WORD
    terminator line. The body is input to the receiving command, not shell syntax."""
    out, terminator = [], None
    for line in cmd.split("\n"):
        if terminator is not None:
            if line.strip() == terminator:
                terminator = None
            continue
        m = HEREDOC.search(line)
        out.append(line)
        if m:
            terminator = m.group(2)
    return "\n".join(out)


def _norm(tok: str) -> str:
    tok = tok.strip("'\"")
    if tok.startswith(str(ROOT) + "/"):
        tok = tok[len(str(ROOT)) + 1:]
    return re.sub(r"^\./", "", tok)


def _write_targets(segment: str) -> list[str]:
    """Best-effort list of paths a segment writes to. Empty when nothing is clearly
    written (or the segment can't be parsed — conservative, see module docstring)."""
    targets = [m.group(1) for m in REDIRECT_TARGET.finditer(segment)]
    try:
        toks = shlex.split(segment)
    except ValueError:
        return [_norm(t) for t in targets]
    while toks and os.path.basename(toks[0]) in ("sudo", "env", "command", "nice"):
        toks = toks[1:]
    if toks:
        cmd = os.path.basename(toks[0])
        if cmd == "sed" and not any(t.startswith("-i") for t in toks[1:]):
            pass                                   # sed without -i doesn't write its file arg
        elif cmd == "dd":
            targets.extend(t[3:] for t in toks[1:] if t.startswith("of="))
        elif cmd in WRITE_CMDS:
            args = [t for t in toks[1:] if not t.startswith("-")]
            if cmd in DEST_LAST:
                args = args[-1:]
            targets.extend(args)
    return [_norm(t) for t in targets]


def main():
    try:
        event = json.load(sys.stdin)
    except Exception:
        sys.exit(0)                        # never break the session on a parse error

    cmd = (event.get("tool_input", {}) or {}).get("command", "") or ""
    if not cmd:
        sys.exit(0)
    cmd = _strip_heredocs(cmd)

    mode = os.environ.get("SDLC_ENFORCE", "block").lower()
    enforcing = mode not in ("0", "warn")
    gate_open = SENTINEL.exists()

    for segment in SEGMENT_SPLIT.split(cmd):
        if ALLOWED_SEGMENT.match(segment):
            continue
        targets = _write_targets(segment)

        for t in targets:
            if LEDGER_NAME in t:
                print(f"[sdlc] the ledger is append-only — write it through "
                      f"`python SDLC/sdlc.py <cmd>`, never a shell write ({segment.strip()!r}).",
                      file=sys.stderr)
                sys.exit(2)
            if any(t.startswith(p) for p in FRAMEWORK):
                print(f"[sdlc] {t!r} is a protected framework/ledger path "
                      f"({', '.join(FRAMEWORK)}) — shell writes are blocked; use the Edit/Write "
                      f"tools so the operator is asked, or stop and request the change on the PR.",
                      file=sys.stderr)
                sys.exit(2)
            if any(t.startswith(p) for p in GATED) and not gate_open:
                msg = (f"[sdlc] BUILD gate is shut — shell write to {t!r} is gated.\n"
                       f"       The arbiter opens it with:  touch {SENTINEL_REL}\n"
                       f"       (set SDLC_ENFORCE=warn to make this advisory.)")
                print(msg, file=sys.stderr)
                if enforcing:
                    sys.exit(2)

        # a non-read command that mentions the ledger without a parseable target is
        # still suspect (e.g. `python -c "open('.sdlc/ledger/rounds.jsonl','a')…"`)
        if LEDGER_NAME in segment and not READ_ONLY.match(segment) \
                and not any(LEDGER_NAME in t for t in targets):
            print(f"[sdlc] command references the append-only ledger outside the sdlc.py CLI "
                  f"and known read-only tools — blocked ({segment.strip()!r}).", file=sys.stderr)
            sys.exit(2)

    sys.exit(0)


if __name__ == "__main__":
    main()
