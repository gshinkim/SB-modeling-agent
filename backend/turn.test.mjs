/* node backend/turn.test.mjs
   runTurn with a fake runtime in a temp project folder — no HTTP, no port, no
   workspace/. Pins the ordering /api/chat depends on. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTurn } from './turn.mjs';

const root = await mkdtemp(join(tmpdir(), 'turn-'));
const mfile = join(root, 'model.txt'), hfile = join(root, 'history.md');
await writeFile(join(root, 'session.json'), '{}');   // appendHistory only writes into a real project
await writeFile(mfile, 'old');

// one turn: resolves with the events and whether history.md was on disk when `end` ran
const turn = (message, agent, then = () => {}) => new Promise(ok => {
  const events = [];
  const stop = runTurn({ root, sdir: root, mfile, scratch: root, message, runtime: 'openai', agent,
    args: { sessionId: 'given' }, compact: async () => '', editorEcho: () => false,
    emit: e => events.push(e),
    end: async () => ok({ events, history: await readFile(hfile, 'utf8').catch(() => '') }) });
  then(stop);
});
const types = r => r.events.map(e => e.type);

/* 1. A turn that edits the model: events in the runtime's order, the edit shown before
      the result that reports it, and history on disk before the stream is ended. */
let got;
const answered = await turn('first question', a => {
  got = a;
  (async () => {
    a.onEvent({ type: 'thinking', text: 'hmm' });
    a.onEvent({ type: 'delta', text: 'partial' });
    await writeFile(mfile, 'new');
    a.onEvent({ type: 'result', text: 'final answer' });
    a.onEvent({ type: 'done', code: 0 });
  })();
  return { kill() {} };
});
assert.deepEqual(types(answered).filter(t => t !== 'model_changed'), ['session', 'thinking', 'delta', 'result', 'done']);
assert.deepEqual(answered.events[0], { type: 'session', sessionId: 'given', runtime: 'openai' });
const changed = answered.events.findIndex(e => e.type === 'model_changed');
assert.ok(changed > 0 && changed < types(answered).indexOf('result'), 'model_changed precedes result');
assert.equal(answered.events[changed].src, 'new');
assert.match(answered.history, /first question/);
assert.match(answered.history, /hmm/);
assert.match(answered.history, /final answer/);          // the result replaces the streamed deltas
assert.doesNotMatch(answered.history, /partial/);
assert.equal(got.liveModel, 'old');
assert.equal(got.summary, '');
assert.ok(got.prompt.startsWith('first question'));
console.log('turn order ok');

/* 2. Stopped mid-turn: the runtime ends with 'done' when killed, and what had streamed
      is still written to history — and is the next turn's memory. */
const stopped = await turn('second question', a => {
  a.onEvent({ type: 'delta', text: 'half an ans' });
  return { kill: () => a.onEvent({ type: 'done', code: null }) };
}, stop => setTimeout(stop, 20));
assert.deepEqual(types(stopped), ['session', 'delta', 'done']);
assert.match(stopped.history, /second question/);
assert.match(stopped.history, /half an ans/);
await turn('third', a => { got = a; a.onEvent({ type: 'done', code: 0 }); return { kill() {} }; });
assert.match(got.summary, /half an ans/);
console.log('stop mid-turn writes history ok');

/* 3. Stopped before the agent starts (the client left during the awaits): no agent, no history. */
const before = await readFile(hfile, 'utf8');
let started = false;
runTurn({ root, sdir: root, mfile, scratch: root, message: 'never', runtime: 'openai',
  agent: () => { started = true; return { kill() {} }; }, args: {}, compact: async () => '',
  editorEcho: () => false, emit: () => assert.fail('no events'), end: () => assert.fail('no end') })();
await new Promise(r => setTimeout(r, 50));
assert.equal(started, false);
assert.equal(await readFile(hfile, 'utf8'), before);
console.log('stop before start ok');

await rm(root, { recursive: true, force: true });
console.log('turn.test.mjs ok');
