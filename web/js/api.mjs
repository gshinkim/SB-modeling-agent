const post = async (url, body) => {
  const r = await fetch(url, { method:'POST', headers:{'content-type':'application/json'},
                               body: JSON.stringify(body) });
  return r.json();
};

export const getEnv      = ()      => fetch('/api/env').then(r=>r.json());
// `project` is the open project's folder id; without one it is the default model
export const getModel    = project => fetch('/api/model' +
  (project ? '?project=' + encodeURIComponent(project) : '')).then(r=>r.json());
export const putModel    = (src, project) => fetch('/api/model', { method:'PUT',
  headers:{'content-type':'application/json'}, body: JSON.stringify({src, project}) }).then(r=>r.json());
export const putSettings = s       => fetch('/api/settings', { method:'PUT',
  headers:{'content-type':'application/json'}, body: JSON.stringify(s) }).then(r=>r.json());
export const getSettings = ()      => fetch('/api/settings').then(r=>r.json());
export const info        = model   => post('/api/info', { model });

/* Local runtimes are found and driven by our own server, so the page never talks
   to localhost itself — no CORS flag on the model server, no browser prompt. */
export const scanLocal  = ()      => fetch('/api/local/scan').then(r=>r.json());
export const startLocal = ()      => post('/api/local/start', {});

export const simulate = q => post('/api/simulate', q);
export const steady   = q => post('/api/steady', q);
export const settle   = q => post('/api/settle', q);
export const mca      = q => post('/api/mca', q);
// SBML → Antimony (Antimony passes through): the editor only ever holds Antimony
export const convert  = src => post('/api/convert', { src });
// a ```latex block in an answer, compiled by Tectonic: {ok, pdf (base64)} or {ok:false, error}
export const latex    = src => post('/api/latex', { src });

/** One agent turn, streamed as server-sent events. Returns an abort function.
    Forwards the whole options object as-is — no per-field allowlist to fall out of
    sync with what chat.mjs sends (sessionDirId, resume and scratchDir were dropped
    this way once already). */
export const chat = (opts, onEvent) => stream('/api/chat', { method:'POST',
  headers:{'content-type':'application/json'}, body: JSON.stringify(opts) }, onEvent);
/** The turn a project is running, from its start: {type:'live', q, chat, files, at}, then
    its events. {type:'none'} alone when there is none. Returns detach(), which only
    stops listening. */
export const live = (project, onEvent) => stream('/api/chat/live?project=' + encodeURIComponent(project ?? ''), {}, onEvent);
/** Closing a page no longer stops a turn, so Stop has to ask for it. */
export const stopChat = project => fetch('/api/chat/stop', { method:'POST', headers:{'content-type':'application/json'},
  body: JSON.stringify({ project: project ?? '' }) }).catch(() => {});

function stream(url, init, onEvent){
  const ctrl = new AbortController();
  (async () => {
    let res;
    try{
      res = await fetch(url, { ...init, signal: ctrl.signal });
    }catch(e){
      // Stop pressed before the server even answered: no fatal, just end the turn
      // like any other abort, so the UI unbusies and doesn't log a fake exchange.
      if(e.name==='AbortError'){ onEvent({type:'closed'}); return; }
      onEvent({type:'fatal', error:String(e.message||e)});
      onEvent({type:'done', code:1});
      return;
    }
    if(res.status === 204) return onEvent({type:'none'});
    if(!res.ok || !res.body){
      // the server explains misconfiguration in JSON; don't flatten it to a status code
      let msg = 'chat failed: HTTP '+res.status;
      try{ const j = await res.json(); if(j?.error) msg = j.error; }catch{}
      onEvent({type:'fatal', error: msg});
      onEvent({type:'done', code:1});
      return;
    }
    const rd = res.body.getReader(), dec = new TextDecoder();
    let buf='';
    const frame = value => {
      for(const line of value.split('\n')){
        if(!line.startsWith('data:')) continue;
        try{ onEvent(JSON.parse(line.slice(5).trim())); }catch{}
      }
    };
    for(;;){
      let chunk;
      try{ chunk = await rd.read(); }
      catch(e){ if(e.name!=='AbortError') onEvent({type:'fatal', error:String(e.message||e)}); break; }
      if(chunk.done){ buf += dec.decode(); break; }
      buf = (buf + dec.decode(chunk.value, {stream:true})).replace(/\r\n/g, '\n');
      let i;
      while((i = buf.indexOf('\n\n')) >= 0){
        const value = buf.slice(0,i); buf = buf.slice(i+2);
        frame(value);
      }
    }
    if(buf.trim()) frame(buf);            // the last event need not have a trailing separator
    onEvent({type:'closed'});
  })();
  return () => ctrl.abort();
}
