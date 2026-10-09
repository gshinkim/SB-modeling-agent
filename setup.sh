#!/usr/bin/env bash
# One-time setup: Node, a Python that Tellurium supports, the Python requirements,
# and the .claude asset mirror.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "Need Node.js 20 or newer (https://nodejs.org), e.g.  brew install node"
  exit 1
fi

PY=""
for c in python3.12 python3.11 python3.10; do command -v "$c" >/dev/null 2>&1 && { PY="$c"; break; }; done
if [ -z "$PY" ]; then
  echo "Need Python 3.10-3.12 for Tellurium (roadrunner has no wheels for 3.13+)."
  echo "  brew install python@3.12"
  exit 1
fi

[ -d .venv ] || "$PY" -m venv .venv
./.venv/bin/python -m pip install -q --upgrade pip
./.venv/bin/python -m pip install -q -r requirements.txt
./.venv/bin/python -c "import tellurium as te, pypdf; print('tellurium', te.__version__)"

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
  [ -d "$LAYLA/.venv" ] || "$PY" -m venv "$LAYLA/.venv"
  "$LAYLA/.venv/bin/python" -m pip install -q --upgrade pip
  "$LAYLA/.venv/bin/python" -m pip install -q laya==0.3.20
  if [ ! -f "$LAYLA/checkpoint/model.safetensors" ]; then
    echo "Downloading Layla's weights (about 800 MB)..."
    # a failed or cut-off download must not leave half a checkpoint that looks installed
    curl -fL --retry 3 "$LAYLA_WEIGHTS" | tar -x -C "$LAYLA" || { rm -rf "$LAYLA/checkpoint"
      echo "WARNING: could not download Layla's weights. Rerun ./setup.sh to try again (or SKIP_LAYLA=1 to continue without the router)."; }
  fi
fi

command -v claude >/dev/null 2>&1 || echo "NOTE: the 'claude' CLI is not on PATH, so the AI panel will not run yet.
      Install it with:  npm install -g @anthropic-ai/claude-code   then run  claude  once to log in."
echo "Setup complete.  Start with:  ./run.sh"
