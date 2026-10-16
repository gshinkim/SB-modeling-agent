/* node backend/agent-events.test.mjs
   toUiEvent: the Claude CLI's stream-json -> the event shapes the UI renders. */
import assert from 'node:assert/strict';
import { toUiEvent, runAgent } from './agent.mjs';

const msg = (type, ...content) => ({ type, message: { content } });
for (const [raw, want] of [
  [{ type: 'done', code: 0, sessionId: 's' }, { type: 'done', code: 0, sessionId: 's' }],
  [{ type: 'stderr', text: 'x' }, { type: 'stderr', text: 'x' }],
  [{ type: 'system', subtype: 'init', model: 'm', tools: ['Read'], agents: ['a'], session_id: 's' },
   { type: 'init', model: 'm', tools: ['Read'], agents: ['a'], sessionId: 's' }],
  [{ type: 'system', subtype: 'other' }, null],
  [{ type: 'system', subtype: 'task_progress', description: 'MCA frame: mca:frame', last_tool_name: 'mca:frame' },
   { type: 'phase', phase: 'MCA frame', label: 'mca:frame' }],
  [{ type: 'system', subtype: 'task_progress', description: 'Run a script', last_tool_name: 'Bash' }, null],
  [{ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'hi' } } }, { type: 'delta', text: 'hi' }],
  [{ type: 'stream_event', event: { delta: { type: 'thinking_delta', thinking: 'hm' } } }, { type: 'thinking', text: 'hm' }],
  [{ type: 'stream_event', event: { type: 'message_stop' } }, null],
  [msg('assistant', { type: 'tool_use', name: 'Read', input: { a: 1 } }),
   { type: 'tools', tools: [{ name: 'Read', input: { a: 1 } }] }],
  [msg('assistant', { type: 'thinking', thinking: 'why' }, { type: 'tool_use', name: 'Read', input: {} }),
   { type: 'thinking', text: 'why', whole: true, tools: [{ name: 'Read', input: {} }] }],
  [msg('assistant', { type: 'text', text: 'already streamed' }), null],
  [msg('user', { type: 'tool_result', is_error: true }), { type: 'tool_result', isError: true }],
  [msg('user', { type: 'text', text: 'x' }), null],
  [{ type: 'result', result: 'ans', is_error: false, duration_ms: 5, total_cost_usd: 0.1, num_turns: 2 },
   { type: 'result', text: 'ans', isError: false, ms: 5, cost: 0.1, turns: 2 }],
  [{ type: 'rate_limit_event' }, null],
]) assert.deepEqual(toUiEvent(raw), want, JSON.stringify(raw));

{
  // A Skill the router puts in the prompt is loaded all the same, and must show as one:
  // the CLI is told not to load it again, so no Skill tool call will ever announce it.
  const seen = [];
  await new Promise(done => {
    const run = runAgent({ root: process.cwd(), prompt: 'q',
      router: async () => ({ ms: 1, hint: [], auto: [['mca', 0.9]] }),
      onEvent: ev => { seen.push(ev); if (ev.type === 'log') run.kill();    // stop before the CLI starts
                       if (ev.type === 'done') done(); } });
  });
  assert.deepEqual(seen.find(e => e.type === 'tools'),
    { type: 'tools', tools: [{ name: 'load_skill', input: { name: 'mca', by: 'router' } }] });
  assert.deepEqual(seen.find(e => e.type === 'session'), { type: 'session', sessionId: null },
    'a stopped route must not leave an id the CLI never created');
}
console.log('agent-events.test.mjs ok');
