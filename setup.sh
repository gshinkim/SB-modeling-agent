#!/usr/bin/env bash
# One-time setup: Node, a Python that Tellurium supports, the Python requirements,
# and the .claude asset mirror. macOS, Linux, and Windows (run it from Git Bash).
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "Need Node.js 20 or newer: https://nodejs.org"
  exit 1
fi

# The version is asked of the interpreter, not read off its name: Windows has only
# `python` and the `py` launcher, and `python` there can be the Store stub that runs nothing.
# $c is left unquoted on purpose, "py -3.14" is a command and its argument.
# Setup never installs Python: it uses one already on the machine, the user's default
# python3 first. PYTHON=/path/to/python picks one explicitly. Two stubs are skipped
# because running them offers to download Python: macOS's /usr/bin/python3 without
# the Command Line Tools, and Windows' WindowsApps "python" that opens the Store.
is_stub() {
  local p; p="$(command -v "${1%% *}" 2>/dev/null)" || return 0
  case "$p" in
    */WindowsApps/*) return 0 ;;
    /usr/bin/python3) [ "$(uname)" = Darwin ] && ! xcode-select -p >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}
PY=""
for c in ${PYTHON:+"$PYTHON"} python3 python python3.14 python3.13 python3.12 python3.11 python3.10 "py -3.14" "py -3.13" "py -3.12" "py -3.11" "py -3.10"; do
  is_stub "$c" && continue
  $c -c 'import sys; sys.exit(not (3,10) <= sys.version_info[:2] <= (3,14))' >/dev/null 2>&1 && { PY="$c"; break; }
done
if [ -z "$PY" ]; then
  echo "Need Python 3.10-3.14 for Tellurium, and none was found on this machine."
  echo "  Already have one? Rerun with it:  PYTHON=/path/to/python3 ./setup.sh"
  echo "  macOS: brew install python@3.14    Ubuntu/Debian: sudo apt install python3.14 python3.14-venv"
  echo "  Windows: winget install Python.Python.3.14"
  exit 1
fi

# A venv keeps its interpreter in Scripts/ on Windows and in bin/ everywhere else.
venv_py() { [ -d "$1/Scripts" ] && echo "$1/Scripts/python" || echo "$1/bin/python"; }

[ -d .venv ] || $PY -m venv .venv
VPY="$(venv_py .venv)"
"$VPY" -m pip install -q --upgrade pip
"$VPY" -m pip install -q -r requirements.txt
"$VPY" -c "import tellurium as te, pypdf; print('tellurium', te.__version__)"

# Claude Code resolves agents/skills/workflows under .claude/. Symlinks, not copies,
# so anything dropped into skills/ is live on the next agent turn. Recreated here
# because a zip download or a Windows clone will not preserve them.
mkdir -p .claude workspace/runs
for d in skills agents workflows; do
  rm -rf ".claude/$d"
  ln -s "../$d" ".claude/$d" 2>/dev/null || cp -R "$d" ".claude/$d"
done

# Layla, the local Skill router. Its own environment (torch is large, and Tellurium's
# must stay small), and its trained weights from this repository's release: one 804 MB
# file, over GitHub's 100 MB limit for git itself, and 65 minutes to train otherwise.
# SKIP_LAYLA=1 leaves it out; the app then routes with Jev, or not at all.
LAYLA="Layla (altlernative to jev)"
LAYLA_WEIGHTS="${LAYLA_WEIGHTS:-https://github.com/gshinkim/MCA-Agent/releases/download/layla-v1/layla-checkpoint.tar}"
if [ "${SKIP_LAYLA:-}" != 1 ]; then
  [ -d "$LAYLA/.venv" ] || $PY -m venv "$LAYLA/.venv"
  LPY="$(venv_py "$LAYLA/.venv")"
  "$LPY" -m pip install -q --upgrade pip
  "$LPY" -m pip install -q laya==0.3.20
  if [ ! -f "$LAYLA/checkpoint/model.safetensors" ]; then
    echo "Downloading Layla's weights (about 800 MB)..."
    # a failed or cut-off download must not leave half a checkpoint that looks installed
    curl -fL --http1.1 --retry 3 "$LAYLA_WEIGHTS" | tar -x -C "$LAYLA" || { rm -rf "$LAYLA/checkpoint"
      echo "WARNING: could not download Layla's weights. Rerun ./setup.sh to try again (or SKIP_LAYLA=1 to continue without the router)."; }
  fi
fi

# Tectonic: real LaTeX for the assistant's ```latex blocks. One binary in .tools/, from
# Tectonic's own installer; it fetches the TeX packages it needs on first use.
# SKIP_TECTONIC=1 leaves it out; those blocks then show as source.
if [ "${SKIP_TECTONIC:-}" != 1 ] && ! command -v tectonic >/dev/null 2>&1 && [ ! -e .tools/tectonic ] && [ ! -e .tools/tectonic.exe ]; then
  mkdir -p .tools
  (cd .tools && curl --proto '=https' --tlsv1.2 -fsSL https://drop-sh.fullyjustified.net | sh) ||
    echo "WARNING: could not install Tectonic. Rerun ./setup.sh to try again; LaTeX blocks show as source until then."
fi

command -v claude >/dev/null 2>&1 || echo "NOTE: the 'claude' CLI is not on PATH, so the AI panel will not run yet.
      Install it (https://code.claude.com/docs/en/setup), then run  claude  once to log in."
echo "Setup complete.  Start with:  ./run.sh"
