/* The Analysis notebook: four steps (import, steady state, control analysis,
   parameter scan), the Elasticities tab, the Time course footer stats, the
   Outline pane and the document status pill.

   Every number shown here was returned by Tellurium through the backend. This
   module only formats, lays out and sequences requests; it never solves. */
import { $, esc, fmt, store } from './util.mjs';
import * as api from './api.mjs';
import { go } from './shell.mjs';

/* ============================ pure, DOM-free ============================ */

export const EXAMPLE = `// Upper glycolysis, Glc to GAP
model glycolysis_core
  compartment cell = 1;
  species Glc in cell, G6P in cell, F6P in cell, FBP in cell, GAP in cell;
  const Glc, GAP;

  HK:  Glc -> G6P;  Vm1*Glc/(Km1 + Glc)*(1 - G6P/Ki1);
  PGI: G6P -> F6P;  Vf2*(G6P - F6P/Keq2)/(Km2 + G6P + F6P);
  PFK: F6P -> FBP;  Vm3*F6P^h/(K05^h + F6P^h)/(1 + FBP/Ki3);
  ALD: FBP -> 2 GAP; Vm4*FBP/(Km4 + FBP);

  // boundary and initial conditions (mM)
  Glc = 5; GAP = 0.1;
  G6P = 0; F6P = 0; FBP = 0;

  // kinetic parameters
  Vm1 = 3; Km1 = 0.5; Ki1 = 5;
  Vf2 = 10; Keq2 = 1; Km2 = 0.5;
  Vm3 = 4; K05 = 0.5; h = 2.4; Ki3 = 5;
  Vm4 = 4.8; Km4 = 1.5;
end`;

export const RANGE = [0.25, 4];               // the scan's default span, × baseline; any other is typed in
export const SCAN_STEPS = 24;                 // log steps, so 25 points; index 12 is exactly 1x
export const SS_TOL = 1e-4;                   // same residual limit te_worker's do_mca uses

const ok = v => typeof v === 'number' && Number.isFinite(v);
/** A scan span Tellurium can be asked for: log steps need 0 < lo < hi. */
export const rangeOk = (lo, hi) => ok(lo) && ok(hi) && lo > 0 && hi > lo;
/** A number for display; Tellurium's NaN/inf arrive as null and stay visibly missing. */
export const num = v => ok(v) ? fmt(v) : 'n/a';
// a value that rounds to zero carries no sign: "−0.00" would claim a direction the digits do not show
const signed = (v, d = 2) => { if(!ok(v)) return 'n/a'; if(v === 0) return '0';
  // dividing by a near-zero rate gives Tellurium values like 8e15; keep those readable
  const s = Math.abs(v) >= 1000 ? Math.abs(v).toExponential(1) : Math.abs(v).toFixed(d);
  return +s === 0 ? s : (v > 0 ? '+' : '−') + s; };
const line1 = e => String(e ?? 'unknown error').trim().split('\n')[0];

/** n log-spaced steps from lo to hi inclusive (n+1 factors). */
export function logFactors(lo, hi, n = SCAN_STEPS){
  return Array.from({ length: n + 1 }, (_, i) => lo * Math.pow(hi / lo, i / n));
}
export const factorLabel = f => (f >= 10 ? f.toFixed(0) : f >= 1 ? f.toFixed(1) : f.toFixed(2)) + '×';

/** Heatmap cell: blue for positive, orange for negative, alpha by magnitude (capped at 1). */
export function heatCell(v){
  if(!ok(v)) return { label: 'n/a', bg: 'transparent' };
  const a = Math.min(Math.abs(v), 1) * 0.5;
  return { label: signed(v), bg: v === 0 ? 'transparent' : `oklch(0.75 0.12 ${v > 0 ? 255 : 50} / ${a.toFixed(2)})` };
}

/** {rows, cols, data} -> [{name, values, sum}] */
export function matrixRows(m){
  // `sums` are te_worker's, taken from Tellurium's matrix: nothing is added up in the browser
  return (m?.rows ?? []).map((name, i) => ({ name, values: m.data[i] ?? [], sum: m.sums?.[i] ?? null }));
}

/** One bar per step for the chosen flux. Width is by |value| against the largest |value|. */
export function fccRows(fc, flux){
  const i = (fc?.rows ?? []).indexOf(flux);
  if(i < 0) return [];
  const vals = fc.data[i];
  const max = Math.max(0, ...vals.filter(ok).map(Math.abs));
  const top = max > 0 ? vals.findIndex(v => ok(v) && Math.abs(v) === max) : -1;
  return fc.cols.map((step, j) => ({
    step, value: vals[j], top: j === top, neg: ok(vals[j]) && vals[j] < 0,
    width: ok(vals[j]) && max > 0 ? Math.abs(vals[j]) / max * 100 : 0,
  }));
}

/** The one sentence under the bars. Says only what a scaled coefficient means. */
export function fccSentence(rows, flux){
  const t = rows.find(r => r.top);
  if(!t) return `No step has a measurable control coefficient on the flux through ${flux}.`;
  return `${t.step} has the largest flux control coefficient on the flux through ${flux} ` +
    `(${signed(t.value, 3)}): a 1% increase in the rate of ${t.step} ${t.neg ? 'lowers' : 'raises'} ` +
    `that steady-state flux by about ${Math.abs(t.value).toPrecision(2)}%.`;
}

const csvCell = s => /[",\n]/.test(String(s)) ? '"' + String(s).replace(/"/g, '""') + '"' : String(s);
const csvMatrix = (title, corner, m) => !m?.rows?.length ? '' :
  [csvCell(title), [corner, ...m.cols].map(csvCell).join(','),
   ...m.rows.map((r, i) => [csvCell(r), ...m.data[i].map(v => ok(v) ? v : '')].join(','))].join('\n');

/** Three titled blocks separated by a blank line, values at full precision. */
export function buildCSV(mca){
  if(!mca) return '';
  return [
    csvMatrix('Scaled flux control coefficients (rows: fluxes, columns: steps)', 'flux', mca.fluxControl),
    csvMatrix('Scaled concentration control coefficients (rows: species, columns: steps)', 'species', mca.concentrationControl),
    csvMatrix('Scaled elasticities (rows: reactions, columns: species)', 'reaction', mca.elasticities),
  ].filter(Boolean).join('\n\n') + '\n';
}

const p4 = v => ok(v) ? String(+v.toPrecision(4)) : 'n/a';
const mdCell = s => String(s).replace(/\|/g, '\\|');
const mdTable = (head, rows) => !rows.length ? '' :
  ['| ' + head.map(mdCell).join(' | ') + ' |', '|' + head.map(() => ' --- ').join('|') + '|',
   ...rows.map(r => '| ' + r.map(mdCell).join(' | ') + ' |')].join('\n');
const mdMatrix = (corner, m, withSum) => mdTable(
  [corner, ...m.cols, ...(withSum ? ['Sum'] : [])],
  matrixRows(m).map(r => [r.name, ...r.values.map(p4), ...(withSum ? [p4(r.sum)] : [])]));

export const obsLabel = o => !o ? '' : o.startsWith('J:') ? 'flux through ' + o.slice(2) : '[' + o.slice(2) + ']';

/** The Time course caption and status line for one run: `i` is Tellurium's result, `c` the window asked for. */
export function describeRun(i, steady, c, ms){
  // a rate-rule model has no reactions and no "floating species"; describe what is
  // actually plotted rather than reporting a pile of zeroes
  const bits = [];
  if(i.reactions.length) bits.push(i.reactions.length+' reactions');
  if(i.floatingSpecies.length) bits.push(i.floatingSpecies.length+' floating species');
  if(i.globalParameters.length) bits.push(i.globalParameters.length+' parameters');
  bits.push(i.names.length+(i.names.length===1?' series':' series')+' plotted');
  const eng = i.engine ? 'tellurium '+i.engine.tellurium : 'tellurium';
  const eig = i.stability?.eigenvalues?.length
    ? ' · max Re(λ) '+(+i.stability.maxRealPart.toPrecision(3)) : '';
  return {
    summary: bits.join(' · '),
    caption: steady
      ? (i.settled
          ? c.points+' pts · steady state at t≈'+(+i.settleTime.toPrecision(4))+
            ' · residual '+i.steadyStateDistance.toExponential(1)+eig+' · '+eng
          : i.unstable
            ? c.points+' pts · unstable steady state'+
              (i.stability?.oscillatory ? ' (oscillatory)' : '')+eig+' · '+eng
            : c.points+' pts · did not settle within t='+(+i.horizon.toPrecision(4))+' · '+eng)
      : c.points+' pts · t '+c.start+'–'+c.end+' · '+eng,
    kind: steady && !i.settled ? 'err' : 'ok',
    status: (steady
               ? (i.settled ? 'Steady state · '
                            : i.unstable ? 'Unstable — no steady state · ' : 'No settling · ')
               : 'Ready · ')+ms.toFixed(0)+' ms',
  };
}

/** Markdown report from a snapshot: {name, info, ss:{data|error}, mca:{data|error}, flux, scan}. */
export function buildReport(s){
  if(!s?.info) return '';
  const { info, ss, mca, scan } = s, out = [];
  out.push('# ' + (s.name || 'MCA run') + ' - run report', '');
  if(info.engine) out.push(`Computed by Tellurium ${info.engine.tellurium} (libRoadRunner ${info.engine.roadrunner}).`, '');
  out.push('## Model', '',
    `- Species: ${info.floatingSpecies.length + info.boundarySpecies.length} ` +
      `(${info.floatingSpecies.length} floating, ${info.boundarySpecies.length} boundary)`,
    `- Reactions: ${info.reactions.length}${info.reactions.length ? ' (' + info.reactions.join(', ') + ')' : ''}`,
    `- Parameters: ${info.globalParameters.length}`, '');

  out.push('## Steady state', '');
  if(ss?.data){
    const d = ss.data, st = d.stability ?? {};
    out.push(mdTable(['Species', 'Concentration', 'dX/dt', 'Type'], steadyRows(d).map(r =>
      [r.id, p4(r.conc), r.boundary ? 'fixed' : p4(r.rate), r.boundary ? 'Boundary' : 'Floating'])), '');
    out.push(`Solver residual ${ok(d.distance) ? d.distance.toExponential(2) : 'n/a'}; ` +
      (ok(st.maxRealPart) ? `max Re(lambda) ${p4(st.maxRealPart)}; ` : '') + stabilityWord(st) + '.', '');
    if(d.reactions?.length) out.push(mdTable(['Reaction', 'Flux'], d.reactions.map(r => [r, p4(d.fluxes[r])])), '');
  } else out.push('Not available: ' + whySteady(info, ss?.error), '');

  out.push('## Control analysis', '');
  if(mca?.data){
    const m = mca.data;
    out.push('### Scaled flux control coefficients', '', 'Rows are fluxes, columns are steps. Summation theorem: each row sums to 1.', '',
      mdMatrix('Flux', m.fluxControl, true), '');
    const rows = fccRows(m.fluxControl, s.flux);
    if(zeroFlux(ss?.data?.fluxes?.[s.flux]))
      out.push(`The steady-state flux through ${s.flux} is zero, so its scaled control coefficients carry no information.`, '');
    else if(rows.length) out.push(fccSentence(rows, s.flux), '');
    out.push('### Scaled concentration control coefficients', '', 'Rows are species, columns are steps. Summation theorem: each row sums to 0.', '',
      mdMatrix('Species', m.concentrationControl, true), '');
    out.push('### Scaled elasticities', '', 'Rows are reactions, columns are species.', '',
      mdMatrix('Reaction', m.elasticities, false), '');
  } else out.push('Not available: ' + whyNot(info, mca?.error), '');

  out.push('## Parameter scan', '');
  if(scan?.pts?.length){
    out.push(`${obsLabel(scan.obs)} against ${scan.param} (baseline ${p4(scan.base)}), ` +
      `${scan.pts.length} of ${SCAN_STEPS + 1} steady states solved` +
      (scan.state === 'failed' ? `; stopped at step ${scan.i}: ${line1(scan.error)}` : '') + '.', '',
      mdTable(['Factor', scan.param, obsLabel(scan.obs)], scan.pts.map(p => [p4(p.f), p4(p.f * scan.base), p4(p.v)])), '');
  } else out.push(scan?.state === 'failed' ? `Failed at step 1: ${line1(scan.error)}` : 'Not run.', '');
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

export function stabilityWord(st){
  if(!st || st.error || !ok(st.maxRealPart)) return 'stability unknown';
  const base = st.stable ? (st.marginal ? 'marginally stable' : 'stable') : 'unstable';
  return base + (st.oscillatory ? ', oscillatory' : '');
}

/** Floating species first (with dX/dt), then boundary species (fixed). */
export function steadyRows(d){
  return [
    ...d.floatingSpecies.map(id => ({ id, conc: d.concentrations?.[id], rate: d.rates?.[id], boundary: false })),
    ...d.boundarySpecies.map(id => ({ id, conc: d.values?.[id], boundary: true })),
  ];
}

const reported = error => error ? ' Tellurium reported: ' + line1(error) : '';

/** Plain words for why control analysis has nothing to show. `error` is Tellurium's, or null when nothing was asked. */
export function whyNot(info, error){
  if(info && !info.reactions.length)
    return 'This model has no reactions (its variables are driven by rules), so there are no fluxes or steps to assign control to.' + reported(error);
  if(info && !info.floatingSpecies.length)
    return 'This model has no floating species, so there is no steady state at which to measure control.' + reported(error);
  return 'Control coefficients and elasticities are only defined at a steady state, and Tellurium could not reach one.' + reported(error);
}

/** Same for the steady state itself. */
export function whySteady(info, error){
  if(info && !info.floatingSpecies.length)
    return 'This model has no floating species, so there is no steady state to solve for.' +
      (info.reactions.length ? '' : ' Its variables are driven by rules; the Time course tab shows how they evolve.') + reported(error);
  return line1(error);
}

/** Scaled coefficients divide by the flux, so at J = 0 they say nothing.
    ponytail: fixed absolute cutoff; make it relative to the model's flux scale if tiny-flux models show up. */
export const zeroFlux = J => ok(J) && Math.abs(J) < 1e-9;

/** Scan chart geometry in the 600x220 viewBox: x is log(factor), y spans 0 and the data. */
export function scanGeometry(pts, lo, hi){
  const X0 = 48, X1 = 590, Y0 = 190, Y1 = 10;
  const vs = pts.map(p => p.v);
  let yLo = Math.min(0, ...vs), yHi = Math.max(0, ...vs);
  if(yHi === yLo) yHi = yLo + 1;
  const x = f => X0 + Math.log(f / lo) / Math.log(hi / lo) * (X1 - X0);
  const y = v => Y0 - (v - yLo) / (yHi - yLo) * (Y0 - Y1);
  const b = pts.find(p => Math.abs(p.f - 1) < 1e-9);
  return {
    points: pts.map(p => x(p.f).toFixed(1) + ',' + y(p.v).toFixed(1)).join(' '),
    x1: x(1), yLo, yHi, min: Math.min(...vs), max: Math.max(...vs),
    base: b ? { x: x(1), y: y(b.v), v: b.v } : null,
  };
}

/** Per-step status from the state: 'done' | 'running' | 'idle' | 'wait' | 'failed'. */
export function stepStatus(s){
  const one = s.info.state === 'ok' ? 'done' : s.info.state === 'failed' ? 'failed'
            : s.info.state === 'loading' ? 'running' : 'idle';
  if(one !== 'done') return [one, 'wait', 'wait', 'wait'];
  return [one, s.ss.state, s.mca.state, s.scan.state];
}

/* ================================ state ================================ */

const idle = () => ({ state: 'idle', pts: [], i: 0 });
/** The error for a steady-state reply the solver did not converge on, else null. */
const unconverged = d => d.distance <= SS_TOL ? null : `steady-state solver did not converge (residual ${num(d.distance)})`;
const call = (fn, q) => fn(q).catch(e => ({ ok: false, error: 'Backend unreachable: ' + (e?.message ?? e) }));

/** The run state and its sequencing, with no DOM: `te` is the three Tellurium calls
    {info, steady, mca} as api.mjs exports them, `changed` runs after every transition. */
export function runState(te, changed){
  const S = {
    src: null,                                   // the model text this state describes
    info: { state: 'empty' },                    // empty | loading | ok{data} | failed{error}
    ss:   { state: 'running' },                  // running | done{data} | failed{error}
    mca:  { state: 'running' },
    scan: idle(),
  };
  let seq = 0, scanSeq = 0, timer = null;
  const pick = { coeff: 'flux', flux: null, param: null, obs: null, lo: RANGE[0], hi: RANGE[1] };

  const info = () => S.info.data;
  const refFlux = () => { const r = info()?.reactions ?? []; return r.includes(pick.flux) ? pick.flux : r.at(-1) ?? null; };
  const scanParams = () => [...(info()?.globalParameters ?? []), ...(info()?.boundarySpecies ?? [])];
  const scanObs = () => [...(info()?.reactions ?? []).map(r => 'J:' + r), ...(info()?.floatingSpecies ?? []).map(s => 'S:' + s)];
  const curParam = () => scanParams().includes(pick.param) ? pick.param : scanParams()[0] ?? null;
  const curObs = () => scanObs().includes(pick.obs) ? pick.obs : (refFlux() ? 'J:' + refFlux() : scanObs()[0] ?? null);
  const baseOf = id => (S.ss.data ?? info())?.values?.[id];

  function start(src, result){
    if(src === S.src) return;                    // same model: what is shown still describes it
    S.src = src;
    seq++; scanSeq++;                            // drops in-flight analysis replies and stops a running scan
    clearTimeout(timer);
    S.scan = idle();
    S.ss = { state: 'running' }; S.mca = { state: 'running' };
    if(!src.trim()){ S.info = { state: 'empty' }; return changed(); }
    S.info = result ? { state: 'ok', data: result } : { state: 'loading' };
    changed();
    const my = seq;
    timer = setTimeout(() => analyse(src, my), 400);
  }

  async function analyse(src, my){
    if(S.info.state !== 'ok'){
      // no result from the run: a model that fails to load, or one that loads but
      // could not be simulated. /api/info only loads it, which tells the two apart.
      const r = await call(te.info, src);
      if(my !== seq) return;
      S.info = r.ok ? { state: 'ok', data: r.result } : { state: 'failed', error: r.error };
      changed();
      if(!r.ok) return;
    }
    // Control analysis needs reactions. Asking anyway is not harmless: roadrunner takes the
    // whole worker down on a rate-rule model, so that case is answered here without a call.
    const i = info();
    const [s, m] = await Promise.all([call(te.steady, { model: src }),
      i.reactions.length ? call(te.mca, { model: src }) : { ok: false, error: null }]);
    if(my !== seq) return;
    S.ss = !s.ok ? { state: 'failed', error: s.error }
         : !i.floatingSpecies.length ? { state: 'failed', error: null }     // "converged" on nothing
         : unconverged(s.result) ? { state: 'failed', error: unconverged(s.result) }
         : { state: 'done', data: s.result };
    S.mca = m.ok ? { state: 'done', data: m.result } : { state: 'failed', error: m.error };
    changed();
  }

  async function runScan(){
    const param = curParam(), obs = curObs(), base = baseOf(param), src = S.src, { lo, hi } = pick;
    if(S.scan.state === 'running' || !param || !obs || !ok(base) || base === 0 || !rangeOk(lo, hi)) return;
    const my = ++scanSeq, fs = logFactors(lo, hi);
    const scan = S.scan = { state: 'running', param, obs, base, lo, hi, pts: [], i: 0, f: fs[0] };
    for(let i = 0; i < fs.length; i++){
      scan.i = i + 1; scan.f = fs[i];
      changed();
      const want = base * fs[i];
      const r = await call(te.steady, { model: src, overrides: { [param]: want } });
      if(my !== scanSeq) return;                 // the model changed under us
      const d = r.result, got = d?.values?.[param];
      const v = !r.ok ? null : obs.startsWith('J:') ? d.fluxes?.[obs.slice(2)] : d.concentrations?.[obs.slice(2)];
      const solver = !r.ok || !!unconverged(d);                 // a real "no steady state", as opposed to a scan we cannot set up
      const error = !r.ok ? r.error
        : solver ? unconverged(d)
        // te_worker skips an override the model rejects; without this the curve would be silently flat
        : !ok(got) || Math.abs(got - want) > 1e-9 * Math.max(1, Math.abs(want))
          ? `Tellurium did not apply ${param} = ${num(want)} (it reports ${num(got)}); the value is probably set by a rule in the model`
        : !ok(v) ? `Tellurium returned no finite value for ${obsLabel(obs)}` : null;
      if(error){ scan.state = 'failed'; scan.error = error; scan.solver = solver; return changed(); }
      scan.pts.push({ f: fs[i], v });
    }
    scan.state = 'done';
    changed();
  }

  function setPick(p){
    Object.assign(pick, p);
    store.set('an.pick', pick);
  }

  /** One selection made in the notebook: `k` is the pick it sets. */
  function choose(k, v){
    const span = k === 'lo' || k === 'hi';
    if(span && S.scan.state === 'running') return;
    setPick({ [k]: span ? +v : v });
    if(k !== 'flux' && k !== 'coeff' && S.scan.state !== 'running') S.scan = idle();   // the old curve answered another question
    changed();
  }

  return { S, pick, info, refFlux, scanParams, scanObs, curParam, curObs, baseOf, start, runScan, choose };
}

const { S, pick, info, refFlux, scanParams, scanObs, curParam, curObs, baseOf, start, runScan, choose } = runState(api, render);
let ctx = null;
let open = { 1: true, 2: false, 3: true, 4: true };
const modelName = () => /^\s*model\s+\*?\s*([A-Za-z_]\w*)/m.exec(S.src ?? '')?.[1] ?? '';

/* ============================== lifecycle ============================== */

export function initAnalysis(c){
  ctx = c;
  open = { ...open, ...store.get('an.open', {}) };
  Object.assign(pick, store.get('an.pick', {}));
  if(!rangeOk(pick.lo, pick.hi)) [pick.lo, pick.hi] = RANGE;
  S.info = { state: c.getModel().trim() ? 'loading' : 'empty' };

  $('#steps').addEventListener('click', onClick);
  $('#steps').addEventListener('change', onChange);
  $('#outline').addEventListener('click', e => {
    const n = e.target.closest('[data-step]')?.dataset.step;
    if(n) jump(+n);
  });
  render();
}

export function onRun(result){ if(ctx) start(ctx.getModel(), result); }

function jump(n){
  go('workspace', 'notes');
  if(n === 1 || S.info.state === 'ok'){ open[n] = true; store.set('an.open', open); }
  render();
  document.getElementById('anStep' + n)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function onClick(e){
  const b = e.target.closest('[data-act]');
  if(!b) return;
  const act = b.dataset.act;
  if(act === 'toggle'){
    const n = +b.dataset.n;
    if(n > 1 && S.info.state !== 'ok') return;
    open[n] = !open[n]; store.set('an.open', open); render();
  }
  else if(act === 'file') ctx.importFile();
  else if(act === 'example') ctx.setModel(EXAMPLE);
  else if(act === 'model'){ e.preventDefault(); go('workspace', 'model'); }
  else if(act === 'coeff') choose(act, b.dataset.v);
  else if(act === 'report' || act === 'coef') ctx[act]();
  else if(act === 'scan') runScan();
}

function onChange(e){
  const k = e.target.dataset.pick, v = e.target.value;
  if(!k) return;
  // the redraw replaces the controls: let the focus land first (Tab from one range box to the next), then put it back
  setTimeout(() => { const f = document.activeElement?.dataset?.pick; choose(k, v); if(f) $(`#steps [data-pick="${f}"]`)?.focus(); });
}

/* =============================== rendering =============================== */

const PILL = { done: ['done', 'Done'], running: ['prog', 'Running'], idle: ['idle', 'Not run'],
               wait: ['idle', 'Waiting on step 1'], failed: ['err', 'Failed'] };
const CHEV = '<svg class="an-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
const errBox = (title, body, extra = '') =>
  `<div class="an-err" role="alert">
     <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/></svg>
     <div><div class="an-err-t">${esc(title)}</div><div class="an-err-b">${body}</div>${extra}</div>
   </div>`;

function subtitles(st){
  const i = info(), J = refFlux(), jv = S.ss.data?.fluxes?.[J];
  const loaded = S.info.state === 'ok';
  return [
    loaded ? (modelName() ? modelName() + ', l' : 'L') + 'oaded by Tellurium' + (i.engine ? ' ' + i.engine.tellurium : '')
      : S.info.state === 'failed' ? line1(S.info.error)
      : S.info.state === 'loading' ? 'Loading the model' : 'No model yet',
    !loaded ? 'Solved automatically after import'
      : st[1] === 'running' ? 'Solving'
      : st[1] === 'failed' ? (S.ss.error ? line1(S.ss.error) : 'No floating species to solve for')
      : (S.ss.data.stability?.stable === false ? 'Converged to an unstable steady state.' : 'Converged.') +
        (J ? ` J = ${num(jv)} through ${J}` : ''),
    !loaded ? 'Computed from the steady state'
      : st[2] === 'running' ? 'Computing'
      : st[2] === 'failed' ? (S.mca.error ? line1(S.mca.error) : 'No reactions to analyse') : 'Scaled control coefficients at the steady state',
    !loaded ? 'Available after step 1'
      : st[3] === 'running' ? `Running, ${S.scan.i} of ${SCAN_STEPS + 1}`
      : st[3] === 'failed' ? `Failed at step ${S.scan.i} of ${SCAN_STEPS + 1}`
      : st[3] === 'done' ? `${obsLabel(S.scan.obs)} against ${S.scan.param}`
      : 'Vary one parameter and record a steady-state observable',
  ];
}

const TITLES = ['Import model', 'Steady state', 'Control analysis', 'Parameter scan'];

function render(){
  const st = stepStatus(S), subs = subtitles(st), loaded = S.info.state === 'ok';
  const bodies = [body1, body2, body3, body4];
  const dl = loaded ? `<div class="an-row an-dl">
      <button class="btn sm" data-act="report" title="Every step of this analysis as one Markdown file">Download report</button>
      <button class="btn sm" data-act="coef" title="Control coefficients and elasticities as CSV"${S.mca.data ? '' : ' disabled'}>Download coefficients (CSV)</button>
    </div>` : '';
  $('#steps').innerHTML = dl + TITLES.map((title, k) => {
    const n = k + 1, locked = n > 1 && !loaded, isOpen = !locked && open[n];
    const [cls, label] = PILL[st[k]];
    return `<section class="an-step${locked ? ' locked' : ''}${isOpen ? ' open' : ''}" id="anStep${n}">
      <button class="an-hd" data-act="toggle" data-n="${n}" aria-expanded="${isOpen}"${locked ? ' disabled' : ''}>
        <span class="an-tt"><span class="an-title">${title}</span><span class="an-sub">${esc(subs[k])}</span></span>
        <span class="pill ${cls}">${label}</span>${CHEV}
      </button>
      ${isOpen ? `<div class="an-body">${bodies[k]()}</div>` : ''}
    </section>`;
  }).join('');

  $('#outline').innerHTML = TITLES.map((title, k) => {
    const sub = st[k] === 'failed' ? (k === 3 ? subs[3] : 'Failed') : k === 3 && st[3] === 'running' ? subs[3]
              : k === 0 && st[0] === 'idle' ? 'Not started' : PILL[st[k]][1];
    return `<button class="an-out" data-step="${k + 1}">
      <span class="an-out-n">0${k + 1}</span>
      <span class="an-out-t"><span class="an-out-l">${title}</span><span class="an-out-s${st[k] === 'failed' ? ' bad' : ''}">${esc(sub)}</span></span>
    </button>`;
  }).join('');

  renderStats();
}

function body1(){
  if(S.info.state === 'empty') return `<div class="an-empty">
      <div class="an-empty-t">Start by importing the model you want to analyze</div>
      <div class="an-empty-b">Choose an Antimony or SBML file. Species, reactions and parameters are read from it by Tellurium, then the steady state is solved.</div>
      <div class="an-row"><button class="btn primary" data-act="file">Choose file</button>
        <button class="btn" data-act="example">Use glycolysis example</button></div>
    </div>`;
  if(S.info.state === 'loading') return '<p class="an-note">Loading the model in Tellurium.</p>';
  if(S.info.state === 'failed') return errBox('Tellurium could not load this model', esc(line1(S.info.error)),
    '<div class="an-row"><button class="btn sm" data-act="model">Open Model tab</button></div>');
  const i = info();
  const tiles = [[i.floatingSpecies.length + i.boundarySpecies.length, 'species', 'species'], [i.reactions.length, 'reaction', 'reactions'],
                 [i.globalParameters.length, 'parameter', 'parameters'], [i.boundarySpecies.length, 'boundary species', 'boundary species']];
  return `<div class="an-tiles">${tiles.map(([v, one, many]) => `<div><div class="an-tile-v">${v}</div><div class="an-tile-k">${v === 1 ? one : many}</div></div>`).join('')}</div>
    <div class="an-rxns mono">${i.reactions.length ? i.reactions.map(esc).join(' · ') : 'No reactions (the model is driven by rules)'}</div>
    <div class="an-links">${i.engine ? `<span class="mono">tellurium ${esc(i.engine.tellurium)} · roadrunner ${esc(i.engine.roadrunner)}</span>` : ''}
      <a href="#" data-act="model">View reactions and rate laws</a></div>`;
}

function body2(){
  if(S.ss.state === 'running') return '<p class="an-note">Solving the steady state in Tellurium.</p>';
  if(S.ss.state === 'failed') return errBox('No steady state', esc(whySteady(info(), S.ss.error)));
  const d = S.ss.data, st = d.stability ?? {}, bad = st.stable === false;
  return `<table class="an-table">
      <thead><tr><th>Species</th><th class="r">Conc.</th><th class="r">dX/dt</th><th class="pad">Type</th></tr></thead>
      <tbody>${steadyRows(d).map(r => `<tr><td class="strong">${esc(r.id)}</td><td class="r mono">${num(r.conc)}</td>
        <td class="r mono muted">${r.boundary ? 'fixed' : !ok(r.rate) ? 'n/a' : r.rate === 0 ? '0' : r.rate.toExponential(1)}</td>
        <td class="pad muted">${r.boundary ? 'Boundary' : 'Floating'}</td></tr>`).join('')}</tbody>
    </table>
    <div class="an-line">Solver residual <span class="mono">${!ok(d.distance) ? 'n/a' : d.distance === 0 ? '0' : d.distance.toExponential(1)}</span>
      ${ok(st.maxRealPart) ? ` · max Re(λ) <span class="mono">${num(st.maxRealPart)}</span>` : ''}
      · <span class="${bad ? 'an-bad' : 'an-good'}">${stabilityWord(st)}</span></div>
    ${bad ? '<p class="an-note">The solver converged, but this state is unstable: the system moves away from it after any small disturbance, so a time course will not settle here.</p>' : ''}
    ${d.reactions.length ? `<div class="an-flux">${d.reactions.map(r =>
      `<span><span class="muted">J ${esc(r)}</span> <span class="mono">${num(d.fluxes[r])}</span></span>`).join('')}</div>` : ''}`;
}

function heatTable(corner, m, withSum){
  return `<div class="an-scroll"><table class="an-table an-heat">
    <thead><tr><th>${corner}</th>${m.cols.map(c => `<th class="c">${esc(c)}</th>`).join('')}${withSum ? '<th class="r">Sum</th>' : ''}</tr></thead>
    <tbody>${matrixRows(m).map(r => `<tr><td class="strong">${esc(r.name)}</td>${r.values.map(v => {
      const c = heatCell(v); return `<td class="c mono" style="background:${c.bg}">${c.label}</td>`; }).join('')}${
      withSum ? `<td class="r mono muted">${signed(r.sum)}</td>` : ''}</tr>`).join('')}</tbody>
  </table></div>`;
}

function body3(){
  if(S.mca.state === 'running') return '<p class="an-note">Computing control coefficients in Tellurium.</p>';
  if(S.mca.state === 'failed') return errBox('Control analysis is not available', esc(whyNot(info(), S.mca.error)));
  const m = S.mca.data, flux = refFlux(), view = ['conc', 'elast'].includes(pick.coeff) ? pick.coeff : 'flux', isFlux = view === 'flux';
  const sum = m.fluxSummation?.[flux], sumOk = ok(sum) && Math.abs(sum - 1) < 1e-6;
  const seg = [['flux', 'Flux control'], ['conc', 'Concentration control'], ['elast', 'Elasticities']].map(([k, l]) =>
    `<button data-act="coeff" data-v="${k}" aria-pressed="${view === k}">${l}</button>`).join('');
  const unstable = S.ss.data?.stability?.stable === false
    ? '<p class="an-note an-bad">These coefficients describe an unstable steady state, one the system does not stay at.</p>' : '';
  let main;
  if(isFlux){
    const rows = fccRows(m.fluxControl, flux);
    main = `<div class="an-row"><label class="an-lbl">Flux
        <select class="field" data-pick="flux">${m.fluxControl.rows.map(r =>
          `<option${r === flux ? ' selected' : ''}>${esc(r)}</option>`).join('')}</select></label></div>
      <div class="an-bars">${rows.map(r => `<div class="an-bar${r.top ? ' top' : ''}${r.neg ? ' neg' : ''}">
        <div class="an-bar-n">${esc(r.step)}</div>
        <div class="an-bar-t"><div class="an-bar-f" style="width:${r.width.toFixed(1)}%"></div></div>
        <div class="an-bar-v mono">${signed(r.value, 3)}</div></div>`).join('')}</div>
      <p class="an-text">${esc(zeroFlux(S.ss.data?.fluxes?.[flux])
        ? `The steady-state flux through ${flux} is zero (${num(S.ss.data.fluxes[flux])}), so its scaled control coefficients, which divide by the flux, carry no information here.`
        : fccSentence(rows, flux))}</p>`;
  } else if(view === 'elast'){
    main = '<p class="an-text">Scaled elasticities: the local sensitivity of each reaction rate to each species, holding everything else fixed.</p>' +
      (!m.elasticities.rows.length || !m.elasticities.cols.length
        ? '<p class="an-note">Tellurium returned an empty elasticity matrix for this model.</p>'
        : stalled() + heatTable('Rate', m.elasticities, false) +
          '<p class="an-cap">Cell shading scales with magnitude. Blue: more of the species speeds the reaction up. Orange: it slows it down.</p>');
  } else {
    main = m.concentrationControl.rows.length
      ? heatTable('Species', m.concentrationControl, true) +
        '<p class="an-cap">Cell shading scales with magnitude. Blue: speeding up the step raises the species. Orange: it lowers it.</p>'
      : '<p class="an-note">This model has no floating species to control.</p>';
  }
  return `<div class="an-row an-between"><div class="an-seg">${seg}</div>
      ${view === 'elast' ? '' : `<span class="an-theorem">Summation theorem check: <span class="mono${isFlux && !sumOk ? ' an-bad' : ''}">${isFlux
        ? 'Σ C<sup>J</sup> = ' + (ok(sum) ? sum.toFixed(4) : 'n/a') + (sumOk ? '' : ' (expected 1)')
        : 'Σ C<sup>X</sup> in the Sum column (expected 0)'}</span></span>`}</div>${unstable}${main}`;
}

function scanChart(scan){
  const { lo, hi } = scan, g = scanGeometry(scan.pts, lo, hi);
  return `<div class="an-chart">
    <div class="an-chart-hd"><span class="strong">${esc(obsLabel(scan.obs))} vs ${esc(scan.param)}, × baseline</span>
      <span class="mono muted">min ${num(g.min)} · max ${num(g.max)}</span></div>
    <svg viewBox="0 0 600 220" role="img" aria-label="${esc(obsLabel(scan.obs))} against ${esc(scan.param)}">
      <line class="ax" x1="48" y1="190" x2="590" y2="190"/><line class="ax" x1="48" y1="10" x2="48" y2="190"/>
      <line class="ax dash" x1="${g.x1.toFixed(1)}" y1="10" x2="${g.x1.toFixed(1)}" y2="190"/>
      <polyline class="ln" points="${g.points}"/>
      ${scan.pts.length === 1 ? `<circle class="pt" cx="${g.points.split(',')[0]}" cy="${g.points.split(',')[1]}" r="3"/>` : ''}
      ${g.base ? `<circle class="base" cx="${g.base.x.toFixed(1)}" cy="${g.base.y.toFixed(1)}" r="4.5"/>
        <text class="lbl" x="${(g.base.x + 8).toFixed(1)}" y="${(g.base.y > 100 ? g.base.y - 10 : g.base.y + 18).toFixed(1)}">baseline ${num(g.base.v)}</text>` : ''}
      <text x="48" y="208">${lo}×</text><text x="${g.x1.toFixed(1)}" y="208" text-anchor="middle">1×</text>
      <text x="590" y="208" text-anchor="end">${hi}×</text>
      <text x="42" y="18" text-anchor="end">${num(g.yHi)}</text><text x="42" y="190" text-anchor="end">${num(g.yLo)}</text>
    </svg></div>`;
}

function body4(){
  const scan = S.scan, running = scan.state === 'running';
  const params = scanParams(), obs = scanObs(), param = curParam(), ob = curObs(), base = baseOf(param);
  if(!params.length) return '<p class="an-note">This model has no parameters or boundary species to vary.</p>';
  if(!obs.length) return '<p class="an-note">This model has no reaction fluxes or floating species to observe.</p>';
  const cant = !ok(base) ? `Tellurium reports no numeric value for ${param}.`
             : base === 0 ? `${param} is 0, and a multiplicative scan of 0 stays at 0. Give it a non-zero value in the Model tab first.`
             : !rangeOk(pick.lo, pick.hi) ? 'The range needs a lowest multiple above 0 and a highest one above that, for example 0.25 to 4.' : '';
  const dis = running ? ' disabled' : '';
  const ctl = `<div class="an-ctl">
      <label class="an-lbl">Parameter<select class="field" data-pick="param"${dis}>${params.map(p =>
        `<option${p === param ? ' selected' : ''}>${esc(p)}</option>`).join('')}</select></label>
      <label class="an-lbl">Observable<select class="field" data-pick="obs"${dis}>${obs.map(o =>
        `<option value="${esc(o)}"${o === ob ? ' selected' : ''}>${esc(obsLabel(o))}</option>`).join('')}</select></label>
      <div class="an-lbl">Range, × baseline (${SCAN_STEPS} log steps)
        <div class="an-opts">
          <input class="field mono" type="number" min="0" step="any" data-pick="lo" value="${esc(pick.lo)}" aria-label="Lowest multiple of the baseline"${dis}>
          <span>to</span>
          <input class="field mono" type="number" min="0" step="any" data-pick="hi" value="${esc(pick.hi)}" aria-label="Highest multiple of the baseline"${dis}></div></div>
      <span class="an-grow"></span>
      <button class="btn primary an-run" data-act="scan"${running || cant ? ' disabled' : ''}>${
        running ? 'Running…' : scan.state === 'idle' ? 'Run scan' : 'Run again'}</button>
    </div>`;
  let out;
  if(cant) out = `<p class="an-note">${esc(cant)}</p>`;
  else if(running) out = `<div class="an-prog">
      <div class="an-prog-l"><span>Solving steady state ${scan.i} of ${SCAN_STEPS + 1}</span>
        <span class="mono muted">${esc(scan.param)} = ${factorLabel(scan.f)}</span></div>
      <div class="an-prog-t"><div style="width:${((scan.i - 1) / (SCAN_STEPS + 1) * 100).toFixed(1)}%"></div></div></div>`;
  else if(scan.state === 'failed'){
    const kept = scan.pts.length;
    out = errBox(`${scan.solver ? 'No steady state' : 'Scan stopped'} at ${factorLabel(scan.f)} ${scan.param}`,
      esc(line1(scan.error)) + (/[.!?]$/.test(line1(scan.error)) ? ' ' : '. ') +
      (kept ? `Steps 1–${kept} solved and are kept.` : 'No steps solved before it.') +
      (scan.solver ? ' Narrow the range, or change the model.' : ''),
      `<div class="an-row"><button class="btn sm" data-act="model">Open Model tab</button></div>`) + (kept ? scanChart(scan) : '');
  }
  else if(scan.state === 'done') out = scanChart(scan);
  else out = `<p class="an-text">Choose a parameter, an observable and a range, then run the scan. Tellurium solves the steady state at each of the ${
    SCAN_STEPS + 1} values (${esc(param)} is currently ${num(base)}) and the observable is plotted against the multiplier.</p>`;
  return ctl + out;
}

function renderStats(){
  const box = $('#simStats');
  if(S.info.state !== 'ok'){ box.innerHTML = ''; return; }
  const J = refFlux(), d = S.ss.data, top = S.mca.data && fccRows(S.mca.data.fluxControl, J).find(r => r.top);
  const stat = (v, k) => `<div><span class="an-stat-v mono">${v}</span> <span class="an-stat-k">${k}</span></div>`;
  const msg = S.ss.state === 'running' ? ['muted', 'Solving steady state']
    : S.ss.state === 'failed' ? ['an-bad', 'No steady state: ' + (S.ss.error ? line1(S.ss.error) : 'the model has no floating species')]
    : d.stability?.stable === false ? ['an-bad', 'Steady state is unstable' + (d.stability.oscillatory ? ' (oscillatory)' : '')]
    : ['an-good', 'Steady state reached'];
  box.className = 'an-stats';
  box.innerHTML = (d && J ? stat(num(d.fluxes[J]), 'flux through ' + esc(J)) : '') +
    (top ? stat(esc(top.step) + ' ' + signed(top.value), 'largest flux control') : '') +
    `<div class="an-stat-m ${msg[0]}">${esc(msg[1])}</div>`;
}

/** Reactions at zero net rate: their scaled elasticities divide by that rate. */
function stalled(){
  const f = S.ss.data?.fluxes ?? {}, z = S.mca.data.elasticities.rows.filter(r => zeroFlux(f[r]));
  return z.length ? `<p class="an-note an-bad">${esc(z.join(', '))} ${z.length === 1 ? 'has' : 'have'} zero net rate at this steady state. Scaled elasticities divide by the rate, so ${
    z.length === 1 ? 'that row is' : 'those rows are'} numerical noise, not sensitivities.</p>` : '';
}

/* ================================ exports ================================ */

export function coefficientsCSV(){ return S.mca.data ? buildCSV(S.mca.data) : ''; }

export function reportMarkdown(){
  if(S.info.state !== 'ok') return '';
  return buildReport({ name: modelName(), info: info(), ss: S.ss, mca: S.mca, flux: refFlux(), scan: S.scan });
}
