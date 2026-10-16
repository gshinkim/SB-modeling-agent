/* node --test web/js/analysis.test.mjs
   The pure half of the Analysis notebook: everything that turns Tellurium's
   matrices into rows, bars, cells, CSV and Markdown. No DOM, no backend. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { eigShort, logFactors, factorLabel, heatCell, matrixRows, fccRows, fccSentence, buildCSV, buildReport,
         scanGeometry, stepStatus, steadyRows, stabilityWord, eigenRows, whyNot, whySteady, zeroFlux, RANGE, EXAMPLE,
         runState, describeRun } from './analysis.mjs';

// `sums` come with the matrix from te_worker; the page never adds the numbers up itself
const FC = { rows: ['J1', 'J2'], cols: ['v1', 'v2', 'v3'], data: [[0.2, 0.9, -0.1], [0.5, 0.25, 0.25]], sums: [1, 1] };
const CC = { rows: ['S1'], cols: ['v1', 'v2', 'v3'], data: [[0.4, -0.3, -0.1]], sums: [0] };
const EE = { rows: ['v1', 'v2', 'v3'], cols: ['S1'], data: [[-0.5], [1], [0]] };
const info = { floatingSpecies: ['S1'], boundarySpecies: ['X0'], reactions: ['v1', 'v2', 'v3'],
               globalParameters: ['k1', 'k2'], engine: { tellurium: '2.2.10', roadrunner: '2.7.0' } };

test('logFactors: 25 log-spaced points, endpoints exact, 1x in the middle', () => {
  for(const [lo, hi] of [RANGE, [0.5, 2], [0.01, 100]]){
    const f = logFactors(lo, hi);
    assert.equal(f.length, 25);
    assert.ok(Math.abs(f[0] - lo) < 1e-12 && Math.abs(f[24] - hi) < 1e-9);
    assert.ok(Math.abs(f[12] - 1) < 1e-12, 'symmetric ranges put the baseline at index 12');
    assert.ok(Math.abs(f[1] / f[0] - f[24] / f[23]) < 1e-9, 'constant ratio');
  }
  assert.equal(factorLabel(0.25), '0.25×'); assert.equal(factorLabel(2), '2.0×'); assert.equal(factorLabel(100), '100×');
});

test('heatCell: sign picks the hue, magnitude the alpha, capped at 1', () => {
  assert.deepEqual(heatCell(0.5), { label: '+0.50', bg: 'oklch(0.75 0.12 255 / 0.25)' });
  assert.deepEqual(heatCell(-3), { label: '−3.00', bg: 'oklch(0.75 0.12 50 / 0.50)' });
  assert.deepEqual(heatCell(0), { label: '0', bg: 'transparent' });
  assert.deepEqual(heatCell(null), { label: 'n/a', bg: 'transparent' });
  assert.equal(heatCell(-1e-9).label, '0.00', 'no minus sign on a value that rounds to zero');
});

test('matrixRows: names, values and row sums', () => {
  const r = matrixRows(FC);
  assert.deepEqual(r.map(x => x.name), ['J1', 'J2']);
  assert.deepEqual(r.map(x => x.sum), [1, 1], "the worker's sums, passed through");
  assert.deepEqual(matrixRows(undefined), []);
  assert.equal(matrixRows({ rows: ['a'], cols: ['x', 'y'], data: [[null, 2]] })[0].sum, null, 'no sum from the worker, none invented here');
});

test('fccRows: width by |value|, largest magnitude is top, negatives flagged', () => {
  const r = fccRows(FC, 'J1');
  assert.deepEqual(r.map(x => x.step), ['v1', 'v2', 'v3']);
  assert.deepEqual(r.map(x => x.top), [false, true, false]);
  assert.deepEqual(r.map(x => x.neg), [false, false, true]);
  assert.equal(r[1].width, 100);
  assert.ok(Math.abs(r[2].width - 100 / 9) < 1e-9, 'a negative value still gets a bar');
  assert.deepEqual(fccRows(FC, 'nope'), []);
  const neg = fccRows({ rows: ['J'], cols: ['a', 'b'], data: [[-0.8, 0.3]] }, 'J');
  assert.ok(neg[0].top && neg[0].neg);
  assert.match(fccSentence(neg, 'J'), /^a has the largest .* lowers .* 0\.80%\.$/);
  assert.match(fccSentence(r, 'J1'), /^v2 .*raises/);
  assert.match(fccSentence(fccRows({ rows: ['J'], cols: ['a'], data: [[0]] }, 'J'), 'J'), /^No step/);
});

test('undefined scaled coefficients and summation values stay missing', () => {
  const missing = { rows: ['J'], cols: ['v1', 'v2'], data: [[null, null]], sums: [null] };
  assert.equal(matrixRows(missing)[0].sum, null);
  const rows = fccRows(missing, 'J');
  assert.ok(rows.every(row => row.value === null && row.width === 0 && !row.top && !row.neg));
  assert.deepEqual(heatCell(rows[0].value), { label: 'n/a', bg: 'transparent' });
  const report = buildReport({ info, ss: { error: 'not available' }, mca: { data: {
    fluxControl: missing, concentrationControl: { ...missing, rows: ['S1'] },
    elasticities: { rows: [], cols: [], data: [] },
  } }, flux: 'J', scan: { state: 'idle', pts: [] } });
  assert.match(report, /\| J \| n\/a \| n\/a \| n\/a \|/);
  assert.match(report, /\| S1 \| n\/a \| n\/a \| n\/a \|/);
});

test('buildCSV: three titled blocks, full precision, quoting', () => {
  const csv = buildCSV({ fluxControl: FC, concentrationControl: CC, elasticities: EE });
  const blocks = csv.trimEnd().split('\n\n');
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].split('\n')[1], 'flux,v1,v2,v3');
  assert.equal(blocks[0].split('\n')[2], 'J1,0.2,0.9,-0.1');
  assert.equal(blocks[1].split('\n')[2], 'S1,0.4,-0.3,-0.1');
  assert.equal(blocks[2].split('\n')[4], 'v3,0');
  assert.ok(blocks[0].startsWith('"Scaled flux control coefficients (rows: fluxes, columns: steps)"'));
  assert.equal(buildCSV(null), '');
  // a model without floating species has empty species matrices: those blocks are dropped, not emitted empty
  assert.equal(buildCSV({ fluxControl: FC, concentrationControl: { rows: [], cols: [], data: [] },
                          elasticities: { rows: [], cols: [], data: [] } }).trimEnd().split('\n\n').length, 1);
});

test('buildReport: every section, and failures read as text rather than vanish', () => {
  const ss = { data: { floatingSpecies: ['S1'], boundarySpecies: ['X0'], reactions: ['v1', 'v2', 'v3'],
    concentrations: { S1: 1.23456 }, rates: { S1: 1e-15 }, values: { X0: 10 }, fluxes: { v1: 2, v2: 2, v3: 0 },
    distance: 1e-14, stability: { maxRealPart: -0.5, stable: true, marginal: false, oscillatory: false } } };
  const scan = { state: 'done', param: 'k1', obs: 'J:v2', base: 2, i: 2, pts: [{ f: 0.5, v: 1 }, { f: 1, v: 2 }] };
  const md = buildReport({ name: 'toy', info, ss, mca: { data: { fluxControl: FC, concentrationControl: CC, elasticities: EE } }, flux: 'J1', scan });
  for(const h of ['# toy - run report', '## Model', '## Steady state', '### Scaled flux control coefficients',
                  '### Scaled concentration control coefficients', '### Scaled elasticities', '## Parameter scan'])
    assert.ok(md.includes(h), h);
  assert.ok(md.includes('Tellurium 2.2.10'));
  assert.ok(md.includes('| S1 | 1.235 | 1e-15 | Floating |'));
  assert.ok(md.includes('| X0 | 10 | fixed | Boundary |'));
  assert.ok(md.includes('| J1 | 0.2 | 0.9 | -0.1 | 1 |'));
  assert.ok(md.includes('| 0.5 | 1 | 1 |'));
  assert.ok(md.includes('max Re(lambda) -0.5; stable.'));

  const bad = buildReport({ info, ss: { error: 'CVODE failed\ntraceback' }, mca: { error: 'no steady state' }, flux: 'v3',
                            scan: { state: 'idle', pts: [] } });
  assert.ok(bad.includes('Not available: CVODE failed') && !bad.includes('traceback'));
  assert.match(bad, /Not available: Control coefficients .* Tellurium reported: no steady state/);
  assert.ok(bad.includes('Not run.'));
  // a closed system at equilibrium: J = 0, so no "largest control" sentence is written about it
  const eq = buildReport({ info, ss: { data: { ...ss.data, fluxes: { v1: 1e-16, v2: 0, v3: 0 } } },
    mca: { data: { fluxControl: { ...FC, rows: ['v1', 'v2'] }, concentrationControl: CC, elasticities: EE } }, flux: 'v1', scan: { state: 'idle', pts: [] } });
  assert.ok(eq.includes('flux through v1 is zero') && !eq.includes('has the largest'));
  assert.equal(buildReport(null), '');
  const withEig = buildReport({ info, ss: { data: { ...ss.data, stability: { ...ss.data.stability, eigenvalues: [[-0.5, 0], [-2, 1]] } } },
    mca: { error: 'x' }, flux: 'v1', scan: { state: 'idle', pts: [] } });
  assert.ok(withEig.includes('| -0.5 | -0.5 | 0 | decays (stable) |'), withEig);
  assert.ok(withEig.includes('| -2 + 1i | -2 | 1 | decays (stable) |'));
  assert.ok(!md.includes('Jacobian eigenvalues'));          // no eigenvalues, no empty table
});

test('eigenRows: a + bi, sorted by real part, sign classified', () => {
  const r = eigenRows({ eigenvalues: [[-1, 2], [0.3, -0.5], [1e-12, 0], [-2, 0], [null, 0]] });
  assert.deepEqual(r.map(e => e.label), ['0.3 - 0.5i', '0', '-1 + 2i', '-2']);
  assert.deepEqual(r.map(e => e.kind), ['grows', 'zero', 'decays', 'decays']);
  assert.deepEqual(eigenRows(undefined), []);
  assert.deepEqual(eigenRows({ error: 'x' }), []);
});

test('scanGeometry: log x axis, y spans zero and the data, baseline at 1x', () => {
  const pts = logFactors(0.25, 4).map(f => ({ f, v: 2 * f }));
  const g = scanGeometry(pts, 0.25, 4);
  const xy = g.points.split(' ').map(p => p.split(',').map(Number));
  assert.equal(xy.length, 25);
  assert.deepEqual(xy[0], [48, 178.8]);          // 190 - 0.5/8*180, to one decimal
  assert.deepEqual(xy[24], [590, 10]);
  assert.equal(g.x1, 319);
  assert.deepEqual([g.yLo, g.yHi, g.min, g.max], [0, 8, 0.5, 8]);
  assert.equal(g.base.v, 2); assert.equal(g.base.x, 319);
  // negative observables and partial (failed) scans
  const n = scanGeometry([{ f: 0.25, v: -1 }, { f: 0.5, v: -3 }], 0.25, 4);
  assert.deepEqual([n.yLo, n.yHi], [-3, 0]); assert.equal(n.base, null);
  assert.equal(scanGeometry([{ f: 1, v: 0 }], 0.5, 2).yHi, 1, 'a flat zero curve still has a height');
});

test('stepStatus: steps 2-4 wait until the model loads', () => {
  const s = (info, ss = 'running', mca = 'running', scan = 'idle') =>
    stepStatus({ info: { state: info }, ss: { state: ss }, mca: { state: mca }, scan: { state: scan } });
  assert.deepEqual(s('empty'), ['idle', 'wait', 'wait', 'wait']);
  assert.deepEqual(s('loading'), ['running', 'wait', 'wait', 'wait']);
  assert.deepEqual(s('failed', 'done', 'done', 'done'), ['failed', 'wait', 'wait', 'wait']);
  assert.deepEqual(s('ok', 'done', 'failed', 'running'), ['done', 'done', 'failed', 'running']);
});

test('steadyRows, stabilityWord, whyNot', () => {
  const rows = steadyRows({ floatingSpecies: ['A'], boundarySpecies: ['B'], concentrations: { A: 1 }, values: { A: 1, B: 5 }, rates: { A: 0 } });
  assert.deepEqual(rows, [{ id: 'A', conc: 1, rate: 0, boundary: false }, { id: 'B', conc: 5, boundary: true }]);
  assert.equal(stabilityWord({ maxRealPart: -1, stable: true, marginal: false, oscillatory: false }), 'stable');
  assert.equal(stabilityWord({ maxRealPart: 0.2, stable: false, marginal: false, oscillatory: true }), 'unstable, oscillatory');
  assert.equal(stabilityWord({ maxRealPart: 0, stable: true, marginal: true, oscillatory: false }), 'marginally stable');
  assert.equal(stabilityWord({ error: 'x' }), 'stability unknown');
  assert.match(whyNot({ ...info, reactions: [] }, null), /no reactions .* control to\.$/, 'nothing was asked, so nothing is attributed to Tellurium');
  assert.match(whyNot({ ...info, floatingSpecies: [] }, 'boom'), /no floating species.*Tellurium reported: boom$/);
  assert.match(whyNot(info, 'boom\nmore'), /could not reach one.*boom$/);
  assert.equal(whySteady(info, 'boom\nmore'), 'boom');
  assert.match(whySteady({ ...info, floatingSpecies: [], reactions: [] }, null), /no floating species.*time course on the Model tab shows how they evolve\.$/);
  assert.ok(zeroFlux(-4e-17) && zeroFlux(0) && !zeroFlux(0.02) && !zeroFlux(null));
});

test('EXAMPLE is the design mock\'s glycolysis model with its default numbers', () => {
  assert.ok(EXAMPLE.includes('model glycolysis_core') && EXAMPLE.includes('Vm3 = 4; K05 = 0.5; h = 2.4; Ki3 = 5;'));
});

test('heatCell keeps runaway values readable', () => {
  assert.equal(heatCell(-8199024286228965).label, '−8.2e+15');
  assert.equal(heatCell(999.994).label, '+999.99');
});

/* ---- run state: the sequencing, driven by fake Tellurium calls ---- */

const LOADED = { ...info, values: { k1: 2, k2: 0, X0: 1 } };
const SOLVED = { distance: 0, values: LOADED.values, fluxes: { v3: 1 }, concentrations: { S1: 1 } };
const flush = () => new Promise(r => setImmediate(r));
/** A fake backend: every call is recorded and answered by `reply[name](query)`. */
function fake(t, reply = {}){
  t.mock.timers.reset(); t.mock.timers.enable({ apis: ['setTimeout'] });   // the 400 ms wait before analysing
  const calls = [], te = {};
  for(const k of ['info', 'steady', 'mca'])
    te[k] = async q => { calls.push([k, q]); return (reply[k] ?? (() => ({ ok: true, result: SOLVED })))(q); };
  let changes = 0;
  const R = runState(te, () => changes++);
  return { R, calls, n: k => calls.filter(c => c[0] === k).length, changes: () => changes,
           settle: async () => { t.mock.timers.tick(400); await flush(); } };
}
// what te_worker does with an override it accepts
const applied = q => ({ ok: true, result: { ...SOLVED, values: { ...LOADED.values, ...q.overrides } } });

test('runState: a reply for an older model is dropped; the same model is not analysed twice', async t => {
  const gate = {};
  const f = fake(t, { steady: q => new Promise(r => { gate[q.model] = r; }) });
  f.R.start('a', LOADED); t.mock.timers.tick(400); await flush();
  f.R.start('b', LOADED); t.mock.timers.tick(400); await flush();
  gate.a({ ok: true, result: { ...SOLVED, from: 'a' } }); await flush();
  assert.equal(f.R.S.ss.state, 'running', 'the reply for "a" must not land on "b"');
  gate.b({ ok: true, result: { ...SOLVED, from: 'b' } }); await flush();
  assert.equal(f.R.S.ss.data.from, 'b'); assert.equal(f.R.S.mca.state, 'done');
  const before = f.calls.length, drawn = f.changes();
  f.R.start('b', LOADED); await f.settle();
  assert.equal(f.calls.length, before); assert.equal(f.changes(), drawn);
});

test('runState: a typed-over model never reaches Tellurium; an empty one is "empty"', async t => {
  const f = fake(t);
  f.R.start('a', LOADED); f.R.start('b', LOADED); await f.settle();
  assert.deepEqual(f.calls.map(c => c[1].model), ['b', 'b']);
  f.R.start('  ', null); await f.settle();
  assert.equal(f.R.S.info.state, 'empty'); assert.equal(f.calls.length, 2);
});

test('runState: no reactions means no MCA call, and a steady state of nothing is not "done"', async t => {
  const rules = { ...LOADED, reactions: [], floatingSpecies: [] };
  const f = fake(t, { info: () => ({ ok: true, result: rules }) });
  f.R.start('rules', null);                      // the run gave no result, so /api/info is asked
  assert.equal(f.R.S.info.state, 'loading');
  await f.settle();
  assert.equal(f.n('info'), 1); assert.equal(f.n('mca'), 0, 'roadrunner crashes the worker on this');
  assert.deepEqual(f.R.S.mca, { state: 'failed', error: null });
  assert.deepEqual(f.R.S.ss, { state: 'failed', error: null });      // solver said ok, on nothing
  assert.deepEqual(stepStatus(f.R.S), ['done', 'failed', 'failed', 'idle']);
});

test('runState: load failure stops there; unconverged and unreachable are failures with a reason', async t => {
  let f = fake(t, { info: () => ({ ok: false, error: 'bad antimony' }) });
  f.R.start('x', null); await f.settle();
  assert.deepEqual(f.R.S.info, { state: 'failed', error: 'bad antimony' });
  assert.equal(f.n('steady') + f.n('mca'), 0);

  f = fake(t, { steady: () => ({ ok: true, result: { ...SOLVED, distance: 3 } }), mca: () => { throw new Error('down'); } });
  f.R.start('x', LOADED); await f.settle();
  assert.match(f.R.S.ss.error, /^steady-state solver did not converge \(residual 3\)$/);
  assert.deepEqual(f.R.S.mca, { state: 'failed', error: 'Backend unreachable: down' });
});

test('runState scan: solves every step, and says why when it cannot', async t => {
  let f = fake(t, { steady: applied });
  f.R.start('m', LOADED); await f.settle();
  await f.R.runScan();
  const sc = f.R.S.scan;
  assert.equal(sc.state, 'done'); assert.equal(sc.pts.length, 25);
  assert.deepEqual([sc.param, sc.obs, sc.base, sc.lo, sc.hi], ['k1', 'J:v3', 2, ...RANGE]);
  assert.equal(f.calls.at(-1)[1].overrides.k1, 2 * RANGE[1]);

  f = fake(t);                                   // the worker ignores the override
  f.R.start('m', LOADED); await f.settle(); await f.R.runScan();
  assert.equal(f.R.S.scan.state, 'failed'); assert.equal(f.R.S.scan.solver, false);
  assert.match(f.R.S.scan.error, /^Tellurium did not apply k1 = 0\.5 \(it reports 2\)/);

  f = fake(t, { steady: q => q.overrides?.k1 > 2 ? { ok: true, result: { ...SOLVED, distance: 1 } } : applied(q) });
  f.R.start('m', LOADED); await f.settle(); f.R.choose('lo', '0.5'); f.R.choose('hi', '2'); await f.R.runScan();
  assert.deepEqual([f.R.pick.lo, f.R.pick.hi], [0.5, 2], 'typed values arrive as text and are kept as numbers');
  assert.equal(f.R.S.scan.solver, true); assert.equal(f.R.S.scan.pts.length, 13, 'the steps that solved are kept');
  assert.match(f.R.S.scan.error, /^steady-state solver did not converge \(residual 1\)$/);

  f.R.choose('param', 'k2'); await f.R.runScan();          // a multiplicative scan of 0 is refused
  assert.equal(f.R.S.scan.state, 'idle');
});

test('runState scan: abandoned when the model changes under it', async t => {
  let go;
  const f = fake(t, { steady: q => q.overrides ? new Promise(r => { go = () => r(applied(q)); }) : { ok: true, result: SOLVED } });
  f.R.start('m', LOADED); await f.settle();
  const done = f.R.runScan(); await flush();
  assert.equal(f.R.S.scan.state, 'running');
  f.R.start('m2', LOADED);
  go(); await done;
  assert.deepEqual(f.R.S.scan, { state: 'idle', pts: [], i: 0 });
  assert.equal(f.calls.filter(c => c[1].overrides).length, 1, 'no further steps are asked for');
});

test('runState picks: which ones throw the scan away', async t => {
  let go, hold = false;
  const f = fake(t, { steady: q => hold ? new Promise(r => { go = () => r(applied(q)); }) : applied(q) });
  f.R.start('m', LOADED); await f.settle();
  const scanned = async () => { await f.R.runScan(); assert.equal(f.R.S.scan.state, 'done'); };
  await scanned();
  f.R.choose('flux', 'v1'); f.R.choose('coeff', 'conc');
  assert.equal(f.R.S.scan.state, 'done', 'neither changes what the scan answered');
  assert.equal(f.R.refFlux(), 'v1'); assert.equal(f.R.pick.coeff, 'conc');
  for(const [k, v] of [['obs', 'S:S1'], ['param', 'X0'], ['param', 'k1'], ['lo', 0.5], ['hi', 100]]){
    if(f.R.S.scan.state !== 'done') await scanned();
    f.R.choose(k, v);
    assert.equal(f.R.S.scan.state, 'idle', k); assert.equal(f.R.pick[k], v);
  }
  hold = true;
  const running = f.R.runScan(); await flush();         // held at its first step
  assert.equal(f.R.S.scan.state, 'running');
  f.R.choose('hi', 7); f.R.choose('obs', 'J:v3');
  assert.equal(f.R.pick.hi, 100, 'the range boxes are dead while it runs');
  assert.equal(f.R.S.scan.state, 'running');
  hold = false; go(); await running;
  assert.equal(f.R.S.scan.state, 'done');
});

/* ---- the Time course caption and status ---- */

test('describeRun: one caption and status per kind of run', () => {
  const c = { start: 0, end: 100, points: 50 };
  const r = { reactions: ['v1', 'v2'], floatingSpecies: ['S1'], globalParameters: ['k1', 'k2', 'k3'], names: ['S1'],
              engine: { tellurium: '2.2.10', roadrunner: '2.7.0' } };
  const eig = { eigenvalues: [[-0.5, 0]], maxRealPart: -0.51234 };
  for(const [name, i, steady, want] of [
    ['time course', r, false,
      ['2 reactions · 1 floating species · 3 parameters · 1 series plotted', '50 pts · t 0–100 · tellurium 2.2.10', 'ok', 'Ready · 12 ms']],
    ['time course ignores settle fields', { ...r, settled: false, unstable: true }, false,
      ['2 reactions · 1 floating species · 3 parameters · 1 series plotted', '50 pts · t 0–100 · tellurium 2.2.10', 'ok', 'Ready · 12 ms']],
    ['rate rules only, no engine', { reactions: [], floatingSpecies: [], globalParameters: ['a'], names: ['x', 'y'] }, false,
      ['1 parameters · 2 series plotted', '50 pts · t 0–100 · tellurium', 'ok', 'Ready · 12 ms']],
    ['settled', { ...r, settled: true, settleTime: 12.3456, steadyStateDistance: 1.23e-9, stability: eig }, true,
      [null, '50 pts · steady state at t≈12.35 · residual 1.2e-9 · max Re(λ) -0.512 · tellurium 2.2.10', 'ok', 'Steady state · 12 ms']],
    ['settled, no eigenvalues', { ...r, settled: true, settleTime: 4, steadyStateDistance: 0, stability: { eigenvalues: [] } }, true,
      [null, '50 pts · steady state at t≈4 · residual 0.0e+0 · tellurium 2.2.10', 'ok', 'Steady state · 12 ms']],
    ['unstable, oscillatory', { ...r, settled: false, unstable: true, stability: { ...eig, maxRealPart: 0.2, oscillatory: true } }, true,
      [null, '50 pts · unstable steady state (oscillatory) · max Re(λ) 0.2 · tellurium 2.2.10', 'err', 'Unstable — no steady state · 12 ms']],
    ['unstable', { ...r, settled: false, unstable: true }, true,
      [null, '50 pts · unstable steady state · tellurium 2.2.10', 'err', 'Unstable — no steady state · 12 ms']],
    ['did not settle', { ...r, settled: false, horizon: 51200 }, true,
      [null, '50 pts · did not settle within t=51200 · tellurium 2.2.10', 'err', 'No settling · 12 ms']],
  ]){
    const d = describeRun(i, steady, c, 12.4);
    if(want[0]) assert.equal(d.summary, want[0], name);
    assert.deepEqual([d.caption, d.kind, d.status], want.slice(1), name);
  }
});

test('eigShort', () => {
  assert.equal(eigShort({ eigenvalues: [[-0.5, 0], [-0.2, 0]] }), ' · λ = -0.2, -0.5');
  assert.match(eigShort({ eigenvalues: [[-1, 0], [-2, 0], [-3, 0]] }, 2), /\(\+1 more\)$/);
  assert.equal(eigShort(undefined), '');
});
