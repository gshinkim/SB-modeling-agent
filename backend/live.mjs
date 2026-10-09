/* Turns that outlive the browser tab. A turn used to belong to the HTTP response that
   started it: closing the page (or a dropped connection) killed the agent mid-work,
   and nothing it had said could be seen again. Now a turn belongs to its project.
   Everything it emits is kept, so a page that comes back is shown the whole turn so
   far — thinking, tool chips, the answer — and then follows it live. Only an explicit
   stop ends it. In memory only: a server restart ends every turn, as it always did. */
const LIVE = new Map();   // project id ('' = no project) -> { meta, events, subs, ended, stop }

/** Start the one turn of `key`, stopping a running one first. `begin(emit, end)` starts
    the work and returns its stop(); `meta` is what a returning page needs to redraw the
    question (its text, the chat it belongs to, attachment names, when it began). */
export function startLive(key, meta, begin) {
  stopLive(key);
  const run = { meta, events: [], subs: new Set(), ended: false, stop: () => {} };
  LIVE.set(key, run);
  const emit = o => { run.events.push(o); for (const f of [...run.subs]) f(o); };
  const end = () => { run.ended = true; for (const f of [...run.subs]) f(null); };
  run.stop = begin(emit, end) ?? run.stop;
}

/** Everything `key`'s turn has emitted so far, then each event as it comes, then
    on(null) once when it ends. null if there is no turn. Returns detach(), which only
    stops the watching. A finished turn is forgotten once someone has been shown it all. */
export function watchLive(key, on) {
  const run = LIVE.get(key);
  if (!run) return null;
  run.events.forEach(o => on(o));
  const fin = () => { if (LIVE.get(key) === run) LIVE.delete(key); on(null); };
  if (run.ended) { fin(); return () => {}; }
  const sub = o => { if (o) return on(o); run.subs.delete(sub); fin(); };
  run.subs.add(sub);
  return () => run.subs.delete(sub);
}

export const liveMeta = key => LIVE.get(key)?.meta ?? null;
/** Stop `key`'s turn if one is running; the turn then ends itself as usual. */
export const stopLive = key => { const r = LIVE.get(key); if (r && !r.ended) r.stop(); };
