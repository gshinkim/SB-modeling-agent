/* node --test backend/live-routes.test.mjs
   Over real HTTP, against a stub model: a turn survives the browser closing its
   connection, a page that comes back is sent the whole turn, and Stop is a request. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5195, url = p => `http://127.0.0.1:${PORT}${p}`;
const tmp = await mkdtemp(join(tmpdir(), 'live-'));

// the model answers only when let go, so the test can leave mid-turn
let release = () => {}, asked = 0;
const stub = createServer((req, res) => {
  if (!req.url.endsWith('/chat/completions')) { res.writeHead(404); return res.end(); }
  req.resume(); asked++;
  release = () => { res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'the answer' } }] }) + '\n\ndata: [DONE]\n\n'); };
});
await new Promise(r => stub.listen(0, '127.0.0.1', r));
const srv = spawn('node', [join(ROOT, 'backend/server.mjs')],
                  { env: { ...process.env, PORT: String(PORT), MCA_NO_EJECT: '1' }, stdio: 'ignore' });
const until = async (ok, what) => { for (let i = 0; i < 200; i++) { if (await ok()) return; await new Promise(r => setTimeout(r, 50)); } throw new Error('timed out: ' + what); };
const events = async res => (await res.text()).split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
const ask = (message, signal) => fetch(url('/api/chat'), { method: 'POST', signal, headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ message, chat: 7, runtime: 'openai', useWorkflow: false, scratchDir: tmp,
                         chatCfg: { baseUrl: 'http://127.0.0.1:' + stub.address().port, model: 'stub' } }) });
try {
  await until(() => fetch(url('/api/env')).then(r => r.ok, () => false), 'server start');
  assert.equal((await fetch(url('/api/chat/live?project='))).status, 204, 'no turn yet');

  // the page starts a turn, then closes
  const page = new AbortController();
  const first = await ask('hello', page.signal);
  await until(() => asked === 1, 'the model being asked');
  page.abort(); await first.body?.cancel().catch(() => {});
  await new Promise(r => setTimeout(r, 300));

  // it comes back: told what was asked, then follows the turn to its end
  const back = await fetch(url('/api/chat/live?project='));
  assert.equal(back.status, 200, 'the turn is still there after the page closed');
  release();
  const got = await events(back);
  assert.deepEqual({ type: got[0].type, q: got[0].q, chat: got[0].chat }, { type: 'live', q: 'hello', chat: 7 });
  assert.equal(got.find(e => e.type === 'result')?.text, 'the answer', 'the model was never stopped');
  assert.ok(got.some(e => e.type === 'done'));
  assert.equal((await fetch(url('/api/chat/live?project='))).status, 204, 'shown in full, so forgotten');

  // Stop is a request
  const second = await ask('again');
  await until(() => asked === 2, 'the second turn asking the model');
  await fetch(url('/api/chat/stop'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"project":""}' });
  const ended = await events(second);
  assert.ok(ended.some(e => e.type === 'done'), 'the stopped turn ends itself');
  assert.ok(!ended.some(e => e.type === 'result' && e.text === 'the answer'));
  console.log('live-routes.test.mjs ok');
} finally {
  srv.kill(); stub.closeAllConnections?.(); stub.close();
  await rm(tmp, { recursive: true, force: true });
}
