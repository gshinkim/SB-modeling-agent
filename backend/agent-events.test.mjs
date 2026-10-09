/* node backend/agent-events.test.mjs
   toUiEvent: the Claude CLI's stream-json -> the event shapes the UI renders. */
import assert from 'node:assert/strict';
import { toUiEvent } from './agent.mjs';

const msg = (type, ...content) => ({ type, message: { content } });
for (const [raw, want] of [
  [{ type: 'done', code: 0, sessionId: 's' }, { type: 'done', code: 0, sessionId: 's' }],
  [{ type: 'stderr', text: 'x' }, { type: 'stderr', text: 'x' }],
  [{ type: 'system', subtype: 'init', model: 'm', tools: ['Read'], agents: ['a'], session_id: 's' },
   { type: 'init', model: 'm', tools: ['Read'], agents: ['a'], sessionId: 's' }],
  [{ type: 'system', subtype: 'other' }, null],
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
console.log('agent-events.test.mjs ok');
