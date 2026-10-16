import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLocalAgent } from './local-agent.mjs';
import { Tellurium } from './tellurium.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = await mkdtemp(join(tmpdir(), 'mca-agent-lifecycle-'));
const serve = async handler => {
  const server = createServer(handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, baseUrl: 'http://127.0.0.1:' + server.address().port };
};
const frame = (res, delta) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n');
};
try {
  // The loading poll used to swallow aborts and wait as long as five minutes.
  let loadingAsked;
  const loading = new Promise(r => loadingAsked = r);
  const { server, baseUrl } = await serve((req, res) => {
    if (req.url.startsWith('/api/v0/models/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ max_context_length: 32768, state: 'loading' }));
      loadingAsked();
    } else { res.writeHead(404); res.end(); }
  });
  let done;
  const finished = new Promise(r => done = r);
  const run = runLocalAgent({ root, scratch, prompt: 'q', useWorkflow: false,
    chatCfg: { baseUrl, model: 'stub' }, onEvent: e => { if (e.type === 'done') done(); } });
  await loading;
  const started = Date.now();
  run.kill();
  await finished;
  assert.ok(Date.now() - started < 1000, 'Stop must abort the loading poll promptly');
  server.closeAllConnections(); server.close();
  console.log('Stop cancels LM Studio loading detection');

  if (new Tellurium(root).installed) {
    let bodies = [];
    const python = await serve((req, res) => {
      if (!req.url.endsWith('/chat/completions')) { res.writeHead(404); return res.end(); }
      let b = ''; req.on('data', d => b += d);
      req.on('end', () => {
        bodies.push(JSON.parse(b));
        frame(res, bodies.length === 1 ? { tool_calls: [{ index: 0, id: 'run1', type: 'function', function: {
          name: 'run_python', arguments: JSON.stringify({ name: 'failed-script', code: 'import sys\nprint("partial output")\nsys.exit(2)' }),
        } }] } : { content: 'The script failed.' });
      });
    });
    await new Promise(done => runLocalAgent({ root, scratch, prompt: 'q', useWorkflow: false,
      chatCfg: { baseUrl: python.baseUrl, model: 'stub' }, onEvent: e => { if (e.type === 'done') done(); } }));
    const output = bodies[1].messages.find(m => m.tool_call_id === 'run1').content;
    assert.match(output, /partial output/);
    assert.match(output, /\[failed\]/, 'nonzero exit must be visible even when stdout is nonempty');
    python.server.closeAllConnections(); python.server.close();

    const stopped = await serve((req, res) => {
      if (!req.url.endsWith('/chat/completions')) { res.writeHead(404); return res.end(); }
      req.resume(); req.on('end', () => frame(res, { tool_calls: [{ index: 0, id: 'run2', type: 'function', function: {
        name: 'run_python', arguments: JSON.stringify({ name: 'stopped-script', code: 'import time\ntime.sleep(1)\nopen("after-stop.txt", "w").write("bad")' }),
      } }] }));
    });
    const began = Date.now();
    await new Promise(done => {
      const active = runLocalAgent({ root, scratch, prompt: 'q', useWorkflow: false,
        chatCfg: { baseUrl: stopped.baseUrl, model: 'stub' }, onEvent: e => {
          if (e.type === 'tools' && e.tools?.some(t => t.name === 'python')) setTimeout(() => active.kill(), 80);
          if (e.type === 'done') done();
        } });
    });
    assert.ok(Date.now() - began < 1000, 'Stop must terminate Python instead of waiting for it');
    await new Promise(r => setTimeout(r, 1100));
    await assert.rejects(readFile(join(scratch, 'after-stop.txt')));
    stopped.server.closeAllConnections(); stopped.server.close();
    console.log('Python failures preserve exit status and Stop terminates the script');
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
