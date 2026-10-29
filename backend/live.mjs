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
    question (its text, the chat it belongs to, attachment names, when it began).
    `keep(key, meta, events)` saves a turn no page saw end: the tab was closed, or another
    project opened. It is then forgotten here, so a page that comes back reads it from disk
    instead of replaying it (and logging it a second time). */
export function startLive(key, meta, begin, keep) {
  stopLive(key);
  key = at(key);
  const run = { meta, events: [], subs: new Set(), ended: false, stop: () => {}, keep };
  LIVE.set(key, run);
  const emit = o => { if (run.ended) return; run.events.push(o); for (const f of [...run.subs]) f(o); };
  const end = () => {
    if (run.ended) return;
    run.ended = true;
    if (keep && !run.subs.size) return void keepRun(run);
    for (const f of [...run.subs]) f(null);
  };
  try { run.stop = begin(emit, end) ?? run.stop; }
  catch (e) {
    end();
    // A startup failure did not start a turn. Do not leave an immortal live
    // entry with no stop function for a later reload to follow forever.
    for (const [k, r] of LIVE) if (r === run) LIVE.delete(k);
    throw e;
  }
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

const keyOf = run => { for (const [k, r] of LIVE) if (r === run) return at(k); };
function keepRun(run){
  const key = keyOf(run);
  for (const [k, r] of LIVE) if (r === run) LIVE.delete(k);
  return run.keep(key, run.meta, run.events);
}

/** The server is going down: every turn it still holds, finished or not, goes to disk
    with what it has so far. A page that was watching one logs it too, but its save
    replaces the whole chat list, so the turn is never there twice. */
export function keepAll(){
  return Promise.all([...new Set(LIVE.values())].filter(r => r.keep).map(keepRun));
}

export const liveMeta = key => LIVE.get(at(key))?.meta ?? null;
/** Stop `key`'s turn if one is running; the turn then ends itself as usual. */
export const stopLive = key => { const r = LIVE.get(at(key)); if (r && !r.ended) r.stop(); };
