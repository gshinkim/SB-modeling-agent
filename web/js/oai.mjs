/* Wire quirks of OpenAI-compatible servers, shared by the browser runtime
   (web/js/localai.mjs) and the server runtime (backend/local-agent.mjs).
   Pure: no DOM, no node builtins, so both can import it. */

const OPEN = '<think>', CLOSE = '</think>';

/** Longest tail of s that could be the beginning of a think tag. */
const partial = s => {
  for (let n = Math.min(CLOSE.length - 1, s.length); n > 0; n--) {
    const t = s.slice(-n);
    if (OPEN.startsWith(t) || CLOSE.startsWith(t)) return n;
  }
  return 0;
};

/**
 * Split reasoning from answer *while it streams*.
 *
 * Ollama puts the scratchpad in a `reasoning` delta, but llama.cpp, LM Studio and
 * any plain GGUF leave it inline as <think>…</think>. Splitting only once the
 * stream ended (what this used to do) meant the whole scratchpad streamed into the
 * answer bubble and the thinking panel never opened at all. Qwen's chat template
 * also pre-opens the tag, so </think> can arrive with no <think> — text before a
 * first unmatched close is reasoning.
 */
export function thinkStream(onStream) {
  let buf = '', inThink = false, sawTag = false, content = '', reasoning = '';
  const out = (text, think) => {
    if (!text) return;
    if (think) { reasoning += text; onStream?.({ type: 'thinking', text }); }
    else { content += text; onStream?.({ type: 'delta', text }); }
  };
  return {
    push(chunk) {
      buf += chunk;
      for (;;) {
        const o = buf.indexOf(OPEN), c = buf.indexOf(CLOSE);
        if (o < 0 && c < 0) break;
        if (o >= 0 && (c < 0 || o < c)) {
          out(buf.slice(0, o), inThink);
          buf = buf.slice(o + OPEN.length); inThink = true; sawTag = true;
        } else {
          // an unmatched close: the template pre-opened <think>, so everything
          // already streamed as answer was really thinking. Say so and move it.
          if (!sawTag && content) {
            reasoning += content; content = '';
            onStream?.({ type: 'unthink' });
          }
          out(buf.slice(0, c), inThink || !sawTag);
          buf = buf.slice(c + CLOSE.length); inThink = false; sawTag = true;
        }
      }
      const keep = partial(buf);          // a tag may be split across two chunks
      out(buf.slice(0, buf.length - keep), inThink);
      buf = keep ? buf.slice(-keep) : '';
    },
    end() {
      out(buf, inThink); buf = '';
      return { content: content.trim(), reasoning: reasoning.trim() || undefined };
    },
  };
}

/* Every shape a model uses when it writes a tool call as prose instead of emitting
   one: <tool_call> tags (Qwen, Hermes), a fenced block (Gemma's template, most
   text protocols), or a bare object. */
const BLOB = /<tool_call>([\s\S]*?)<\/tool_call>|```(?:json|tool_call|tool_code)?\s*([\s\S]*?)```/g;

/* Qwen and Hermes templates often emit a call as nested XML rather than JSON:
     <function=run_python><parameter=code>print(1)</parameter></function>
   That parsed as nothing, so the loop read a tool call as the final answer. */
const XML_FN = /<function=([\w.-]+)>([\s\S]*?)<\/function>/g;
const XML_ARG = /<parameter=([\w.-]+)>([\s\S]*?)<\/parameter>/g;

function xmlToolCalls(content, known) {
  const out = [];
  for (const m of String(content).matchAll(XML_FN)) {
    if (!known.has(m[1])) continue;
    const args = {};
    for (const a of m[2].matchAll(XML_ARG)) args[a[1]] = a[2].trim();
    out.push({ id: 'text_' + out.length, type: 'function',
               function: { name: m[1], arguments: JSON.stringify(args) } });
  }
  return out;
}

/**
 * Recover tool calls a model wrote as text.
 *
 * Gemma-class models have no tool tokens. The server prompts the schemas in text
 * and the model answers with a JSON blob, which arrives as ordinary content with
 * no `tool_calls` — so the agent loop reads it as "done, no tools" and the model
 * looks like it simply cannot call anything. Only names the caller offers are
 * accepted, so ordinary prose that happens to contain JSON is never mistaken for
 * a call.
 */
export function textToolCalls(content, names) {
  if (!content || !names?.length) return [];
  const known = new Set(names);
  const out = [];
  const add = v => {
    for (const o of Array.isArray(v) ? v : [v]) {
      const name = o?.name ?? o?.tool ?? o?.tool_name ?? o?.function?.name;
      if (!known.has(name)) continue;
      const a = o.arguments ?? o.parameters ?? o.args ?? o.input ?? o.function?.arguments ?? {};
      out.push({ id: 'text_' + out.length, type: 'function',
                 function: { name, arguments: typeof a === 'string' ? a : JSON.stringify(a) } });
    }
  };
  const xml = xmlToolCalls(content, known);
  if (xml.length) return xml;
  const blobs = [];
  for (const m of String(content).matchAll(BLOB)) blobs.push(m[1] ?? m[2]);
  blobs.push(content);                                     // an unfenced bare object
  for (const b of blobs) {
    const t = String(b).trim();
    const a = Math.min(...['{', '['].map(c => (t.indexOf(c) + 1 || Infinity)) ) - 1;
    const z = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    if (!(a >= 0 && z > a)) continue;
    try { add(JSON.parse(t.slice(a, z + 1))); } catch { continue; }
    if (out.length) return out;                            // first blob that parses wins
  }
  return out;
}

/** The tool-call protocol for a model whose runtime gives it no tool API. */
export const TEXT_TOOL_PROTOCOL = `
## If you cannot emit a tool call

Some runtimes give you no tool API. If you cannot emit a real tool call, write one
as text instead, alone on its own lines, and stop:

<tool_call>{"name": "<tool>", "arguments": {"<arg>": "<value>"}}</tool_call>

It is executed and the result comes back like any other tool result. Never describe
a call you did not make, and never invent its output.`.trim();

/**
 * The two messages appended when a reasoning model is cut off mid-thought with
 * nothing visible: put what got through back in front of it and ask for its next
 * move — re-running the same request just makes it think again. Shared by the
 * server runtime (backend/local-agent.mjs) and the browser runtime (localai.mjs),
 * which used to have no equivalent retry at all. Also used when the model called
 * a tool after tools were withdrawn (msg.closedCall): it is told to answer instead.
 */
export const cutoffNudge = (msg, hasTools) => msg.closedCall && msg.finish !== 'length' ? [
  { role: 'user', content: 'Tools are closed for this turn: that call was not run. Do not ' +
    'call any tool. Give the final answer now, in prose, from the results above, and say ' +
    'what you could not finish.' },
] : [
  { role: 'assistant', content: msg.reasoning ?? '' },
  { role: 'user', content: 'Your reasoning ' + (msg.finish === 'length' ? 'was cut off' : 'ended with no answer and no tool call') +
    '. Do not think any further and do ' +
    'not repeat it. ' + (hasTools
      ? 'Act now: make the next tool call your plan above calls for, or, if you already ' +
        'have every result you need, give the final answer in full.'
      : 'State the final answer now, in full, from what you worked out above.') },
];

/** Sent last whenever tools are closed (the wrap-up step). It says in words what
    tool_choice 'none' said — LM Studio honours that by dropping the tool list from
    the prompt, which is the prompt-cache miss the closed tools are re-sent to avoid. */
export const closedNote = { role: 'user', content: 'Tools are closed for this turn: do not ' +
  'call any tool. Give the final answer now, in prose, from the results above, and say ' +
  'what you could not finish.' };

/**
 * Appended when Antimony is rejected. The tellurium SKILL.md routes to references
 * and carries almost no syntax, so a model that loaded it still guessed — measured:
 * qwen3.5:9b wrote `S1 -> S2; v1 = k1*S1` ten times in a row, each rejected, and
 * got it right on the next write after it finally read antimony_basics.md.
 */
export const antimonyHint = readTool =>
  '\n\n[hint] Call ' + readTool + '("skills/tellurium/references/antimony_basics.md") ' +
  'before writing again — guessing the syntax fails the same way. A reaction is ' +
  '`J1: S1 -> S2; k1*S1` (optional name and colon, reaction, semicolon, rate ' +
  'expression); values go on their own lines: `k1 = 0.5`, `S1 = 10`.';

/** Strip our own bookkeeping before a message goes back to the server.
    `finish` is ours. `reasoning` goes back: within a turn a thinking model has to
    see its own plan, and without it Qwen re-planned from zero after every tool
    call — measured on Ollama: stripped, qwen3.8:27b could not say what it had
    decided one step earlier; sent as `reasoning`, it could. Ollama reads
    `reasoning`; LM Studio and the stock Qwen chat template read only
    `reasoning_content`, so sent under one name the plan was silently dropped
    there. Both go; a server that knows neither ignores them. */
export const forHistory = m => ({
  role: 'assistant',
  content: m.content ?? '',
  ...(m.reasoning ? { reasoning: m.reasoning, reasoning_content: m.reasoning } : {}),
  ...(m.tool_calls?.length && !isTextCall(m.tool_calls[0])
      ? { tool_calls: m.tool_calls.map(c => ({ ...c,
            function: { ...c.function, arguments: sendableArgs(c.function?.arguments) } })) }
      : {}),
});

/**
 * Tool-call arguments that a server will accept back.
 *
 * A small model that names a tool and stops emits `arguments: ""`. Sent back in
 * the transcript that is not parseable JSON: LM Studio answers HTTP 500 and the
 * whole turn dies, which is what "it just gets cut off" looks like. Measured:
 * "" -> 500, "{}" -> 200. Truncated JSON from a dropped stream chunk is the same
 * hazard, so anything that does not parse becomes an empty object.
 */
export function sendableArgs(a) {
  if (a == null) return '{}';
  if (typeof a !== 'string') { try { return JSON.stringify(a); } catch { return '{}'; } }
  const t = a.trim();
  if (!t) return '{}';
  try { JSON.parse(t); return t; } catch { return '{}'; }
}

/** A call textToolCalls recovered from prose, rather than one the server emitted. */
export const isTextCall = c => typeof c?.id === 'string' && c.id.startsWith('text_');

/**
 * The message that carries a tool's output back to the model.
 *
 * A call written as prose came from a runtime with no tool API, so its chat template
 * very likely renders neither an assistant `tool_calls` field nor a `tool` role. Sent
 * that way the result is dropped on the floor, the model sees no answer, and it writes
 * the same call again — which is what "it cannot call tools, it just repeats itself"
 * looks like. Those results go back as ordinary user text, which every template renders.
 */
export const toolResult = (call, name, out) => isTextCall(call)
  ? { role: 'user', content: `Result of ${name}:\n\n${out}` }
  : { role: 'tool', tool_call_id: call.id, name, content: out };

/** Streamed tool-call deltas, accumulated. Some servers send `arguments` as an
    object rather than a JSON string; concatenating that yields "[object Object]". */
export function mergeToolDeltas(calls, deltas) {
  for (const tc of deltas ?? []) {
    const k = slotFor(calls, tc);
    calls[k] ??= { id: tc.id || 'call_' + k, type: 'function', function: { name: '', arguments: '' } };
    if (tc.id) calls[k].id = tc.id;
    const fn = calls[k].function;
    // llama.cpp and vLLM repeat the name on every chunk. Concatenating gave
    // "run_pythonrun_python", which matches no tool, so the model retried forever.
    // An exact repeat is a repeat; a different fragment is a name still arriving.
    const name = tc.function?.name;
    if (name && fn.name !== name) fn.name += name;
    const a = tc.function?.arguments;
    if (a != null && a !== '') {
      const s = typeof a === 'string' ? a : JSON.stringify(a);
      if (fn.arguments !== s) fn.arguments += s;   // some servers resend the whole object
    }
  }
  return calls;
}

/* Which call a delta belongs to. `index` is authoritative; without it (llama.cpp
   omits it) a chunk that names no tool is the continuation of the call already
   being built, not a new one — otherwise each fragment became its own call and
   every argument string was half-parsed. */
function slotFor(calls, tc) {
  if (tc.index != null) return tc.index;
  if (tc.id) { const i = calls.findIndex(c => c?.id === tc.id); if (i >= 0) return i; }
  if (!tc.function?.name && calls.length) return calls.length - 1;
  return calls.length;
}

/**
 * Run a tool by name, and when the model invents one, say what actually exists.
 *
 * The agent definition tells the model to call Read, Write, Edit and Skill;
 * the local runtimes offer read_model/write_model/simulate/... instead.
 * A model that follows the prose got back "impl[name] is not a function", which
 * names neither the problem nor the fix, so it had no way to recover.
 */
export async function callTool(impl, name, args) {
  const fn = impl?.[name];
  if (typeof fn !== 'function')
    return `ERROR: there is no tool called "${name}" here. Your tools are: ` +
           Object.keys(impl ?? {}).join(', ') + '. Call one of those instead.';
  try { return await fn(args); }
  catch (e) { return 'ERROR: ' + (e?.message ?? e); }
}

/**
 * callTool, with an identical repeat short-circuited.
 *
 * A local model that gets a tool result it does not like re-issues the same call
 * with the same arguments. Nothing stopped it, so one mistake ate the whole step
 * budget and the turn ended with "(kept calling tools without answering)" - which
 * is what "it loops and says the same thing over and over" looks like from the
 * chat. Replaying the recorded output and naming the repeat is what lets it move on.
 * One runner per agent loop; the memory is that loop's.
 */
export function toolRunner(impl, mutates = []) {
  const seen = new Map(), writes = new Set(mutates);
  const run = async (name, args) => {
    const key = name + ' ' + JSON.stringify(args ?? {});
    if (seen.has(key)) {
      run.repeats++;
      return `You already called ${name} with exactly these arguments. It returned:\n\n` +
             seen.get(key) +
             `\n\nRepeating it cannot give a different answer. Change the arguments, use a ` +
             `different tool, or answer with what you already have.`;
    }
    run.repeats = 0;
    const out = String(await callTool(impl, name, args));
    // A tool that changes the project makes every earlier result stale: a read_file
    // replayed from before a write_file would show the model its own edit missing.
    if (writes.has(name)) seen.clear();
    seen.set(key, out);
    return out;
  };
  /* Telling a weak model it is repeating itself does not stop it — measured: a 9B
     re-sent the same broken script seven times, reading the warning each time, and
     spent the whole step budget on it. The caller watches this and forces an answer. */
  run.repeats = 0;
  return run;
}

/** How many identical repeats before the loop gives up and demands an answer. */
export const REPEAT_LIMIT = 2;

/**
 * Remove a tool call the model wrote as text from an answer.
 *
 * On the final step tools are withheld so the turn ends in prose. A model that
 * emits a call anyway had it shown to the user as the answer — raw
 * `<tool_call>` XML in the chat bubble.
 */
export function stripToolSyntax(text) {
  return String(text ?? '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/<function=[\w.-]+>[\s\S]*?<\/function>/g, '')
    .replace(/```(?:json|tool_call|tool_code)\s*[\s\S]*?```/g, '')
    .trim();
}

/* --------------------------- the streaming response --------------------------- */
/**
 * Read one OpenAI-compatible streaming response into a single assistant message.
 *
 * Both runtimes had their own copy of this loop and both had the same two holes:
 * bytes left in the buffer when the stream ends were never parsed (a final frame
 * with no trailing newline is simply lost, and it is usually the tool call), and
 * a server that ignores `stream: true` and returns one plain JSON body produced
 * an empty message, because every line failed the `data:` test.
 */
export async function readCompletion(res, { onStream, toolNames } = {}) {
  let reasoning = '', finish = '', frames = 0;
  const think = thinkStream(onStream);
  const calls = [];

  const frame = payload => {
    if (!payload || payload === '[DONE]') return;
    let d;
    try { d = JSON.parse(payload); } catch { return; }
    frames++;
    if (d.error) throw new Error(String(d.error.message ?? d.error));
    const ch = d.choices?.[0];
    if (!ch) return;
    if (ch.finish_reason) finish = ch.finish_reason;
    const delta = ch.delta ?? ch.message ?? {};      // non-streaming bodies use `message`
    const th = delta.reasoning ?? delta.reasoning_content;
    if (th) { reasoning += th; onStream?.({ type: 'thinking', text: th }); }
    if (delta.content) think.push(delta.content);
    mergeToolDeltas(calls, delta.tool_calls);
  };
  const line = l => { const t = l.trim(); if (t.startsWith('data:')) frame(t.slice(5).trim()); };

  const rd = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', raw = '';
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    const s = dec.decode(value, { stream: true });
    raw += s; buf += s;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); }
  }
  const tail = dec.decode();                 // flush a split multi-byte character
  raw += tail; buf += tail;
  if (buf.trim()) line(buf);                 // the last frame, when it had no newline
  if (!frames && raw.trim()) frame(raw.trim());   // the server never spoke SSE at all

  const split = think.end();
  const msg = { role: 'assistant', content: split.content, finish,
                reasoning: [reasoning, split.reasoning].filter(Boolean).join('\n') || undefined };
  let tc = calls.filter(Boolean);
  // a model whose runtime has no tool API writes the call as prose; take it anyway
  if (!tc.length) tc = textToolCalls(split.content, toolNames);
  // ...and some write it inside the scratchpad, where thinkStream had already moved it
  if (!tc.length && split.reasoning) tc = textToolCalls(split.reasoning, toolNames);
  /* No tools offered means the caller wants the answer. Ollama still parses a
     <tool_call> the model writes into tool_calls, and every loop ran it and ended
     on "(no final answer)" — measured on qwen3.5:9b's wrap-up step. Flag it so
     the caller can ask for prose instead. */
  if (tc.length && toolNames && !toolNames.length) msg.closedCall = true;
  else if (tc.length) msg.tool_calls = tc;
  /* ...and a call written as text, which textToolCalls cannot match with no names
     offered: stripToolSyntax erased it and the turn ended "(the model produced no
     final answer)" with no retry — measured on bonsai-27b in LM Studio. */
  else if (toolNames && !toolNames.length && /<tool_call>|<function=[\w.-]+>/.test(msg.content)) {
    msg.closedCall = true;
    msg.content = stripToolSyntax(msg.content).trim();
  }
  return msg;
}

/* ------------------------------ context budget ------------------------------ */
/* Local runtimes load a model with whatever context the app chose, usually 8192
   even when the weights allow far more. Nothing here could exceed it, so the
   transcript silently lost its oldest messages mid-turn: the model stopped
   seeing the tool result it had just been given and asked for it again, which is
   the looping. Everything below sizes the turn to fit instead.

   8192 was that default until a turn that loaded two Skills stopped fitting in
   it. Half the window is reserved for the reply, so 8192 leaves a 4096-token
   prompt budget, and one Skill is ~2500 of it. Measured on a real "build an
   oscillating model" turn — system prompt, question, two Skills, one reference
   file, a write and a simulate result — the transcript is 11,107 tokens and
   first survives whole at 24576. Below that the trimmer drops a Skill the model
   just loaded and it loads it again: the looping, back in a new place.
   ponytail: still one default, overridable per model in Settings → Runtime;
   detect it per provider only if this number turns out to be wrong too. A model
   served with a smaller window than this truncates on its own side, where
   nothing here can see it. */
export const CONTEXT_DEFAULT = 24576;
const CHARS_PER_TOKEN = 3.5;

/* Sampling for every local call. temperature 0.2 is near-greedy, and Qwen3's own
   card warns greedy decoding makes thinking mode repeat without end — measured on
   qwen3.8:27b: at 0.2 it re-derived the same Jacobian for 3000 tokens; at these
   (Qwen's recommended thinking settings) it moved on to the answer. All three are
   standard OpenAI parameters, so any compatible server accepts them. */
export const SAMPLING = { temperature: 0.6, top_p: 0.95, presence_penalty: 1.0 };

/* How the window is divided, as shares of it rather than absolute token counts:
   one setting then means the same thing on an 8k model and a 128k one. These
   defaults are exactly what the code used to hardcode — half the window for the
   reply, a quarter for a single tool result — so leaving them alone changes
   nothing. Settings → Budget moves them. */
export const BUDGET = { replyPct: 50, resultPct: 25, steps: 14 };
export const BUDGET_LIMITS = { replyPct: [10, 90], resultPct: [5, 60], steps: [2, 40] };

const share = (v, k) => {
  const [lo, hi] = BUDGET_LIMITS[k];
  const n = Number(v);
  return n > 0 ? Math.min(hi, Math.max(lo, n)) : BUDGET[k];
};

/** Tokens the model may spend on one reply — thinking and answer together. */
export const replyTokens = (ctx = CONTEXT_DEFAULT, replyPct) =>
  Math.max(256, Math.round(ctx * share(replyPct, 'replyPct') / 100));

/** Chars a single tool result may add. A quarter of the window by default, so a
    transcript survives several of them; 40000 chars was ~3x the whole window. */
export const resultCap = (ctx = CONTEXT_DEFAULT, resultPct) =>
  Math.max(1500, Math.round(ctx * CHARS_PER_TOKEN * share(resultPct, 'resultPct') / 100));

/** Tool steps a turn gets before it is made to answer with what it has. */
/** Settings → Budget → "No limit": the turn ends when the model answers, the same
    call is repeated, or the user presses Stop. */
export const NO_STEP_LIMIT = 'none';
export const stepBudget = steps => steps === NO_STEP_LIMIT ? Infinity : Math.round(share(steps, 'steps'));

// counts `reasoning` too: it goes back to the server with each step (see forHistory),
// and leaving it out let the real prompt outgrow the window unseen
export const estTokens = messages =>
  Math.ceil(messages.reduce((n, m) =>
    n + String(m.content ?? '').length + String(m.reasoning ?? '').length +
        (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0) + 16, 0) / CHARS_PER_TOKEN);

/**
 * Make the turn fit, losing as little as possible, in three stages:
 *
 * 1. Drop the thinking of every step but the latest. The current plan is in the
 *    latest step; older reasoning is the cheapest thing to lose.
 * 2. Shorten tool results, oldest first, to their opening. Dropping them whole was
 *    the defect: three Skills (~10k tokens) outgrew a 12k prompt budget, the call
 *    that loaded them went, its results could not stay without it, and the model
 *    was left with the bare question — so it loaded them again, and again.
 * 3. Only then drop the oldest exchanges, keeping the system message and the
 *    question.
 *
 * Cutting at an arbitrary point would leave a `tool` message whose call is gone,
 * which strict servers reject outright, so the window always starts on a message
 * that can stand alone.
 *
 * The first user message is pinned for the same reason. It sits at the front of
 * the transcript, so trimming the oldest messages reached it first: two Skill
 * loads in one turn were enough to outgrow the window, and what went to the
 * server was `system, assistant, tool` with the question gone. Ollama rejects
 * that with HTTP 500 "no user query found in messages". Keeping it also keeps
 * the turn pointed at what was actually asked.
 */
const QUESTION = Symbol('question');
/** This turn's question, marked so fitMessages pins it rather than the oldest user
    message. A Symbol key: JSON.stringify skips it, so the server never sees it. */
export const userQuestion = content => ({ role: 'user', content, [QUESTION]: true });

const SHORT_RESULT = 2000;   // chars an old tool result keeps once the window is tight

export function fitMessages(messages, ctx = CONTEXT_DEFAULT, reserve = 1024) {
  const budget = Math.max(512, ctx - reserve);
  if (estTokens(messages) <= budget) return messages;

  const lastStep = messages.findLastIndex(m => m.role === 'assistant');
  messages = messages.map((m, i) => {
    if (!m.reasoning || i === lastStep) return m;
    const { reasoning, reasoning_content, ...rest } = m;
    return rest;
  });
  if (estTokens(messages) <= budget) return messages;

  for (let i = 0; i < messages.length && estTokens(messages) > budget; i++) {
    const m = messages[i];
    // Text-mode tool calling (toolResult) returns these as role:'user' "Result of
    // ..." messages, not role:'tool' — skipping them here meant stage 3 dropped
    // the whole exchange instead of shortening it, the "reload Skills again and
    // again" failure this stage exists to prevent, on exactly the small models
    // most likely to use text mode.
    const isResult = m.role === 'tool' ||
      (m.role === 'user' && String(m.content ?? '').startsWith('Result of '));
    if (!isResult || String(m.content ?? '').length <= SHORT_RESULT) continue;
    messages = messages.with(i, { ...m, content: String(m.content).slice(0, SHORT_RESULT) +
      '\n…[shortened to fit the context window; call the tool again for the full text]' });
  }
  if (estTokens(messages) <= budget) return messages;

  const [system, ...rest] = messages;
  const head = messages[0]?.role === 'system' ? [system] : [];
  const body = head.length ? rest : messages;
  // The loop's own question when it marked one; with chat history in front, the
  // first user message is the oldest of the conversation, not this turn's.
  const marked = body.findLastIndex(m => m[QUESTION]);
  const askAt = marked >= 0 ? marked : body.findIndex(m => m.role === 'user');
  const ask = askAt >= 0 ? [body[askAt]] : [];
  const tail = askAt >= 0 ? body.slice(askAt + 1) : body;
  const keep = [...head, ...ask];
  let start = 0;
  while (start < tail.length && estTokens([...keep, ...tail.slice(start)]) > budget) start++;
  while (start < tail.length && tail[start].role === 'tool') start++;   // never orphan a result
  return [...keep, ...tail.slice(start)];
}

/**
 * Check a tool call against the schema the model was given.
 *
 * A small model often names a tool and supplies nothing. `JSON.parse(args || '{}')`
 * turned that into a call with no arguments, which ran and failed somewhere deeper
 * — `write_file` with no `path` failed with an error about the path, which
 * tells the model nothing about what it did wrong. Naming the missing argument is
 * what lets it recover on the next step instead of guessing again.
 */
export function missingArgs(defs) {
  const need = new Map((defs ?? []).map(d =>
    [d.function?.name, d.function?.parameters?.required ?? []]));
  return (name, args) => {
    const gone = (need.get(name) ?? []).filter(k => {
      const v = args?.[k];
      return v === undefined || v === null || (typeof v === 'string' && !v.trim());
    });
    return gone.length
      ? `ERROR: ${name} requires ${gone.join(' and ')}, which you left out. You called it ` +
        `with ${JSON.stringify(args ?? {})}. Call it again with ${gone.length > 1 ? 'those' : 'that'} ` +
        `filled in — nothing ran.`
      : null;
  };
}

/* ---- the tool loop's shared pieces (backend/local-agent.mjs, web/js/agent.mjs) ---- */
export const NO_ANSWER = '(the model produced no final answer)';
export const hasNumber = t => /\d/.test(String(t ?? ''));

/** The API root for an endpoint as the user typed it: `/v1` is appended unless the
    URL already ends in a version. */
export const v1Base = baseUrl => {
  const url = String(baseUrl || '').replace(/\/+$/, '');
  return url && !/\/v\d+$/.test(url) ? url + '/v1' : url;
};

/**
 * One completion: the request both runtimes send, and the one retry. `send(body)` is
 * the runtime's own transport (node:http on the server, fetch in the page) and
 * resolves to readCompletion's message. `closedTools` are the last tools offered.
 */
export async function completion(send, { model, messages, tools, closedTools, schema, ctx, cap, extra, onStream }) {
  /* Closing tools (the wrap-up) still sends the last ones offered, and says so in
     words at the end instead of tool_choice 'none'. The chat template renders the
     tool list first, so dropping it changed the prompt from its first token and
     the prompt cache missed — measured on LM Studio: the wrap-up re-read 25,910
     tokens from zero (~3 min at 140 tok/s) and looked hung; and tool_choice
     'none' makes LM Studio drop the list itself (0 cached tokens vs 3072). A
     call made anyway is caught (closedCall). A schema step gets no tools at all. */
  const closed = !tools?.length && closedTools?.length && !schema;
  const body = { model,
                 messages: fitMessages(closed ? [...messages, closedNote] : messages, ctx, cap),
                 max_tokens: cap, stream: true, ...SAMPLING, ...extra };
  if (tools?.length || closed) body.tools = tools?.length ? tools : closedTools;
  else body.tool_choice = 'none';        // a server that honours it cannot emit a call
  if (schema) body.response_format = {
    type: 'json_schema', json_schema: { name: 'result', strict: true, schema } };
  const ask = async body => {
    const msg = await send(body);
    if (!msg.tool_calls?.length && msg.finish === 'length' && msg.content) onStream?.({ type: 'log',
      text: model + ' hit its token limit before finishing - the answer is cut off.' });
    return msg;
  };

  const msg = await ask(body);
  // A closed-tools call is retried even when prose came with it: that prose is the
  // run-up to the call ("Let me write the final model…:"), not an answer — measured
  // on bonsai-27b, it was shown as one.
  // Nothing visible is a dead end whatever ended it: the token limit, or (measured on
  // ternary-bonsai-2-27b: 17 minutes of thinking, then end of turn) the model itself.
  // The page used to retry only the token limit, and showed the other as a blank bubble.
  if (!msg.closedCall && (msg.tool_calls?.length || msg.content)) return msg;

  /* Cut off mid-thought with nothing visible. The thinking is the work, and it
     is already done, so put what got through back in front of the model and ask
     for its next move — re-running the same request just thinks again. "State
     the final answer" alone was wrong early in a turn: nothing had been run yet,
     so a model that obeyed the rules had nothing to say and said nothing. */
  onStream?.({ type: 'log', text: model +
    (msg.closedCall ? ' called a tool after tools were closed; asking it to answer.'
                 : msg.finish === 'length' ? ' was cut off while thinking; asking it for its next move.'
                 : ' stopped after thinking without answering; asking it for its next move.') });
  const second = await ask({ ...body,
    messages: fitMessages([...messages, ...cutoffNudge(msg, tools?.length)], ctx, cap) });
  // Never trade a partial answer for nothing: keep the first message unless the
  // retry actually said something.
  return second.content || second.tool_calls?.length ? second : msg;
}

/* Tools that change the project, on either runtime (their tool names do not overlap).
   A repeat of any call is replayed from memory (see toolRunner), so anything that
   writes has to invalidate that memory. */
const WRITES = ['write_file', 'run_python', 'write_model'];

/* Tools that produce a number. Reading the model is not computing with it: a model
   that reads `k=0.4` and then reports a flux of 1.2 worked it out in its head, which
   is the one thing the agent is not allowed to do. The answer is still shown — it is
   labelled, so the user knows nothing behind the number was checked. */
const COMPUTES = new Set(['run_python', 'simulate', 'steady_state', 'mca']);

function computedResult(name, out){
  if(!COMPUTES.has(name)) return false;
  const text = String(out ?? '').trim();
  if(!text || /^(?:ERROR:|REJECTED\b|REFUSED\b)/i.test(text) || /\[failed\]/i.test(text)) return false;
  let data;
  try { data = JSON.parse(text); } catch {}
  if(data && typeof data === 'object' && (data.error || data.ok === false || data.success === false)) return false;
  return hasNumber(text);
}

/* The loop itself: one copy, on the server and in
   the page. A runtime supplies what differs — its tools, its completion call, and
   `hook`: before(step) ahead of each completion, gate(name, args, run) to refuse a
   call (a string) or let it run (null), ran(name, args, out) after each one.
   Resolves to the answer's text (undefined if the steps ran out or the turn was
   stopped) and the names of the tools called. */
async function toolLoop({ complete, messages, tools, emit, signal, maxSteps,
                          cap = resultCap(), hook = {} }) {
  const run = toolRunner(tools.impl, WRITES), lacks = missingArgs(tools.defs);
  const used = new Set();
  let computed = false;
  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) break;
    await hook.before?.(step);
    // Out of steps: ask once more with NO tools, so the model has to
    // answer. Breaking out here instead handed the turn back empty, which is what
    // the user saw as the agent going round in circles and then saying nothing.
    // ...or as soon as it is plainly stuck: a repeated call warned about twice
    // will be repeated a third time, and each one costs a step.
    const stuck = run.repeats >= REPEAT_LIMIT;
    const wrapUp = step === maxSteps - 1 || stuck;
    if (wrapUp) emit({ type: 'log', text: (stuck ? 'same call repeated ' + run.repeats + 'x'
      : 'out of steps') + '; answering with what it has' });
    const m = await complete({ messages, tools: wrapUp ? undefined : tools.defs, signal, onStream: emit });
    messages.push(forHistory(m));
    const calls = m.tool_calls ?? [];
    if (!calls.length) return { text: m.content ?? '', used, computed };
    for (const c of calls) {
      if (signal?.aborted) break;   // Stop: the call already in flight finishes, the rest (a write_model, say) never start
      const name = c.function?.name;
      let args = {};
      try { args = JSON.parse(c.function?.arguments || '{}'); } catch {}
      emit({ type: 'tools', tools: [{ name, input: args }] });
      used.add(name);
      const denied = lacks(name, args) ?? await hook.gate?.(name, args, run);
      const out = denied ?? await run(name, args);
      if(denied == null && run.repeats === 0 && name in tools.impl && computedResult(name, out)) computed = true;
      messages.push(toolResult(c, name, String(out).slice(0, cap)));
      hook.ran?.(name, args, out);
    }
  }
  return { used, computed };
}

/** The outer turn: thinking and tokens both stream. Resolves to its `result` event. */
export async function runTurn(o) {
  const { text, used, computed } = await toolLoop(o);
  const final = stripToolSyntax(text);
  return { type: 'result', text: final || NO_ANSWER, isError: !final, noTools: !used.size,
           unverified: !computed && hasNumber(final) };
}
