# SB modeling agent

A free app for building, running and understanding biochemical models (systems biology).
You write or paste a model, see its simulation as a plot, and chat with an AI assistant
that can read your model, fix it, change it, run it and explain the results to you.

**Watch the video walkthrough first:** https://www.youtube.com/watch?v=lzYMwGxiaCc

> **You do not need to know programming to use this.** This guide assumes you have never
> used a terminal or GitHub before. Follow the steps in order and copy-paste the commands
> exactly. Setup takes about 30–60 minutes the first time, mostly waiting for downloads.

---

## Contents

1. [What you need before you start](#1-what-you-need-before-you-start)
2. [How to open a Terminal and paste commands](#2-how-to-open-a-terminal-and-paste-commands)
3. [Install the required programs (one time)](#3-install-the-required-programs-one-time)
4. [Download and set up the app (one time)](#4-download-and-set-up-the-app-one-time)
5. [Start the app (every time)](#5-start-the-app-every-time)
6. [Using the app](#6-using-the-app)
7. [Stopping the app, and starting it again later](#7-stopping-the-app-and-starting-it-again-later)
8. [Getting the newest version](#8-getting-the-newest-version)
9. [Something went wrong (troubleshooting)](#9-something-went-wrong-troubleshooting)
10. [Developer documentation](#developer-documentation)

---

## 1. What you need before you start

- A computer running **macOS** (Mac), **Windows 10/11**, or **Linux**.
- About **10 GB of free disk space** and a decent internet connection.
- For the AI assistant, **one** of these:
  - **Option A — Claude (easiest, best results):** a paid Claude subscription
    (Pro or Max) from [claude.ai](https://claude.ai). You log in once and the app uses it.
  - **Option B — Free, runs on your own computer:** install [Ollama](https://ollama.com/download)
    or [LM Studio](https://lmstudio.ai). Slower and less smart than Claude, but no subscription.
    Works best on a computer with 16 GB of memory or more.

  The plot and simulation parts of the app work even with no AI at all.

---

## 2. How to open a Terminal and paste commands

A **Terminal** is a window where you type commands instead of clicking. You will only
need it to install and start the app.

**On a Mac**
1. Press `Cmd + Space`, type **Terminal**, press `Enter`.
2. To paste a command: copy it from this page, click inside the Terminal window,
   press `Cmd + V`, then press `Enter`.

**On Windows**
1. Click the Start button, type **PowerShell**, click **Windows PowerShell**.
2. To paste a command: copy it from this page, then **right-click** inside the
   PowerShell window (or press `Ctrl + V`), then press `Enter`.

**On Linux:** open the "Terminal" app. Paste with `Ctrl + Shift + V`.

Tips:
- Paste **one command at a time** and wait until it finishes (the blinking cursor comes
  back and you can type again) before pasting the next one.
- If it asks for a **password**, type your computer login password and press `Enter`.
  **Nothing shows on screen while you type it — that is normal.**
- If it asks `Do you want to continue? [Y/n]`, type `y` and press `Enter`.
- Lots of text scrolling by is normal. Only worry if you see the word `error` at the very end.

---

## 3. Install the required programs (one time)

The app needs four free programs: **Git** (downloads the app), **Node.js** (runs the app),
**Python** (does the math), and **Claude Code** (the AI assistant, only for Option A).

**Important: after installing everything in this step, close the Terminal/PowerShell
window and open a new one.** Otherwise the new programs will not be found.

### On a Mac

**3a. Install Homebrew** (a helper that installs the other programs). Paste:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

It will ask for your password and to press `Enter`. It can take 5–15 minutes and may
also install Apple's "Command Line Tools" (this gives you Git).

**When it finishes, read the last lines.** Under **"Next steps"** it shows two or three
commands that start with `echo` or `eval`. Copy and paste those lines too, one at a time.
(If you skip this, the next commands will say `brew: command not found`.)

**3b. Install Node.js and Python.** Paste:

```bash
brew install node python@3.14
```

**3c. (Option A only) Install Claude Code.** Paste:

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

### On Windows

Paste these into PowerShell one at a time. Click **Yes** if Windows asks for permission.

```powershell
winget install Git.Git
```
```powershell
winget install OpenJS.NodeJS.LTS
```
```powershell
winget install Python.Python.3.14
```

(Option A only) Install Claude Code:

```powershell
irm https://claude.ai/install.ps1 | iex
```

> Do **not** install Claude Code with `npm install -g` on Windows. The app cannot use
> that version. Use the command above.

If `winget` says "not recognized", update **App Installer** from the Microsoft Store and try again.

### On Linux (Ubuntu/Debian)

```bash
sudo apt update && sudo apt install -y git curl python3.14 python3.14-venv
```

Install Node.js 20 or newer from [nodejs.org](https://nodejs.org) (choose the "LTS" version).
(Option A only) install Claude Code:

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

### Log in to Claude (Option A only, all computers)

**Close the window and open a new Terminal/PowerShell.** Then type:

```bash
claude
```

Follow what it says on screen to log in with your Claude account (it opens a browser).
When you see a chat prompt, type `/exit` and press `Enter`. You only do this once.

### Check that everything installed

Open a new Terminal/PowerShell and paste these. Each should print a version number:

```bash
git --version
node --version
```

`node --version` must show `v20` or higher. If a command says "not found" /
"not recognized", see [Troubleshooting](#9-something-went-wrong-troubleshooting).

---

## 4. Download and set up the app (one time)

This downloads the app into a folder called `SB-modeling-agent` inside your home folder
and installs everything it needs.

### On Mac or Linux

Paste these one at a time:

```bash
cd ~
```
```bash
git clone https://github.com/gshinkim/SB-modeling-agent.git
```
```bash
cd SB-modeling-agent
```
```bash
bash setup.sh
```

### On Windows (PowerShell)

```powershell
cd ~
```
```powershell
git clone https://github.com/gshinkim/SB-modeling-agent.git
```
```powershell
cd SB-modeling-agent
```
```powershell
.\setup.cmd
```

> On Windows, type `.\setup.cmd` exactly. Do **not** type `bash setup.sh` in PowerShell.

**Setup takes 10–40 minutes** and downloads several GB (one file alone is about 800 MB).
Let it run. It is finished when you see:

```
Setup complete.  Start with:  ./run.sh
```

If you see `NOTE: the 'claude' CLI is not on PATH`, the app still works, but the
Claude assistant will not until you install Claude Code and log in (step 3).

> **Low on disk space or slow internet?** You can skip the biggest download (an optional
> helper that picks which expert knowledge the AI loads). On Mac/Linux run
> `SKIP_LAYLA=1 bash setup.sh` instead of `bash setup.sh`. The app still works.

---

## 5. Start the app (every time)

In the same Terminal window (you should still be in the `SB-modeling-agent` folder):

**Mac / Linux:**
```bash
bash run.sh
```

**Windows:**
```powershell
.\run.cmd
```

You will see a line like:

```
MCA Atlas  →  http://127.0.0.1:5173
```

Now open your web browser (Chrome, Safari, Edge, Firefox) and go to:

### **http://127.0.0.1:5173**

That is the app. **Keep the Terminal window open while you use it** — closing it
stops the app. The app runs only on your computer; nothing is put on the internet.

---

## 6. Using the app

The screen has three main parts:

- **The model** — your biochemical model, written in **Antimony**, a simple text format
  for reactions. Example:
  ```
  J1: S1 -> S2; k1*S1
  J2: S2 -> ;   k2*S2
  S1 = 10; S2 = 0
  k1 = 0.5; k2 = 0.2
  ```
  This means: S1 turns into S2 at rate `k1*S1`, and S2 is removed at rate `k2*S2`.
  You do not need to learn Antimony to start — you can ask the AI to write it for you.
- **The simulation** — a plot of how each species changes over time. It updates when
  you edit the model. Use the **Steady state** button to see where the system settles,
  and **Download** to save the plot (PNG/SVG) or the numbers (CSV, opens in Excel).
- **The AI assistant** — a chat box at the bottom
  ("Ask about the model, or tell it what to change…"). Type a request and press **Send**.

### Choosing the AI

Pick it in the **AI model** dropdown next to the chat box.

- **Option A (Claude):** choose **Claude (default to your CLI)**. It uses the Claude account you logged in with.
- **Option B (free, local):**
  1. Install and open [Ollama](https://ollama.com/download) or [LM Studio](https://lmstudio.ai).
  2. Download a model. For Ollama, in a Terminal run: `ollama pull qwen3:8b`
     (about 5 GB). In LM Studio, use its search tab to download a model, then load it.
  3. Reload the app page. The model appears in the **AI model** dropdown
     (for example `Ollama · qwen3:8b`). Pick it.
  4. If it does not appear, open **Settings** (the gear button at the bottom of the left edge) →
     **Local models** → **Start Ollama**, then reload.

### Things you can ask

- "Build a model of a three-step linear pathway with feedback inhibition on the first enzyme."
- "Why does my model not reach steady state?"
- "Which reaction controls the flux the most? Run a metabolic control analysis."
- "Increase k1 by 50% and explain what changes."
- "Explain this model to me like I'm a first-year biology student."

The assistant edits the model directly, so the editor and plot update on their own.
Each answer ends with a network map and a causal map of the model.

Your model is saved automatically in the `workspace` folder inside `SB-modeling-agent`.

---

## 7. Stopping the app, and starting it again later

**To stop:** click the Terminal window and press `Ctrl + C` (on Mac too — `Ctrl`, not `Cmd`),
or just close the window.

**To start again another day:** open a new Terminal/PowerShell and paste:

Mac / Linux:
```bash
cd ~/SB-modeling-agent
```
```bash
bash run.sh
```

Windows:
```powershell
cd ~\SB-modeling-agent
```
```powershell
.\run.cmd
```

Then open **http://127.0.0.1:5173** in your browser. You do **not** need to run setup again.

---

## 8. Getting the newest version

When the app is updated, open a Terminal/PowerShell and paste these one at a time:

Mac / Linux:
```bash
cd ~/SB-modeling-agent
```
```bash
git pull
```
```bash
bash setup.sh
```
```bash
bash run.sh
```

Windows:
```powershell
cd ~\SB-modeling-agent
```
```powershell
git pull
```
```powershell
.\setup.cmd
```
```powershell
.\run.cmd
```

Running setup again is safe; it only adds what is new. To update Claude Code itself, run `claude update`.

---

## 9. Something went wrong (troubleshooting)

**First thing to try for almost any problem:** close every Terminal/PowerShell window,
open a new one, and try again. New programs are only found by new windows.

| What you see | What to do |
|---|---|
| `command not found` / `is not recognized` (for `git`, `node`, `python`, `claude`) | The program is not installed, or the window is old. Open a new window. Still failing? Redo that program's install in [step 3](#3-install-the-required-programs-one-time). |
| `brew: command not found` (Mac) | You missed Homebrew's "Next steps" lines. Rerun the Homebrew install command from step 3a and paste the lines it shows at the end. |
| `Need Node.js 20 or newer` | Your Node.js is too old. Mac: `brew upgrade node`. Windows: `winget upgrade OpenJS.NodeJS.LTS`. Then open a new window. |
| `Need Python 3.10-3.14 for Tellurium` | Install Python as in step 3, open a new window, and run setup again. |
| `fatal: destination path 'SB-modeling-agent' already exists` | You already downloaded it. Skip `git clone`; just run `cd SB-modeling-agent` and continue. |
| `No such file or directory` / `Cannot find path` when running `cd SB-modeling-agent` or `run.sh` | You are in the wrong folder. Run `cd ~/SB-modeling-agent` (Windows: `cd ~\SB-modeling-agent`) first. |
| `Run ./setup.sh first.` | Setup did not finish. Run step 4's setup command again. |
| `WARNING: could not download Layla's weights` | Internet hiccup. Run setup again. Or skip it: `SKIP_LAYLA=1 bash setup.sh` (the app still works). |
| `EADDRINUSE` when starting | The app is already running in another window. Use that one, or close it and start again. |
| Browser says "This site can't be reached" | The Terminal running the app was closed or stopped. Start it again (step 5) and keep it open. |
| AI says Claude is not available | Run `claude` in a Terminal and log in (step 3), then restart the app. You need a paid Claude plan. |
| Local model not in the dropdown | Make sure Ollama or LM Studio is open and you downloaded a model, then reload the page. |
| Using Python other than the one setup found | Mac/Linux: `PYTHON=/path/to/python3 bash setup.sh`. If you change Python versions, delete the `.venv` folder inside `SB-modeling-agent` and run setup again. |

Windows extras:
- Using WSL2 (Linux inside Windows)? Follow the Linux steps inside it.
- If you add or edit a Skill in the `skills` folder, run `.\setup.cmd` again so the app sees it.

Still stuck? Open an issue at https://github.com/gshinkim/SB-modeling-agent/issues and
paste the last ~20 lines from your Terminal.

---

## Developer documentation

_Everything below is for programmers who want to change, host, or extend the app. You do not need it to use the app._

## How it fits together

```
web/                 frontend (ES modules, no build step, no dependencies)
backend/server.mjs   HTTP + SSE, Node stdlib only
backend/tellurium.mjs  one warm Python worker, newline-delimited JSON
backend/py/          the Tellurium worker: simulate / steadyState / mca
backend/agent.mjs    spawns the Claude Code CLI as the agent runtime
workspace/model.txt  THE LIVE MODEL — the editor and the agent share this file
workspace/runs/      the agent's scratch scripts, kept for inspection
agents/  skills/     your assets
.claude/ -> symlinks to the two folders above
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
available, with Bash and the real `Skill` tool.

### Two agent runtimes, one agent

Pick the model in the bar under the plot. **Claude (default to your CLI)** sends the
turn with no `--model`, so it uses whatever model your own Claude Code is set to
(change it there with `/model`). Both runtimes run the same analysis discipline:
frame with the `mca` Skill, plan with `tellurium`, execute, validate, diagnose and
repair on failure, interpret, audit. The agent does each stage itself; there is no
separate workflow script.

**`claude-code`** — spawns `claude -p --agent model-scientist`, so the agent gets
the tools its frontmatter declares (`Skill`, `Bash`, file tools) and follows the
procedure in `agents/model-scientist.md`. A session id is claimed once with
`--session-id` and continued with `--resume`, so the chat has memory.

**`openai`** — any OpenAI-compatible server: Ollama, LM Studio, `llama-server`, a
GGUF served by any of them, or a hosted gateway. It gets a compact version of the
same rules (`web/js/prompt.mjs`). This runs in the browser (`web/js/agent.mjs`) when
hosted and on the server (`backend/local-agent.mjs`) in local dev.

In the browser its tools are typed, not arbitrary: `simulate`, `steady_state`, `mca`,
`read_model`, `write_model`, `load_skill`, `read_reference`. There is no
"run this Python", so a hosted deployment never executes model-authored code.
`write_model` simulates a candidate before accepting it and rejects one that does
not load.

`.claude/{agents,skills}` are symlinks, so anything you drop into
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
| `GET /api/env` | tellurium / claude / agent / skills availability |
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
