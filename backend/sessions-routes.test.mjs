/* node backend/sessions-routes.test.mjs
   Boots the real server on a spare port against the real workspace, exercises the
   four session routes over HTTP, then puts the workspace back exactly as it was. */
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORK = join(ROOT, 'workspace');
const PORT = 5199;
const url = p => `http://127.0.0.1:${PORT}${p}`;
const post = (p, b) => fetch(url(p), { method: 'POST', headers: { 'content-type': 'application/json' },
                                       body: JSON.stringify(b) }).then(r => r.json());

const beforeModel = await readFile(join(WORK, 'model.txt'), 'utf8').catch(() => '');
const beforeSettings = await readFile(join(WORK, 'settings.json'), 'utf8').catch(() => '');

const srv = spawn('node', [join(ROOT, 'backend/server.mjs')],
                  { env: { ...process.env, PORT: String(PORT), MCA_NO_EJECT: '1' }, stdio: 'ignore' });
const up = async () => { for (let i = 0; i < 60; i++) {
  if (await fetch(url('/api/health')).then(() => true).catch(() => false)) return;
  await new Promise(r => setTimeout(r, 150)); } throw new Error('server never came up'); };

try {
  await up();

  // name slugs to exactly 'test-abc' so saveSession's rename-on-name-change path
  // (tested separately in sessions.test.mjs) does not fire and move the folder
  await post('/api/sessions/save', { id: 'test-abc', name: 'test abc',
    chats: [{ id: 1, title: 'hello', log: [], history: [] }],
    settings: { start: 0, end: 7, points: 11 }, model: 'A -> B; k*A' });

  const list = await fetch(url('/api/sessions')).then(r => r.json());
  assert.ok(list.sessions.some(s => s.id === 'test-abc'), 'saved session is listed');

  // a project's model lives in its own folder: the default model moving on does not
  // touch it, and opening the project does not copy it over the default one
  const put = (src, project) => fetch(url('/api/model'), { method: 'PUT',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ src, project }) });
  await put('something else entirely');
  const opened = await post('/api/sessions/open', { id: 'test-abc' });
  assert.equal(opened.model, 'A -> B; k*A');
  assert.equal(opened.settings.points, 11);
  assert.equal(opened.chats[0].title, 'hello');
  assert.equal(await readFile(join(WORK, 'model.txt'), 'utf8'), 'something else entirely',
               'opening a project leaves the default model alone');

  // editor saves for the project land in the project's model.txt, and read back from it
  await put('A -> B; 2*k*A', 'test-abc');
  assert.equal(await readFile(join(WORK, 'test-abc/model.txt'), 'utf8'), 'A -> B; 2*k*A');
  assert.equal((await fetch(url('/api/model?project=test-abc')).then(r => r.json())).src, 'A -> B; 2*k*A');
  assert.equal((await fetch(url('/api/model')).then(r => r.json())).src, 'something else entirely');

  // an autosave carrying a stale editor copy must not undo an edit made in place
  await post('/api/sessions/save', { id: 'test-abc', name: 'test abc', chats: [],
    settings: { start: 0, end: 7, points: 11 }, model: 'A -> B; k*A' });
  assert.equal(await readFile(join(WORK, 'test-abc/model.txt'), 'utf8'), 'A -> B; 2*k*A',
               'save does not overwrite the project model');

  const bad = await post('/api/sessions/delete', { id: '../..' });
  assert.ok(bad.error, 'traversal is refused');
  assert.ok((await post('/api/sessions/delete', { id: 'runs' })).error, 'runs/ is not a project');

  // the router's Test button: an empty key is refused before any network call
  assert.deepEqual(await post('/api/router/test', { key: '' }), { ok: false, error: 'the key is empty' });

  await post('/api/sessions/delete', { id: 'test-abc' });
  const after = await fetch(url('/api/sessions')).then(r => r.json());
  assert.ok(!after.sessions.some(s => s.id === 'test-abc'), 'deleted session is gone');
} finally {
  srv.kill();
  await rm(join(WORK, 'test-abc'), { recursive: true, force: true });
  await writeFile(join(WORK, 'model.txt'), beforeModel);   // also when it was empty: a new project's model is
  if (beforeSettings) await writeFile(join(WORK, 'settings.json'), beforeSettings);
}

console.log('session routes ok');
