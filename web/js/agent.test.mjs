/* node web/js/agent.test.mjs
   The pieces of the tool loop that the page (agent.mjs) and the server
   (backend/local-agent.mjs) share. They were two copies and had drifted: the page's
   retried a stopped request and dropped `unthink`. */
import assert from 'node:assert/strict';
import { constrain, quiet } from './oai.mjs';

const schema = { required: ['ok', 'notes'], properties: { ok: { type: 'boolean' }, notes: { type: 'array' } } };

// Stop is rethrown, not taken for "no json_schema support" and asked again
{
  let asked = 0;
  const complete = async () => { asked++; throw Object.assign(new Error('stopped'), { name: 'AbortError' }); };
  await assert.rejects(constrain({ complete, messages: [], schema, emit() {} }), { name: 'AbortError' });
  assert.equal(asked, 1);
}

// a stage forwards thinking and unthink, never the tokens; a server without
// json_schema is asked again without it, and a missing required field is filled
{
  const seen = [], schemas = [];
  const complete = async ({ schema, onStream }) => {
    schemas.push(!!schema);
    if (schema) throw new Error('HTTP 400 response_format');
    for (const type of ['delta', 'thinking', 'unthink']) onStream({ type });
    return { content: '```json\n{"ok": true}\n```' };
  };
  assert.deepEqual(await constrain({ complete, messages: [], schema, emit: e => seen.push(e.type) }),
                   { ok: true, notes: [] });
  assert.deepEqual(schemas, [true, false]);
  assert.deepEqual(seen, ['thinking', 'unthink']);
  quiet(e => seen.push(e.type))({ type: 'unthink' });      // the stage loop's own filter
  assert.equal(seen.length, 3);
}
console.log('agent.test.mjs ok');

/* The loop itself, driven with a scripted completion call and fake tools: no HTTP.
   Both runtimes run this one copy (runTurn for the outer turn, runStage for a
   workflow stage), so what holds here holds on the server and in the page. */
import { runTurn, runStage, hostWorkflow, withWorkflow, completion, v1Base } from './oai.mjs';

const def = (name, required = []) => ({ type: 'function', function: { name, parameters: { type: 'object', required } } });
const call = (name, args, id = name) => ({ tool_calls: [{ id, type: 'function',
  function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } }] });
/** Fake tools, and a completion call that replays `script` (the last entry repeats). */
function rig(script) {
  const ran = [], asked = [], events = [];
  const tools = { impl: { read: async ({ path }) => { ran.push('read ' + path); return 'k1 = 0.4'; },
                          run_python: async ({ code }) => { ran.push('py ' + code); return '1.2'; } },
                  defs: [def('read', ['path']), def('run_python', ['code'])] };
  const complete = async a => {
    asked.push({ ...a, messages: [...a.messages] });
    const m = script[Math.min(asked.length - 1, script.length - 1)];
    return typeof m === 'function' ? m(a) : m;
  };
  return { ran, asked, events, o: { complete, tools, emit: e => events.push(e), maxSteps: 6, cap: 1000,
                                    messages: [{ role: 'user', content: 'q' }] } };
}

// a tool call, then the answer: the result goes back, and a computed number is not "unverified"
{
  const r = rig([call('run_python', { code: 'print(J)' }), { content: 'J = 1.2' }]);
  const res = await runTurn(r.o);
  assert.deepEqual(r.ran, ['py print(J)']);
  assert.deepEqual(r.asked[1].messages.at(-1), { role: 'tool', tool_call_id: 'run_python', name: 'run_python', content: '1.2' });
  assert.deepEqual(res, { type: 'result', text: 'J = 1.2', isError: false, noTools: false, unverified: false });
  assert.deepEqual(r.events.filter(e => e.type === 'tools')[0].tools, [{ name: 'run_python', input: { code: 'print(J)' } }]);
  // reading is not computing, and neither is a tool that does not exist here
  for (const c of [call('read', { path: 'm' }), call('simulate', {})])
    assert.equal((await runTurn(rig([c, { content: 'J = 1.2' }]).o)).unverified, true);
  assert.equal((await runTurn(rig([{ content: 'no number' }]).o)).noTools, true);
}

// the repeat guard: the tool runs once, and after REPEAT_LIMIT replays the tools are withdrawn
{
  const r = rig([a => a.tools ? call('read', { path: 'm' }) : { content: 'answered' }]);
  const res = await runTurn({ ...r.o, maxSteps: 20 });
  assert.deepEqual(r.ran, ['read m']);
  assert.equal(r.asked.length, 4, 'one real call, two replays, then the wrap-up');
  assert.equal(r.asked.at(-1).tools, undefined);
  assert.match(r.asked.at(-1).messages.at(-1).content, /already called read/);
  assert.ok(r.events.some(e => e.type === 'log' && /same call repeated 2x/.test(e.text)));
  assert.equal(res.text, 'answered');
}

// out of steps: the last one is asked without tools
{
  const r = rig([a => a.tools ? call('read', { path: 'f' + r.asked.length }) : { content: 'so far' }]);
  assert.equal((await runTurn({ ...r.o, maxSteps: 3 })).text, 'so far');
  assert.equal(r.ran.length, 2);
}

// a call that leaves a required argument out (or sends unparseable ones) never runs, and is told why
{
  const r = rig([call('read', {}), call('read', '{"path":'), { content: 'ok' }]);
  await runTurn(r.o);
  assert.deepEqual(r.ran, []);
  for (const i of [1, 2]) assert.match(r.asked[i].messages.at(-1).content, /read requires path/);
}

// a runtime's hook: before each completion, a gate that refuses, and a record of every call
{
  const r = rig([call('read', { path: 'm' }), call('run_python', { code: 'x' }), { content: 'ok' }]);
  const seen = [];
  await runTurn({ ...r.o, hook: {
    before: step => { seen.push('before ' + step); },
    gate: name => name === 'run_python' ? 'REFUSED' : null,
    ran: (name, args, out) => { seen.push(name + ' -> ' + out); } } });
  assert.deepEqual(r.ran, ['read m']);
  assert.deepEqual(seen, ['before 0', 'read -> k1 = 0.4', 'before 1', 'run_python -> REFUSED', 'before 2']);
}

// a schema stage: tools first, then the declared object, with only thinking let through
{
  const r = rig([call('read', { path: 'm' }), { content: 'prose' },
    a => { a.onStream({ type: 'delta' }); a.onStream({ type: 'thinking' }); return { content: '{"ok": true}' }; }]);
  assert.deepEqual(await runStage({ ...r.o, schema }), { ok: true, notes: [] });
  assert.ok(r.asked[2].schema, 'the schema is asked for only once the tools are done');
  assert.deepEqual(r.events.filter(e => e.type !== 'tools').map(e => e.type), ['thinking']);
  // no schema: the text; and a stage past its clock is wrapped up at once
  assert.equal(await runStage(rig([{ content: 'prose' }]).o), 'prose');
  const late = rig([a => a.tools ? call('read', { path: 'm' }) : { content: 'late' }]);
  assert.equal(await runStage({ ...late.o, ms: -1 }), 'late');
  assert.deepEqual(late.ran, []);
}

// Stop between two calls of one reply: the first finishes, the second never starts
{
  const ctrl = new AbortController();
  const two = { tool_calls: [...call('read', { path: 'a' }, 'c1').tool_calls, ...call('run_python', { code: 'rm' }, 'c2').tool_calls] };
  const r = rig([two, { content: 'never asked' }]);
  r.o.tools.impl.read = async () => { r.ran.push('read'); ctrl.abort(); return 'x'; };
  const res = await runTurn({ ...r.o, signal: ctrl.signal });
  assert.deepEqual(r.ran, ['read']);
  assert.equal(r.asked.length, 1, 'no further completion after Stop');
  assert.equal(res.isError, true);
  // a stage that was stopped throws rather than handing the workflow an empty result
  const s = rig([two]);
  s.o.tools.impl.read = async () => { ctrl.abort(); return 'x'; };
  await assert.rejects(runStage({ ...s.o, signal: ctrl.signal }), /aborted/);
}

// the workflow file is hosted the same way on both runtimes, behind run_mca_workflow
{
  const events = [], staged = [];
  const src = 'export const meta = { name: "t" };\nphase("P"); log(1);\n' +
    'return { got: await agent(args.question, { phase: "P", label: "L", schema: 1 }) };';
  const wf = withWorkflow({ impl: {}, defs: [] }, { prompt: 'the question', emit: e => events.push(e.type), cap: 1000,
    run: a => hostWorkflow({ src, system: 'SYS', args: a, emit: e => events.push(e.type),
      stage: async (messages, s) => { staged.push(messages, s); return 'staged'; } }) });
  assert.equal(await wf.impl.run_mca_workflow({}), '{"got":"staged"}');
  assert.deepEqual(staged, [[{ role: 'system', content: 'SYS' }, { role: 'user', content: 'the question' }], 1]);
  assert.deepEqual(events, ['workflow_start', 'phase', 'log', 'phase', 'workflow_done']);
  assert.deepEqual(wf.defs.map(d => d.function.name), ['run_mca_workflow']);
  const r = rig([call('run_mca_workflow', {}), { content: 'J = 1.2' }]);
  r.o.tools = withWorkflow(r.o.tools, { prompt: 'q', emit() {}, run: async () => ({}) });
  assert.equal((await runTurn(r.o)).unverified, false);
  assert.deepEqual(r.events.find(e => e.type === 'tools').tools, [{ name: 'Workflow', input: { workflow: 'mca-tellurium' } }]);
}

// one retry rule for both transports: nothing visible, or a call after tools closed
{
  const sent = [], logs = [];
  const run = (replies, o = {}) => { sent.length = 0;
    return completion(async body => { sent.push(body); return replies[sent.length - 1]; },
      { model: 'm', messages: [{ role: 'user', content: 'q' }], ctx: 8192, cap: 4096, onStream: e => logs.push(e.text), ...o }); };
  assert.equal((await run([{ content: '', reasoning: 'hm', finish: 'stop' }, { content: 'A' }])).content, 'A');
  assert.match(logs.at(-1), /stopped after thinking/);
  assert.equal(sent[0].tool_choice, 'none');
  assert.equal(sent[1].messages.at(-2).content, 'hm', 'its thinking is put back in front of it');
  assert.equal((await run([{ content: 'partial', finish: 'length' }])).content, 'partial');
  assert.equal(sent.length, 1, 'a cut-off answer is kept, not retried');
  assert.equal((await run([{ content: '', finish: 'length' }, { content: '' }])).finish, 'length', 'an empty retry does not replace the first');
  const closedTools = [def('read')];
  assert.equal((await run([{ content: 'Let me:', closedCall: true }, { content: 'B' }], { closedTools })).content, 'B');
  assert.deepEqual(sent[0].tools, closedTools, 'closed tools are still sent');
  assert.match(sent[0].messages.at(-1).content, /^Tools are closed/);
  assert.match(sent[1].messages.at(-1).content, /that call was not run/);
}

for (const [url, want] of [['http://h:1234', 'http://h:1234/v1'], ['http://h:1234/', 'http://h:1234/v1'],
                           ['http://h/v1/', 'http://h/v1'], ['https://g/api/v4', 'https://g/api/v4'], ['', '']])
  assert.equal(v1Base(url), want);
console.log('shared loop ok');
