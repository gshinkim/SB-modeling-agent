/* node web/js/session.test.mjs
   No DOM and no server: the id rules are the part worth pinning. */
import assert from 'node:assert/strict';
import { slug } from './util.mjs';
import { S } from './state.mjs';
import * as api from './api.mjs';
import { initSession, saveSoon, savedId, openSessionById, deleteSessionById, newProject } from './session.mjs';

const tick = () => new Promise(r => setTimeout(r, 0));
const ok = body => Promise.resolve({ json: async () => body });
const hooks = o => ({ getName: () => 'Untitled project', getModel: () => 'm', getSettings: () => ({}),
                      getChats: () => [], setAll: () => {}, stopTurn: () => {}, reset: () => {}, ...o });

assert.equal(slug('Untitled project'), 'Untitled-project');

{
  // THE "NOTHING SAVES" BUG: editing the model or renaming (no chat turn at all)
  // must create the project's folder. The first save is `fresh` so the server
  // claims a new folder instead of writing into another project's.
  let name = 'Untitled project';
  initSession(hooks({ getName: () => name, getModel: () => 'S1 -> S2; k*S1' }));
  const calls = [];
  globalThis.fetch = (path, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    return Promise.resolve({ json: async () => ({ id: body.fresh ? 'Untitled-project-2' : body.id }) });
  };
  S.sessionDirId = null;
  // untouched and never saved: closing the page must leave nothing behind
  saveSoon(false);
  await new Promise(r => setTimeout(r, 900));
  assert.equal(calls.length, 0, 'untouched: no save');
  saveSoon();                                       // what a model edit / rename does
  // two saves asked for while the debounced one is pending: only ONE may be fresh
  assert.deepEqual(await Promise.all([savedId(), savedId()]), ['Untitled-project-2', 'Untitled-project-2']);
  await new Promise(r => setTimeout(r, 900));
  assert.deepEqual(calls.map(c => [c.id, c.fresh]),
                   [['Untitled-project', true], ['Untitled-project-2', false]]);
  assert.equal(S.sessionDirId, 'Untitled-project-2');
  delete globalThis.fetch;
  S.sessionDirId = null;
}

{
  // SAVED, THEN ID: what a turn and a model write call first. The id is the one the
  // SERVER returned (it claims Glycolysis-2 when Glycolysis is taken, and renames the
  // folder on a rename), and it only resolves once the save has landed — a model
  // PUT sent earlier goes to the old folder or to the shared default file.
  let name = 'Glycolysis', release;
  initSession(hooks({ getName: () => name }));
  const calls = [];
  globalThis.fetch = (path, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ path, ...body });
    if (path !== '/api/sessions/save') return ok({ version: 1 });
    const answer = () => ok({ id: body.fresh ? 'Glycolysis-2' : slug(body.name) });
    return release === undefined ? answer() : new Promise(r => { release = () => r(answer()); });
  };
  S.sessionDirId = null;
  assert.equal(await savedId(), 'Glycolysis-2', 'before a turn: the id the server claimed');
  assert.deepEqual(calls.map(c => [c.path, c.id, c.fresh]), [['/api/sessions/save', 'Glycolysis', true]]);

  name = 'TCA'; release = null;                      // a rename, its save held in flight
  const turn = savedId();
  const write = savedId(false).then(id => api.putModel('S1 -> S2', id));   // what main.mjs commit() does
  await tick(); await tick();
  assert.equal(calls.some(c => c.path === '/api/model'), false, 'no model write while the save is in flight');
  release();
  assert.equal(await turn, 'TCA');
  await write;
  assert.deepEqual(calls.slice(1).map(c => [c.path, c.project ?? c.id]),
                   [['/api/sessions/save', 'Glycolysis-2'], ['/api/model', 'TCA']],
                   'the model write follows the save, into the renamed folder, and adds no save of its own');
  delete globalThis.fetch;
  S.sessionDirId = null;
}

{
  // OPENING ANOTHER PROJECT: the turn on screen is left (not stopped) before anything
  // else — it ends by arming a save, which must land in the OLD folder before the open
  // request. A save still in flight when the open lands must not hand the old id back.
  const order = [];
  let release;
  initSession(hooks({ stopTurn: real => { order.push('stop:' + real); saveSoon(); },
                      setAll: () => order.push('setAll') }));
  globalThis.fetch = (path, opts) => {
    const body = JSON.parse(opts.body);
    order.push(path + ' ' + body.id);
    if (path === '/api/sessions/open') return new Promise(r => { release = () => r({ json: async () => ({ id: 'B' }) }); });
    return order.length > 3 ? new Promise(r => setTimeout(() => r({ json: async () => ({ id: body.id }) }), 20))
                            : ok({ id: body.id });
  };
  S.sessionDirId = 'A';
  const opening = openSessionById('B');
  await tick(); await tick();
  assert.deepEqual(order, ['stop:false', '/api/sessions/save A', '/api/sessions/open B']);
  const late = savedId();                           // a save for A, answered only after B is open
  release();
  await opening;
  assert.equal(S.sessionDirId, 'B');
  await late;
  assert.equal(S.sessionDirId, 'B', 'a late answer to the old project\'s save must not take the id back');
  assert.equal(order.at(-1), 'setAll');
  delete globalThis.fetch;
  S.sessionDirId = null;
}

{
  // THE GHOST BUG: a chat turn (or a model edit) arms an 800ms saveSoon() debounce
  // for the CURRENT session. Before that timer fires, the user deletes the session
  // and confirms — while the delete's own fetch is still in flight. If the armed
  // save is merely left alone (or flushed), it fires for the OLD id and recreates
  // the very folder the user just deleted. deleteSessionById() must CANCEL the pending
  // save, not flush it, and must not let one get armed again until the delete
  // settles. This drives the REAL exported deleteSessionById()/saveSoon(), not a pure
  // helper standing in for them. It also stops the turn itself — whose ending arms a
  // save, as chat.mjs's does — and resets the page only once the folder is gone.
  const calls = [];
  initSession(hooks({ getName: () => 'Bob Smith', getModel: () => 'model text',
                      getChats: () => [{ log: [{ q: 'x', a: 'y' }] }],
                      stopTurn: real => { calls.push({ path: 'stop:' + real }); saveSoon(); },
                      reset: () => calls.push({ path: 'reset' }) }));

  let releaseDelete;
  const deleteGate = new Promise(r => { releaseDelete = r; });
  globalThis.fetch = (path, opts) => {
    calls.push({ path, body: opts?.body ? JSON.parse(opts.body) : null });
    if (path === '/api/sessions/delete')
      return deleteGate.then(() => ({ json: async () => ({ ok: true }) }));
    return Promise.resolve({ json: async () => ({ id: 'bob-smith' }) });
  };

  S.sessionDirId = 'bob-smith';
  saveSoon();                                     // arms the 800ms debounce, as a finished turn would
  const delP = deleteSessionById('bob-smith');     // fires the delete; its fetch is still pending below
  saveSoon();                                      // a stray re-arm attempt mid-delete must also be refused
  await new Promise(r => setTimeout(r, 900));       // let the debounce window pass while delete is in flight
  assert.equal(calls.some(c => c.path === '/api/sessions/save'), false,
    'a pending (or re-armed) save must never fire while its session is being deleted');

  releaseDelete();
  const delResult = await delP;
  assert.equal(delResult.ok, true);
  assert.equal(S.sessionDirId, null, 'the deleted id must be cleared');
  assert.deepEqual(calls.map(c => c.path), ['stop:true', '/api/sessions/delete', 'reset']);

  await new Promise(r => setTimeout(r, 900));       // nothing lands late after the delete settles either
  assert.equal(calls.some(c => c.path === '/api/sessions/save'), false,
    'no stale save may land after the delete has completed');

  delete globalThis.fetch;
}

{
  // THE REENTRANCY GAP: two overlapping deleteSessionById() calls — reachable because
  // the delete button's click handler is async and nothing disables it while a
  // delete is in flight, so a user can accept two confirm() dialogs before the
  // first fetch resolves. A plain boolean `deleting` flag lets the FIRST call's
  // finally clear it while the SECOND call's post() is still pending, reopening
  // the window for saveSoon() to arm a save that resurrects the folder. Must be
  // a counter: only the LAST delete to settle may re-enable saving. Drives the
  // REAL exported deleteSessionById()/saveSoon(), not a pure helper standing in.
  initSession(hooks({ getName: () => 'Bob Smith', getModel: () => 'model text',
                      getChats: () => [{ log: [{ q: 'x', a: 'y' }] }] }));

  const calls = [];
  let releaseDelete1, releaseDelete2;
  const gate1 = new Promise(r => { releaseDelete1 = r; });
  const gate2 = new Promise(r => { releaseDelete2 = r; });
  let deleteCallCount = 0;
  globalThis.fetch = (path, opts) => {
    calls.push({ path, body: opts?.body ? JSON.parse(opts.body) : null });
    if (path === '/api/sessions/delete') {
      deleteCallCount++;
      const gate = deleteCallCount === 1 ? gate1 : gate2;
      return gate.then(() => ({ json: async () => ({ ok: true }) }));
    }
    return Promise.resolve({ json: async () => ({ id: 'bob-smith' }) });
  };

  S.sessionDirId = 'bob-smith';
  const del1 = deleteSessionById('bob-smith');   // first overlapping delete, fetch pending
  const del2 = deleteSessionById('bob-smith');   // second, fired before the first settles

  releaseDelete1();
  await del1;                     // first delete resolves; the SECOND's fetch is still pending
  saveSoon();                     // fired in the reentrancy gap — must still be blocked
  await new Promise(r => setTimeout(r, 900));   // let the debounce window pass

  assert.equal(calls.some(c => c.path === '/api/sessions/save'), false,
    'no save may fire while a second overlapping delete is still in flight');

  releaseDelete2();
  await del2;

  await new Promise(r => setTimeout(r, 900));
  assert.equal(calls.some(c => c.path === '/api/sessions/save'), false,
    'no save may land after both deletes settle either');

  delete globalThis.fetch;
}

{
  // NEW PROJECT: the old project's pending edit lands in ITS folder, then the page is an
  // untouched Untitled project that creates nothing until it is touched
  const order = [];
  initSession(hooks({ stopTurn: real => order.push('stop:' + real), reset: () => order.push('reset') }));
  const calls = [];
  globalThis.fetch = (path, opts) => { const b = JSON.parse(opts.body); calls.push(b); order.push(b.id);
    return Promise.resolve({ json: async () => ({ id: b.fresh ? 'Untitled-project-3' : b.id }) }); };
  S.sessionDirId = 'Old-project';
  saveSoon();                                       // an edit, still inside the debounce
  await newProject();
  assert.deepEqual(calls.map(c => c.id), ['Old-project'], 'pending save flushed to the old folder');
  assert.equal(S.sessionDirId, null);
  assert.deepEqual(order, ['stop:false', 'Old-project', 'reset'], 'the turn is left first, the page reset last');
  saveSoon(false);
  await new Promise(r => setTimeout(r, 900));
  assert.equal(calls.length, 1, 'untouched new project: no folder');
  await savedId(false);                             // the first model edit
  assert.deepEqual(calls.at(-1), { ...calls.at(-1), fresh: true, id: 'Untitled-project' });
  assert.equal(S.sessionDirId, 'Untitled-project-3');
  delete globalThis.fetch;
  S.sessionDirId = null;
}

console.log('session id ok');

{
  // The editor has its own debounce, separate from session autosave. Its pending
  // model writes must finish in the old project before open replaces that id.
  const order = [];
  let releaseWrite;
  const writeGate = new Promise(resolve => { releaseWrite = resolve; });
  initSession(hooks({ beforeLeave: async saveEdits => {
    order.push('leave:' + saveEdits);
    await writeGate;
    order.push('editor write A');
  }, setAll: () => order.push('setAll B') }));
  globalThis.fetch = (path, opts) => {
    order.push(path);
    return ok({ id: JSON.parse(opts.body).id });
  };
  S.sessionDirId = 'A';
  const opening = openSessionById('B');
  await tick();
  assert.deepEqual(order, ['leave:true'], 'opening waits for the old editor write');
  assert.equal(S.sessionDirId, 'A');
  releaseWrite(); await opening;
  assert.deepEqual(order, ['leave:true', 'editor write A', '/api/sessions/open', 'setAll B']);
  assert.equal(S.sessionDirId, 'B');
  initSession(hooks({ beforeLeave: saveEdits => order.push('delete leave:' + saveEdits) }));
  await deleteSessionById('B');
  assert.ok(order.indexOf('delete leave:false') < order.indexOf('/api/sessions/delete'),
    'deletion drains writes without flushing pending editor edits');
  delete globalThis.fetch; S.sessionDirId = null;
}
console.log('editor switching hook ok');
