/* Turns that outlive the browser tab. A turn used to belong to the HTTP response that
   started it: closing the page (or a dropped connection) killed the agent mid-work,
   and nothing it had said could be seen again. Now a turn belongs to its project.
   Everything it emits is kept, so a page that comes back is shown the whole turn so
   far — thinking, tool chips, the answer — and then follows it live. Only an explicit
   stop ends it. In memory only: a server restart ends every turn, as it always did. */
import { followId } from './sessions.mjs';

const LIVE = new Map();   // project id ('' = no project) -> { meta, events, subs, ended, stop }

/* A project can be renamed while its turn runs, and its id is its folder's name. The
   page that started the turn still asks by the old id; a reload, or another tab, asks
   by the new one, and found nothing. Both now resolve to where the project is (and the
   turn is re-filed there, so a later project taking the old name does not inherit it). */
const at = key => {
  for (const [k, run] of LIVE) { const now = followId(k); if (now !== k) { LIVE.delete(k); LIVE.set(now, run); } }
  return followId(key);
};

/** Start the one turn of `key`, stopping a running one first. `begin(emit, end)` starts
    the work and returns its stop(); `meta` is what a returning page needs to redraw the
    question (its text, the chat it belongs to, attachment names, when it began). */
export function startLive(key, meta, begin) {
  stopLive(key);
  key = at(key);
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
  const run = LIVE.get(at(key));
  if (!run) return null;
  run.events.forEach(o => on(o));
  const fin = () => { for (const [k, r] of LIVE) if (r === run) LIVE.delete(k); on(null); };
  if (run.ended) { fin(); return () => {}; }
  const sub = o => { if (o) return on(o); run.subs.delete(sub); fin(); };
  run.subs.add(sub);
  return () => run.subs.delete(sub);
}

export const liveMeta = key => LIVE.get(at(key))?.meta ?? null;
/** Stop `key`'s turn if one is running; the turn then ends itself as usual. */
export const stopLive = key => { const r = LIVE.get(at(key)); if (r && !r.ended) r.stop(); };
