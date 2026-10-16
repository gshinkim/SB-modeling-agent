import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Tellurium } from './tellurium.mjs';

const root = await mkdtemp(join(tmpdir(), 'mca-worker-'));
const workerSource = `import readline from 'node:readline';
readline.createInterface({ input: process.stdin }).on('line', line => {
  const q = JSON.parse(line);
  if (q.op === 'hang') return;
  console.log(JSON.stringify({ id: q.id, ok: true, result: { version: 'test', op: q.op } }));
});`;
const script = join(root, 'worker.mjs');
await writeFile(script, workerSource);
const te = new Tellurium(root, { python: process.execPath, script, name: 'Test' });
try {
  assert.equal((await te.call('echo')).result.op, 'echo');
  const hanging = te.call('hang', {}, 50);
  const waiting = te.call('hang', {}, 5000);
  const [first, second] = await Promise.all([hanging, waiting]);
  assert.match(first.error, /timed out/);
  assert.match(second.error, /stopped/);
  // Restart immediately, before the old process's close callback runs.
  assert.equal((await te.call('echo')).result.op, 'echo');

  const badPython = join(root, 'no-execute');
  await writeFile(badPython, '#!/bin/sh\nexit 1\n');
  await chmod(badPython, 0o600);
  const broken = new Tellurium(root, { python: badPython, script, name: 'Test' });
  const started = Date.now();
  assert.match((await broken.call('echo', {}, 5000)).error, /could not start/);
  assert.ok(Date.now() - started < 1500, 'spawn errors must be returned promptly');
  let requests = 0;
  broken.call = async () => ++requests === 1
    ? { ok: false, error: 'temporary failure' } : { ok: true, result: { version: 'recovered' } };
  assert.deepEqual(await broken.versions(), { error: 'temporary failure' });
  assert.deepEqual(await broken.versions(), { version: 'recovered' });
  assert.deepEqual(await broken.versions(), { version: 'recovered' });
  assert.equal(requests, 2);
  console.log('Tellurium worker failure, timeout, restart and version recovery ok');
} finally {
  te.proc?.kill();
  await rm(root, { recursive: true, force: true });
}
