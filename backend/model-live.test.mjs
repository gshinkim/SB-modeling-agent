/* node backend/model-live.test.mjs
   Boots the real server (on a temp workspace) and a stub model that edits the project's model mid-turn,
   then keeps the turn running. The editor must hear about the edit while the turn
   is still going — it used to only at the very end, so a long local turn, or one
   that was stopped, never showed the AI's edit at all. The editor's own writes
   must not be echoed back. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// realpath: the agent's file tools compare real paths, and macOS's tmpdir is a symlink
const WORK = await realpath(await mkdtemp(join(tmpdir(), 'mca-ws-')));
const PORT = 5196;
const SID = 'test-model-live';
const url = p => `http://127.0.0.1:${PORT}${p}`;
const post = (p, b) => fetch(url(p), { method: 'POST', headers: { 'content-type': 'application/json' },
                                       body: JSON.stringify(b) }).then(r => r.json());
const NEW_MODEL = 'model m()\n  J1: A -> B; k*A;\n  k = 7; A = 1; B = 0;\nend\n';

let step = 0;
const stub = createServer((req, res) => {
  if (!req.url.endsWith('/chat/completions')) { res.writeHead(404); return res.end(); }
  let b = '';
  req.on('data', c => (b += c));
  req.on('end', () => {
    step++;
    const skill = ['mca', 'pathway-modeling', 'tellurium'][step - 1];
    const call = (name, args) => ({ tool_calls: [{ index: 0, id: 'c' + step, type: 'function',
      function: { name, arguments: JSON.stringify(args) } }] });
    const delta = skill ? call('load_skill', { name: skill })
      : step === 4 ? call('write_file', { path: join(WORK, SID, 'model.txt'), content: NEW_MODEL })
      : { content: 'Changed k to 7.' };
    // the answer after the write takes a while, as a real model's does
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n');
    }, step === 5 ? 2000 : 0);
  });
});
await new Promise(r => stub.listen(0, '127.0.0.1', r));

const srv = spawn('node', [join(ROOT, 'backend/server.mjs')],
                  { env: { ...process.env, PORT: String(PORT), MCA_NO_EJECT: '1', MCA_WORKSPACE: WORK }, stdio: 'ignore' });
try {
  for (let i = 0; i < 60; i++) {
    if (await fetch(url('/api/health')).then(() => true).catch(() => false)) break;
    await new Promise(r => setTimeout(r, 150));
  }
  await post('/api/sessions/save', { id: SID, name: SID, chats: [], settings: {},
                                     model: 'model m()\n  J1: A -> B; k*A;\n  k = 1; A = 1; B = 0;\nend\n' });

  const res = await fetch(url('/api/chat'), { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'set k to 7', sessionDirId: SID, runtime: 'openai', useWorkflow: false,
      chatCfg: { baseUrl: 'http://127.0.0.1:' + stub.address().port, model: 'stub' } }) });
  const events = [];
  const rd = res.body.getReader(), dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await rd.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      for (const line of frame.split('\n'))
        if (line.startsWith('data:')) try { events.push(JSON.parse(line.slice(5))); } catch {}
    }
    // editing from the editor mid-turn must not come back as an AI edit
    if (events.some(e => e.type === 'model_changed') && !events.editorWrote) {
      events.editorWrote = true;
      await fetch(url('/api/model'), { method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ src: NEW_MODEL.replace('k = 7', 'k = 8'), project: SID }) });
    }
  }

  const changed = events.findIndex(e => e.type === 'model_changed');
  const result = events.findIndex(e => e.type === 'result');
  assert.ok(changed >= 0, 'the editor heard about the edit');
  assert.equal(events[changed].src, NEW_MODEL);
  assert.ok(changed < result, 'it arrived while the turn was still running, not at its end');
  assert.equal(events.filter(e => e.type === 'model_changed').length, 1,
               "the editor's own write was not echoed back");
  console.log('model edits reach the editor mid-turn ok');
} finally {
  srv.kill(); stub.close();
  await rm(WORK, { recursive: true, force: true });
}
