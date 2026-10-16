/* node backend/agent-args.test.mjs */
import assert from 'node:assert/strict';
import { buildArgs } from './agent.mjs';
import { VENV_PY } from './tellurium.mjs';
import { join } from 'node:path';

const base = { root: '/tmp/app', prompt: 'hi', sid: 'abc-123', model: '',
               useWorkflow: true, liveModel: '', scratch: '', summary: '' };

{
  const fresh = buildArgs({ ...base, resuming: false });
  assert.ok(fresh.includes('--session-id'), 'a new session claims its id');
  assert.ok(!fresh.includes('--resume'));
  // without it the CLI sends thinking blocks with empty text and the panel never opens
  assert.equal(fresh[fresh.indexOf('--thinking-display') + 1], 'summarized');
}

{
  const again = buildArgs({ ...base, resuming: true });
  assert.ok(again.includes('--resume'), 'a known session resumes');
  assert.ok(!again.includes('--session-id'), 'an id may only be claimed once');
  assert.equal(again[again.indexOf('--resume') + 1], 'abc-123');
}

{
  // the rolling summary must reach the model without needing a tool call
  const withSummary = buildArgs({ ...base, resuming: true, summary: 'Step 3 holds the control.' });
  const appended = withSummary[withSummary.indexOf('--append-system-prompt') + 1];
  assert.match(appended, /Step 3 holds the control\./);
}

{
  const none = buildArgs({ ...base, resuming: false, summary: '' });
  const appended = none[none.indexOf('--append-system-prompt') + 1];
  assert.doesNotMatch(appended, /Project history/, 'no empty history block');
}

{
  // A1-9: cat/ls read any file on the machine; Read/Glob/Grep (scoped by --add-dir)
  // already cover reading, so the broad Bash rules must be gone.
  const args = buildArgs({ ...base, resuming: false });
  assert.ok(!args.includes('Bash(cat:*)'), 'Bash(cat:*) must not be allowed');
  assert.ok(!args.includes('Bash(ls:*)'), 'Bash(ls:*) must not be allowed');
  assert.ok(args.includes(`Bash(./${VENV_PY}:*)`), 'the venv python rule must stay');
}

{
  // A3-22: history must not be treated as a tool result the model can quote from memory
  const withSummary = buildArgs({ ...base, resuming: true, summary: 'Step 3 holds the control.' });
  const appended = withSummary[withSummary.indexOf('--append-system-prompt') + 1];
  assert.doesNotMatch(appended, /Treat it as established, and do not re-derive it\./);
  assert.match(appended, /not\s+a tool result/);
}

{
  // the Skills are named by their real folder, not the .claude/skills link the CLI reports
  const args = buildArgs({ ...base, resuming: false });
  assert.ok(args[args.indexOf('--append-system-prompt') + 1].includes(join('/tmp/app', 'skills')));
}

{
  // the live model is gated on pathway-modeling having been used (backend/model-gate.mjs)
  const args = buildArgs({ ...base, resuming: false, modelPath: 'projects/p1/model.txt' });
  const { hooks } = JSON.parse(args[args.indexOf('--settings') + 1]);
  const [h] = hooks.PreToolUse;
  assert.match(h.matcher, /Edit/);
  assert.match(h.matcher, /Write/);
  assert.ok(h.hooks[0].command.includes(join('/tmp/app', 'backend', 'model-gate.mjs')));
  assert.ok(h.hooks[0].command.includes(join('/tmp/app', 'projects/p1/model.txt')), 'the project model, not the default');
}

console.log('agent args ok');
