/* node --test backend/scratch.test.mjs
   Pointing the AI at a folder has to mean its work actually lands there: the script
   it runs, the cwd it runs in, and anything that script writes by a relative path. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLocalAgent } from './local-agent.mjs';
import { scratchBlock } from './agent.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = await mkdtemp(join(tmpdir(), 'mca-scratch-'));

/* A model that loads the three Skills (every turn must), runs one script writing a
   file by a relative path, then answers. */
let turn = 0;
const call = (name, args) => ({ tool_calls: [{ index: 0, id: 'c' + turn, type: 'function',
  function: { name, arguments: JSON.stringify(args) } }] });
const srv = createServer((req, res) => {
  // like any non-Ollama server: the context probe (/api/ps, /api/show) gets a 404
  if (!req.url.endsWith("/chat/completions")) { res.writeHead(404); return res.end(); }
  let b = '';
  req.on('data', c => (b += c));
  req.on('end', () => {
    const withTools = (JSON.parse(b).tools ?? []).length > 0;
    const t = withTools ? turn++ : 99;
    const delta = t < 3 ? call('load_skill', { name: ['mca', 'pathway-modeling', 'tellurium'][t] })
      : t === 3 ? call('read_file', { path: 'skills/tellurium/references/simulation.md' })   // run_python is gated on a read
      : t === 4 ? call('run_python', { code:
            "open('result.txt','w').write('from the scratch dir')\nprint('done')" })
      : { content: 'Ran it.' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n');
  });
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));

const events = [];
await new Promise(done => {
  runLocalAgent({ root: ROOT, prompt: 'go', scratch,
    chatCfg: { baseUrl: 'http://127.0.0.1:' + srv.address().port, model: 'stub' },
    onEvent: e => { events.push(e); if (e.type === 'done') done(); } });
});
srv.close();

const left = await readdir(scratch);

// the script itself
assert.ok(left.some(f => f.endsWith('.py')), 'the script is kept in the chosen folder, got: ' + left);
// and what the script wrote by a bare relative path, which proves cwd moved too
assert.ok(left.includes('result.txt'),
  'a relative write from the script lands in the chosen folder, got: ' + left);
assert.equal(await readFile(join(scratch, 'result.txt'), 'utf8'), 'from the scratch dir');

// nothing leaked into the install's own scratch
const runs = await readdir(join(ROOT, 'workspace/runs')).catch(() => []);
assert.ok(!runs.includes('result.txt'), 'the default folder stays untouched when one is chosen');
console.log('local agent writes into the chosen folder ok (' + left.join(', ') + ')');

/* The Claude Code path cannot be spawned in a test, but the instruction it is given
   is the thing that decides where that agent writes, so assert on that. */
{
  const b = scratchBlock('/some/where');
  assert.ok(b.includes('/some/where'), 'the folder is named in the system prompt');
  assert.match(b, /workspace\/model\.txt/, 'the live model is still edited in place');
}
console.log('claude-code prompt names the folder ok');

await rm(scratch, { recursive: true, force: true });
console.log('scratch.test.mjs ok');
