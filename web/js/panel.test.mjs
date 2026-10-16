/* node web/js/panel.test.mjs
   writeOnly() rewrites a slider's assignment in the Antimony source in place.
   It must only touch a whole statement whose right-hand side is a lone number —
   never an expression, an assignment rule, a comment, or another id's line. */
import assert from 'node:assert/strict';
import { writeOnly } from './panel.mjs';

const editor = v => ({ value: v });

// an expression on the right-hand side is not a lone number: left untouched
{
  const e = editor('k1 = 2*k2');
  writeOnly(e, 'k1', 5);
  assert.equal(e.value, 'k1 = 2*k2', 'expression RHS unchanged');
}

// an assignment rule must not be corrupted or duplicated
{
  const e = editor('k1 := x');
  writeOnly(e, 'k1', 5);
  assert.equal(e.value, 'k1 := x', 'assignment rule unchanged');
}

// a commented-out line above the real one must never be the match
{
  const e = editor('// k1 = 5\nk1 = 1');
  writeOnly(e, 'k1', 9);
  assert.equal(e.value, '// k1 = 5\nk1 = 9', 'only the real (line 2) assignment is edited');
}

// two statements on one line, semicolon-separated: only the named one moves
{
  const e = editor('k1 = 1; k2 = 3');
  writeOnly(e, 'k1', 7);
  assert.equal(e.value, 'k1 = 7; k2 = 3', 'k1 edited, k2 left alone');
}

// an id with a regex metacharacter must not throw or match the wrong thing
{
  const e = editor('J.1 = 2');
  writeOnly(e, 'J.1', 4);
  assert.equal(e.value, 'J.1 = 4', 'dotted id works');
}

// no existing assignment at all: appended
{
  const e = editor('k1 = 1');
  writeOnly(e, 'k2', 3);
  assert.equal(e.value, 'k1 = 1\nk2 = 3', 'a brand-new id is appended');
}

{
  const e = editor('const k1 = 1\nspecies S1 = 10');
  writeOnly(e, 'k1', 2); writeOnly(e, 'S1', 3);
  assert.equal(e.value, 'const k1 = 2\nspecies S1 = 3', 'keyword declarations edited in place, nothing appended');
}

{
  const e = editor('model m\n  S1 -> S2; k*S1\n  k = 1\nend');
  writeOnly(e, 'k', 4);
  assert.equal(e.value, 'model m\n  S1 -> S2; k*S1\n  k = 4\nend', 'edit stays inside model ... end');
}

{
  const e = editor('// archived; k1 = 5\n/*\nk1 = 6;\n*/\nk1 = +1; # keep this comment');
  writeOnly(e, 'k1', 9);
  assert.equal(e.value, '// archived; k1 = 5\n/*\nk1 = 6;\n*/\nk1 = 9; # keep this comment',
    'semicolons and numeric assignments inside comments are untouched');
}

{
  const e = editor('model m\n  species S1;\n  S1 -> S2; k*S1;\nend');
  writeOnly(e, 'S1', 4);
  assert.equal(e.value, 'model m\n  species S1;\n  S1 -> S2; k*S1;\nS1 = 4;\nend',
    'an unset initial condition is assigned inside its model');
}

{
  const e = editor('model *main()\n species S1;\nend\nmodel helper()\n species X;\nend');
  writeOnly(e, 'S1', 2);
  assert.equal(e.value, 'model *main()\n species S1;\nS1 = 2;\nend\nmodel helper()\n species X;\nend',
    'the main model receives a missing assignment even when a helper follows');
}

console.log('panel writeOnly ok');
