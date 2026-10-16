/* Starting the turn a POST /api/chat asks for, without the HTTP around it: server.mjs
   parses the request and streams the result; the rules — which runtime, which folders,
   which model file, where attachments go, what is remembered versus what is asked —
   are here. What reaches outside the workspace (ejecting other models, the summariser,
   holding off sleep) is passed in, so chat.test.mjs runs it in a temp folder with fakes. */
import { stat, access } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { join, normalize, isAbsolute } from 'node:path';
import { VENV_PY } from './tellurium.mjs';
import { runAgent } from './agent.mjs';
import { runLocalAgent } from './local-agent.mjs';
import { runTurn } from './turn.mjs';
import { startLive } from './live.mjs';
import { compactPrompt, thinkingPrompt } from './sessions.mjs';
import { rootFor, saveAttachments, attachmentNote } from './files.mjs';

const bad = msg => Object.assign(new Error(msg), { status: 400 });

/* Where the AI does its work. Default is the install's own scratch folder; the user
   can point it anywhere they can write. Only the AI's scratch moves — the live model
   and the simulation settings stay in workspace/ either way. */
export async function resolveScratch(dir, runs) {
  if (!dir) return runs;
  const p = normalize(String(dir));
  if (!isAbsolute(p)) throw new Error('the working folder must be an absolute path');
  const st = await stat(p).catch(() => null);
  if (!st) throw new Error('no such folder: ' + p);
  if (!st.isDirectory()) throw new Error('not a folder: ' + p);
  await access(p, FS.W_OK).catch(() => { throw new Error('cannot write to: ' + p); });
  return p;
}

/** `q` is the request body; `work` the workspace root. `eject`, `summarise` ({ local,
    claude }) and `awake` are the outside effects, `run` is runTurn (or a fake). A request
    that cannot start a turn throws with status 400 and the text the chat shows.
    Returns the key the turn is followed by (live.mjs). */
export async function startTurn({ message, sessionId, sessionDirId, model, env, runtime, chatCfg,
                                  scratchDir, useWorkflow = true, resume = false, router: routerCfg,
                                  attachments, chat },
                                { root, work, te, editorEcho, eject, summarise, awake, run = runTurn }) {
  if (typeof message !== 'string' || !message.trim()) throw bad('message is empty');
  const local = runtime === 'openai';
  // A misconfigured endpoint used to surface in the browser as a bare "network
  // error"; say what is actually wrong, over SSE, so the chat can show it.
  if (local && (typeof chatCfg?.baseUrl !== 'string' || !chatCfg.baseUrl.trim()))
    throw bad('No server URL for this model. Open Settings → Local models, set the URL ' +
      '(Ollama: http://localhost:11434, LM Studio: http://localhost:1234), press ' +
      '"Test & list models", then Save.');
  const folder = q => rootFor(q, { work, runs: join(work, 'runs'), resolveScratch });
  // The project's own folder is where its memory (history.md) and its scratch live.
  let sdir = null, scratch;
  try { if (sessionDirId) sdir = await folder({ project: sessionDirId }); }
  // worded as before: 'no such project: x' bare, a bad id prefixed
  catch (e) { throw bad(e.message.replace(/^(?!no such project)/, 'Project: ')); }
  // A working folder the user picked in Settings wins over the project's own
  // folder; the project folder is only the fallback scratch (rootFor's precedence).
  try { scratch = await folder({ dir: scratchDir, project: sessionDirId }); }
  catch (e) { throw bad('Working folder: ' + e.message +
    ' — pick another in Settings, or clear it to use the default.'); }
  // in a project the agent edits that project's model, not the default one
  const mfile = join(sdir ?? work, 'model.txt');
  // Attachments go where the agent already works, and the message says where: both
  // runtimes can then open them with the file tools they have.
  let att = [];
  try { att = await saveAttachments(scratch, attachments, join(root, VENV_PY)); }
  catch (e) { throw bad('Could not save the attachment: ' + e.message); }
  // history.md and the router get the question and the file names; only the agent gets the contents
  const said = !att.length ? message : message + '\n\n[attached: ' + att.map(f => f.path).join(', ') + ']';
  const ask = message + attachmentNote(att, local);

  // Refused requests must never unload a running model. Validate the folders and
  // save the attachments before touching any local runtime.
  if (local) await eject(chatCfg.baseUrl, chatCfg.model).catch(() => {});

  const held = awake();
  // history.md's summaries are written by the model the user is already using
  const sum = local ? p => summarise.local(chatCfg, p) : p => summarise.claude(model, p);

  // The turn belongs to the project, not to this response (live.mjs): closing the page
  // no longer stops it. The turn itself — watcher, event queue, history, end-of-turn
  // ordering — is turn.mjs.
  const key = sessionDirId || '';
  try {
    startLive(key, { q: message, chat, files: att.map(f => f.name), at: Date.now() }, (emit, end) => run({
      root, sdir, mfile, scratch, message: said, ask, routerCfg, runtime, editorEcho, emit,
      agent: local ? runLocalAgent : runAgent,
      args: { sessionId, model, env: env || {}, chatCfg, useWorkflow, resume, te, images: att.filter(f => f.kind === 'image').map(f => f.url) },
      compact: (s, batch) => sum(compactPrompt(s, batch)),
      shorten: thinking => sum(thinkingPrompt(thinking)),
      end: () => { held?.kill(); end(); } }));
  } catch (e) { held?.kill(); throw e; }
  return key;
}
