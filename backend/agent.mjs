import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { FORMAT } from '../web/js/prompt.mjs';
import { logLine, hintLine, autoBlock } from './router.mjs';

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

Tellurium is installed at ./.venv/bin/python (tellurium, roadrunner, numpy, scipy).
Always invoke it as ./.venv/bin/python - the system python3 does NOT have tellurium.
Running it is pre-approved, whether or not the workflow is on. Write the script with
the Write tool, then run it as one plain command: ./.venv/bin/python <script>. No
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

The Workflow tool is NOT available and the ${WORKFLOW} workflow will not run. The
user turned it off deliberately, because the full seven-stage sequence is slow.
Do not ask for it back and do not refuse the work.

Do the analysis directly instead, and keep every other rule in your definition:
inspect the model before any claim about it, load a Skill with the Skill tool 
when you need its detail use each skill as much as you can instead of using your own knowledge,
compute nothing from memory - every number still comes from a Tellurium run you
performed - and still say how well supported each part of your answer is.

Be proportionate: a short question gets a short, direct answer.
`.trim();

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

/* The project's history.md. Inlined rather than pointed at: a model that has to
   call a tool to find its own memory is a model that will sometimes not bother. */
export const summaryBlock = text => !text?.trim() ? '' : `

## Project history

Your own record of this project: a summary of everything older, then the
latest turns (what was asked, how you reasoned, what you answered). It is not
a tool result: a number from it may be stale, and the live model may have
changed since. Any number you report this turn comes from a tool call you
make this turn.

${text.trim()}
`;

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
    'Bash(./.venv/bin/python:*)', 'Bash(.venv/bin/python:*)',
    // The agent writes scripts to the working folder by absolute path, so it runs the
    // venv by absolute path too — often after a `cd`. A plain absolute-path rule never
    // matches (the path is quoted: spaces, parentheses); the leading * does.
    `Bash(*${root}/.venv/bin/python*)`,
    '--append-system-prompt', projectModel(SYSTEM_APPEND + (scratch ? scratchBlock(scratch) : '') +
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
  const proc = spawn('claude', args, {
    cwd: root,
    // extended thinking is off by default in print mode; the UI has a place to show it.
    // Only MAX_THINKING_TOKENS is a caller override — the request body's `env` is not
    // otherwise merged into the child process (it used to be, letting a direct POST
    // set PATH, CLAUDE_*, proxy vars, etc. for the `claude` subprocess).
    env: { ...process.env, MAX_THINKING_TOKENS: String(env.MAX_THINKING_TOKENS ?? '6000') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

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
  proc.on('error', e => emit({ type: 'fatal', error: e.code === 'ENOENT'
    ? 'The `claude` CLI was not found on PATH. Install Claude Code, or pick a different runtime in Settings.'
    : e.message }));
  proc.on('close', code => emit({ type: 'done', code, sessionId: sid }));
  return proc;
}

/* Flatten the CLI's stream-json into the few event shapes the UI actually renders. */
export function toUiEvent(ev) {
  if (ev.type === 'stderr' || ev.type === 'fatal' || ev.type === 'done') return ev;
  if (ev.type === 'system' && ev.subtype === 'init')
    return { type: 'init', model: ev.model, tools: ev.tools, agents: ev.agents, sessionId: ev.session_id };
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
