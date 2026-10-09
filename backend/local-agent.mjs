import { readFile, writeFile, readdir, mkdir, lstat, realpath } from 'node:fs/promises';
import { join, resolve, relative, dirname, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { forHistory, toolRunner, toolResult, readCompletion, fitMessages, resultCap,
         CONTEXT_DEFAULT, REPEAT_LIMIT, stripToolSyntax, missingArgs, replyTokens,
         stepBudget, SAMPLING, cutoffNudge, antimonyHint, callTool, userQuestion, closedNote,
         constrain, quiet, hasNumber, NO_ANSWER } from '../web/js/oai.mjs';
import { localSystem } from '../web/js/prompt.mjs';
import { logLine, hintLine, recentLine, failed } from './router.mjs';
import { pdfText, asText } from './files.mjs';
import { VENV_PY, PY_ENV } from './tellurium.mjs';

/* A second agent runtime for models that are not Claude Code: anything speaking
   OpenAI-compatible /v1/chat/completions (Ollama, LM Studio, llama-server, a GGUF
   served by any of them, a hosted gateway).

   The point of this file is that it does NOT re-implement the workflow. It loads
   workflows/mca-tellurium.js and runs that exact source, supplying its own
   agent()/phase()/log(). The user's workflow drives the local model verbatim. */

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/* ------------------------------- provider ------------------------------- */
export class Chat {
  constructor({ baseUrl, apiKey, model, contextTokens, replyPct, resultPct, steps }) {
    this.url = String(baseUrl || '').replace(/\/+$/, '');
    if (!/\/v\d+$/.test(this.url)) this.url += '/v1';
    this.apiKey = apiKey; this.model = model;
    // What the runtime loaded the model with, not what the weights allow: LM
    // Studio and Ollama both default well below the maximum.
    this.ctxSet = Number(contextTokens) > 0;
    this.ctx = this.ctxSet ? Number(contextTokens) : CONTEXT_DEFAULT;
    // Settings -> Budget. Left unset each falls back to the shares in oai.mjs.
    this.replyPct = replyPct; this.resultPct = resultPct; this.steps = steps;
  }

  /* Always streams. A slow local model can sit well past Node's 300s fetch
     header timeout before its first byte, which surfaces to the user as a bare
     "network error"; streaming returns headers immediately and then keeps the
     body flowing, so the connection never idles out. It also lets thinking and
     tokens reach the UI as they are produced. */
  /* max_tokens bounds the thinking block and the visible answer together. Pinned
     at a flat 4096 a reasoning model spent the whole of it thinking and came back
     finish_reason "length" with nothing to show — and raising the context setting
     could not help, because 4096 was the binding term, not the window. Size the
     reply to the window the model was actually loaded with, and fit the prompt
     around that same number so both halves fit at once. */
  /* LM Studio: see below. Otherwise, unless the user set a context size, ask Ollama
     the window of the loaded model (/api/ps), else the model's own num_ctx (/api/show). The
     24576 default was 8k short of the 32768 Ollama had loaded, and it is what three
     Skills overflowed. Any other server, or no answer, keeps the default. */
  /* Asked twice at most: before the first request, and once more after a request
     has gone out, unless the first ask already found the loaded window. Ollama loads the model on
     that first request, so /api/ps only knows its window afterwards — measured:
     asked once, qwen3.8:27b ran all turn on the 24576 default while Ollama had it
     at 32768, and the trimmer cut both Skills to 2000 chars mid-turn. */
  async detectContext(signal) {
    if (this.detected >= 2 || (this.detected === 1 && !this.sent)) return;
    this.detected = (this.detected ?? 0) + 1;
    const base = this.url.replace(/\/v\d+$/, '');
    // Two lookups, so a server that never answers at all can take up to two 3 s
    // timeouts; tie each to the caller's own abort signal too, so Stop still ends
    // this rather than leaving it to run out the clock on its own.
    const deadline = ms => signal ? AbortSignal.any([AbortSignal.timeout(ms), signal]) : AbortSignal.timeout(ms);
    const ask = async (path, body, ms = 3000) => {
      const r = await post(base + path, { 'content-type': 'application/json' },
        body && JSON.stringify(body), deadline(ms), body ? 'POST' : 'GET');
      return r.ok ? JSON.parse(await r.text()) : {};
    };
    /* LM Studio, model not loaded yet: the first chat request JIT-loads it at LM
       Studio's own default, 8192 — measured: the turn died on its first Skill
       load with HTTP 400 "request (10294 tokens) exceeds the available context
       size (8192 tokens)", every time. Load it ourselves, and at the largest window
       this computer takes: ask for the model's maximum (or the user's own number),
       and halve on a refusal down to a size a Skill turn still fits in. LM Studio may
       also fit the request to memory itself (measured, MLX: asked 131072, loaded
       118016), so the window is read back rather than assumed. Already loaded: its
       real window wins over any setting. */
    const info = () => ask('/api/v0/models/' + encodeURIComponent(this.model)).catch(() => ({}));
    const lm = await info();
    if (lm.max_context_length > 0) {
      if (lm.state === 'loaded' && lm.loaded_context_length > 0) { this.ctx = lm.loaded_context_length; this.detected = 2; return; }
      // Already loading (LM Studio's own JIT, or another turn): a second load made a second
      // instance, "model:2", 37 GB beside the first. Wait for the one under way instead.
      for (let i = 0, m = lm; m.state === 'loading' && i < 300; i++) {
        await new Promise(r => setTimeout(r, 1000)); m = await info();
        if (m.state === 'loaded' && m.loaded_context_length > 0) { this.ctx = m.loaded_context_length; this.detected = 2; return; }
      }
      // ponytail: halving search, each refusal costs one load attempt; ask LM Studio for its own estimate if that gets slow
      for (let want = Math.min(this.ctxSet ? this.ctx : Infinity, lm.max_context_length); ; want = Math.floor(want / 2)) {
        const r = await ask('/api/v1/models/load', { model: this.model, context_length: want }, 300000)
          .catch(() => ({}));
        if (r.status === 'loaded') { this.ctx = (await info()).loaded_context_length || want; this.detected = 2; return; }
        if (want <= LMSTUDIO_LOAD_CTX) break;
      }
    }
    if (this.ctxSet) { this.detected = 2; return; }
    // Separate try per lookup: /api/show failing (a timeout, or a 200 that is not
    // JSON) used to throw away a good /api/ps result too, and the turn silently
    // fell back to the 24576 default. Skip /api/show once /api/ps already answered.
    const live = await ask('/api/ps').then(j => j.models
      ?.find(m => m.name === this.model || m.model === this.model)?.context_length).catch(() => 0);
    const n = live > 0 ? live : await ask('/api/show', { model: this.model })
      .then(j => Number(/(?:^|\n)\s*num_ctx\s+(\d+)/.exec(j.parameters ?? '')?.[1])).catch(() => 0);
    if (n > 0) this.ctx = n;
    if (live > 0) this.detected = 2;
  }

  async complete({ messages, tools, schema, signal, onStream, maxTokens, extra }) {
    await this.detectContext(signal);
    const cap = Math.max(256, Math.min(maxTokens ?? Infinity, replyTokens(this.ctx, this.replyPct)));
    /* Closing tools (the wrap-up) still sends the last ones offered, and says so in
       words at the end instead of tool_choice 'none'. The chat template renders the
       tool list first, so dropping it changed the prompt from its first token and
       the prompt cache missed — measured on LM Studio: the wrap-up re-read 25,910
       tokens from zero (~3 min at 140 tok/s) and looked hung; and tool_choice
       'none' makes LM Studio drop the list itself (0 cached tokens vs 3072). A
       call made anyway is caught (closedCall). A schema step gets no tools at all. */
    if (tools?.length) this.open = tools;
    const closed = !tools?.length && this.open && !schema;
    const body = { model: this.model,
                   messages: fitMessages(closed ? [...messages, closedNote] : messages, this.ctx, cap),
                   max_tokens: cap, stream: true, ...SAMPLING, ...extra };
    if (tools?.length || closed) body.tools = tools?.length ? tools : this.open;
    else body.tool_choice = 'none';        // a server that honours it cannot emit a call
    if (schema) body.response_format = {
      type: 'json_schema', json_schema: { name: 'result', strict: true, schema } };

    const msg = await this.send(body, { signal, onStream, tools });
    // A closed-tools call is retried even when prose came with it: that prose is the
    // run-up to the call ("Let me write the final model…:"), not an answer — measured
    // on bonsai-27b, it was shown as one.
    // Nothing visible is a dead end whatever ended it: the token limit, or (measured on
    // ternary-bonsai-2-27b: 17 minutes of thinking, then end of turn) the model itself.
    if (!msg.closedCall && (msg.tool_calls?.length || msg.content)) return msg;

    /* Cut off mid-thought with nothing visible. The thinking is the work, and it
       is already done, so put what got through back in front of the model and ask
       for its next move — re-running the same request just thinks again. "State
       the final answer" alone was wrong early in a turn: nothing had been run yet,
       so a model that obeyed the rules had nothing to say and said nothing. */
    onStream?.({ type: 'log', text: this.model +
      (msg.closedCall ? ' called a tool after tools were closed; asking it to answer.'
                   : msg.finish === 'length' ? ' was cut off while thinking; asking it for its next move.'
                   : ' stopped after thinking without answering; asking it for its next move.') });
    const retry = { ...body, messages: fitMessages([...messages, ...cutoffNudge(msg, tools?.length)],
      this.ctx, cap) };
    const second = await this.send(retry, { signal, onStream, tools });
    // Never trade a partial answer for nothing: keep the first message unless the
    // retry actually said something.
    return second.content || second.tool_calls?.length ? second : msg;
  }

  async send(body, { signal, onStream, tools }) {
    this.sent = true;
    let res;
    try {
      res = await post(this.url + '/chat/completions', {
        'content-type': 'application/json',
        ...(this.apiKey ? { authorization: 'Bearer ' + this.apiKey } : {}) },
        JSON.stringify(body), signal);
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      throw new Error(`cannot reach ${this.url} — ${e.message}. Is the server running, ` +
                      `and is the URL right? (Ollama: http://localhost:11434, LM Studio: http://localhost:1234)`);
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`${this.model} @ ${this.url}: HTTP ${res.status} ${t.slice(0, 300)}`);
    }
    if (!res.body) throw new Error('no response body from ' + this.url);

    const msg = await readCompletion(res, {
      onStream, toolNames: (tools ?? []).map(t => t.function?.name) });
    if (!msg.tool_calls?.length && msg.finish === 'length' && msg.content) onStream?.({ type: 'log',
      text: this.model + ' hit its token limit before finishing - the answer is cut off.' });
    return msg;
  }
}

// What Ollama loads by default here (its logs: n_ctx = 32768); CONTEXT_DEFAULT's
// note measures a two-Skill turn at 11k tokens, so 8192 cannot hold one.
const LMSTUDIO_LOAD_CTX = 32768;

/* fetch() gives up on any response that has not started within 300 s (undici's
   headersTimeout, not settable without the undici package). A local server that
   runs one request at a time holds the next one unanswered until the current one
   ends, so a queued step died at exactly 5m0s — measured twice in Ollama's log —
   and llama-server kept generating the abandoned request, blocking its only slot
   for whatever came next. node:http has no such deadline; the user's stop button
   (signal) is the only thing that ends a request. */
function post(url, headers, body, signal, method = 'POST') {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith('https:') ? httpsRequest : httpRequest)(url,
      { method, headers, signal, autoSelectFamily: true }, res => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode,
        // Lazy: eagerly calling Readable.toWeb(res) attaches a 'data' consumer, so
        // any await before text() reads it made text() come back empty — both
        // current callers read text() right away, but a future one would not.
        get body() { return Readable.toWeb(res); },
        text: async () => { let s = ''; for await (const c of res) s += c; return s; },
      }));
    req.on('error', reject);
    req.end(body);
  });
}

/* --------------------------------- tools --------------------------------- */
// Tools that change the project. A repeat of any call is replayed from memory
// (see toolRunner), so anything that writes has to invalidate that memory.
const WRITES = ['write_file', 'run_python', 'run_mca_workflow'];

/* Tools that produce a number. Reading the model is not computing with it: a model
   that reads `k=0.4` and then reports a flux of 1.2 worked it out in its head, which
   is the one thing the agent is not allowed to do. The answer is still shown — it is
   labelled, so the user knows nothing behind the number was checked. */
const COMPUTES = new Set(['run_python', 'run_mca_workflow']);

/* A model that has not read the tellurium Skill invents the API and burns a step
   per guess — measured: five attempts at loadAntimonyModel / Simulator / SBMLReader
   before one worked. The traceback alone never points anywhere; this does. */
const apiHint = stderr => /AttributeError|ImportError|ModuleNotFoundError|NameError/.test(stderr || '')
  && /tellurium|roadrunner|antimony|\bte\b/i.test(stderr || '')
  ? '\n\n[hint] That is not the documented API. Call load_skill("tellurium") and route ' +
    'from its tables to the right reference before writing this script again — guessing ' +
    'another attribute name will fail the same way.'
  : '';

/* Building or changing the model needs the pathway-modeling Skill (rate laws,
   stoichiometry), loaded before tellurium; every other Skill is only recommended.
   A refusal repeated counts toward the repeat guard. */
export const modelGate = (run, loaded, isModelWrite) => {
  if (!isModelWrite || loaded.has('pathway-modeling')) return null;
  if (run.refused) run.repeats++; else run.refused = true;
  return 'REFUSED — building or changing the model needs the pathway-modeling Skill. ' +
         'Call load_skill("pathway-modeling") first, then load_skill("tellurium") for the ' +
         'Antimony syntax, then call write_file again.';
};

function makeTools(root, emit, te, cap = resultCap(), scratch = join(root, 'workspace/runs'),
                   modelPath = DEFAULT_MODEL_PATH, loaded = new Set()) {
  // The project is readable because the Skills and the live model live there; the
  // scratch folder is the user's own and is the only other place in play. A bare
  // startsWith(root) also passes a sibling directory whose name has root as a
  // string prefix (root-evil/x), so every comparison requires the separator too.
  const inside = (abs, dir) => abs === dir || abs.startsWith(dir + sep);
  const jail = async p => {
    let abs = resolve(root, p || '.');
    // "/workspace/x" meant the project root — measured: bonsai-27b spent 7 of 14
    // steps on "path escapes" for it. Still checked below like any other path.
    if (!inside(abs, root) && !inside(abs, scratch) && String(p).startsWith('/'))
      abs = resolve(root, '.' + p);
    if (!inside(abs, root) && !inside(abs, scratch))
      throw new Error('path escapes the project and the working folder: ' + p);
    // ...and through a symlink, which resolve() alone does not see (as safePath in
    // files.mjs): the deepest part that exists must really live inside. The roots
    // are realpathed too — on macOS tmpdir() is under /var -> /private/var.
    let probe = abs;
    while (!(await lstat(probe).catch(() => null))) probe = dirname(probe);
    const [real, r, s] = await Promise.all([probe, root, scratch].map(d => realpath(d).catch(() => null)));
    if (!real || !(r && inside(real, r)) && !(s && inside(real, s)))
      throw new Error('path escapes the project and the working folder: ' + p);
    return abs;
  };
  const py = join(root, VENV_PY);

  const impl = {
    async load_skill({ name }) {
      // The schema offers an enum, but nothing stopped a model or a crafted
      // tool-call from sending a raw path — '../../etc' walked straight out of
      // skills/ since this never went through jail().
      if (!/^[\w-]+$/.test(String(name))) throw new Error('unknown skill: ' + name);
      const md = await readFile(join(root, 'skills', name, 'SKILL.md'), 'utf8');
      loaded.add(name);
      const files = await readdir(join(root, 'skills', name), { recursive: true })
        .catch(() => []);
      return md + '\n\n--- The text above is only the index. Before you answer, read_file every file below that covers ' +
        'the question. There is no limit on how many you read; a question means a file to open. Once what you ' +
        'have read answers the question, stop reading and answer. ---\n' +
        files.filter(f => f.endsWith('.md')).map(f => 'skills/' + name + '/' + f).join('\n');
    },
    async read_file({ path, offset }) {
      const abs = await jail(path);
      /* One result holds `cap` characters and nine Skill references are longer (the
         largest 372 KB): the rest used to be unreachable ("read a narrower path", of a
         single file). `offset` reads on from where the last result stopped. */
      const part = t => {
        const from = Math.max(0, Math.floor(Number(offset) || 0)), room = Math.max(500, cap - 200), left = t.length - from - room;
        return left > 0 ? t.slice(from, from + room) + `\n…[${left} more characters. To read on, call read_file again with ` +
          `the same path and offset=${from + room}]` : t.slice(from);
      };
      // read as utf8, a 700 KB photo came back as a screenful of binary and the model looped on it
      if (/\.pdf$/i.test(abs)) return pdfText(py, abs).then(part, e => 'ERROR: could not read text from that PDF: ' + e.message);
      const t = asText(await readFile(abs));
      if (t == null) return 'ERROR: ' + path + ' is not text (an image or other binary file), so it cannot be read ' +
        'this way. An image the user attached is already shown to you in their message: look at it there.';
      return part(t);
    },
    async write_file({ path, content }) {
      const abs = await jail(path);
      // Being inside the project was not a limit at all: write_file could overwrite
      // backend/*.mjs, .claude/settings.json or a Skill. Only the live model and the
      // user's own working folder are legitimate write targets.
      if (!inside(abs, scratch) && abs !== join(root, modelPath))
        throw new Error('write_file may only write the live model (' + modelPath + ') or into the working folder (' + scratch + '): ' + path);
      // The live model is the text in the user's editor. Antimony that does not load
      // would replace it with something broken they cannot get back, so it is checked
      // first — the same gate web/js/agent.mjs already applies to write_model.
      if (te && abs === join(root, modelPath)) {
        const r = await te.call('info', { model: String(content ?? '') });
        if (!r.ok) return 'REJECTED — that Antimony does not load: ' + r.error +
          '\nThe live model is unchanged. Fix it and call write_file again.' + antimonyHint('read_file');
      }
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
      return 'wrote ' + relative(root, abs) + ' (' + content.length + ' bytes)';
    },
    async list_dir({ path }) {
      return (await readdir(await jail(path), { withFileTypes: true }))
        .map(d => (d.isDirectory() ? d.name + '/' : d.name)).join('\n');
    },
    async run_python({ code, name }) {
      const stem = scriptStem(name, code);
      let file = join(scratch, stem + '.py');
      for (let i = 2; existsSync(file); i++) file = join(scratch, `${stem}-${i}.py`);   // never over a file already there, the user's least of all
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, code);
      emit({ type: 'tools', tools: [{ name: 'python', input: { file: relative(root, file) } }] });
      return await new Promise(res => {
        // cwd is the scratch folder, so anything the script writes by a relative
        // path lands with the user's other work rather than in the install
        execFile(py, [file], { cwd: scratch, env: PY_ENV, timeout: 180000, maxBuffer: 8e6 },
          (err, out, errOut) => res(
            ((out || '') + (errOut ? '\n[stderr]\n' + errOut : '') +
             (err && !out && !errOut ? '\n[failed] ' + err.message : '') || '(no output)')
            + apiHint(errOut)));
      });
    },
  };

  const schemas = [
    ['load_skill', 'Load a Skill and list its reference files. Use before making any domain claim.',
      { name: { type: 'string',
                enum: ['mca', 'tellurium', 'pathway-modeling'] } }, ['name']],
    ['read_file', 'Read a file in the project (e.g. a Skill reference, or ' + modelPath + ').',
      { path: { type: 'string' },
        offset: { type: 'integer', description: 'characters to skip: only to read on past a result that said there was more' } }, ['path']],
    ['write_file', 'Write the live model at ' + modelPath + ', or a file in the working folder ' + scratch + '.',
      { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']],
    ['list_dir', 'List a directory in the project.', { path: { type: 'string' } }, ['path']],
    ['run_python', 'Run Python with Tellurium available. Print what you need; only stdout comes back.',
      { name: { type: 'string', description: 'file name saying what the script does, e.g. steady-state-solver' },
        code: { type: 'string' } }, ['code']],
  ];

  return {
    impl, loaded,
    isModel: p => resolve(root, p || '.') === join(root, modelPath),
    defs: schemas.map(([name, description, properties, required]) => ({
      type: 'function',
      function: { name, description, parameters: { type: 'object', properties, required } },
    })),
  };
}

/* The router puts a Skill in and says "do not load it again"; the model loaded it again
   anyway — measured: bonsai-27b reloaded tellurium, ~4k tokens, right after the router.
   Answered from this loop's own transcript, not the turn's `loaded` set: a workflow
   stage starts from a fresh transcript and must still get the Skill. */
const skillIn = (messages, name) =>
  messages.some(m => String(m.content?.[0]?.text ?? m.content ?? '').includes('\nname: ' + name + '\n'));
const reload = (messages, name, args) => name === 'load_skill' && skillIn(messages, args?.name)
  ? 'The ' + args.name + ' Skill is already loaded above in this conversation; use that ' +
    'text. Do not load it again. To go deeper, read_file one of its reference files.'
  : null;

/* ------------------------------- agent loop ------------------------------- */
/* The Skill router (backend/router.mjs), when switched on: before step 0, then after
   any round that loaded a Skill or failed. A hint rides on the end of the last
   message, so the chat structure is unchanged; an auto-load goes through load_skill,
   so modelGate sees a real load. The first failure switches it off for the turn. */
async function steer(rt, tools, messages, recent, step, emit, cap) {
  const r = await rt.fn({ loaded: [...tools.loaded], recent, step });
  emit({ type: 'log', text: logLine(r) });
  if (r.error) { rt.fn = null; return; }
  let add = hintLine(r.hint);
  for (const [name] of r.auto) {
    // Shown like any load: without it the chat listed only the model's own loads, and a
    // Skill the router put in (measured: mca) looked as if it had never loaded.
    emit({ type: 'tools', tools: [{ name: 'load_skill', input: { name, by: 'router' } }] });
    add += '\n\n[router] loaded the ' + name + ' Skill for you; do not load it again.\n\n' +
      String(await callTool(tools.impl, 'load_skill', { name })).slice(0, cap);
  }
  // a question with photos is [text part, image parts]: `+=` on that array sent the model "[object Object],[object Object]"
  const last = messages.at(-1);
  if (add) Array.isArray(last.content) ? (last.content[0].text += add) : (last.content += add);
}

/* One tool call, the same in a stage and in the outer turn: refused (missing
   arguments, a Skill reload, the model gate) or run, then recorded. True if it failed. */
const dispatcher = (lacks, run, tools, messages, recent, cap) => async (c, name, args) => {
  const out = lacks(name, args) ?? reload(messages, name, args) ?? modelGate(run, tools.loaded, name === 'write_file' && tools.isModel(args.path)) ?? await run(name, args);
  messages.push(toolResult(c, name, String(out).slice(0, cap)));
  recent.push(recentLine(name, args, out));
  return failed(recent.at(-1));
};

async function toolLoop({ chat, system, prompt, tools, schema, emit, signal,
                          maxSteps = 12, stageMs = 900000, cap = resultCap(), rt = {} }) {
  const messages = [{ role: 'system', content: system }, { role: 'user', content: prompt }];
  const recent = [];
  if (rt.fn) await steer(rt, tools, messages, recent, 0, emit, cap);
  const t0 = Date.now();
  const run = toolRunner(tools.impl, WRITES);
  const call = dispatcher(missingArgs(tools.defs), run, tools, messages, recent, cap);
  // A local 27B running seven sequential stages is slow but not dead — say so.
  const beat = setInterval(() => emit({ type: 'heartbeat', seconds: Math.round((Date.now()-t0)/1000) }), 15000);
  try {
  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) throw new Error('aborted');
    // Out of steps or out of time: ask once more with NO tools, so the model has to
    // answer. Breaking out here instead handed the stage back empty, which is what
    // the user saw as the agent going round in circles and then saying nothing.
    const stuck = run.repeats >= REPEAT_LIMIT;
    const wrapUp = step === maxSteps - 1 || Date.now() - t0 > stageMs || stuck;
    if (wrapUp) emit({ type: 'log', text: stuck
      ? 'same call repeated ' + run.repeats + 'x; answering with what it has'
      : 'stage is out of ' + (step === maxSteps - 1 ? 'steps' : 'time') +
        '; answering with what it has' });
    // Ask for the schema only once the model has stopped calling tools; many local
    // models cannot emit a tool call and a constrained JSON object in one turn.
    const m = await chat.complete({ messages, tools: wrapUp ? undefined : tools.defs, signal,
      onStream: quiet(emit) });
    messages.push(forHistory(m));
    const calls = m.tool_calls ?? [];
    if (!calls.length) {
      if (!schema) return m.content ?? '';
      return await constrain({ complete: a => chat.complete(a), messages, schema, emit, signal });
    }
    const had = tools.loaded.size;
    let bad = false;
    for (const c of calls) {
      const name = c.function?.name;
      let args = {};
      try { args = JSON.parse(c.function?.arguments || '{}'); } catch {}
      emit({ type: 'tools', tools: [{ name, input: args }] });
      bad = await call(c, name, args) || bad;
    }
    if (rt.fn && (bad || tools.loaded.size > had)) await steer(rt, tools, messages, recent, step + 1, emit, cap);
  }
  if (!schema) return '(the model kept calling tools without answering)';
  return await constrain({ complete: a => chat.complete(a), messages, schema, emit, signal });
  } finally { clearInterval(beat); }
}

/* --------------------------- the workflow, verbatim --------------------------- */
export async function runWorkflowFile({ root, chat, args, emit, signal, te, scratch,
                                        modelPath = DEFAULT_MODEL_PATH, loaded, rt }) {
  const src = await readFile(join(root, 'workflows/mca-tellurium.js'), 'utf8');
  const body = src.replace(/^\s*export\s+const\s+meta\s*=/m, 'const meta =');
  const cap = resultCap(chat.ctx, chat.resultPct);
  const system = localSystem({ tools: TOOL_NAMES, liveModel: args?.model ?? '', modelPath,
                               howToRun: howToRun(root, modelPath, scratch) });
  const tools = makeTools(root, emit, te, cap, scratch, modelPath, loaded);

  const agent = async (prompt, opts = {}) => {
    emit({ type: 'phase', phase: opts.phase, label: opts.label });
    return toolLoop({ chat, system, prompt, tools, schema: opts.schema, emit, signal, cap, rt,
                      maxSteps: Math.max(2, stepBudget(chat.steps) - 2) });
  };
  const phase = title => emit({ type: 'phase', phase: title });
  const log = msg => emit({ type: 'log', text: String(msg) });

  const fn = new AsyncFunction('agent', 'phase', 'log', 'args', body);
  return await fn(agent, phase, log, args);
}

const TOOL_NAMES = ['load_skill', 'read_file', 'write_file', 'list_dir', 'run_python'];

const DEFAULT_MODEL_PATH = 'workspace/model.txt';

/* The file a run_python script is kept as. The working folder is the user's, so it
   should read like their own work: the name the model gave, else the script's first
   comment line, else (a model that gave neither) the old timestamp. */
export const scriptStem = (name, code) =>
  String(name || /^\s*#(?!!)\s*(.+)/m.exec(code ?? '')?.[1] || '').toLowerCase().replace(/\.py$/, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'run-' + Date.now();

/* The file tools resolve paths from the install root, but run_python runs in the
   working folder (the open project's own folder). With only relative paths to go
   on, qwen3.8:27b guessed the wrong folder and opened a stale model.txt without
   any error. The absolute path takes the guessing out. */
const howToRun = (root, modelPath, scratch) => `THE LIVE MODEL is \`${modelPath}\`. Write that file to change what the user sees.

\`run_python\` is your shell: it runs a Python script with tellurium, roadrunner, numpy
and scipy importable, and returns only stdout — so print everything you need. Every
script is kept. It runs from the working folder \`${scratch}\`, so a relative path you
write to lands there. The file tools resolve paths from the project root instead, so
in Python always load the live model by its absolute path:
\`te.loada(open(${JSON.stringify(join(root, modelPath))}).read())\`
There is no separate terminal; run_python is it.`;

/* Handed to the workflow, which otherwise tells every stage to "run it with Bash". */
const EXEC_NOTE =
  'Run the computation with `run_python`: one self-contained script, printing every ' +
  'number you will report. Only stdout comes back — every script you run is already ' +
  'kept in the working folder as the reproducibility record.';

/* ------------------------------ the outer turn ------------------------------ */
/* `summary` is the project's history.md, and on the server path `history` is empty:
   one copy of each past turn, never two. Seeing a turn both live and declared
   "settled, do not re-derive" is the defect that made a local model loop. */
export function runLocalAgent({ root, prompt, images, history = [], chatCfg, useWorkflow = true,
                               liveModel = '', modelPath = DEFAULT_MODEL_PATH, te, onEvent, summary = '',
                               scratch = join(root, 'workspace/runs'), router = null }) {
  const ctrl = new AbortController();
  const rt = { fn: router };
  const emit = o => onEvent(o);
  if (!chatCfg?.baseUrl || !chatCfg?.model) {
    queueMicrotask(() => {
      emit({ type: 'fatal', error: 'This model has no server URL or model name. ' +
        'Open Settings → Local models, fill them in, press "Test & list models", then Save.' });
      emit({ type: 'done', code: 1 });
    });
    return { kill(){} };
  }
  const chat = new Chat(chatCfg);

  (async () => {
    try {
      // Detect before sizing the cap: this used to run before the first
      // chat.complete() (the only other place detectContext() runs), so cap and
      // the tools built from it stayed at the 24576 default all turn on a server
      // whose real window was smaller or larger.
      await chat.detectContext(ctrl.signal);
      const cap = resultCap(chat.ctx, chat.resultPct);
      const tools = makeTools(root, emit, te, cap, scratch, modelPath);

      /* "Treat it as established; do not re-derive it" contradicted the rule that
         every reported number comes from a tool call made this turn. Once the
         history held a full answer to the question being asked again, qwen3.8:27b
         obeyed the first rule: it called no tools and produced no answer. */
      const memory = !summary.trim() ? '' : [
        '', '## Project history', '',
        'Your own record of this project: a summary of everything older, then the',
        'latest turns. Use it for what was asked, decided and changed. It is not a',
        'tool result: a number from it may be stale, and the live model may have',
        'changed since. Any number you report this turn comes from a tool call you',
        'make this turn.', '', summary.trim(), '',
      ].join('\n');

      const system = localSystem({
        tools: useWorkflow ? [...TOOL_NAMES, 'run_mca_workflow'] : TOOL_NAMES,
        liveModel, modelPath, howToRun: howToRun(root, modelPath, scratch),
        extra: (useWorkflow
          ? '\n## The workflow\n\nAnything needing numbers — control, elasticities, control ' +
            'coefficients, steady state in a control context — MUST go through `run_mca_workflow`. ' +
            'Answer directly only for questions that need no computation.'
          : '\n## The workflow is off\n\nThe user turned the seven-stage workflow off because it ' +
            'is slow. Do not ask for it back and do not refuse the work — do the analysis yourself, ' +
            'keeping every rule above.') + memory,
      });

      const wfDef = { type: 'function', function: {
        name: 'run_mca_workflow',
        description: 'Run the enforced mca-tellurium workflow (MCA frame → Tellurium plan → ' +
                     'execute → validate → interpret → audit). Use for any analysis.',
        parameters: { type: 'object', properties: {
          question: { type: 'string', description: 'the question, stated fully and standalone' },
          needsNumbers: { type: 'boolean' },
        }, required: ['question'] } } };

      const allTools = { impl: {
        ...tools.impl,
        run_mca_workflow: async ({ question, needsNumbers = true }) => {
          // The model names the workflow and often supplies no question. It is
          // always this turn's question, so use it rather than failing the stage.
          question = String(question ?? '').trim() || prompt;
          emit({ type: 'workflow_start' });
          const model = await readFile(join(root, modelPath), 'utf8').catch(() => '');
          const out = await runWorkflowFile({
            root, chat, emit, te, scratch, modelPath, loaded: tools.loaded, signal: ctrl.signal, rt,
            args: { question, model, needsNumbers, workdir: scratch, exec: EXEC_NOTE },
          });
          emit({ type: 'workflow_done' });
          return JSON.stringify(out).slice(0, cap);
        },
      }, defs: useWorkflow ? [...tools.defs, wfDef] : tools.defs };

      // attached photos ride on the question itself, the OpenAI way; a model without vision refuses them
      const messages = [{ role: 'system', content: system }, ...history, userQuestion(!images?.length ? prompt
        : [{ type: 'text', text: prompt }, ...images.map(url => ({ type: 'image_url', image_url: { url } }))])];
      const run = toolRunner(allTools.impl, WRITES);
      let final = '', usedTools = false, computed = false;
      const recent = [];
      const call = dispatcher(missingArgs(allTools.defs), run, tools, messages, recent, cap);
      if (rt.fn) await steer(rt, tools, messages, recent, 0, emit, cap);
      const STEPS = stepBudget(chat.steps);
      for (let step = 0; step < STEPS; step++) {
        if (ctrl.signal.aborted) break;
        // ...or as soon as it is plainly stuck: a repeated call warned about twice
        // will be repeated a third time, and each one costs a step.
        const stuck = run.repeats >= REPEAT_LIMIT;
        if (stuck) emit({ type: 'log', text: 'same call repeated; asking for the answer' });
        const wrapUp = step === STEPS - 1 || stuck;
        const m = await chat.complete({ messages, tools: wrapUp ? undefined : allTools.defs,
          signal: ctrl.signal, onStream: emit }); // outer turn: thinking and tokens both
        messages.push(forHistory(m));
        const calls = m.tool_calls ?? [];
        if (!calls.length) {
          final = stripToolSyntax(m.content); break;
        }
        usedTools = true;
        const had = tools.loaded.size;
        let bad = false;
        for (const c of calls) {
          const name = c.function?.name;
          let a = {};
          try { a = JSON.parse(c.function?.arguments || '{}'); } catch {}
          if (name !== 'run_mca_workflow') emit({ type: 'tools', tools: [{ name, input: a }] });
          else emit({ type: 'tools', tools: [{ name: 'Workflow', input: { workflow: 'mca-tellurium' } }] });
          if (COMPUTES.has(name)) computed = true;
          bad = await call(c, name, a) || bad;
        }
        if (rt.fn && (bad || tools.loaded.size > had)) await steer(rt, tools, messages, recent, step + 1, emit, cap);
      }
      emit({ type: 'result', text: final || NO_ANSWER,
             isError: !final, noTools: !usedTools, unverified: !computed && hasNumber(final) });
      emit({ type: 'done', code: 0 });
    } catch (e) {
      emit({ type: 'fatal', error: String(e.message || e) });
      emit({ type: 'done', code: 1 });
    }
  })();

  return { kill: () => ctrl.abort() };
}
