#!/bin/sh
# Start the Shamash watch board. Needs only Python 3.9+.
# If .venv exists (see README, "Optional extras"), its Python is used so AIS and Intel extras work.
cd "$(dirname "$0")" || exit 1
if [ -x .venv/bin/python ]; then exec .venv/bin/python server.py "$@"; fi
exec python3 server.py "$@"
