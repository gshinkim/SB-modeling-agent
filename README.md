# SB modeling agent

An expert agent for creating, fixing, understanding biochemical models: an Antimony model on the left, its
simulation in the middle, its configuration on the right, and an agent that can
read, edit, run and analyse the model the same way you can.
## Note: Claude Code needs a subscription to use, unless you use local ai models using providers such as LmStudio and Ollama

## Install and run

Runs on macOS, Linux and Windows. You need Git, Node.js 20+, Python 3.10–3.14, and
Claude Code for the AI panel. The rest of the app works without Claude Code.

## If you haven't installed git (needed to pull this repository), node, python (3.10 - 3.14) , and claude code (to use as agent), use the following instructions: 

| | macOS | Linux (Debian/Ubuntu) | Windows |
|---|---|---|---|
| Git | `xcode-select --install` | `sudo apt install git curl` | `winget install Git.Git` |
| Node.js 20+ | `brew install node` | [nodejs.org](https://nodejs.org) or your package manager | `winget install OpenJS.NodeJS.LTS` |
| Python | `brew install python@3.14` | `sudo apt install python3.14 python3.14-venv` | `winget install Python.Python.3.14` |
| Claude Code | `curl -fsSL https://claude.ai/install.sh \| bash` | `curl -fsSL https://claude.ai/install.sh \| bash` | PowerShell: `irm https://claude.ai/install.ps1 \| iex` |

In a terminal, type 'claude' to start claude and log in.

Then, on macOS or Linux in a terminal run the following commands:

```bash
git clone https://github.com/gshinkim/SB-modeling-agent.git
cd SB-modeling-agent
bash setup.sh     # once: Python venv, Tellurium, the Layla router and its weights
                  # uses your existing Python (never downloads one); PYTHON=/path/to/python3 bash setup.sh picks it
bash run.sh       # open http://127.0.0.1:5173
```

On Windows, in a terminal run the following commands:

```powershell
git clone https://github.com/gshinkim/SB-modeling-agent.git
cd SB-modeling-agent
.\setup.cmd       # once
.\run.cmd         # open http://127.0.0.1:5173
```

Do not type `bash setup.sh` in PowerShell or cmd: `bash` there is the WSL launcher,
not Git Bash. `setup.cmd` finds Git's own bash and runs `setup.sh` with it.

Windows notes:

- Install Claude Code with the native installer above or go to the Anthropic website and follow the instructions to install claude code. Do not use `npm install -g`. npm
  installs a `claude.cmd` shim, which the app cannot start; the installer gives
  `claude.exe`.
- Open a new terminal after installing anything, so it is on `PATH`.
- `.claude/{agents,skills,workflows}` are copies on Windows, not symlinks. After
  adding or editing a Skill, rerun `.\setup.cmd` to refresh them.
- WSL2 also works; inside it, follow the Linux column.

`setup.sh` takes several minutes and several GB on first run (PyTorch and the router
weights are the bulk). `SKIP_LAYLA=1 ./setup.sh` skips the router; the app then uses
Jev, or no router at all. Rerunning `setup.sh` is safe.

### Updating the application (if there is a newer version) run the following:

```bash
git pull
bash setup.sh     # safe to rerun: picks up new requirements, refreshes .claude/
bash run.sh
```

On Windows: `git pull`, then `.\setup.cmd`, then `.\run.cmd`.

To update the tools themselves:

| | macOS | Linux (Debian/Ubuntu) | Windows |
|---|---|---|---|
| Claude Code | `claude update` | `claude update` | `claude update` |
| Node.js | `brew upgrade node` | your package manager | `winget upgrade OpenJS.NodeJS.LTS` |
| Python | stay on 3.10–3.14 | stay on 3.10–3.14 | stay on 3.10–3.14 |

If you change the Python version, delete `.venv` and rerun `bash setup.sh`.
# How to Run the app: 
https://www.youtube.com/watch?v=VFNUfk25T_o


## Developer Documentation
## How it fits together

```
web/                 frontend (ES modules, no build step, no dependencies)
backend/server.mjs   HTTP + SSE, Node stdlib only
backend/tellurium.mjs  one warm Python worker, newline-delimited JSON
backend/py/          the Tellurium worker: simulate / steadyState / mca
backend/agent.mjs    spawns the Claude Code CLI as the agent runtime
workspace/model.txt  THE LIVE MODEL — the editor and the agent share this file
workspace/runs/      the agent's scratch scripts, kept for inspection
agents/  skills/  workflows/     your assets
.claude/ -> symlinks to the three folders above
```

## Deploying it

The site is hosted; **the AI is not**. Inference runs on the researcher's own
machine and the browser talks to it directly, so the server never sees a key, a
prompt, or a token — it only runs Tellurium.

This section is about a *hosted* deployment. Running locally needs none of it —
see [Using a local model](#using-a-local-model).

```
browser ──► http://localhost:11434   inference (their laptop, their GGUF)
        └─► https://your-site/api    simulate · steady · mca   (Tellurium)
```

**This works.** Verified on Chrome 152 with Local Network Access enforced: a page
on `https://example.com` ran a prompt through Ollama on the local machine and got
the reply back in 8.1s. Requirements:

| | |
|---|---|
| Site on HTTPS | yes |
| Local Network Access permission | one-time per site, and it only prompts **during a user gesture** — that is why connecting is a button |
| CORS on the model server | `OLLAMA_ORIGINS=https://your-site ollama serve` · LM Studio's CORS toggle · `llama-server --cors` |
| `targetAddressSpace` | omit, or `'loopback'` for localhost. Never `'local'` — 127.0.0.1 is the loopback space and the mismatch is rejected instantly |
| Server-side opt-in headers | none. Local Network Access supersedes Private Network Access, so `Access-Control-Allow-Private-Network` is no longer needed |

Settings → Local models → **Connect** distinguishes the three failure modes,
because from JavaScript they are identical: permission blocked, CORS not
configured, server not running.

### Where to host

**Not Vercel or Netlify.** `libroadrunner` is a compiled C++ wheel and the
dependency tree is ~625 MB — far past any serverless function limit. You need a
container.

| Host | Free tier | Notes |
|---|---|---|
| **Fly.io** | yes, scales to zero | `fly.toml` is in the repo — `fly launch --copy-config` |
| **Hugging Face Spaces** | yes, Docker SDK | good fit for a research tool; set the port to 8080 |
| **Google Cloud Run** | generous, scales to zero | `gcloud run deploy --source .` |
| **Render** | yes, sleeps when idle | Docker service, 512 MB is tight but works |

Set `MCA_HOSTED=1`. That serves Tellurium and the static app only, and refuses the
server-side agent path — so a public deployment cannot be made to execute code.

Locally (`./run.sh`, no `MCA_HOSTED`) the Claude Code agent runtime stays
available, with Bash and the real `Workflow` tool.

### Two agent runtimes, one workflow

Pick the model in the bar under the plot. **Claude (default to your CLI)** sends the
turn with no `--model`, so it uses whatever model your own Claude Code is set to
(change it there with `/model`). Both runtimes run **the same**
`workflows/mca-tellurium.js` and the same `agents/model-scientist.md`.

**`claude-code`** — spawns `claude -p --agent model-scientist` with
`enableWorkflows` on, so the agent gets exactly the eight tools its frontmatter
declares, `Workflow` and `Skill` included. A session id is claimed once with
`--session-id` and continued with `--resume`, so the chat has memory.

**`openai`** — any OpenAI-compatible server: Ollama, LM Studio, `llama-server`, a
GGUF served by any of them, or a hosted gateway. There is no `Workflow` tool there,
so the runtime **loads `workflows/mca-tellurium.js` and runs that exact source**,
supplying its own `agent()` / `phase()` / `log()` backed by the endpoint. This runs
in the browser (`web/js/agent.mjs`) when hosted and on the server
(`backend/local-agent.mjs`) in local dev — same workflow file either way.

Its tools are typed, not arbitrary: `simulate`, `steady_state`, `mca`,
`read_model`, `write_model`, `load_skill`, `read_reference`. There is no
"run this Python", so a hosted deployment never executes model-authored code.
`write_model` simulates a candidate before accepting it and rejects one that does
not load.
The workflow is not re-implemented or approximated — your file drives the local
model verbatim, including its `missing_from_user` halt and its repair loop. Stage
prompts that say "call the Skill tool" are served by a `load_skill` tool over the
same `skills/` folder.

Verified on a mock endpoint: `MCA frame → Tellurium plan → Execute → MCA validate →
MCA interpret → Tellurium audit` (Diagnose is skipped when validation passes), with
real Tellurium runs at the Execute stage.

Local models are *slow* at this: seven sequential stages, each a multi-turn tool
loop. A 27B on a laptop can take an hour. The UI streams the current phase and a
heartbeat so you can see it is alive, and each stage has a 15-minute budget after
which it is forced to answer.

**Settings → Runtime → "Max Effort"** turns the orchestration
off. The agent then analyses directly — same `model-scientist` definition, same
Skills, same Tellurium, no seven-stage sequence. With it off the `Workflow` tool is
withheld from the CLI (`--settings '{"enableWorkflows":false}'` and dropped from
`--allowedTools`) and the local runtime stops offering `run_mca_workflow`, so the
agent cannot quietly take the slow path anyway.

`.claude/{agents,skills,workflows}` are symlinks, so anything you drop into
`skills/` is live on the next turn — no restart, no copy step (on Windows they are
copies: rerun `.\setup.cmd`).

### Using a local model

Locally there is nothing to configure. On load the page calls `GET /api/local/scan`
and **this server** — not the browser — probes the ports a local runtime listens on
out of the box:

| | |
|---|---|
| Ollama | `11434` |
| LM Studio | `1234` |
| `llama-server` | `8080` |
| vLLM | `8000` |

Whatever answers shows up in the model picker as `Ollama · qwen3:8b`; pick it and
the turn is proxied through `POST /api/chat`. Because the page only ever talks to
its own origin, **none of the browser-side requirements apply**: no `OLLAMA_ORIGINS`,
no CORS toggle, no Chrome local-network prompt.

If nothing is running, Settings → Local models → **Start Ollama** launches the
daemon for you (`POST /api/local/start` spawns `ollama serve` detached and waits for
the port). Models still have to exist on disk — `ollama pull qwen3:8b` — because
that is a multi-gigabyte download and not something to start behind a button.

The browser-direct path in [Deploying it](#deploying-it) is only for a **hosted**
deployment, where the server is not the user's machine and genuinely cannot reach
their runtime. That is the case that needs the CORS flag and the permission prompt.

### Picking local model files

Everything below is the manual fallback, for a runtime on a port we do not scan or
a machine that is not this one. The Settings → Local models tab has a **Browse…**
button. A browser cannot reveal a real filesystem path from `<input type=file>`, so
`GET /api/fs` lists directories server-side and the picker returns an absolute path.
**Test & list models** probes an endpoint's `/v1/models` and fills in the model list
for you.

A `.gguf` file is weights, not a server — serve it first
(`llama-server -m <file> --port 8080`, or `lms load <file>`) and point the URL at it.

**Permissions are scoped, not bypassed.** The agent may run the project's own
`./.venv/bin/python` (`./.venv/Scripts/python.exe` on Windows) and read/edit files in the project. Nothing else is allowed;
widen the `--allowedTools` list in `backend/agent.mjs` deliberately.

## Everything numeric is Tellurium

There is no solver, no integrator and no model parser in the browser. The frontend
sends Antimony text to the backend and draws whatever comes back; axis ticks and
pixel positions are the only arithmetic it does.

That is enforced, not just true today: the Python worker stamps every reply with
`source: "tellurium"` plus the engine versions, and `chart.mjs` refuses to plot a
result that lacks the stamp — it draws *"Refusing to plot: result did not come from
Tellurium"* instead. The running versions are printed in the caption under the plot.

## Steady state

The **Steady state** button next to the plot title switches the run mode. Instead
of a fixed window it asks RoadRunner's own steady-state solver for the target,
then widens the integration horizon (doubling, up to t=1e6) until the trajectory
is within tolerance of it, and plots the approach with a dashed marker at the
settling time. The caption reports the settling time and the solver residual.

The target comes from the solver, never from watching the curve flatten — a slow
transient must not be mistaken for convergence. If the solver does not converge
(an oscillator, an unstable model) the run reports that rather than plotting a
guess. Start/End are disabled in this mode; Tellurium picks the horizon.

## When the solver struggles

A stiff, singular or diverging model makes CVODE give up (`CV_TOO_MUCH_WORK`,
`CV_CONV_FAILURE`). That is information about the model, not a reason to show
nothing, so the worker:

- raises the integrator's step ceiling from 20 000 to 500 000;
- on failure, **bisects the reachable horizon** and returns the trajectory up to
  the point the solver stopped, with a warning under the editor. `-> X; X*X`
  with `X=1` plots to t≈0.977 — the analytic blow-up is exactly t=1.

Steady state checks **stability at the fixed point** before integrating toward it.
An unstable fixed point is never reached however far you integrate — that is what
used to run the horizon out to 1e6 and kill the solver. The Brusselator at A=1,
B=3 now returns in 0.1s reporting eigenvalues 0.5 ± 0.866i (a Hopf pair), plots
the oscillation, and says the steady state exists but is unstable.

## The model is one source of truth

`workspace/model.txt` is the Antimony source. The editor writes it, the agent edits
it, and both re-read it. Moving a slider rewrites the matching `k = value`
assignment in that text rather than holding a separate value, so the code you see
is always the model that ran. When the agent changes the file, the turn ends with a
`model_changed` event and the editor and chart follow.

## API

| | |
|---|---|
| `GET /api/env` | tellurium / claude / agent / workflow / skills availability |
| `GET`·`PUT /api/model` | the live Antimony source |
| `POST /api/simulate` | `{model,start,end,points}` → timecourse + species/parameter ids |
| `POST /api/steady` | steady state: distance, concentrations, fluxes |
| `POST /api/settle` | simulate up to steady state: the approach, settling time, residual |
| `POST /api/mca` | scaled flux/concentration control coefficients, elasticities, summation residuals |
| `POST /api/chat` | one agent turn, streamed as SSE; `runtime` picks claude-code or openai |
| `GET /api/fs` | directory listing for the local-model file picker |
| `POST /api/probe` | check an OpenAI-compatible endpoint and list its models |

## Exporting

The **Download** button under the plot writes a PNG (2× scale), an SVG, or the
plotted series as CSV. Past eight series identity moves to a second channel
(dash pattern) rather than a reused hue, so no two curves ever look alike.

## Notes

- Tellurium 2.2.13.1 (libroadrunner 2.10.0) runs on Python 3.10–3.14. `setup.sh`
  picks a compatible interpreter and keeps it in `.venv`.
- The Python worker stays warm because `import tellurium` costs seconds and the UI
  simulates on every edit.
- Endpoints and keys entered in Settings stay in the browser; they are sent with the
  turn that uses them and never written to disk by the server.
- The local runtime's tools are jailed to the project directory; `run_python` uses
  the project's own `.venv` and keeps each script in `workspace/runs/`.

## Layla: the local skill router

`Layla (altlernative to jev)/` is a fine-tuned [Laya](https://github.com/receptron/laya)
(ModernBERT-large) that decides which Skills (`mca`, `tellurium`, `pathway-modeling`)
a request needs, fully offline. It replaces Jev as the router; pick one under
Settings → Runtime. `backend/router.mjs` runs `serve.py` as a warm Python worker.

Held-out test set (173 cases), exact-set accuracy: **Layla 0.971**, TF-IDF 0.890,
keywords 0.792, Jev 0.283, untrained Laya 0.249.

The trained weights are one 804 MB file, over GitHub's 100 MB limit for git, so they
are attached to the `layla-v1` release instead, and `./setup.sh` downloads them and
installs Layla's own Python environment (`pip install laya==0.3.20`).
`SKIP_LAYLA=1 ./setup.sh` leaves Layla out.

Publishing new weights (maintainers, after pushing):

```bash
tar -cf /tmp/layla-checkpoint.tar -C "Layla (altlernative to jev)" checkpoint
gh release create layla-v1 /tmp/layla-checkpoint.tar --title "Layla weights" \
  --notes "Trained Layla checkpoint, downloaded by setup.sh."
```
