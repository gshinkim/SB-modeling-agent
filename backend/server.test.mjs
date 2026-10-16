/* HTTP validation and hosted/local isolation. Every process uses a temp workspace;
   no test starts or ejects a model, or changes the user's files or settings. */
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'mca-server-test-'));

async function start(hosted = false) {
  const reserve = createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const work = await mkdtemp(join(temp, hosted ? 'hosted-' : 'local-'));
  await writeFile(join(work, 'model.txt'), 'private local model');
  await writeFile(join(work, 'settings.json'), JSON.stringify({ start: 3, end: 4, apiKey: 'private-local-key' }));
  const proc = spawn(process.execPath, [join(ROOT, 'backend/server.mjs')], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), MCA_WORKSPACE: work,
      MCA_NO_EJECT: '1', MCA_HOSTED: hosted ? '1' : '0' }, stdio: 'ignore',
  });
  const base = 'http://127.0.0.1:' + port;
  try {
    for (let i = 0; i < 100; i++) {
      if (await fetch(base + '/api/health').then(r => r.ok, () => false)) return { proc, base, port, work };
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('server did not start');
  } catch (e) { proc.kill(); throw e; }
}

async function stop(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise(resolve => { proc.once('exit', resolve); proc.kill(); });
}

const raw = (port, path, headers) => new Promise((resolve, reject) => {
  const req = request({ hostname: '127.0.0.1', port, path, method: 'GET', headers }, res => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
  });
  req.on('error', reject); req.end();
});

let local, hosted;
try {
  local = await start();
  const post = (path, body, headers = {}) => fetch(local.base + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body,
  });
  for (const body of ['{broken', 'null', '[]', '42', '"text"']) {
    const res = await post('/api/latex', body);
    assert.equal(res.status, 400, 'malformed/non-object JSON is a caller error');
    assert.ok((await res.json()).error);
  }
  const large = await post('/api/latex', JSON.stringify({ src: 'x'.repeat(200_001) }));
  assert.equal(large.status, 413, 'oversized payload gets an HTTP response without destroying its socket');
  assert.equal((await large.json()).error, 'payload too large');
  for (const path of ['/api/simulate', '/api/info'])
    assert.equal((await post(path, '{"model":42}')).status, 400);
  assert.equal((await post('/api/latex', '{"src":42}')).status, 400);
  assert.equal((await post('/api/chat', '{"message":42}')).status, 400);

  // Browser-simple POSTs can carry JSON using text/plain. Their Origin must be
  // checked before a route with local side effects is even entered.
  for (const path of ['/api/chat', '/api/local/eject', '/api/local/start', '/api/scratch']) {
    const denied = await post(path, '{}', { 'content-type': 'text/plain', origin: 'https://foreign.example' });
    assert.equal(denied.status, 403, path + ' refuses a foreign browser origin');
  }
  const same = await post('/api/chat', '{"message":""}', { origin: local.base });
  assert.equal(same.status, 400, 'same-origin request reaches validation');
  assert.equal((await raw(local.port, '/api/model', { host: 'rebind.example:' + local.port })).status, 403,
    'untrusted Host is refused even without Origin');
  assert.equal((await fetch(local.base + '/api/model')).status, 200, 'CLI without Origin still works');
  assert.equal((await fetch(local.base + '/api/model', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);

  hosted = await start(true);
  assert.deepEqual(await fetch(hosted.base + '/api/model?project=anything').then(r => r.json()), { src: '' },
    'hosted readers cannot see a saved local draft');
  assert.deepEqual(await fetch(hosted.base + '/api/settings').then(r => r.json()), { start: 0, end: 100, points: 50 },
    'hosted readers cannot see saved settings or keys');
  assert.equal((await raw(hosted.port, '/api/model', { host: 'public.example' })).status, 200,
    'hosted mode permits public proxy Host headers');
  console.log('server HTTP validation and isolation ok');
} finally {
  if (local) await stop(local.proc);
  if (hosted) await stop(hosted.proc);
  await rm(temp, { recursive: true, force: true });
}
