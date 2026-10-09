/* node --test web/js/search.test.mjs
   No DOM: the keyword rule Search shares with backend/files.mjs, and the index
   built from the last Tellurium result and the chat log. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryWords, hits, snippet, rank, buildIndex, merge, askText } from './search.mjs';
import { queryWords as backendWords } from '../../backend/files.mjs';

const result = { reactions: ['J1', 'J2'], floatingSpecies: ['S1'], boundarySpecies: ['Xo'],
                 globalParameters: ['k1', 'k10'], values: { k1: 0.5, k10: 2, S1: 3.14159265, Xo: 10 } };
const src = '$Xo -> S1; k1*Xo\nJ2: S1 -> ; k10*S1\nk1 = 0.5; k10 = 2';
const chats = [{ id: 'c1', title: 'First', log: [
  { q: 'Which step controls the flux?', a: 'Intro line.\nJ1 holds most of the flux control (0.8).' },
  { q: 'thanks', a: '' }] }];

test('queryWords: lower-case, longer than one character, same rule as the backend', () => {
  for (const q of ['  Flux, a CONTROL? k1 ', 'scan.py', 'k1*Xo -> S1', '', 'a b', 'flux flux'])
    assert.deepEqual(queryWords(q), backendWords(q));
  assert.deepEqual(queryWords('  Flux, a CONTROL? k1 '), ['flux', 'control', 'k1']);
  assert.deepEqual(queryWords('scan.py.'), ['scan.py']);
  assert.deepEqual(queryWords('a b'), []);
  assert.equal(hits(['flux', 'zz'], 'The FLUX rose'), 1);
});

test('snippet: the line with the most words, capped at 160 characters', () => {
  assert.equal(snippet(['flux', 'control'], 'flux only\n  flux control here  \nx'), 'flux control here');
  assert.equal(snippet(['zz'], '\nfirst line\nsecond'), 'first line');
  assert.equal(snippet(['aa'], 'aa' + 'x'.repeat(300)).length, 160);
  assert.equal(snippet(['aa'], ''), '');
});

test('buildIndex: model parts carry their value and their line of the model', () => {
  const idx = buildIndex(result, chats, src);
  assert.deepEqual(idx.map(i => i.type), ['Reaction', 'Reaction', 'Species', 'Species', 'Parameter', 'Parameter', 'Chat', 'Chat']);
  const by = Object.fromEntries(idx.map(i => [i.title, i]));
  assert.ok(by['k1 = 0.5'] && by['k10 = 2'] && by['S1 = 3.14159'] && by['Xo = 10'] && by['J2']);
  assert.equal(by['J2'].why, 'Reaction: J2: S1 -> ; k10*S1');
  assert.equal(by['k10 = 2'].why, 'Parameter: J2: S1 -> ; k10*S1');   // whole id, not the k1 line
  assert.equal(by['J1'].why, 'Reaction');                             // unnamed in the source
  assert.match(by['Xo = 10'].why, /^Boundary species: \$Xo/);
  assert.deepEqual(buildIndex(null, [], ''), []);
  assert.deepEqual(buildIndex(null, undefined), []);
});

test('rank: every-word matches first, chat snippet from the answer', () => {
  const idx = buildIndex(result, chats, src);
  const r = rank(idx, 'flux control');
  assert.equal(r.length, 1);
  assert.equal(r[0].type, 'Chat');
  assert.equal(r[0].title, 'Which step controls the flux?');
  assert.equal(r[0].why, 'J1 holds most of the flux control (0.8).');
  assert.equal(r[0].all, true);

  const k = rank(idx, 'k10 boundary');
  assert.deepEqual(k.map(x => [x.title, x.all]), [['J2', false], ['Xo = 10', false], ['k10 = 2', false]]);
  const both = rank([{ type: 'X', title: 'one', text: 'alpha' }, { type: 'X', title: 'two', text: 'alpha beta' }], 'alpha beta');
  assert.deepEqual(both.map(x => [x.title, x.all]), [['two', true], ['one', false]]);
  assert.deepEqual(rank(idx, 'thanks').map(x => x.why), ['']);       // matched on the question; empty answer
  assert.deepEqual(rank(idx, 'q'), []);
  assert.deepEqual(rank(idx, 'nothinghere'), []);
  assert.equal(rank(Array.from({ length: 50 }, (_, i) => ({ type: 'X', title: 'hit' + i, text: '' })), 'hit').length, 30);
});

test('merge: all-word matches of every kind before any-word ones', () => {
  const local = [{ type: 'Parameter', title: 'k1', all: false }, { type: 'Chat', title: 'c', all: true }];
  const files = [{ path: 'a/scan.py', line: 3, snippet: 'k1 scan', all: true }, { path: 'plot.png', line: 0, snippet: '', all: false }];
  const m = merge(local, files);
  assert.deepEqual(m.map(r => r.title), ['a/scan.py', 'c', 'k1', 'plot.png']);
  assert.equal(m[0].why, 'Line 3: k1 scan');
  assert.equal(m[3].why, 'The file name matches');
  assert.equal(m[0].type, 'File');
});

test('askText names at most six matches', () => {
  const t = askText('flux', Array.from({ length: 9 }, (_, i) => ({ title: 't' + i })));
  assert.equal(t, 'I searched this project for "flux". The matches were: t0; t1; t2; t3; t4; t5. What should I look at or do next?');
  assert.match(askText('x1', []), /The matches were: none\./);
});
