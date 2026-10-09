/* node web/js/turn.test.mjs
   No DOM: feeds a turn the events a runtime emits and pins the state send() paints,
   and what the turn writes to the chat's log and history when it ends. */
import assert from 'node:assert/strict';
import { newTurn } from './turn.mjs';

const chat = () => ({ history: [], log: [], sessionId: null });
const run = (events, c = chat(), q = 'q') => {
  const t = newTurn(q, c);
  for(const ev of events) t.feed(ev);
  return { t, c };
};

{
  // text streamed before a tool call is preamble, not the answer
  const { t } = run([{ type:'delta', text:'Let me check. ' },
                     { type:'tools', tools:[{ name:'read_file' }] }]);
  assert.equal(t.body, '');
  assert.deepEqual([...t.chips], [['read', 1]]);
}

{
  // unthink: what streamed as the answer was the scratchpad — it moves to thoughts
  const { t } = run([{ type:'thinking', text:'a' }, { type:'delta', text:'b' }, { type:'unthink' }]);
  assert.equal(t.thoughts, 'ab');
  assert.equal(t.body, '');
}

{
  // 'done' and 'closed' both arrive on the server path: one exchange, not two
  const { t, c } = run([{ type:'session', sessionId:'s1' }, { type:'delta', text:'42' },
                        { type:'done', code:0 }, { type:'closed' }]);
  assert.deepEqual(c.log, [{ q:'q', a:'42', tools:[] }]);
  assert.deepEqual(c.history, [{ role:'user', content:'q' }, { role:'assistant', content:'42' }]);
  assert.equal(c.sessionId, 's1');
  assert.equal(t.status, null);
}

{
  // a failed turn is not an exchange, even though 'done' follows the fatal
  const { t, c } = run([{ type:'delta', text:'half' }, { type:'fatal', error:'boom' },
                        { type:'done', code:1 }]);
  assert.equal(t.failed, true);
  assert.deepEqual(c.log, []);
  assert.deepEqual(c.history, []);
}

{
  // stopped before anything was said (stream closed, no 'done'): nothing to log
  const { c } = run([{ type:'init' }, { type:'closed' }]);
  assert.deepEqual(c.log, []);
  assert.deepEqual(c.history, []);
}

{
  // an agent that finished ('done') with no text IS logged, as "(no answer)"
  const { c } = run([{ type:'done', code:0 }]);
  assert.deepEqual(c.log, [{ q:'q', a:'', tools:[] }]);
  assert.equal(c.history[1].content, '(no answer)');
}

{
  // the tools-used suffix: labels, de-duplicated, phases left out; a repeat is counted
  const { t, c } = run([{ type:'phase', phase:'plan' },
                        { type:'tools', tools:[{ name:'run_python' }, { name:'Skill', input:{ skill:'mca' } }] },
                        { type:'tools', tools:[{ name:'python' }] },
                        { type:'result', text:'J = 1.2' }, { type:'done', code:0 }]);
  assert.equal(c.history[1].content, 'J = 1.2\n\n[tools used this turn: python, skill: mca]');
  assert.deepEqual(c.log[0].tools, ['python', 'skill: mca']);
  assert.equal(t.chips.get('python'), 2);
  assert.ok(t.seen.has('phase:plan'));
}

{
  // history is what the hosted agent re-sends, so it is trimmed to the last 24
  const c = chat();
  c.history = Array.from({ length: 24 }, (_, i) => ({ role:'user', content:'old'+i }));
  run([{ type:'delta', text:'a' }, { type:'done', code:0 }], c, 'new');
  assert.equal(c.history.length, 24);
  assert.equal(c.history[0].content, 'old2');
  assert.deepEqual(c.history.slice(-2), [{ role:'user', content:'new' }, { role:'assistant', content:'a' }]);
}

{
  // status follows the phase; a new phase heads the thoughts only once there are some
  const { t } = run([{ type:'phase', phase:'frame' }, { type:'thinking', text:'x' },
                     { type:'phase', phase:'plan' }, { type:'heartbeat', seconds:65 }]);
  assert.equal(t.thoughts, 'x\n\n— plan —\n');
  assert.equal(t.status, 'Phase: plan · 1m 5s');
}

{
  // a whole block echoing the deltas changes nothing, and says so to the painter
  const t = newTurn('q', chat());
  const said = 'Let me think about this step by step while examining the pathway.';
  t.feed({ type:'thinking', text: said });
  assert.equal(t.feed({ type:'thinking', whole:true, text: said }), false);
  assert.equal(t.thoughts, said);
}

{
  // the "nothing was computed / checked" warnings need an answer to warn about
  assert.equal(run([{ type:'result', text:'J = 1.2', unverified:true, noTools:true }]).t.warns.length, 2);
  assert.deepEqual(run([{ type:'result', text:'', unverified:true, noTools:true }]).t.warns, []);
}

{
  // Stop ends the turn there and then. The hosted agent cannot be interrupted inside
  // a tool call, so after Stop it still emits 'tools', a placeholder 'result' and
  // 'done' code 0 — which used to be logged as an exchange and repainted the bubble.
  const { t, c } = run([{ type:'tools', tools:[{ name:'read_model' }] },
                        { type:'closed', stopped:true }]);
  for(const late of [{ type:'tools', tools:[{ name:'mca' }] },
                     { type:'result', text:'(the model produced no final answer)' },
                     { type:'done', code:0 }])
    assert.equal(t.feed(late), false, 'a stopped turn must ignore a late ' + late.type);
  assert.equal(t.body, '');
  assert.deepEqual([...t.chips.keys()], ['read_model']);
  assert.deepEqual(c.log, []);
  assert.deepEqual(c.history, []);
}

{
  // ...but a turn that merely finished is not deaf: on the server path the last
  // model_changed push arrives after 'done', and 'closed' after that
  const { t } = run([{ type:'delta', text:'a' }, { type:'done', code:0 }]);
  assert.equal(t.feed({ type:'model_changed', src:'x' }), true);
  assert.equal(t.feed({ type:'closed' }), true);
}

{
  // what Stop keeps: the answer so far is still logged, as it always was
  const { c } = run([{ type:'delta', text:'partial' }, { type:'closed', stopped:true },
                     { type:'done', code:0 }]);
  assert.deepEqual(c.log, [{ q:'q', a:'partial', tools:[] }]);
  assert.equal(c.history.length, 2);
}

console.log('turn state ok');

// leaving a turn (another project opened) logs nothing: it runs on at the server
{
  const { t, c } = run([{ type: 'delta', text: 'half an ans' }, { type: 'closed', stopped: true, detached: true }]);
  assert.deepEqual([c.log, c.history], [[], []], 'a partial answer saved now would be saved again, whole, on return');
  assert.equal(t.feed({ type: 'delta', text: 'wer' }), false, 'and this page stops listening');
}
