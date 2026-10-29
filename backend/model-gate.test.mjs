import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { missing, unread, isAnalysis } from './model-gate.mjs';
import { runGate } from './local-agent.mjs';

let seq = 0;
const attempt = (name, input, id) => JSON.stringify({ message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, content = 'successfully read content', is_error = false) =>
  JSON.stringify({ message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } });
const use = (name, input) => { const id = 'tool-' + ++seq; return attempt(name, input, id) + '\n' + result(id); };
const SKILL = use('Skill', { skill: 'pathway-modeling' });
const REF = use('Read', { file_path: '/app/skills/pathway-modeling/references/02_kinetics_in_a_nutshell.md', offset: 200, limit: 80 });

test('a model write needs pathway-modeling loaded and a reference opened with Read', () => {
  assert.match(missing(''), /not been loaded.*None of its reference files/s);
  assert.match(missing(SKILL), /None of its reference files/, 'the index alone is not use');
  assert.match(missing(SKILL + '\n' + use('Read', { file_path: '/app/skills/pathway-modeling/SKILL.md' })), /None of/);
  assert.match(missing(SKILL + '\n' + use('Grep', { pattern: 'Hill', path: '/app/skills/pathway-modeling/references' })), /None of/,
    'a keyword grep is not a read');
  assert.match(missing(REF), /not been loaded/);
  assert.equal(missing(SKILL + '\n' + REF), '');
  assert.equal(missing(use('Skill', { skill: 'mca' }) + '\n' + REF).length > 0, true, 'another Skill does not count');
  // the router inlined the index instead of a Skill call
  const routed = JSON.stringify({ message: { content: "[router] The pathway-modeling Skill's index is below; do not load it again." } });
  assert.equal(missing(routed + '\n' + REF), '');
});

test('failed, incomplete, empty and index-only tool reads do not satisfy the gate', () => {
  const input = { file_path: '/app/skills/pathway-modeling/references/02_kinetics_in_a_nutshell.md' };
  assert.match(missing(SKILL + '\n' + attempt('Read', input, 'r')), /None of its reference files/);
  assert.match(missing(SKILL + '\n' + attempt('Read', input, 'r') + '\n' + result('r', 'not found', true)), /None of/);
  assert.match(missing(SKILL + '\n' + attempt('Read', input, 'r') + '\n' + result('r', '')), /None of/);
  assert.match(missing(SKILL + '\n' + use('Read', { file_path: '/app/skills/pathway-modeling/references/../SKILL.md' })), /None of/);
  assert.match(missing(attempt('Skill', { skill: 'pathway-modeling' }, 's') + '\n' + result('s', 'failed', true) + '\n' + REF), /not been loaded/);
  assert.equal(missing(SKILL + '\n' + attempt('Read', input, 'r') + '\n' + result('r', [{ type: 'text', text: 'reference contents' }])), '');
});

test('the hook blocks only writes to the live model, and only when the Skill was not used', () => {
  const d = mkdtempSync(join(tmpdir(), 'gate-')), model = join(d, 'model.txt');
  const tr = (name, text) => { const f = join(d, name); writeFileSync(f, text); return f; };
  const run = (file_path, transcript_path) => spawnSync(process.execPath,
    [fileURLToPath(new URL('./model-gate.mjs', import.meta.url)), model],
    { input: JSON.stringify({ cwd: d, transcript_path, tool_name: 'Edit', tool_input: { file_path } }), encoding: 'utf8' });
  const bare = tr('bare.jsonl', SKILL), used = tr('used.jsonl', SKILL + '\n' + REF);
  const r = run(model, bare);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /REFUSED/);
  assert.equal(run('model.txt', used).status, 0, 'relative path resolved against cwd');
  assert.equal(run(join(d, 'script.py'), bare).status, 0, 'other files are not gated');
  assert.equal(run(model, join(d, 'nope.jsonl')).status, 0, 'no transcript: fail open');
});

test('running Python needs some Skill file opened with Read first', () => {
  assert.match(unread(''), /REFUSED/);
  assert.match(unread(SKILL), /REFUSED/, 'loading a Skill is not reading it');
  assert.match(unread(use('Read', { file_path: '/app/skills/mca/SKILL.md' })), /REFUSED/);
  assert.match(unread(use('Grep', { pattern: 'getCC', path: '/app/skills/tellurium/references' })), /REFUSED/);
  assert.equal(unread(use('Read', { file_path: '/app/skills/mca/references/elasticities.md' })), '');
  assert.equal(unread(use('Read', { file_path: '/app/.claude/skills/tellurium/workflows/run_control_analysis.md' })), '');
  assert.equal(unread(REF), '');
  assert.ok(isAnalysis('./.venv/bin/python model-scientist-runs/pass-1/ss.py'));
  assert.ok(!isAnalysis('./.venv/bin/python backend/py/web.py pubmed "x"'), 'web access is not an analysis');
  assert.ok(!isAnalysis('ls model-scientist-runs'));
  assert.match(runGate('run_python', new Set()), /REFUSED/);
  assert.equal(runGate('run_python', new Set(['x.md'])), null);
  assert.equal(runGate('read_file', new Set()), null);
});

test('the hook blocks a Python run until a Skill file was read', () => {
  const d = mkdtempSync(join(tmpdir(), 'gate-')), model = join(d, 'model.txt');
  const tr = (name, text) => { const f = join(d, name); writeFileSync(f, text); return f; };
  const run = (command, transcript_path) => spawnSync(process.execPath,
    [fileURLToPath(new URL('./model-gate.mjs', import.meta.url)), model],
    { input: JSON.stringify({ cwd: d, transcript_path, tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8' });
  const bare = tr('bare.jsonl', SKILL), read = tr('read.jsonl', use('Read', { file_path: '/app/skills/mca/references/elasticities.md' }));
  const py = './.venv/bin/python run.py';
  assert.equal(run(py, bare).status, 2);
  assert.equal(run(py, read).status, 0);
  assert.equal(run('ls', bare).status, 0, 'other commands are not gated');
});
