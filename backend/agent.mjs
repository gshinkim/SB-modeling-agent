import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FORMAT, WORKFLOW_OFF, summaryBlock } from '../web/js/prompt.mjs';
import { logLine, hintLine, autoBlock } from './router.mjs';
import { VENV_PY } from './tellurium.mjs';

/* The agent runtime is the Claude Code CLI, because that is what the project's
   assets are written against: agents/model-scientist.md is a subagent definition
   and workflows/mca-tellurium.js calls agent()/phase()/Skill. Re-implementing
   those semantics against a raw chat API would be a second, worse runtime.
   .claude/{agents,skills,workflows} symlink to the real folders, so anything the
   user drops in skills/ is picked up on the next turn with no restart. */

const AGENT = 'model-scientist';
const WORKFLOW = 'mca-tellurium';

export const SYSTEM_APPEND = `
You are running inside MCA Atlas, a web workbench for metabolic control analysis.

THE LIVE MODEL is the file workspace/model.txt, in Antimony format. It is the exact
text shown in the user's editor. To change what the user sees, edit that file with
Edit or Write - the UI reloads it when your turn ends. Never describe an edit you
did not make to that file.

Simulation settings the user has set live in workspace/settings.json
({start, end, points}); honour them when you simulate unless asked otherwise.

Tellurium is installed at ./${VENV_PY} (tellurium, roadrunner, numpy, scipy).
Always invoke it as ./${VENV_PY} - the system python3 does NOT have tellurium.
Running it is pre-approved, whether or not the workflow is on. Write the script with
the Write tool, then run it as one plain command: ./${VENV_PY} <script>. No
heredocs, no \`cat >\`, no chains of commands - a long compound command is refused as
a whole even though every part of it is allowed. If a run was denied earlier in this
conversation, that was the command's shape, not Tellurium: retry in this shape.

Route every analysis through the ${WORKFLOW} workflow, per your agent definition.

${FORMAT}
`.trim();

/* The model is pasted in, not just pointed at: an agent that asks "is there a model?"
   when one is sitting in the editor is useless. It must still re-read the file before
   editing, because the user may have typed since this prompt was built. */
export const liveModelBlock = src => !src?.trim() ? `

The live model file workspace/model.txt is currently EMPTY. If the user asks for a
model, write one there yourself - do not ask them to supply one.` : `

## The live model, as of this message

This is the current content of workspace/model.txt. You can see it; never ask the
user whether a model exists or to paste one. Re-read the file before editing it,
since the user may have typed since.

\`\`\`
${src.trim()}
\`\`\``;

/* Workflows off: the orchestration is skipped, the scientific discipline is not. */
export const NO_WORKFLOW = `
## Workflow disabled for this session

The Workflow tool is NOT available and the ${WORKFLOW} workflow will not run.
${WORKFLOW_OFF}

Do the analysis directly instead, and keep every other rule in your definition:
inspect the model before any claim about it, load a Skill with the Skill tool 
when you need its detail use each skill as much as you can instead of using your own knowledge,
compute nothing from memory - every number still comes from a Tellurium run you
performed - and still say how well supported each part of your answer is.

Be proportionate: a short question gets a short, direct answer.
`.trim();

/* The CLI can only discover Skills under .claude/skills, and announces that as each
   Skill's base directory. The real folder is skills/ at the install root; say so by
   absolute path, so the agent reads the files the user edits and never goes looking
   in its own ~/.claude/skills or in the workspace. */
export const skillsBlock = root => `

## Where the Skills are

This project's Skills (mca, tellurium, pathway-modeling) are the folder
\`${join(root, 'skills')}\`
Load one with the Skill tool by its bare name. The tool will report a base directory
ending in .claude/skills/<name>: that is only a link the CLI needs. Read a Skill's
reference files from \`${join(root, 'skills')}\`/<name>/ instead. Skills are not in
workspace/, not in your working folder, and not in the user's home ~/.claude/skills;
never look for them or load same-named Skills from there.

## A loaded index is not a used Skill

A Skill's SKILL.md is only its index. Having it in front of you - because you loaded
it, or because it was put in this prompt for you - does not mean you have used the
Skill. You have used a Skill only when you have opened the reference files its index
points to for this question and worked from what they say.

Do not trust what you already know. Before you build, change or analyse anything:
1. Decide which Skills the request touches. Building or changing a model, kinetics,
   steady states, stability or oscillation: pathway-modeling. Any Tellurium or
   Antimony code: tellurium. Control coefficients, elasticities, or any claim about
   what controls or limits a pathway: mca. Most requests touch more than one.
2. For each one, read its index, then open the specific reference files that cover
   the request. Do this before writing the model or the script, not after.
3. Before your final answer, check again: for every Skill the request touched, name
   to yourself the reference files you opened. If the answer is none, stop and read
   them now, then revise the work if they change it.

Go back to a Skill as often as you need. Each Skill holds many reference files, and
having read one part of it is no reason not to read another: after one pathway-modeling
chapter you may open a second and a third. You may also open the same reference file
again if you no longer remember what it said. "Do not load it again" only ever means
the index itself.

If you are unsure whether a Skill applies, it applies: open it. Never tell the user
you used a Skill whose reference files you did not open.`;

// Sessions this process actually started. A id is claimed once with --session-id
// and continued with --resume; guessing wrong is an immediate exit(1).
const STARTED = new Set();

/* The user's working folder. Everything the agent produces goes here; the project
   itself stays read-mostly, holding the Skills, the venv and the live model. */
export const scratchBlock = dir => `

## Your working folder

\`${dir}\`

Every script, table, figure and data file you produce goes in there, and nothing you
create belongs anywhere else. Write to it by absolute path. It is the user's folder,
so leave it readable: name files for what they are, not run-1234567890.py.
The live model stays at workspace/model.txt - that one is still edited in place.`;

/* In a project the live model is that project's own model.txt. The agent definition
   and the text above name workspace/model.txt throughout; point every mention at the
   project's file, and say so outright, so no edit lands in the default model. */
export const projectModel = (text, modelPath) => modelPath === 'workspace/model.txt' ? text :
  text.replaceAll('workspace/model.txt', modelPath) + `

## This project's model

THE LIVE MODEL for this project is \`${modelPath}\`. Wherever your agent definition
says workspace/model.txt, it means this file. Never read or edit workspace/model.txt:
that is the default model, not this project's.`;

export function buildArgs({ root, prompt, sid, resuming, model, useWorkflow = true,
                            liveModel = '', modelPath = 'workspace/model.txt',
                            scratch = '', summary = '' }) {
  const args = [
    '-p', prompt,
    '--agent', AGENT,
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    // Claude 5 models default to thinking blocks with empty text ("thinking_display":
    // "updates"), which leaves the UI's thinking panel shut. Ask for the summary.
    '--thinking-display', 'summarized',
    '--forward-subagent-text',            // surface the workflow subagents' reasoning too
    // A session id may only be *claimed* once; continuing one is --resume.
    ...(resuming ? ['--resume', sid] : ['--session-id', sid]),
    '--setting-sources', 'project',
    '--permission-mode', 'acceptEdits',
    '--permission-prompts', 'none',
    // Narrow, not bypassed: the agent may run the project's own venv python and
    // read/edit files in the project, and nothing else. Widen only deliberately.
    '--allowedTools',
    'Skill', ...(useWorkflow ? ['Workflow'] : []), 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite',
    `Bash(./${VENV_PY}:*)`, `Bash(${VENV_PY}:*)`,
    // The agent writes scripts to the working folder by absolute path, so it runs the
    // venv by absolute path too — often after a `cd`. A plain absolute-path rule never
    // matches (the path is quoted: spaces, parentheses); the leading * does.
    // On Windows the agent's shell is Git Bash, which may spell the root C:/..., /c/...
    // or with backslashes, so there the rule matches on the venv path alone.
    `Bash(*${process.platform === 'win32' ? '' : root}/${VENV_PY}*)`,
    '--append-system-prompt', projectModel(SYSTEM_APPEND + skillsBlock(root) + (scratch ? scratchBlock(scratch) : '') +
                              liveModelBlock(liveModel) + summaryBlock(summary) +
                              (useWorkflow ? '' : '\n\n' + NO_WORKFLOW), modelPath),
    '--settings', JSON.stringify({ enableWorkflows: useWorkflow }),
    '--add-dir', root,
    ...(scratch && !scratch.startsWith(root) ? ['--add-dir', scratch] : []),
  ];
  if (model) args.push('--model', model);
  return args;
}

export function runAgent({ root, prompt, sessionId, model, env = {}, useWorkflow = true,
                          liveModel = '', modelPath, scratch = '', summary = '', resume = false,
                          router = null, onEvent }) {
  /* STARTED only knows about this process's own runs. A session loaded from disk
     was claimed by an earlier run of this server, so the caller says so with
     `resume` — without it the CLI is handed an id it has already claimed and the
     turn dies on a restart. */
  const resuming = !!sessionId && (resume || STARTED.has(sessionId));
  const sid = resuming ? sessionId : randomUUID();
  STARTED.add(sid);
  // UI events out, the same shapes runLocalAgent emits: stream-json never leaves this file.
  const emit = raw => { const ev = toUiEvent(raw); if (ev) onEvent(ev); };
  let proc = null, killed = false;
  (async () => {
    // The Skill router (backend/router.mjs), if switched on in Settings. The local
    // agent routes at every step itself; the Claude CLI runs its own tool loop, so it
    // is routed once, here, before the turn. The key is never logged.
    if (router) {
      const r = await router({});
      onEvent({ type: 'log', text: logLine(r) });
      // Shown like any load, as the local agent does: the CLI is told not to load these
      // again, so no Skill tool call would otherwise ever put them in the chat.
      if (r.auto.length) onEvent({ type: 'tools', tools: r.auto.map(([name]) => ({ name: 'load_skill', input: { name, by: 'router' } })) });
      prompt += hintLine(r.hint) + await autoBlock(r.auto, root);
    }
    // stopped while routing: end the turn as a killed CLI would, without starting one
    if (killed) return emit({ type: 'done', code: null, sessionId: sid });
    proc = spawnClaude(buildArgs({ root, prompt, sid, resuming, model, useWorkflow,
                                   liveModel, modelPath, scratch, summary }), root, env, emit, sid);
  })().catch(e => { emit({ type: 'fatal', error: String(e.message || e) });
                    emit({ type: 'done', code: 1, sessionId: sid }); });

  return { sessionId: sid, kill: () => { killed = true; proc?.kill('SIGTERM'); } };
}

function spawnClaude(args, root, env, emit, sid) {
  /* Windows caps a whole command line at 32,767 characters, and a turn's prompt (with
     Skills inlined) plus its system prompt (live model, history) can pass that. So
     neither rides in argv: the prompt goes in on stdin, the system prompt in a file. */
  const [, prompt, ...rest] = args;                       // buildArgs starts '-p', prompt
  const i = rest.indexOf('--append-system-prompt');
  const sysFile = join(tmpdir(), `mca-atlas-${sid}.txt`);
  writeFileSync(sysFile, rest[i + 1]);
  rest.splice(i, 2, '--append-system-prompt-file', sysFile);
  const tidy = () => rmSync(sysFile, { force: true });
  const proc = spawn('claude', ['-p', ...rest], {
    cwd: root,
    // extended thinking is off by default in print mode; the UI has a place to show it.
    // Only MAX_THINKING_TOKENS is a caller override — the request body's `env` is not
    // otherwise merged into the child process (it used to be, letting a direct POST
    // set PATH, CLAUDE_*, proxy vars, etc. for the `claude` subprocess).
    env: { ...process.env, MAX_THINKING_TOKENS: String(env.MAX_THINKING_TOKENS ?? '6000') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  proc.stdin.on('error', () => {});                       // no CLI to write to: 'error' below reports it
  proc.stdin.end(prompt);

  let buf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try { emit(JSON.parse(line)); }
      catch { /* a non-JSON line from the CLI is noise, not a turn */ }
    }
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', d => emit({ type: 'stderr', text: String(d) }));
  proc.on('error', e => { tidy(); emit({ type: 'fatal', error: e.code === 'ENOENT'
    ? 'The `claude` CLI was not found on PATH. Install Claude Code, or pick a different runtime in Settings.' +
      (process.platform === 'win32' ? ' On Windows use the native installer (claude.exe); the npm install is a .cmd shim this app cannot start.' : '')
    : e.message }); });
  proc.on('close', code => { tidy(); emit({ type: 'done', code, sessionId: sid }); });
  return proc;
}

/* Flatten the CLI's stream-json into the few event shapes the UI actually renders. */
export function toUiEvent(ev) {
  if (ev.type === 'stderr' || ev.type === 'fatal' || ev.type === 'done') return ev;
  if (ev.type === 'system' && ev.subtype === 'init')
    return { type: 'init', model: ev.model, tools: ev.tools, agents: ev.agents, sessionId: ev.session_id };
  /* A workflow's stages run as subagents whose tool calls the CLI does not stream: all
     that reaches here is progress, described as "<phase title>: <stage label>". Without
     it a workflow turn showed one chip and then nothing for minutes. */
  if (ev.type === 'system' && ev.subtype === 'task_progress') {
    const tail = ': ' + ev.last_tool_name;
    return ev.last_tool_name && ev.description?.endsWith(tail)
      ? { type: 'phase', phase: ev.description.slice(0, -tail.length), label: ev.last_tool_name } : null;
  }
  if (ev.type === 'stream_event') {
    const d = ev.event?.delta;
    if (d?.type === 'text_delta' && d.text) return { type: 'delta', text: d.text };
    if (d?.type === 'thinking_delta' && d.thinking) return { type: 'thinking', text: d.thinking };
    return null;
  }
  if (ev.type === 'assistant') {
    const out = [];
    let thought = '';
    for (const c of ev.message?.content ?? []) {
      if (c.type === 'tool_use') out.push({ name: c.name, input: c.input });
      else if (c.type === 'thinking' && c.thinking) thought += c.thinking;
    }
    // whole-block thinking; the UI drops it if the deltas already delivered it
    if (thought) return { type: 'thinking', text: thought, whole: true,
                          tools: out.length ? out : undefined };
    return out.length ? { type: 'tools', tools: out } : null;
  }
  if (ev.type === 'user') {
    const c = ev.message?.content?.find?.(x => x.type === 'tool_result');
    if (c) return { type: 'tool_result', isError: !!c.is_error };
    return null;
  }
  if (ev.type === 'result')
    return { type: 'result', text: ev.result, isError: ev.is_error,
             ms: ev.duration_ms, cost: ev.total_cost_usd, turns: ev.num_turns };
  return null;
}
