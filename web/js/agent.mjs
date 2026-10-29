import { localChat } from './localai.mjs';
import { userQuestion, resultCap, stepBudget, antimonyHint, runTurn } from './oai.mjs';
import { localSystem, SKILL_NOTE } from './prompt.mjs';
import * as api from './api.mjs';

/* The agent, running in the page. Inference happens on the user's machine; the
   numbers come from Tellurium on the server.

   The tool surface is deliberately typed - simulate/steady_state/mca, not
   "run this Python" - so a hosted deployment never executes model-authored code. */

const strip = md => md.replace(/^---\n[\s\S]*?\n---\n/, '').trim();

const cache = new Map();
const text = async url => {
  if (!cache.has(url)) {
    // A rejected promise must not stick around: one transient failure loading a
    // Skill would otherwise fail every later load forever.
    const p = fetch(url).then(r => {
      if (!r.ok) throw new Error('could not load ' + url + ' (HTTP ' + r.status + ')');
      return r.text();
    });
    cache.set(url, p);
    p.catch(() => cache.delete(url));
  }
  return cache.get(url);
};

const HOW_TO_RUN = `THE LIVE MODEL is the Antimony in the user's editor: \`read_model\` returns it,
\`write_model\` replaces it, and that is how the user sees your change.

You cannot execute code here — there is no shell and no Python. Every number comes
from \`simulate\`, \`steady_state\` or \`mca\`, which run real Tellurium (libroadrunner)
on the server. If an analysis needs something those three cannot give, say so plainly
rather than estimating it.`;

export function makeBrowserTools(getModel, setModel, emit){
  const loaded = new Set(), references = new Set();
  const impl = {
    list_skills: async () => (await text('/skills/index.json')).toString(),
    load_skill: async ({ name }) => {
      if(!['mca', 'tellurium', 'pathway-modeling'].includes(name)) throw new Error('unknown Skill: ' + name);
      const md = await text('/skills/' + name + '/SKILL.md');
      if(!md.trim()) throw new Error('the Skill is empty: ' + name);
      loaded.add(name);
      return md + '\n\n(The text above is only the index. Before you answer, read_reference every file it lists that ' +
        'covers the question. There is no limit on how many you read; a question means a file to open. Once ' +
        'what you have read answers the question, stop reading and answer.)';
    },
    read_reference: async ({ path }) => {
      if (!/^skills\/[\w.\-\/]+\.md$/.test(path) || path.split('/').some(part => part === '.' || part === '..'))
        throw new Error('only skills/**.md may be read');
      const md = await text('/' + path);
      if(!md.trim()) throw new Error('the reference is empty: ' + path);
      if(path.startsWith('skills/pathway-modeling/references/')) references.add(path);
      return md;
    },
    read_model: async () => getModel(),
    write_model: async ({ antimony }) => {
      if (!antimony?.trim()) throw new Error('antimony is empty');
      if(!loaded.has('pathway-modeling') || !references.size) return 'REFUSED - building or changing the model needs ' +
        'the pathway-modeling Skill, used, not just loaded. Call load_skill("pathway-modeling"), then open the ' +
        'reference files that cover this change with read_reference("skills/pathway-modeling/references/..."). ' +
        'SKILL.md alone does not count. Then call write_model again.';
      // Gate on load, not on integrating a time course: a valid stiff or
      // currently-singular draft must be saveable here exactly as it is locally
      // (backend/local-agent.mjs write_file uses the same te.call('info') gate).
      const r = await api.info(antimony);
      if (!r.ok) return 'REJECTED - that model does not load: ' + r.error +
                        '\nThe live model is unchanged. Fix it and call write_model again.' +
                        antimonyHint('read_reference');
      setModel(antimony);
      return 'saved; the editor now shows this model';
    },
    simulate: async ({ antimony, start = 0, end = 100, points = 200 }) => {
      const r = await api.simulate({ model: antimony ?? await getModel(), start, end, points });
      if (!r.ok) return 'ERROR: ' + r.error;
      const d = r.result;
      const head = d.names.join('\t');
      const rows = d.t.map((tv,i) => [tv, ...d.cols.map(c=>c[i])]
        .map(v => Number(v).toPrecision(6)).join('\t'));
      const keep = rows.length > 60 ? rows.filter((_,i)=> i % Math.ceil(rows.length/60) === 0) : rows;
      return (d.note ? 'NOTE: ' + d.note + '\n' : '') +
             'time\t' + head + '\n' + keep.join('\n');
    },
    steady_state: async ({ antimony }) => {
      const r = await api.steady({ model: antimony ?? await getModel() });
      if (!r.ok) return 'ERROR: ' + r.error;
      return JSON.stringify(r.result, null, 1);
    },
    mca: async ({ antimony }) => {
      const r = await api.mca({ model: antimony ?? await getModel() });
      if (!r.ok) return 'ERROR: ' + r.error;
      return JSON.stringify(r.result, null, 1);
    },
  };

  const S = (name, description, properties, required = []) => ({
    type: 'function', function: { name, description,
      parameters: { type: 'object', properties, required } } });

  const defs = [
    S('list_skills', 'List the Skills available in this project.', {}),
    S('load_skill', 'Load a Skill before making any claim it is the authority on.',
      { name: { type:'string',
                enum:['mca','tellurium','pathway-modeling'] } }, ['name']),
    S('read_reference', 'Read one reference file named by a Skill, e.g. skills/mca/references/x.md.',
      { path: { type:'string' } }, ['path']),
    S('read_model', 'Read the live Antimony model from the editor.', {}),
    S('write_model', 'Replace the live model. Rejected if it does not load.',
      { antimony: { type:'string' } }, ['antimony']),
    S('simulate', 'Time course from real Tellurium. Omit antimony to use the live model.',
      { antimony:{type:'string'}, start:{type:'number'}, end:{type:'number'}, points:{type:'number'} }),
    S('steady_state', 'Steady state: residual, concentrations, fluxes, Jacobian eigenvalues.',
      { antimony:{type:'string'} }),
    S('mca', 'Scaled flux/concentration control coefficients, elasticities, summation residuals.',
      { antimony:{type:'string'} }),
  ];
  return { impl, defs };
}

/** One turn. Returns { kill }. Events mirror the server runtime's shapes. */
export function runBrowserAgent({ cfg, prompt, history = [], getModel, setModel, onEvent }){
  const ctrl = new AbortController();
  const emit = onEvent;
  let open;   // the last tools offered, re-sent closed on wrap-up (see localChat)
  const chat = ({ messages, tools, schema, onStream }) => {
    if (tools?.length) open = tools;
    return localChat({ ...cfg, messages, tools, closedTools: open, schema, signal: ctrl.signal, onStream });
  };

  (async () => {
    try {
      const tk = makeBrowserTools(getModel, setModel, emit);
      const cap = resultCap(cfg?.contextTokens, cfg?.resultPct);
      const STEPS = stepBudget(cfg?.steps);
      const sys = { liveModel: await getModel(), howToRun: HOW_TO_RUN };
      const loop = { complete: chat, emit, signal: ctrl.signal, cap };
      const name = t => t.defs.map(d => d.function.name);

      const system = localSystem({ ...sys, tools: name(tk) });
      emit(await runTurn({ ...loop, tools: tk, maxSteps: STEPS,
        messages: [{ role:'system', content: system }, ...history, userQuestion(prompt + SKILL_NOTE)] }));
      emit({ type:'done', code: 0 });
    } catch (e) {
      emit({ type:'fatal', error: String(e.message || e) });
      emit({ type:'done', code: 1 });
    }
  })();

  return { kill: () => ctrl.abort() };
}
