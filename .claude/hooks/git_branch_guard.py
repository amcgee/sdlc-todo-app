#!/usr/bin/env python3
"""git_branch_guard.py — PreToolUse guard: block git commit/push on the default branch.

Wired to Bash. Reads the tool-call JSON on stdin, inspects the command string
itself, and blocks (exit 2) any `git commit`/`git push` while HEAD is on
main/master. Everything else proceeds through the normal permission flow (exit 0).

Because it parses the command rather than relying on permission-pattern matching,
it catches compound commands regardless of ordering — `git add -A && git commit`
is guarded even though it starts with `git add`. That ordering is exactly the
blind spot of an `if: Bash(git commit:*)` matcher, which is why the guard lives
here instead.

Hook protocol: reads a JSON event on stdin; exit 2 + stderr blocks the tool call.
"""
import json, re, subprocess, sys

PROTECTED_BRANCHES = {"main", "master"}
SHELL_OPS = re.compile(r"&&|\|\||;|\||\n")


def _is_git_write(segment: str) -> bool:
    """True if a shell segment invokes git commit or git push."""
    if not re.search(r"\bgit\b", segment):
        return False
    return re.search(r"\b(commit|push)\b", segment) is not None


def main():
    try:
        event = json.load(sys.stdin)
    except Exception:
        sys.exit(0)                       # never break the session on a parse error

    cmd = (event.get("tool_input", {}) or {}).get("command", "") or ""
    if not any(_is_git_write(seg) for seg in SHELL_OPS.split(cmd)):
        sys.exit(0)                       # not a commit/push — nothing to guard

    try:
        branch = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True, text=True, timeout=5,
        ).stdout.strip()
    except Exception:
        sys.exit(0)                       # can't determine branch -> don't block

    if branch in PROTECTED_BRANCHES:
        print(
            f"[sdlc] refusing to git commit/push on '{branch}' — the default branch is "
            f"protected. Work on a feature branch (e.g. claude/sdlc-issue-<n>).",
            file=sys.stderr,
        )
        sys.exit(2)                       # block the tool call

    sys.exit(0)


if __name__ == "__main__":
    main()
