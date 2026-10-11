/* node --test backend/live.test.mjs — a turn outlives the page that started it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLive, watchLive, liveMeta, stopLive } from './live.mjs';
import { saveSession } from './sessions.mjs';

test('closing the page does not stop the turn, and a page that comes back sees all of it', () => {
  let emit, end, stopped = 0;
  startLive('p', { q: 'why?' }, (e, n) => { emit = e; end = n; return () => { stopped++; }; });
  const first = [];
  const leave = watchLive('p', o => first.push(o));
  emit({ type: 'thinking', text: 'a' });
  leave();                                              // the tab closes
  emit({ type: 'thinking', text: 'b' });                // the agent keeps working
  assert.equal(stopped, 0, 'nothing stopped it');
  assert.deepEqual(first, [{ type: 'thinking', text: 'a' }], 'the closed page gets nothing more');

  const back = [];
  watchLive('p', o => back.push(o));                    // reopened mid-turn: replay, then live
  assert.deepEqual(liveMeta('p'), { q: 'why?' });
  emit({ type: 'result', text: 'because' });
  end();
  assert.deepEqual(back, [{ type: 'thinking', text: 'a' }, { type: 'thinking', text: 'b' },
                          { type: 'result', text: 'because' }, null]);
  assert.equal(watchLive('p', () => {}), null, 'shown in full, so forgotten');
});

test('a turn that ends with nobody watching is kept until someone looks', () => {
  startLive('q', { q: 'x' }, (emit, end) => { emit({ type: 'result', text: 'done' }); end(); });
  const got = [];
  watchLive('q', o => got.push(o));
  assert.deepEqual(got, [{ type: 'result', text: 'done' }, null]);
  assert.equal(liveMeta('q'), null);
});

test('only an explicit stop ends a turn, and a new turn replaces the running one', () => {
  let stops = 0;
  startLive('r', {}, () => () => { stops++; });
  stopLive('r');
  assert.equal(stops, 1);
  startLive('r', {}, () => () => { stops++; });         // the first never ended: stopped again, then replaced
  assert.equal(stops, 2);
  stopLive('nope');                                     // no turn: nothing to do
});

test('a project renamed mid-turn keeps its turn, under the new id and the old one', async () => {
  const work = await mkdtemp(join(tmpdir(), 'live-'));
  const { id } = await saveSession(work, { name: 'Before', fresh: true });
  let emit, stops = 0;
  startLive(id, { q: 'x' }, e => { emit = e; return () => { stops++; }; });
  const renamed = (await saveSession(work, { id, name: 'After' })).id;
  assert.equal(renamed, 'After');
  assert.deepEqual(liveMeta(renamed), { q: 'x' }, 'a reload asks by the new id');
  const got = [];
  watchLive(renamed, o => got.push(o));
  emit({ type: 'delta', text: 'a' });
  assert.deepEqual(got, [{ type: 'delta', text: 'a' }]);
  stopLive(id);                                         // the page that started it still holds the old id
  assert.equal(stops, 1);
  // the old name, taken by a new project, does not inherit the turn
  assert.equal((await saveSession(work, { name: 'Before', fresh: true })).id, 'Before');
  assert.equal(liveMeta('Before'), null);
  assert.deepEqual(liveMeta('After'), { q: 'x' });
});
