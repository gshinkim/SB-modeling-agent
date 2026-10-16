/* node web/js/sessionpicker.test.mjs */
import assert from 'node:assert/strict';
import { matches, pickSession } from './sessionpicker.mjs';
import { pickFile } from './filepicker.mjs';

const rows = [
  { id: 'Glycolysis-v2', name: 'Glycolysis v2' },
  { id: '2026-09-20',    name: 'Untitled project' },
  { id: 'TCA-cycle',     name: 'TCA cycle' },
];

{
  assert.deepEqual(rows.filter(r => matches(r, '')).map(r => r.id),
                   ['Glycolysis-v2', '2026-09-20', 'TCA-cycle'], 'empty query keeps everything');
  assert.deepEqual(rows.filter(r => matches(r, 'gly')).map(r => r.id), ['Glycolysis-v2']);
  assert.deepEqual(rows.filter(r => matches(r, 'GLY')).map(r => r.id), ['Glycolysis-v2'],
                   'case-insensitive');
  assert.deepEqual(rows.filter(r => matches(r, '2026')).map(r => r.id), ['2026-09-20'],
                   'the id is searchable too, not just the name');
  assert.deepEqual(rows.filter(r => matches(r, 'zzz')).map(r => r.id), []);
}

console.log('session picker filter ok');

{
  const originals = { document: globalThis.document, fetch: globalThis.fetch, addEventListener: globalThis.addEventListener };
  const nodes = new Map();
  const node = selector => {
    if(!nodes.has(selector)){
      const classes = new Set();
      nodes.set(selector, { textContent: '', value: '', children: [], disabled: false,
        classList: { add: value => classes.add(value), remove: value => classes.delete(value) },
        setAttribute() {}, addEventListener() {}, focus() {}, append(child) { this.children.push(child); },
        querySelector: node });
    }
    return nodes.get(selector);
  };
  globalThis.document = { querySelector: node, createElement: () => node('#dialog'), body: node('#body') };
  globalThis.addEventListener = () => {};
  const requests = [];
  globalThis.fetch = path => new Promise(resolve => requests.push({ path, resolve: body => resolve({ json: async () => body }) }));
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  try {
    const opening = pickSession();
    node('#spCancel').onclick();
    const cancelled = await Promise.race([opening, new Promise(resolve => setTimeout(() => resolve('unsettled'), 100))]);
    assert.equal(cancelled, null, 'Cancel must settle the picker even before its network request answers');
    requests[0].resolve({ sessions: [] }); await tick();
    assert.equal(node('#spList').textContent, 'Loading…', 'a cancelled request cannot redraw the closed picker');

    const old = pickFile({ start: '/old', dirs: true });
    const current = pickFile({ start: '/current', dirs: true });
    assert.equal(await old, null, 'opening a new picker settles the old invocation');
    requests[2].resolve({ path: '/current', parent: '/', entries: [] }); await tick();
    requests[1].resolve({ path: '/old', parent: '/', entries: [] }); await tick();
    assert.equal(node('#fpCur').textContent, '/current', 'a late directory response cannot replace the current one');
    node('#fpOk').onclick();
    assert.equal(await current, '/current');
  } finally {
    for(const [name, value] of Object.entries(originals)){
      if(value === undefined) delete globalThis[name]; else globalThis[name] = value;
    }
  }
}
console.log('picker cancellation and stale directory reads ok');
