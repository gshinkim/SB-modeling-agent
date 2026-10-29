import { S } from './state.mjs';
import { slug } from './util.mjs';

/* A project is a folder under workspace/. It is created on the first touch (an edit,
   a rename, a chat) — never on page load, so a project opened and closed untouched
   leaves nothing behind. */

const DEFAULT_NAME = 'Untitled project';

// keepalive: a save sent as the tab closes still arrives. Only then: it caps the body at 64 KB.
let leaving = false;
const post = (path, body) => fetch(path, { method: 'POST', keepalive: leaving,
  headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());

export const listSessions = () => fetch('/api/sessions').then(r => r.json())
  .then(r => r.sessions ?? []).catch(() => []);

let getName = () => DEFAULT_NAME, getModel = () => '', getSettings = () => ({}),
    getChats = () => [], setAll = () => {}, stopTurn = () => {}, reset = () => {}, beforeLeave = () => {};

/** Wire the module to the page once, at boot, rather than importing main.mjs back.
    `stopTurn(real)` ends the turn on screen (real false only leaves it: the server keeps
    running it); `reset` puts the page's project name and chats back to an untouched project. */
export function initSession(hooks) {
  ({ getName, getModel, getSettings, getChats, setAll, stopTurn, reset, beforeLeave = () => {} } = hooks);
}

export const currentId = () => S.sessionDirId;

/* Nothing has been touched and no folder exists: saving would create a folder for
   an untouched project. Also what stops a just-deleted project coming back from a
   stray save — deleteSessionById() clears `touched` along with the folder id. */
let touched = false;

/* Saves run one at a time: two first-saves in flight together would each claim a
   folder, leaving a stray Untitled-project-2 behind. */
let chain = Promise.resolve();
const saveNow = () => (chain = chain.then(doSave, doSave));

/* Resolves once whatever save is currently in flight (a rename, a first save that's
   still claiming a folder id) has settled, success or failure — never rejects. A
   model PUT that races that save can land in the OLD id (rename) or in the shared
   default file (first save still pending); await this before it. */
const saveIdle = () => chain.catch(() => {});

/** The one call before a turn or a model write: resolves to the open project's folder
    id once that folder exists and no save is in flight. Never rejects; null when there
    is no folder (hosted, or the save failed). A turn's memory (history.md) and files go
    in that folder, which must have its final name before the agent starts, so the
    project is saved first. `rewrite` false is for a model write, which happens on every
    slider move: it only creates a missing folder. */
export async function savedId(rewrite = true) {
  touched = true;
  if (rewrite || S.sessionDirId == null) { cancelPending(); saveNow(); }
  await saveIdle();
  return S.sessionDirId;
}

async function doSave() {
  if (S.env?.hosted) return null;
  const was = S.sessionDirId, fresh = was == null;
  if (fresh && !touched) return null;
  const id = was ?? (slug(getName()) || slug(DEFAULT_NAME));
  const r = await post('/api/sessions/save', { id, fresh, name: getName(), chats: getChats(),
                                               settings: getSettings(), model: getModel() });
  // a new folder or a rename comes back with its name; not if another project was
  // opened while this was in flight, or the open one would take the old one's id
  if (r.id && S.sessionDirId === was) S.sessionDirId = r.id;
  return r;
}

/* Autosave is debounced. It is NOT held back while a turn runs: a rename lands at once,
   and the server keeps the running turn's paths working (sessions.mjs holdDir/follow).
   Holding it back made the rename land at the turn's end, mid-compression, and that
   turn's history was lost. `deleting`
   blocks a save from being armed (or re-armed) while deleteSessionById() is in flight —
   without it, a save timer set just before delete(), or one set by a stray caller
   DURING the delete's own await, can fire after the folder is gone and recreate it.
   It's a COUNTER, not a boolean: the confirm() button isn't disabled fast enough to
   rule out two overlapping deleteSessionById() calls, and with a boolean the FIRST
   call's finally would clear it while the SECOND call's post() is still pending,
   reopening the window. Only the last delete to settle may re-enable saving.
   `touching` false saves a project that already has something to save and never
   creates a folder (deleting a chat: an unsaved project has nothing on disk to update). */
let t = null, scheduled = false, deleting = 0;
export function saveSoon(touching = true) {
  if (deleting > 0) return;             // a delete is in flight — never arm a save for it
  if (touching) touched = true;         // every other caller is a user action
  clearTimeout(t);
  scheduled = true;
  t = setTimeout(() => { scheduled = false; saveNow(); }, 800);
}

/* A debounce still outstanding targets whoever
   S.sessionDirId is RIGHT NOW. Call this before that changes, or the save either
   never happens (the old session silently loses its last turn/rename) or fires
   after the switch and re-saves the wrong, now-current session. A save already in
   flight is waited for too: its answer carries a folder id, and landing after the
   switch it would hand that id to the project opened since. */
// the tab closing inside the 800 ms after a turn ended used to drop that turn
globalThis.addEventListener?.('pagehide', () => { if (scheduled) { leaving = true; cancelPending(); saveNow(); } });
globalThis.addEventListener?.('pageshow', () => { leaving = false; });

async function flushPending() {
  if (scheduled) { cancelPending(); saveNow(); }
  await saveIdle();
}

/* Same triggers as flushPending, but CANCELS instead of flushing: used by
   deleteSessionById(), where writing the folder back out is exactly the opposite of
   what the user just asked for ("I deleted it and it comes back"). */
function cancelPending() {
  clearTimeout(t);
  scheduled = false;
}

/** Open a saved project. The running turn is left, not stopped: it is the old project's
    turn, the server keeps running it, and it is picked up when that project is opened again. */
export async function openSessionById(id) {
  stopTurn(false);                      // first: a turn that ends arms a save, flushed below
  await beforeLeave(true);             // flush editor writes before replacing its text and folder id
  await flushPending();                 // save whatever was pending for the OLD session first
  const r = await post('/api/sessions/open', { id });
  if (r.error) throw new Error(r.error);
  S.sessionDirId = r.id ?? id;
  setAll(r);                            // editor, settings, chats, project name
  return r;
}

/** Start a new, untouched Untitled project — what a page reload used to be for.
    The old project's pending save lands in ITS folder first; nothing is created
    for the new one until it is touched. */
export async function newProject() {
  stopTurn(false);                      // leave it running: it is that project's turn, not this page's
  await beforeLeave(true);
  await flushPending();
  S.sessionDirId = null;
  touched = false;
  reset();                              // clean Untitled project; the editor keeps its model, as a reload does
}

/** Delete any saved project. Deleting the open one stops its turn and also forgets it, so
    the page is back to an untouched Untitled project that will not recreate the folder. */
export async function deleteSessionById(id) {
  if (!id) return { ok: true };
  const isCurrent = id === S.sessionDirId;
  if (isCurrent) {
    deleting++;                         // block saveSoon() from arming a save until this settles
    stopTurn(true);                     // after deleting++: a turn that ends tries to arm one
    cancelPending();                    // a save already armed for THIS id must not race the delete below
  }
  try {
    if (isCurrent) { await beforeLeave(false); await saveIdle(); } // drain in-flight writes without saving new edits
    const r = await post('/api/sessions/delete', { id });
    // still the open one: an overlapping delete may have settled first and another project been opened since
    if (!r.error && id === S.sessionDirId) { S.sessionDirId = null; touched = false; reset(); }
    return r;
  } finally {
    if (isCurrent) deleting--;
  }
}
