/* node backend/router.test.mjs — the Skill router's logic, with a fake fetch (no network). */
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, hintLine, autoBlock, route, questions, logLine, recentLine, active } from './router.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const on = { enabled: true, key: 'sk-test', auto: true };

// decide: auto / hint / silent, loaded skipped, auto switch off → hints
{
  const p = { tellurium: 0.91, mca: 0.88, 'pathway-modeling': 0.86 };
  const d = decide(p, [], on);
  assert.deepEqual(d.auto.map(a => a[0]), ['tellurium', 'mca', 'pathway-modeling'], 'all confident ones auto-load, highest first');
  assert.deepEqual(d.hint, []);
  assert.deepEqual(decide(p, ['tellurium'], on).auto.map(a => a[0]), ['mca', 'pathway-modeling']);
  const off = decide(p, [], { ...on, auto: false });
  assert.equal(off.auto.length, 0);
  assert.deepEqual(off.hint.map(a => a[0]), ['tellurium', 'mca', 'pathway-modeling']);
  assert.deepEqual(decide({ mca: 0.49 }, [], on), { auto: [], hint: [] }, 'below 0.50 is silent');
  assert.deepEqual(decide({ mca: 0.6 }, [], on).hint, [['mca', 0.6]]);
  console.log('ok (decide)');
}

// text the model sees
{
  assert.equal(hintLine([]), '');
  assert.equal(hintLine([['tellurium', 0.912], ['mca', 0.74]]),
    '\n\n[router] likely needed: tellurium (0.91), mca (0.74). Load with load_skill / Skill.');
  const block = await autoBlock([['tellurium', 0.9]], ROOT);
  assert.match(block, /The tellurium Skill's index is below; do not load it again/);
  assert.match(block, /open the reference files/, 'an inlined index must not pass for a used Skill');
  assert.match(block, /name: tellurium/);
  assert.equal(logLine({ ms: 231, hint: [['tellurium', 0.91]], auto: [] }),
    'router 231ms: hint tellurium 0.91 | auto none');
  assert.equal(logLine({ ms: 5, hint: [], auto: [], error: 'Jev rejected the API key' }),
    'router: Jev rejected the API key');
  assert.equal(recentLine('load_skill', { name: 'mca' }, 'md…'), 'load_skill mca -> ok');
  assert.equal(recentLine('run_python', { code: 'import te\nsecret()' },
      'x\n[stderr]\nTraceback\nAttributeError: no getCC2\n'),
    'run_python -> AttributeError: no getCC2', 'never the script, the error line');
  assert.equal(recentLine('load_skill', { name: 'tellurium' }, '# T\nAn AttributeError means…'),
    'load_skill tellurium -> ok', 'a Skill that talks about errors is not a failure');
  assert.equal(recentLine('read_file', { path: 'x' }, 'ERROR: ENOENT: no such file\nmore'),
    'read_file x -> ERROR: ENOENT: no such file');
  assert.equal(recentLine('run_python', { code: '' }, 'print says Error: none\n'), 'run_python -> ok',
    'stdout is not an error');
  console.log('ok (text)');
}

// questions come from each SKILL.md description
{
  const q = await questions(ROOT);
  assert.deepEqual(Object.keys(q).sort(), ['mca', 'pathway-modeling', 'tellurium']);
  assert.equal(q.tellurium.type, 'noul');
  assert.match(q.tellurium.instructions, /NEXT steps need the 'tellurium' Skill\? That Skill covers: Model, simulate/);
  assert.doesNotMatch(q.tellurium.instructions, /[>|]\s*$/);
  console.log('ok (questions from SKILL.md)');
}

// route: parses answers, sends a trimmed state, never throws
{
  let sent;
  const ok = async (url, init) => { sent = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ answers: {
      tellurium: { type: 'noul', noul: 0.9 }, mca: { type: 'noul', noul: 0.6 } } })); };
  const r = await route({ cfg: on, root: ROOT, request: 'x'.repeat(5000), loaded: ['pathway-modeling'],
                          recent: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], hasModel: true, step: 2, fetch: ok });
  assert.deepEqual(r.auto, [['tellurium', 0.9]]);
  assert.deepEqual(r.hint, [['mca', 0.6]]);
  assert.equal(sent.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(sent.init.headers.authorization, 'Bearer sk-test');
  assert.equal(sent.body.model, 'jev-1.13.0');
  assert.equal(sent.body.state.request.length, 2000);
  assert.deepEqual(sent.body.state.recent, ['b', 'c', 'd', 'e', 'f', 'g']);
  assert.equal(sent.body.state.model, 'has model');
  assert.ok(!('pathway-modeling' in sent.body.questions), 'a loaded Skill is not asked about');

  const empty = { auto: [], hint: [] };
  const fails = {
    401: async () => new Response('no', { status: 401 }),
    500: async () => new Response('no', { status: 500 }),
    json: async () => new Response('not json'),
    // AbortSignal.timeout is unref'd; the held timer keeps this script alive for it
    timeout: (u, { signal }) => new Promise((_, rej) => { const held = setTimeout(() => {}, 5000);
      signal.addEventListener('abort', () => { clearTimeout(held); rej(signal.reason); }); }),
  };
  for (const [k, f] of Object.entries(fails)) {
    const x = await route({ cfg: on, root: ROOT, request: 'q', fetch: f, timeout: 50 });
    assert.deepEqual({ auto: x.auto, hint: x.hint }, empty, k);
    assert.ok(x.error, k + ' reports why');
  }
  assert.equal((await route({ cfg: on, root: ROOT, request: 'q', fetch: fails[401] })).error,
    'Jev rejected the API key');
  let called = false;
  const off = await route({ cfg: { enabled: false, key: 'k' }, root: ROOT, request: 'q',
                            fetch: async () => { called = true; } });
  assert.deepEqual({ auto: off.auto, hint: off.hint }, empty);
  assert.equal(called, false, 'off makes no call');
  await route({ cfg: { enabled: true, key: '' }, root: ROOT, request: 'q',
                fetch: async () => { called = true; } });
  assert.equal(called, false, 'no key makes no call');
  console.log('ok (route: parse, trim, every failure is empty)');
}

// provider: Layla needs no key and never touches Jev; one provider per call
{
  let jevCalled = false, got;
  const fetch = async () => { jevCalled = true; };
  const lf = async a => { got = a; return { tellurium: 0.95, mca: 0.7 }; };
  const r = await route({ cfg: { enabled: true, provider: 'laya', key: '', auto: true }, root: ROOT,
                          request: 'simulate', loaded: ['pathway-modeling'], fetch, laya: lf });
  assert.deepEqual(r.auto, [['tellurium', 0.95]]);
  assert.deepEqual(r.hint, [['mca', 0.7]]);
  assert.equal(jevCalled, false, 'laya never calls Jev');
  assert.deepEqual(Object.keys(got.questions).sort(), ['mca', 'tellurium']);
  let layaCalled = false;
  await route({ cfg: { ...on, provider: 'jev' }, root: ROOT, request: 'q', laya: async () => { layaCalled = true; },
                fetch: async () => new Response(JSON.stringify({ answers: {} })) });
  assert.equal(layaCalled, false, 'jev never calls Layla');
  const e = await route({ cfg: { enabled: true, provider: 'laya' }, root: ROOT, request: 'q',
                          laya: async () => { throw new Error('Layla call timed out after 20s'); } });
  assert.equal(e.error, 'Layla call timed out after 20s');
  assert.equal(active({ enabled: true, provider: 'laya' }), true);
  assert.equal(active({ enabled: true, provider: 'jev', key: '' }), false);
  assert.equal(active({ enabled: false, provider: 'laya' }), false);
  console.log('ok (provider: laya | jev, never both)');
}

// all three Skills confident -> all three go in (the cap was 2: measured, Laya scored
// mca, tellurium and pathway-modeling 1.00 and pathway-modeling was demoted to a hint)
{
  const { decide } = await import('./router.mjs');
  const d = decide({ mca: 1, tellurium: 1, 'pathway-modeling': 1 }, [], { auto: true });
  assert.equal(d.auto.length, 3); assert.equal(d.hint.length, 0);
  console.log('router auto cap ok');
}
