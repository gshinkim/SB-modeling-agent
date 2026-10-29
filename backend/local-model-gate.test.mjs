import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLocalAgent } from './local-agent.mjs';

const root = await mkdtemp(join(tmpdir(), 'local-model-gate-'));
const model = join(root, 'workspace/model.txt'), scratch = join(root, 'work');
const reference = 'skills/pathway-modeling/references/02_kinetics_in_a_nutshell.md';
await mkdir(join(root, 'skills/pathway-modeling/references'), { recursive: true });
await mkdir(join(root, 'workspace')); await mkdir(scratch);
await writeFile(join(root, 'skills/pathway-modeling/SKILL.md'), '---\nname: pathway-modeling\n---\nRead references/02_kinetics_in_a_nutshell.md for rate laws.');
await writeFile(join(root, reference), 'Read the kinetic assumptions before changing the model.');
await symlink(model, join(scratch, 'model-alias.txt'));

const load = ['load_skill', { name: 'pathway-modeling' }];
const read = ['read_file', { path: reference }];
const write = path => ['write_file', { path, content: 'new model' }];
const run = async (calls, te) => {
  await writeFile(model, 'old model');
  const bodies = [];
  const server = createServer((req, res) => {
    if (!req.url.endsWith('/chat/completions')) { res.writeHead(404); return res.end(); }
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => {
      bodies.push(JSON.parse(body));
      const call = calls[bodies.length - 1];
      const delta = call ? { tool_calls: [{ index: 0, id: 'c' + bodies.length, type: 'function',
        function: { name: call[0], arguments: JSON.stringify(call[1]) } }] } : { content: 'done' };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    await new Promise(done => runLocalAgent({ root, scratch, prompt: 'change model', te,
      chatCfg: { model: 'stub', baseUrl: 'http://127.0.0.1:' + server.address().port },
      onEvent: e => { if (e.type === 'done') done(); } }));
    return bodies.at(-1).messages.filter(m => m.role === 'tool').at(-1).content;
  } finally { server.closeAllConnections(); server.close(); }
};
try {
  for (const calls of [
    [write('/workspace/model.txt')],
    [load, write('/workspace/model.txt')],
    [load, ['read_file', { path: 'skills/pathway-modeling/SKILL.md' }], write('/workspace/model.txt')],
    [load, ['read_file', { path: reference + '-missing.md' }], write('/workspace/model.txt')],
    [load, ['read_file', { path: reference, offset: 1e6 }], write('/workspace/model.txt')],
    [load, write(join(scratch, 'model-alias.txt'))],
  ]) {
    assert.match(await run(calls), /^REFUSED/);
    assert.equal(await readFile(model, 'utf8'), 'old model');
  }
  assert.match(await run([load, read, write('/workspace/model.txt')]), /^wrote /);
  assert.equal(await readFile(model, 'utf8'), 'new model');

  // A symlink alias also passes through Antimony validation once the Skill gate is satisfied.
  let validated = false;
  const te = { call: async () => { validated = true; return { ok: false, error: 'invalid Antimony' }; } };
  assert.match(await run([load, read, write(join(scratch, 'model-alias.txt'))], te), /^REJECTED/);
  assert.ok(validated);
  assert.equal(await readFile(model, 'utf8'), 'old model');
  console.log('local model gate requires successful reference use and protects slash/symlink aliases');
} finally { await rm(root, { recursive: true, force: true }); }
