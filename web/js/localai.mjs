import { readCompletion, CONTEXT_DEFAULT, replyTokens, completion, v1Base } from './oai.mjs';

/* Reaching a model server on the user's own machine from a hosted https page.
   Chrome 141+ gates this behind the Local Network Access permission, which only
   prompts on a user gesture — so the "Connect" button is not decoration, it is
   the mechanism. Three things can go wrong and they look identical from JS, so
   probe() distinguishes them explicitly. */

export const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/** 127.0.0.1 is the `loopback` space, not `local`; annotating it `local` fails. */
function spaceFor(url){
  try { return LOOPBACK.test(new URL(url).origin) ? 'loopback' : 'local'; }
  catch { return undefined; }
}

async function ping(base, path, init = {}){
  const url = base.replace(/\/+$/,'') + path;
  const space = spaceFor(url);
  const opts = { ...init, ...(space ? { targetAddressSpace: space } : {}) };
  try {
    return { ok: true, res: await fetch(url, opts) };
  } catch (e) {
    // a mis-annotated address space rejects instantly; retry unannotated once
    if (space) { try { return { ok: true, res: await fetch(url, init) }; } catch {} }
    return { ok: false, error: e };
  }
}

/**
 * True when the page and the target sit in the same address space, so Local
 * Network Access does not apply. A page served from 127.0.0.1 reaching
 * localhost:1234 is loopback→loopback: nothing to grant, nothing to block.
 */
export function samePageSpace(url, origin = globalThis.location?.origin){
  return !!origin && LOOPBACK.test(origin) && spaceFor(url) === 'loopback';
}

export async function permissionState(){
  try { return (await navigator.permissions.query({ name: 'local-network-access' })).state; }
  catch { return 'unsupported'; }
}

/**
 * One command per runtime that makes it accept this site — a terminal command for
 * each, not a paragraph mixing all three. `origin` is this exact deployment, so the
 * Ollama line can be pasted as-is.
 */
export const corsCommands = (origin = location.origin) => [
  { app: 'Ollama', cmd: `OLLAMA_ORIGINS=${origin} ollama serve`,
    note: 'Quit the Ollama menu-bar app first — it holds port 11434.' },
  { app: 'LM Studio', cmd: 'lms server start --cors',
    note: 'Or: Developer tab → enable CORS, then start the server.' },
  { app: 'llama.cpp', cmd: 'llama-server -m model.gguf --port 8080 --cors',
    note: 'Point --port at whatever URL you set above.' },
];

/**
 * Diagnose a local model server. MUST be called from a click: the browser only
 * shows the Local Network Access prompt during a user gesture.
 * @returns {{status:'ok'|'permission'|'cors'|'offline'|'http', models?:string[], detail:string}}
 */
export async function probe(baseUrl, apiKey){
  if (!baseUrl) return { status: 'offline', detail: 'No server URL set.' };
  const before = await permissionState();
  const t0 = performance.now();
  const r = await ping(v1Base(baseUrl), '/models',
    { headers: apiKey ? { authorization: 'Bearer ' + apiKey } : {} });
  const ms = performance.now() - t0;

  if (r.ok && r.res.ok) {
    const j = await r.res.json().catch(() => ({}));
    const models = (j.data ?? j.models ?? []).map(m => m.id ?? m.name).filter(Boolean);
    return { status: 'ok', models,
             detail: models.length ? models.length + ' model' + (models.length===1?'':'s') + ' available'
                                   : 'connected, but the server lists no models' };
  }
  if (r.ok) return { status: 'http', detail: 'Server answered HTTP ' + r.res.status +
                                             '. Is that the right URL for an OpenAI-compatible API?' };

  const after = await permissionState();
  if (after === 'denied')
    return { status: 'permission', detail:
      'Local network access is blocked for this site. Click the icon at the left of the ' +
      'address bar → Site settings → allow "Local network access", then try again.' };
  /* A refused connection and a blocked one are both an instant TypeError, so "fast
     failure" alone never meant the browser blocked it: with nothing listening on
     the port this told people to click Allow, which could not help. Local Network
     Access only gates a request that LEAVES an address space, so a loopback page
     asking loopback is never gated — there the fast failure is a closed port or a
     missing CORS header, which is what the branch below already says, with the
     command that fixes either. */
  if (before === 'prompt' && after === 'prompt' && ms < 50 && !samePageSpace(baseUrl))
    return { status: 'permission', detail:
      'The browser blocked the request to your machine. Click Connect again and choose ' +
      'Allow on the "local network" prompt.' };

  return { status: 'cors', cmds: corsCommands(),
    detail: 'Could not reach ' + baseUrl + '. It is either not running, or not allowing ' +
            'this site. Run the one for your app, then press Connect again.' };
}

/** Chat completions against the user's own machine, streamed. `closedTools` are
    the last tools offered, re-sent closed on the wrap-up (see completion in oai.mjs). */
export async function localChat({ baseUrl, apiKey, model, messages, tools, schema, signal,
                                  onStream, contextTokens, replyPct, closedTools }){
  const url = v1Base(baseUrl) + '/chat/completions';
  // Sized to the window the runtime actually loaded, not to the weights' maximum:
  // asking for more than it holds truncates the prompt instead of lengthening the
  // answer, and that truncation is what made the model repeat itself. The reply
  // budget has to also be the fitMessages reserve — the server runtime does this
  // (backend/local-agent.mjs Chat.complete); without it the prompt could fill
  // ctx-1024 while max_tokens asked for another ctx/2, over-filling the window.
  // ponytail: the window is the setting, not detected as on the server
  // (Chat.detectContext); port that here if pages keep running on the wrong one.
  const ctx = Number(contextTokens) > 0 ? Number(contextTokens) : CONTEXT_DEFAULT;
  const space = spaceFor(url);
  return completion(async body => {
    const res = await fetch(url, {
      method: 'POST', signal,
      ...(space ? { targetAddressSpace: space } : {}),
      headers: { 'content-type':'application/json',
                 ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}) },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(model + ': HTTP ' + res.status + ' ' + (await res.text().catch(()=>'')).slice(0,200));
    if (!res.body) throw new Error('no response body from ' + url);
    return readCompletion(res, { onStream, toolNames: (tools ?? []).map(t => t.function?.name) });
  }, { model, messages, tools, closedTools, schema, ctx, cap: replyTokens(ctx, replyPct), onStream });
}
