import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, normalize, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { Tellurium } from './tellurium.mjs';
import { Chat } from './local-agent.mjs';
import { v1Base } from '../web/js/oai.mjs';
import { startTurn, resolveScratch } from './chat.mjs';
import { exitMessage } from './agent.mjs';
import { watchLive, liveMeta, stopLive, keepAll } from './live.mjs';
import { jev, laya, questions } from './router.mjs';
import { homedir, hostname } from 'node:os';
import { listSessions, saveSession, openSession, deleteSession,
         sessionDir, readHistory, parseHistory } from './sessions.mjs';
import { typeset } from './latex.mjs';
import { rootFor, listFiles, readText, openRaw, writeText, deleteFile, searchFiles } from './files.mjs';

const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const WEB = join(ROOT, 'web');
// Given, not assumed: the route tests point it at a temp folder, so they never touch
// the user's projects. Unset, it is where it always was.
const WORK = process.env.MCA_WORKSPACE || join(ROOT, 'workspace');
const MODEL_FILE = join(WORK, 'model.txt');
const RUNS = join(WORK, 'runs');
const SETTINGS_FILE = join(WORK, 'settings.json');
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || '127.0.0.1';
// Hosted: Tellurium only. AI runs in the user's browser (local models on their
// machine, hosted models with their own key), so no keys and no code execution here.
const HOSTED = process.env.MCA_HOSTED === '1';

// Local routes can run code and edit files. A foreign page can submit JSON with
// text/plain (no CORS preflight), and DNS rebinding can give localhost a foreign
// Host header. Check both before dispatch; command-line callers need no Origin.
const hostName = s => String(s).toLowerCase().replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');
const localHosts = new Set(['localhost', '127.0.0.1', '::1', hostname().toLowerCase(),
  ...((process.env.MCA_ALLOWED_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean))]);
if (!['0.0.0.0', '::'].includes(HOST)) localHosts.add(hostName(HOST));
function localRequest(req) {
  let host;
  try {
    host = new URL('http://' + req.headers.host);
    if (host.username || host.password || host.pathname !== '/' || host.search || host.hash ||
        host.host !== String(req.headers.host).toLowerCase()) return false;
  } catch { return false; }
  if (!localHosts.has(hostName(host.hostname)) && hostName(host.hostname) !== hostName(req.socket.localAddress)) return false;
  if (req.headers.origin) {
    try {
      const origin = new URL(req.headers.origin);
      if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== host.host ||
          origin.origin !== req.headers.origin) return false;
    } catch { return false; }
  } else if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  return true;
}

const te = new Tellurium(ROOT);

const DEFAULT_MODEL = '';   // a project starts with no model: the user writes, imports or asks for one

const MIME = { '.md': 'text/markdown; charset=utf-8', '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8',
                        'content-length': Buffer.byteLength(s), 'cache-control': 'no-store' });
  res.end(s);
};

async function body(req, limit = 4e6) {
  const chunks = []; let n = 0;
  // Breaking a request's async iterator destroys its socket. Drain an oversized
  // request instead so the caller receives the 413 JSON response, not a network error.
  await new Promise((ok, no) => {
    const cleanup = () => { req.off('data', data); req.off('end', done); req.off('error', fail); req.off('aborted', aborted); };
    const fail = e => { cleanup(); no(e); };
    const aborted = () => fail(Object.assign(new Error('request aborted'), { status: 400 }));
    const done = () => { cleanup(); ok(); };
    const data = c => {
      n += c.length;
      if (n > limit) {
        cleanup(); chunks.length = 0; req.resume();
        return no(Object.assign(new Error('payload too large'), { status: 413 }));
      }
      chunks.push(c);
    };
    req.on('data', data); req.on('end', done); req.on('error', fail); req.on('aborted', aborted);
  });
  if (!chunks.length) return {};
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('invalid JSON body'), { status: 400 }); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw Object.assign(new Error('JSON body must be an object'), { status: 400 });
  return parsed;
}

/* One history.md summary (the fold: ~1000 words -> ~200; or one turn's thinking), by
   the model the user is already using.
   Claude Code has no plain completion endpoint, so it gets a one-shot `claude -p`. */
const summarise = {
  // No maxTokens: the reply budget covers thinking too, and at 800 a thinking model
  // spent it all thinking — measured: bonsai-27b failed every fold (and the cutoff
  // retry) this way and history.md grew to 3,688 words. Uncapped it thought ~1,500
  // words, then wrote the ~200-word summary.
  // Thinking off where the server allows it: a summary needs none, and it is what made
  // a fold take ~5 min on bonsai-27b (LM Studio honours reasoning_effort 'none':
  // measured 0.6 s vs 29 s on a one-line summary). A server that rejects the field
  // gets the plain request.
  async local(chatCfg, [sys, user]) {
    const chat = new Chat(chatCfg);
    const msg = await chat.complete({ messages: [sys, user], extra: { reasoning_effort: 'none' } })
      .catch(() => chat.complete({ messages: [sys, user] }));
    return msg.content;
  },
  claude: (model, [sys, user]) => new Promise((ok, fail) => {
    // the batch goes in on stdin, not argv: Windows caps a command line at 32,767 characters
    const p = spawn('claude', ['-p', '--append-system-prompt', sys.content,
                               '--setting-sources', 'project', ...(model ? ['--model', model] : [])],
                    { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    p.stdin.on('error', () => {});
    p.stdin.end(user.content);
    let out = '', err = '';
    p.stdout.setEncoding('utf8').on('data', d => (out += d));
    p.stderr.setEncoding('utf8').on('data', d => (err = (err + d).slice(-2000)));
    const t = setTimeout(() => p.kill(), 120_000);
    p.on('error', fail);
    p.on('close', (code, sig) => { clearTimeout(t); code === 0 ? ok(out) : fail(new Error(exitMessage(code, err, code === null ? sig : null))); });
  }),
};

/* A local model turn runs for many minutes with nobody touching the Mac, and idle
   sleep cut one mid-step — measured (pmset -g log): display off 19:03:41, idle
   sleep 19:05:55; Chrome dropped the stream as "network error" and the run was
   killed. Hold off idle sleep for the turn only (-w: never outlives the server;
   the display may still sleep). */
const awake = () => process.platform === 'darwin'
  ? spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' }).on('error', () => {})
  : null;

async function ensureWorkspace() {
  await mkdir(join(WORK, 'runs'), { recursive: true });
  if (!existsSync(MODEL_FILE)) await writeFile(MODEL_FILE, DEFAULT_MODEL);
  if (!existsSync(SETTINGS_FILE))
    await writeFile(SETTINGS_FILE, JSON.stringify({ start: 0, end: 100, points: 50 }, null, 2));
}

// The one answer to "which folder does this request mean" (files.mjs rootFor), bound once.
const folder = q => rootFor(q, { work: WORK, runs: RUNS, resolveScratch });

/* A project's model lives in its own folder: the editor, the agent and its Python
   all read and write workspace/<project>/model.txt. workspace/model.txt is only the
   default, for the page before any project exists. The browser names the project
   on every call rather than the server remembering which one is open. */
const modelFile = async project => project ? join(await folder({ project }), 'model.txt') : MODEL_FILE;
// What the editor itself last wrote, per file: the turn's watcher must not echo the
// user's own edits back (a stale echo would snap a dragged slider back). Only a
// *recent* write counts — an old one must not suppress a later AI write that
// happens to land on the same text.
const editorWrote = new Map();
const noteEditorWrite = (file, src) => {
  const seen = editorWrote.get(file) ?? [];
  seen.push({ src, t: Date.now() }); if (seen.length > 20) seen.shift();
  editorWrote.set(file, seen);
};
const editorEcho = (file, src) =>
  (editorWrote.get(file) ?? []).some(w => w.src === src && Date.now() - w.t < 5000);

const WIN = process.platform === 'win32';
const which = cmd => new Promise(r => WIN
  ? execFile('where', [cmd], (e, out) => r(e ? null : out.split(/\r?\n/)[0].trim()))
  : execFile('sh', ['-lc', `command -v ${cmd}`], (e, out) => r(e ? null : out.trim())));
const sleep = ms => new Promise(r => setTimeout(r, ms));
// LM Studio installs its CLI here and only adds it to PATH if you let it.
const LMS = join(homedir(), '.lmstudio/bin/lms' + (WIN ? '.exe' : ''));
const lmsBin = async () => (await which('lms')) ?? (existsSync(LMS) ? LMS : null);

/* Ask an OpenAI-compatible server what it serves. Done here rather than in the
   page: the browser reaching localhost needs OLLAMA_ORIGINS or a CORS setting on
   the model server plus Chrome's local-network prompt, and this server needs
   none of it. */
async function probeOai(baseUrl, apiKey, ms = 6000) {
  const url = v1Base(baseUrl);
  if (!url) return { ok: false, error: 'no URL' };
  try {
    const r = await fetch(url + '/models', { signal: AbortSignal.timeout(ms),
      headers: apiKey ? { authorization: 'Bearer ' + apiKey } : {} });
    if (!r.ok) return { ok: false, error: 'HTTP ' + r.status + ' from ' + url };
    const j = await r.json();
    return { ok: true, url, models: (j.data ?? j.models ?? []).map(m => m.id ?? m.name).filter(Boolean) };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// Where a local runtime listens if you installed it and changed nothing.
const OLLAMA = 'http://127.0.0.1:11434';
const KNOWN = [
  { kind: 'Ollama',    base: OLLAMA },
  { kind: 'LM Studio', base: 'http://127.0.0.1:1234' },
  { kind: 'llama.cpp', base: 'http://127.0.0.1:8080' },
  { kind: 'vLLM',      base: 'http://127.0.0.1:8000' },
];

/* Two large local models do not fit in GPU memory together (LM Studio then fails
   with "Compute error." mid-reply), so picking a model unloads every other one
   loaded in Ollama or LM Studio. No keep = unload everything (a Claude model).
   ponytail: only the default ports in KNOWN; a runtime moved elsewhere is left alone. */
const hostOf = u => String(u || '').replace(/\/v\d+\/?$/, '').replace(/\/+$/, '').replace('//localhost', '//127.0.0.1');
const LMSTUDIO = KNOWN.find(k => k.kind === 'LM Studio').base;
async function ejectOthers(keepBase = '', keepModel = '') {
  // The test suite starts this server against a stub model, and "every other model"
  // was then the user's real one: it was unloaded mid-turn (measured 2026-10-08, three
  // times). A test server must never reach the real LM Studio or Ollama.
  if (process.env.MCA_NO_EJECT === '1') return [];
  const keep = (base, ...names) => hostOf(keepBase) === base &&
    names.some(n => n === keepModel || n === keepModel + ':latest');
  const call = (url, body) => fetch(url, { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(3000),
    headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
    .then(r => r.json()).catch(() => ({}));
  const gone = [];
  for (const m of (await call(OLLAMA + '/api/ps')).models ?? [])
    if (!keep(OLLAMA, m.name, m.model)) {
      await call(OLLAMA + '/api/generate', { model: m.name, keep_alive: 0 }); gone.push('Ollama ' + m.name);
    }
  for (const m of (await call(LMSTUDIO + '/api/v1/models')).models ?? [])
    for (const i of m.loaded_instances ?? [])
      if (!keep(LMSTUDIO, m.key, i.id)) {
        await call(LMSTUDIO + '/api/v1/models/unload', { instance_id: i.id }); gone.push('LM Studio ' + i.id);
      }
  if (gone.length) console.log('[eject]', gone.join(', '));
  return gone;
}

/* ------------------------------- static ------------------------------- */
// The browser agent loads its prompt and Skills over HTTP, so these
// two folders are served read-only alongside web/.
const ASSET_DIRS = ['agents', 'skills'];

async function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0]);
  if (p === '/') p = '/index.html';
  const top = p.split('/')[1];
  const root = ASSET_DIRS.includes(top) ? ROOT : WEB;
  const file = normalize(join(root, p));
  const base = root === ROOT ? join(ROOT, top) : WEB;
  if (!file.startsWith(base + sep)) return json(res, 403, { error: 'forbidden' });
  if (root === ROOT && !/\.(md|js|json)$/.test(file)) return json(res, 403, { error: 'forbidden' });
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream',
                         'cache-control': 'no-cache' });
    res.end(data);
  } catch { json(res, 404, { error: 'not found: ' + p }); }
}

/* -------------------------------- api --------------------------------- */
/* What a hosted deployment answers instead of running the route: it has no local
   folder, no keys and no model server, so everything but Tellurium is refused (or
   answered empty, where the page asks on load). */
const NOT_HOSTED = { error: 'not available on a hosted deployment' };
const NO_SESSIONS = { error: 'sessions are local-only' }, NO_FILES = { error: 'files are local-only' };
const HOSTED_REPLY = {
  // Hosted: no-op. There's one Tellurium worker shared by every visitor, so
  // persisting a model here would leak one visitor's draft into another's page;
  // the editor already holds the model client-side.
  'PUT /api/model':            [200, { ok: true }],
  'PUT /api/settings':         [200, { ok: true }],
  'GET /api/model':            [200, { src: '' }],
  'GET /api/settings':         [200, { start: 0, end: 100, points: 50 }],
  'GET /api/history':          [200, { summary: '', lines: [] }],
  'GET /api/fs':               [400, NOT_HOSTED],
  'POST /api/scratch':         [400, { ok: false,
    error: 'This deployment runs Tellurium only; there is no local folder to write to.' }],
  'GET /api/sessions':         [400, NO_SESSIONS],
  'POST /api/sessions/save':   [400, NO_SESSIONS],
  'POST /api/sessions/open':   [400, NO_SESSIONS],
  'POST /api/sessions/delete': [400, NO_SESSIONS],
  'GET /api/files':            [400, NO_FILES],
  'GET /api/file':             [400, NO_FILES],
  'PUT /api/file':             [400, NO_FILES],
  'DELETE /api/file':          [400, NO_FILES],
  'GET /api/search':           [400, NO_FILES],
  'POST /api/probe':           [400, NOT_HOSTED],
  'POST /api/latex':           [400, { ok: false, ...NOT_HOSTED }],
  'GET /api/local/scan':       [200, { hosted: true, servers: [], ollama: null }],
  'POST /api/local/eject':     [200, { ejected: [] }],
  'POST /api/local/start':     [400, { ok: false, ...NOT_HOSTED }],
  'POST /api/router/test':     [400, { ok: false, ...NOT_HOSTED }],
  'POST /api/chat':            [400, { error:
    'This deployment runs Tellurium only. Pick a local model in Settings — it runs on ' +
    'your machine and talks to this site directly.' }],
};

const routes = {
  'GET /api/health': async (req, res) => json(res, 200, { ok: te.installed }),

  'GET /api/env': async (req, res) => {
    const [ver, claude, skills] = await Promise.all([
      te.versions(),
      which('claude'),
      readdir(join(ROOT, 'skills')).catch(() => []),
    ]);
    json(res, 200, {
      hosted: HOSTED,
      tellurium: te.installed ? ver : { error: 'not installed — run: bash setup.sh' },
      telluriumInstalled: te.installed,
      claude: claude ? { path: claude } : { error: 'claude CLI not found on PATH' },
      agent: existsSync(join(ROOT, 'agents/model-scientist.md')) ? 'model-scientist' : null,
      skills: skills.filter(s => !s.includes('.')),   // folders only, not index.json
    });
  },

  'GET /api/model': async (req, res) => {
    const file = await modelFile(new URL(req.url, 'http://x').searchParams.get('project'));
    json(res, 200, { src: await readFile(file, 'utf8').catch(() => '') });
  },

  'PUT /api/model': async (req, res) => {
    const { src, project } = await body(req);
    if (typeof src !== 'string') return json(res, 400, { error: 'src must be a string' });
    const file = await modelFile(project);
    noteEditorWrite(file, src);
    await writeFile(file, src);
    json(res, 200, { ok: true });
  },

  'PUT /api/settings': async (req, res) => {
    const s = await body(req);
    await writeFile(SETTINGS_FILE, JSON.stringify(s, null, 2));
    json(res, 200, { ok: true });
  },

  'GET /api/settings': async (req, res) => {
    let s;
    try { s = JSON.parse(await readFile(SETTINGS_FILE, 'utf8')); }
    catch { s = { start: 0, end: 100, points: 50 }; }
    json(res, 200, s);
  },

  'POST /api/simulate': async (req, res) => {
    const q = await body(req);
    if (typeof q.model !== 'string' || !q.model.trim()) return json(res, 400, { ok: false, error: 'model is empty' });
    json(res, 200, await te.call('simulate', q));
  },
  'POST /api/info': async (req, res) => {
    const q = await body(req);
    if (typeof q.model !== 'string' || !q.model.trim()) return json(res, 400, { ok: false, error: 'model is empty' });
    json(res, 200, await te.call('info', q));
  },
  'POST /api/steady': async (req, res) => json(res, 200, await te.call('steadyState', await body(req))),
  'POST /api/settle': async (req, res) => json(res, 200, await te.call('settle', await body(req), 120000)),
  'POST /api/mca':    async (req, res) => json(res, 200, await te.call('mca', await body(req), 120000)),

  /* A ```latex block in an answer, compiled by Tectonic (backend/latex.mjs). */
  'POST /api/latex': async (req, res) => {
    const { src } = await body(req, 2e5);
    if (typeof src !== 'string' || !src.trim()) return json(res, 400, { ok: false, error: 'src is empty' });
    json(res, 200, await typeset(src, ROOT));
  },

  /* An imported file becomes Antimony: SBML is converted by Tellurium. */
  'POST /api/convert': async (req, res) => json(res, 200, await te.call('antimony', await body(req))),

  /* The project's memory (history.md), for the History pane. */
  'GET /api/history': async (req, res) => {
    const project = new URL(req.url, 'http://x').searchParams.get('project');
    if (!project) return json(res, 200, { summary: '', lines: [] });
    let dir;
    try { dir = await sessionDir(WORK, project); } catch (e) { return json(res, 400, { error: e.message }); }
    json(res, 200, parseHistory(await readHistory(dir)));
  },

  /* Directory listing for the local-model file picker. The browser cannot give a
     real path from <input type=file>, so the server browses instead. */
  'GET /api/fs': async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const want = u.searchParams.get('path');
    const dir = want ? normalize(want) : homedir();
    const filter = (u.searchParams.get('ext') || '').split(',').filter(Boolean);
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (e) { return json(res, 400, { error: e.code === 'ENOENT' ? 'no such folder' : e.message, path: dir }); }
    const dirs = [], files = [];
    for (const d of entries) {
      if (d.name.startsWith('.')) continue;
      if (d.isDirectory()) dirs.push({ name: d.name, dir: true, path: join(dir, d.name) });
      else if (!filter.length || filter.some(x => d.name.toLowerCase().endsWith(x)))
        files.push({ name: d.name, dir: false, path: join(dir, d.name) });
    }
    const sort = (a, b) => a.name.localeCompare(b.name);
    json(res, 200, { path: dir, parent: dirname(dir) === dir ? null : dirname(dir),
                     home: homedir(), entries: [...dirs.sort(sort), ...files.sort(sort)] });
  },

  'POST /api/scratch': async (req, res) => {
    const { dir } = await body(req);
    try { json(res, 200, { ok: true, dir: await resolveScratch(dir, RUNS), default: RUNS }); }
    catch (e) { json(res, 200, { ok: false, error: String(e.message || e) }); }
  },

  /* Sessions. One folder per project directly under workspace/; the directory
     listing is the session list. Hosted deployments have no local folder to keep them in. */
  'GET /api/sessions': async (req, res) => {
    json(res, 200, { sessions: await listSessions(WORK) });
  },

  'POST /api/sessions/save': async (req, res) => {
    const { id, name, fresh, chats, settings, model } = await body(req);
    if (!id) return json(res, 400, { error: 'id is required' });
    try { json(res, 200, await saveSession(WORK, { id, name, fresh, chats, settings, model })); }
    catch (e) { json(res, 400, { error: String(e.message || e) }); }
  },

  'POST /api/sessions/open': async (req, res) => {
    const { id } = await body(req);
    let s;
    try { s = await openSession(WORK, id); }
    catch (e) { return json(res, 400, { error: String(e.message || e) }); }
    // the project's own model.txt is what the editor shows and the agent edits;
    // nothing is copied over the default workspace/model.txt any more
    if (s.settings && Object.keys(s.settings).length)
      await writeFile(SETTINGS_FILE, JSON.stringify(s.settings, null, 2));
    json(res, 200, s);
  },

  'POST /api/sessions/delete': async (req, res) => {
    const { id } = await body(req);
    try { await deleteSession(WORK, id); stopLive(id); json(res, 200, { ok: true }); }
    catch (e) { json(res, 400, { error: String(e.message || e) }); }
  },

  /* Files and Search views (backend/files.mjs). The folder is the one the agent
     writes to: the working folder from Settings, else the project's, else runs/. */
  'GET /api/files': async (req, res) => {
    const q = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
    const root = await folder(q);
    json(res, 200, { root, files: await listFiles(root) });
  },

  'GET /api/file': async (req, res) => {
    const q = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
    const root = await folder(q);
    if (q.raw !== '1') return json(res, 200, await readText(root, q.path));
    const { stream, size, type } = await openRaw(root, q.path);
    // sandbox: an SVG opened on its own must not run script with this origin
    res.writeHead(200, { 'content-type': type, 'content-length': size, 'cache-control': 'no-store',
                         'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox' });
    stream.on('error', () => res.destroy()).pipe(res);
  },

  'PUT /api/file': async (req, res) => {
    const q = await body(req);
    const root = await folder(q);
    json(res, 200, await writeText(root, q.path, q.content));
  },

  'DELETE /api/file': async (req, res) => {
    const q = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
    const root = await folder(q);
    json(res, 200, await deleteFile(root, q.path));
  },

  'GET /api/search': async (req, res) => {
    const q = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
    const root = await folder(q);
    json(res, 200, { results: await searchFiles(root, q.q) });
  },

  /* Probe an OpenAI-compatible endpoint and list the models it serves. */
  'POST /api/probe': async (req, res) => {
    const { baseUrl, apiKey } = await body(req);
    if (!baseUrl) return json(res, 400, { ok: false, error: 'baseUrl is required' });
    const r = await probeOai(baseUrl, apiKey);
    json(res, 200, r.ok ? r : { ...r, error: r.error + ' — is the server running?' });
  },

  /* Every local runtime already listening, found without the user configuring
     anything. This is what makes a local model plug-and-play: the page picks a
     model from here and the turn is proxied through this server, so the model
     server never sees a browser origin and never needs a CORS flag. */
  'GET /api/local/scan': async (req, res) => {
    const servers = (await Promise.all(KNOWN.map(async k => {
      const r = await probeOai(k.base, '', 1500);
      return r.ok ? { ...k, models: r.models } : null;
    }))).filter(Boolean);
    json(res, 200, { hosted: false, servers, ollama: await which('ollama'), lmstudio: await lmsBin() });
  },

  'POST /api/local/eject': async (req, res) => {
    const { baseUrl, model } = await body(req);
    json(res, 200, { ejected: await ejectOthers(baseUrl, model) });
  },

  /* Start Ollama and LM Studio's server for the user instead of telling them to
     open a terminal. LM Studio's app running is not enough: its models only reach
     the picker once its server listens on 1234, and nothing here could start it. */
  'POST /api/local/start': async (req, res) => {
    const [ol, lms] = await Promise.all([which('ollama'), lmsBin()]);
    if (!ol && !lms) return json(res, 200, { ok: false,
      error: 'Neither Ollama nor LM Studio is installed. Install one (https://ollama.com/download or https://lmstudio.ai), then press Start again.' });
    const bring = async (bin, base, args) => {
      if (!bin) return undefined;                 // not installed: nothing to start
      const up = await probeOai(base, '', 1200);
      if (up.ok) return up.models;
      spawn(bin, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      for (let i = 0; i < 25; i++) {
        await sleep(400);
        const r = await probeOai(base, '', 1000);
        if (r.ok) return r.models;
      }
      return null;
    };
    const got = await Promise.all([bring(ol, OLLAMA, ['serve']), bring(lms, LMSTUDIO, ['server', 'start'])]);
    if (!got.some(Array.isArray))
      return json(res, 200, { ok: false, error: 'started the local servers, but nothing came up on 11434 or 1234' });
    json(res, 200, { ok: true, models: got.filter(Array.isArray).flat() });
  },

  /* The Settings "Test" button: one fixed routing call to the chosen provider, which
     should say tellurium. For Layla it also warms the worker (the model load). */
  'POST /api/router/test': async (req, res) => {
    const { key, provider } = await body(req);
    if (provider !== 'laya' && !key) return json(res, 400, { ok: false, error: 'the key is empty' });
    const t0 = Date.now();
    const state = { request: 'simulate this model for 100 seconds', loaded: [], recent: [],
                    model: 'has model', step: 0 };
    try {
      const p = provider === 'laya' ? await laya({ root: ROOT, state, questions: await questions(ROOT) })
        : await jev({ key, questions: await questions(ROOT), signal: AbortSignal.timeout(10000), state });
      json(res, 200, { ok: true, ms: Date.now() - t0, p });
    } catch (e) {
      json(res, 200, { ok: false, error: e?.name === 'TimeoutError' ? 'Jev timed out' : String(e?.message || e) });
    }
  },

  /* Server-sent events: one agent turn, streamed. */
  'POST /api/chat': async (req, res) => {
    const q = await body(req, 60e6);       // photos: far past the 4 MB a JSON call needs
    let key;
    try { key = await startTurn(q, { root: ROOT, work: WORK, te, editorEcho, eject: ejectOthers, summarise, awake }); }
    catch (e) { if (e.status) return json(res, e.status, { error: e.message }); throw e; }
    follow(res, key);
  },

  /* A page that was closed, or reloaded, while its project's turn was running: the turn
     so far, then the rest live. 204 when there is none. The first event says what was
     asked, since the page that knew is gone. */
  'GET /api/chat/live': async (req, res) => {
    const key = new URL(req.url, 'http://x').searchParams.get('project') || '';
    const meta = liveMeta(key);   // never one on a hosted deployment: /api/chat is refused there
    if (!meta) { res.writeHead(204); return res.end(); }
    follow(res, key, { type: 'live', ...meta });
  },

  // Stop is a request now: a closed connection used to be the only way to say it.
  'POST /api/chat/stop': async (req, res) => {
    stopLive((await body(req)).project || '');
    json(res, 200, { ok: true });
  },
};

/** Stream a project's turn to one browser as SSE: all of it so far, then live. The
    browser going away only ends this stream. */
function follow(res, key, first) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8',
                       'cache-control': 'no-cache', connection: 'keep-alive',
                       'x-accel-buffering': 'no' });
  const write = o => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(o)}\n\n`); };
  if (first) write(first);
  const ka = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15000);
  const off = watchLive(key, o => { if (o) return write(o); clearInterval(ka); if (!res.writableEnded) res.end(); });
  // res 'close' is what tracks the SSE connection (req 'close' fires once the body is read)
  res.on('close', () => { clearInterval(ka); off?.(); });
}

const server = createServer(async (req, res) => {
  const url = req.url || '/';
  const key = `${req.method} ${url.split('?')[0]}`;
  const handler = routes[key];
  try {
    if (!HOSTED && !localRequest(req)) json(res, 403, { error: 'local server requires a trusted Host and same-origin request' });
    else if (HOSTED && HOSTED_REPLY[key]) json(res, ...HOSTED_REPLY[key]);
    else if (handler) { await ensureWorkspace(); await handler(req, res); }
    else if (req.method === 'GET') await serveStatic(req, res, url);
    else json(res, 404, { error: 'no route for ' + key });
  } catch (e) {
    console.error(key, e);
    if (!res.headersSent) json(res, e.status || 500, { error: String(e.message || e) });
    else res.end();
  }
});

// A crash here reaches the browser as an unexplained "network error"; log and stay up.
process.on('uncaughtException', e => console.error('[uncaught]', e));
// Ctrl+C, a closed terminal, a stop: running turns go to disk before the process does.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.once(sig, () => keepAll().finally(() => process.exit(0)));
process.on('unhandledRejection', e => console.error('[unhandled]', e));

await ensureWorkspace();
server.listen(PORT, HOST, async () => {
  const v = await te.versions();
  console.log(`MCA Atlas  →  http://${HOST}:${PORT}${HOSTED ? '  (hosted mode: Tellurium only)' : ''}`);
  console.log(te.installed ? `  tellurium ${v.tellurium} · roadrunner ${v.roadrunner} · python ${v.python}`
                           : '  tellurium NOT installed — run: bash setup.sh');
  console.log(HOSTED ? '  agent runs in the browser; no keys or code execution on this server'
                     : '  agent: model-scientist');
});
