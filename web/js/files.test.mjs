import assert from 'node:assert/strict';
import test from 'node:test';
import { S } from './state.mjs';
import { initFiles } from './files.mjs';
import { go } from './shell.mjs';

test('Files ignores stale reads, project switches and deletes after another file opens', async () => {
  const nodes = new Map();
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {
      value: '', textContent: '', innerHTML: '', dataset: {}, style: {}, hidden: false,
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      setAttribute() {}, focus() {}, querySelector() { return node('#child'); },
    });
    return nodes.get(selector);
  };
  const globals = { document: globalThis.document, addEventListener: globalThis.addEventListener,
    fetch: globalThis.fetch, confirm: globalThis.confirm };
  globalThis.document = { querySelector: node, querySelectorAll: () => [] };
  globalThis.addEventListener = () => {};
  globalThis.confirm = () => true;
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const answer = body => ({ ok: true, json: async () => body });
  const reads = [], deletes = [];
  const entries = ['a.txt', 'b.txt'].map(path => ({ path, mtime: 1, size: 3, text: true }));
  globalThis.fetch = (url, options = {}) => {
    const parsed = new URL(url, 'http://test');
    if (parsed.pathname === '/api/files') return Promise.resolve(answer({
      files: entries, root: parsed.searchParams.get('project'),
    }));
    const request = { project: parsed.searchParams.get('project'), path: parsed.searchParams.get('path') };
    return new Promise(resolve => {
      request.resolve = content => resolve(answer({ content, mtime: 1, size: 3 }));
      (options.method === 'DELETE' ? deletes : reads).push(request);
    });
  };
  const select = path => node('#flList').onclick({ target: { closest: () => ({ dataset: { path } }) } });
  try {
    S.env = { hosted: false }; S.sessionDirId = 'first';
    initFiles(); go('files'); await tick();
    select('a.txt'); select('b.txt');
    assert.equal(reads.length, 2);
    reads[1].resolve('BBB'); await tick();
    reads[0].resolve('AAA'); await tick();
    assert.equal(node('#flName').textContent, 'b.txt');
    assert.equal(node('#flText').value, 'BBB', 'a slower old selection cannot replace the newest file');

    select('a.txt');
    S.sessionDirId = 'second'; go('files'); await tick();
    reads[2].resolve('old project'); await tick();
    assert.equal(node('#flBar').hidden, true, 'an old project response cannot reappear after switching');
    select('b.txt'); reads[3].resolve('new project'); await tick();
    assert.equal(reads[3].project, 'second');
    assert.equal(node('#flText').value, 'new project');

    node('#flDelete').onclick(); node('#flDelete').onclick();
    select('a.txt'); reads[4].resolve('current'); await tick();
    deletes[0].resolve(); await tick();
    assert.equal(node('#flName').textContent, 'a.txt');
    assert.equal(node('#flBar').hidden, false, 'deleting the previous file cannot clear the new selection');

    select('b.txt');
    node('#flText').value = 'edits while loading'; node('#flText').oninput();
    reads[5].resolve('late read'); await tick();
    assert.equal(node('#flName').textContent, 'a.txt');
    assert.equal(node('#flText').value, 'edits while loading', 'a pending read cannot discard newly typed edits');
  } finally {
    for (const [name, value] of Object.entries(globals)) {
      if (value === undefined) delete globalThis[name]; else globalThis[name] = value;
    }
    S.env = null; S.sessionDirId = null;
  }
});
