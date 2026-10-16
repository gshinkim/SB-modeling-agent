/* The Skill router: before a step, one provider — TypeSafe's Jev (API, needs a key) or
   Layla (the local fine-tuned Laya in LAYLA_DIR) — estimates for each Skill not yet
   loaded the probability that the next steps need it. Confident → the SKILL.md goes
   in directly; likely → a one-line hint; otherwise nothing. It only ever adds help:
   off, keyless, failing or slow, the turn runs exactly as it did without it. */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Tellurium, VENV_PY } from './tellurium.mjs';

const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
// Pinned: the thresholds below are tuned against one version; "latest" can move under them.
const JEV_MODEL = 'jev-1.13.0';
const AUTO = 0.85, HINT = 0.5, MAX_AUTO = 3, TIMEOUT_MS = 2000;
export const LAYLA_DIR = 'Layla (altlernative to jev)';
// The first Layla call loads the model (~10 s); warm calls take ~100 ms.
const LAYLA_TIMEOUT_MS = 20000;

/** Exactly one provider per config: 'laya' needs no key, 'jev' (the default) does. */
export const active = cfg => !!cfg?.enabled && (cfg.provider === 'laya' || !!cfg.key);

/** The only Jev-specific code. Throws on HTTP errors or bad JSON. */
export async function jev({ key, state, questions, signal, fetch: f = fetch }) {
  const r = await f(JEV_URL, { method: 'POST', signal,
    headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    body: JSON.stringify({ model: JEV_MODEL, state, questions }) });
  if (r.status === 401 || r.status === 403) throw new Error('Jev rejected the API key');
  if (!r.ok) throw new Error('Jev HTTP ' + r.status);
  const { answers } = await r.json();
  const p = {};
  for (const k of Object.keys(questions))
    if (typeof answers?.[k]?.noul === 'number') p[k] = answers[k].noul;
  return p;
}

/** Layla over a warm Python worker (LAYLA_DIR/serve.py). Throws on any failure, like jev(). */
let worker = null;
export async function laya({ root, state, questions }) {
  worker ??= new Tellurium(root, { python: join(root, LAYLA_DIR, VENV_PY),
    script: join(root, LAYLA_DIR, 'serve.py'), name: 'Layla',
    missing: 'Layla is not set up: train it in ' + LAYLA_DIR });
  const r = await worker.call('predict', { state, questions }, LAYLA_TIMEOUT_MS);
  if (!r.ok) throw new Error(r.error);
  return r.result;
}

/* The frontmatter description, folded (`description: >`) or inline. */
const describe = md => {
  const m = md.match(/^description:[ \t]*(.*)\n((?:[ \t]+.*\n)*)/m);
  if (!m) return '';
  const head = /^[>|]-?$/.test(m[1].trim()) ? '' : m[1].replace(/^["']|["']$/g, '');
  return (head + ' ' + m[2]).replace(/\s+/g, ' ').trim();
};

/* One "noul" per Skill folder, built once per process: a new Skill needs a
   restart, the same as skills/index.json. */
const cache = new Map();
export function questions(root) {
  if (!cache.has(root)) cache.set(root, (async () => {
    const q = {};
    for (const d of await readdir(join(root, 'skills'), { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const md = await readFile(join(root, 'skills', d.name, 'SKILL.md'), 'utf8').catch(() => null);
      if (md) q[d.name] = { type: 'noul', instructions:
        `Given the request and what the agent has already done, will the agent's NEXT steps ` +
        `need the '${d.name}' Skill? That Skill covers: ${describe(md)}` };
    }
    return q;
  })().catch(e => { cache.delete(root); throw e; }));
  return cache.get(root);
}

/** p → { auto, hint } as [name, p] pairs, highest first. Pure. */
export function decide(p, loaded = [], cfg = {}) {
  const auto = [], hint = [];
  Object.entries(p).filter(([k, v]) => !loaded.includes(k) && v >= HINT)
    .sort((a, b) => b[1] - a[1])
    .forEach(e => (cfg.auto && e[1] >= AUTO && auto.length < MAX_AUTO ? auto : hint).push(e));
  return { auto, hint };
}

/* Building or changing a model needs pathway-modeling: the model gates (model-gate.mjs
   for the CLI, local-agent.mjs modelGate) refuse the write without it. So a request
   that asks for one routes it at full confidence, whatever the provider scored -
   measured: the provider routed tellurium and mca for "build a model" and not it. */
export const MODEL_ASK = /\b(build|write|create|make|add|change|modify|edit|extend|remove|replace|set up)\b[^.?!\n]*\b(models?|reactions?|rate laws?|kinetics|feedback|enzymes?|species|moiet(y|ies)|steps?)\b/i;

/** Never throws: any failure is { auto: [], hint: [], error } (plus a forced pathway-modeling). */
export async function route({ cfg, root, request, loaded = [], recent = [], hasModel = false,
                              step = 0, fetch: f, timeout = TIMEOUT_MS, laya: lf = laya }) {
  const t0 = Date.now(), none = { auto: [], hint: [] };
  if (!active(cfg)) return { ...none, ms: 0 };
  const force = MODEL_ASK.test(String(request ?? '')) ? { 'pathway-modeling': 1 } : {};
  try {
    const ask = Object.fromEntries(Object.entries(await questions(root))
      .filter(([k]) => !loaded.includes(k)));
    if (!Object.keys(ask).length) return { ...none, ms: 0 };
    const state = { request: String(request ?? '').slice(0, 2000), loaded: [...loaded],
                    recent: recent.slice(-6), model: hasModel ? 'has model' : 'empty', step };
    const p = cfg.provider === 'laya' ? await lf({ root, state, questions: ask })
      : await jev({ key: cfg.key, questions: ask, fetch: f, signal: AbortSignal.timeout(timeout), state });
    return { ...decide({ ...p, ...force }, loaded, cfg), ms: Date.now() - t0 };
  } catch (e) {
    return { ...decide(force, loaded, cfg), ms: Date.now() - t0,
             error: e?.name === 'TimeoutError' ? 'Jev timed out' : String(e?.message || e) };
  }
}

const fmt = list => list.map(([k, v]) => k + ' ' + v.toFixed(2)).join(', ') || 'none';
export const logLine = r => r.error ? 'router: ' + r.error
  : `router ${r.ms}ms: hint ${fmt(r.hint)} | auto ${fmt(r.auto)}`;

export const hintLine = hint => !hint.length ? '' : '\n\n[router] likely needed: ' +
  hint.map(([k, v]) => `${k} (${v.toFixed(2)})`).join(', ') + '. Load with load_skill / Skill.';

/** The Claude path: SKILL.md text in the prompt, so no Skill turn is spent on it. */
export async function autoBlock(auto, root) {
  let out = '';
  for (const [name] of auto) {
    const md = await readFile(join(root, 'skills', name, 'SKILL.md'), 'utf8').catch(() => null);
    if (md) out += `\n\n[router] The ${name} Skill's index is below; do not load it again. It is only the index: ` +
      `open the reference files it points to before you rely on this Skill, as many of them and as often as you need.\n\n` + md;
  }
  return out;
}

/* One tool call as the router sees it: name, main argument (never file contents or
   a script), and for a failure the error line. Only a result that IS a failure counts:
   a Skill or a file that merely mentions AttributeError is not one. */
export function recentLine(name, args = {}, out = '') {
  const s = String(out), arg = args.name ?? args.path ?? '';
  const stderr = s.includes('[stderr]') || s.includes('[failed]')
    ? s.slice(Math.max(0, s.indexOf('[stderr]'))) : '';
  const err = /^(ERROR:|REFUSED|REJECTED)/.test(s) ? s.split('\n')[0]
    : stderr.split('\n').filter(l => /Error\b|\[failed\]/.test(l)).at(-1);
  return name + (arg ? ' ' + arg : '') + ' -> ' + (err ? err.trim().slice(0, 200) : 'ok');
}
export const failed = line => !line.endsWith('-> ok');
