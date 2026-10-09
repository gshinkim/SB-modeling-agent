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
