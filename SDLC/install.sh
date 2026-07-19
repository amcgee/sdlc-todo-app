#!/usr/bin/env sh
# install.sh — convenience wrapper around SDLC/install.py.
#
# The real installer is install.py (stdlib Python, cross-platform, does the JSON merge).
# This wrapper just finds a Python 3 and forwards every argument to it, so you can run:
#
#     ./SDLC/install.sh --target /path/to/your/repo
#
# See `python3 SDLC/install.py --help` for options.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

for py in python3 python; do
  if command -v "$py" >/dev/null 2>&1; then
    exec "$py" "$here/install.py" "$@"
  fi
done

echo "error: Python 3 not found on PATH — install Python 3.8+ to run the SDLC installer." >&2
exit 1
