#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
[ -x .venv/bin/python ] || [ -x .venv/Scripts/python.exe ] || { echo "Run ./setup.sh first."; exit 1; }
exec node backend/server.mjs
