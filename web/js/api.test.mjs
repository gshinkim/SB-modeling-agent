import assert from 'node:assert/strict';
import test from 'node:test';
import { chat } from './api.mjs';

test('chat transport ends the turn when the initial fetch fails', async () => {
  const original = globalThis.fetch, events = [];
  globalThis.fetch = async () => { throw new Error('connection lost'); };
  try {
    await new Promise(resolve => chat({}, event => { events.push(event); if(event.type === 'done') resolve(); }));
    assert.deepEqual(events, [{ type: 'fatal', error: 'connection lost' }, { type: 'done', code: 1 }]);
  } finally { globalThis.fetch = original; }
});

test('chat transport parses CRLF frames and the last event without a separator', async () => {
  const original = globalThis.fetch, events = [], enc = new TextEncoder();
  const chunks = ['data: {"type":"delta","text":"a"}\r', '\n\r\n', 'data: {"type":"result","text":"answer"}'];
  globalThis.fetch = async () => ({ ok: true, status: 200, body: { getReader: () => ({
    read: async () => chunks.length ? { done: false, value: enc.encode(chunks.shift()) } : { done: true },
  }) } });
  try {
    await new Promise(resolve => chat({}, event => { events.push(event); if(event.type === 'closed') resolve(); }));
    assert.deepEqual(events, [{ type: 'delta', text: 'a' }, { type: 'result', text: 'answer' }, { type: 'closed' }]);
  } finally { globalThis.fetch = original; }
});
