/* node --test backend/token-cap.test.mjs
   The bug this covers: a reasoning model spent its whole max_tokens budget inside
   the thinking block, came back finish_reason "length" with empty content, and the
   turn ended with "(the model produced no final answer)". Raising the context
   setting to 20000 changed nothing, because the cap was a hardcoded 4096 rather
   than anything derived from the window. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Chat } from './local-agent.mjs';

/** A stub that records what was asked of it and replays scripted turns. */
function stub(turns) {
  const seen = [];
  const srv = createServer((req, res) => {
    // like any server that is not LM Studio or Ollama: the context probes get a 404
    if (!req.url.endsWith('/chat/completions')) { res.writeHead(404); return res.end(); }
    let b = '';
    req.on('data', c => (b += c));
    req.on('end', () => {
      seen.push(JSON.parse(b));
      const t = turns[Math.min(seen.length - 1, turns.length - 1)];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({
        choices: [{ delta: t.delta ?? {}, finish_reason: t.finish ?? 'stop' }] }) +
        '\n\ndata: [DONE]\n\n');
    });
  });
  return { srv, seen, url: () => 'http://127.0.0.1:' + srv.address().port };
}

const listen = s => new Promise(r => s.listen(0, '127.0.0.1', r));

/* ---- the cap must track the window the model was actually loaded with ---- */
{
  const s = stub([{ delta: { content: 'hi' } }]);
  await listen(s.srv);
  await new Chat({ baseUrl: s.url(), model: 'stub', contextTokens: 20000 })
    .complete({ messages: [{ role: 'user', content: 'q' }] });
  const cap = s.seen[0].max_tokens;
  assert.ok(cap > 4096, `cap should scale past the old 4096 literal, got ${cap}`);
  assert.equal(cap, 10000, 'half of a 20000 window');
  s.srv.close();
  console.log('cap scales with context ok (' + cap + ')');
}

/* The prompt budget and the reply must fit the same window together. The old code
   asked for a 7168-token prompt plus 4096 of reply inside an 8192 window. */
{
  const s = stub([{ delta: { content: 'hi' } }]);
  await listen(s.srv);
  await new Chat({ baseUrl: s.url(), model: 'stub', contextTokens: 8192 })
    .complete({ messages: [{ role: 'user', content: 'q' }] });
  assert.ok(s.seen[0].max_tokens <= 8192 / 2, 'reply may not claim the whole window');
  s.srv.close();
  console.log('prompt and reply share the window ok');
}

/* ---- cut off mid-thought: ask again for the answer instead of giving up ---- */
{
  const s = stub([
    // all budget burned inside the scratchpad, nothing visible
    { delta: { reasoning: 'thinking'.repeat(50) }, finish: 'length' },
    { delta: { content: 'The control coefficients are zero because the flux is fixed.' } },
  ]);
  await listen(s.srv);
  const m = await new Chat({ baseUrl: s.url(), model: 'stub', contextTokens: 8192 })
    .complete({ messages: [{ role: 'user', content: 'why zero?' }] });
  assert.equal(s.seen.length, 2, 'a truncated, empty answer must be retried once');
  assert.match(m.content, /control coefficients are zero/);
  assert.ok(!/produced no final answer/.test(m.content));
  s.srv.close();
  console.log('empty length-truncation retried ok');
}

/* A retry that also says nothing must not discard the first reply. */
{
  const s = stub([
    { delta: { content: 'partial answer' }, finish: 'length' },
    { delta: {} },
  ]);
  await listen(s.srv);
  const m = await new Chat({ baseUrl: s.url(), model: 'stub', contextTokens: 8192 })
    .complete({ messages: [{ role: 'user', content: 'q' }] });
  assert.equal(s.seen.length, 1, 'a truncated answer with content is kept, not retried');
  assert.equal(m.content, 'partial answer');
  s.srv.close();
  console.log('partial answer preserved ok');
}

/* Tools withdrawn, and the model calls one anyway (Ollama parses a written
   <tool_call> into tool_calls regardless): the call is not handed back to be
   run — every loop used to run it and end on "no final answer" — and the model
   is asked once for prose instead. */
{
  const s = stub([
    { delta: { tool_calls: [{ index: 0, id: 'x', type: 'function',
        function: { name: 'run_python', arguments: '{"code":"print(1)"}' } }] }, finish: 'tool_calls' },
    { delta: { content: 'Here is what I found.' } },
  ]);
  await listen(s.srv);
  const m = await new Chat({ baseUrl: s.url(), model: 'stub', contextTokens: 8192 })
    .complete({ messages: [{ role: 'user', content: 'q' }] });
  assert.equal(s.seen.length, 2, 'asked again for prose');
  assert.match(s.seen[1].messages.at(-1).content, /Tools are closed/);
  assert.equal(m.tool_calls, undefined);
  assert.equal(m.content, 'Here is what I found.');
  s.srv.close();
  console.log('call after tools closed -> prose ok');
}

/* LM Studio with the model not loaded: load it ourselves, at the model's maximum,
   instead of letting the chat request JIT-load it at 8192 (measured: HTTP 400 on the
   first Skill load, every turn). Halving on a refusal and reading back the window
   LM Studio really gave are in local-agent.test.mjs. */
{
  const seen = [], loads = [];
  const srv = createServer((req, res) => {
    let b = '';
    req.on('data', c => (b += c));
    req.on('end', () => {
      const j = b ? JSON.parse(b) : {};
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/api/v0/models/qm')
        return res.end(JSON.stringify({ id: 'qm', state: 'not-loaded', max_context_length: 262144 }));
      if (req.url === '/api/v1/models/load') { loads.push(j); return res.end(JSON.stringify({ status: 'loaded' })); }
      if (!req.url.endsWith('/chat/completions')) return res.end('{"error":"Unexpected endpoint"}');
      seen.push(j);
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await listen(srv);
  const chat = new Chat({ baseUrl: 'http://127.0.0.1:' + srv.address().port, model: 'qm' });
  await chat.complete({ messages: [{ role: 'user', content: 'q' }] });
  assert.deepEqual(loads, [{ model: 'qm', context_length: 262144 }]);
  assert.equal(chat.ctx, 262144);
  assert.equal(seen[0].max_tokens, 131072);
  srv.close();
  console.log('LM Studio model loaded at a usable context ok');
}

console.log('token-cap.test.mjs ok');
