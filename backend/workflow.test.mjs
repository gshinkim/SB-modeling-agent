import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { hostWorkflow } from '../web/js/oai.mjs';

const src = await readFile(new URL('../workflows/mca-tellurium.js', import.meta.url), 'utf8');
const frame = { missing_from_user: [], to_establish: [], brief: 'compute flux', quantity: 'flux', topology: 'linear', steady_state_required: true };
const plan = { calls: [], traps: [], build_path: 'supplied', unestablished: [] };
const execution = { ran: true, error: '', results: 'J = 1', steady_state_evidence: '0', script_path: 'test.py' };
const validation = { verdict: 'pass', report: 'passed' };
const interpretation = { mathematics: 'J = 1', biology: 'test', assumptions: [], unresolved: [] };
const invoke = audit => hostWorkflow({ src, system: '', args: { question: 'flux?', model: 'test' }, emit() {},
  stage: async (_, schema) => schema.properties.quantity ? frame
    : schema.properties.calls ? plan
    : schema.properties.ran ? execution
    : schema.properties.verdict ? validation
    : schema.properties.mathematics ? interpretation : audit });

assert.equal((await invoke({ ok: true, unsupported: [] })).status, 'VALIDATED');
for (const audit of [null, { ok: false, unsupported: ['imagined API'] }]) {
  const result = await invoke(audit);
  assert.equal(result.status, 'AUDIT_FAILED');
  assert.match(result.note, /audit did not pass/);
}
console.log('workflow final audit gates validated status');
