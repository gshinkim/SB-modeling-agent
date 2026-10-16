import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tellurium, VENV_PY } from './tellurium.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const te = new Tellurium(root);
if (!te.installed) console.log('scientific tests skipped: Tellurium is not installed');
else {
  const exec = promisify(execFile);
  const result = await exec(join(root, VENV_PY), [join(root, 'backend/py/te_worker_test.py')], { timeout: 30000 });
  assert.match(result.stderr, /OK/);
  const replies = await new Promise((resolve, reject) => {
    const p = spawn(join(root, VENV_PY), [join(root, 'backend/py/te_worker.py')], { timeout: 10000 });
    let output = '';
    p.stdout.on('data', d => output += d);
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve(output.trim().split('\n').map(JSON.parse))
      : reject(new Error('worker exited ' + code)));
    p.stdin.end('null\n[]\n{"id":1,"op":"version"}\n');
  });
  assert.equal(replies.length, 3);
  assert.equal(replies[0].ok, false);
  assert.equal(replies[1].ok, false);
  assert.equal(replies[2].ok, true, 'malformed requests must not kill the warm worker');
  console.log(result.stderr.trim());
  console.log('worker rejects non-object JSON and continues serving requests');
}
