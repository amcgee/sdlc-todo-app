#!/usr/bin/env python3
"""resolve_scope.py — decide whether a PR is under SDLC enforcement and resolve its work item.

A PR is an SDLC PR if its branch is `claude/sdlc-issue-<n>` (→ item `ISSUE-<n>`), it carries the
`sdlc` label (or a namespaced `sdlc:*` one), or a work item was passed explicitly (dispatch).
Reads the GitHub context from env and writes `is_sdlc`/`item` to $GITHUB_OUTPUT (and echoes a
summary). Keeping this here — not inline in YAML — is what lets the workflow stay a thin caller.

Env: REF (head ref), LABELS_JSON (JSON array of label names), INPUT_ITEM (dispatch override).
"""
from __future__ import annotations
import json, os, re, sys


def resolve(ref: str, labels_json: str, input_item: str) -> tuple[bool, str]:
    m = re.match(r"^claude/sdlc-issue-(\d+)", ref or "")
    n = m.group(1) if m else ""
    item = input_item or (f"ISSUE-{n}" if n else "")
    try:
        labels = json.loads(labels_json or "[]")
    except Exception:
        labels = []
    has_label = any(str(x) == "sdlc" or str(x).startswith("sdlc:") for x in labels)
    is_sdlc = bool(n or input_item or has_label)
    return is_sdlc, item


def main():
    ref = os.environ.get("REF", "")
    is_sdlc, item = resolve(ref, os.environ.get("LABELS_JSON", ""), os.environ.get("INPUT_ITEM", ""))
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a") as f:
            f.write(f"is_sdlc={'true' if is_sdlc else 'false'}\n")
            f.write(f"item={item}\n")
    print(f"ref='{ref}'  is_sdlc={'true' if is_sdlc else 'false'}  item='{item}'")


if __name__ == "__main__":
    main()
