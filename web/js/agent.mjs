import { localChat } from './localai.mjs';
import { forHistory, userQuestion, toolRunner, toolResult, resultCap, CONTEXT_DEFAULT,
         REPEAT_LIMIT, stripToolSyntax, missingArgs, stepBudget, antimonyHint,
         constrain, quiet, hasNumber, NO_ANSWER } from './oai.mjs';
import { localSystem, SKILL_NOTE } from './prompt.mjs';
import * as api from './api.mjs';

/* The agent, running in the page. Inference happens on the user's machine; the
   numbers come from Tellurium on the server. It does NOT re-implement the
   workflow: it fetches workflows/mca-tellurium.js and runs that exact source,
   supplying its own agent()/phase()/log().

   The tool surface is deliberately typed - simulate/steady_state/mca, not
   "run this Python" - so a hosted deployment never executes model-authored code. */

const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
const strip = md => md.replace(/^---\n[\s\S]*?\n---\n/, '').trim();

const cache = new Map();
const text = async url => {
  if (!cache.has(url)) {
    // A rejected promise must not stick around: one transient failure loading a
    // Skill or the workflow would otherwise fail every later load forever.
    const p = fetch(url).then(r => {
      if (!r.ok) throw new Error('could not load ' + url + ' (HTTP ' + r.status + ')');
      return r.text();
    });
    cache.set(url, p);
    p.catch(() => cache.delete(url));
  }
  return cache.get(url);
};

const TOOL_NAMES = ['list_skills', 'load_skill', 'read_reference', 'read_model',
                    'write_model', 'simulate', 'steady_state', 'mca'];

const HOW_TO_RUN = `THE LIVE MODEL is the Antimony in the user's editor: \`read_model\` returns it,
\`write_model\` replaces it, and that is how the user sees your change.

You cannot execute code here — there is no shell and no Python. Every number comes
from \`simulate\`, \`steady_state\` or \`mca\`, which run real Tellurium (libroadrunner)
on the server. If an analysis needs something those three cannot give, say so plainly
rather than estimating it.`;

/* The workflow otherwise tells every stage to write a script and run it with Bash,
   which this runtime has no way to do. */
const EXEC_NOTE =
  'Compute with the `simulate`, `steady_state` and `mca` tools — they run real ' +
  'Tellurium on the server. There is no shell here, so there is no script to write ' +
  'or save: report the numbers those tools return. If the plan needs something they ' +
  'cannot do, say so in "error" instead of approximating it.';

// Tools that change the project; a repeat of any call is replayed from memory
// (see toolRunner), so anything that writes has to invalidate that memory.
const WRITES = ['write_model', 'run_mca_workflow'];

/* Tools that produce a number. Reading the model is not computing with it. */
const COMPUTES = new Set(['simulate', 'steady_state', 'mca', 'run_mca_workflow']);

function tools(getModel, setModel, emit){
  const impl = {
    list_skills: async () => (await text('/skills/index.json')).toString(),
    load_skill: async ({ name }) => {
      const md = await text('/skills/' + name + '/SKILL.md');
      return md + '\n\n(The text above is only the index. Before you answer, read_reference every file it lists that ' +
        'covers the question. There is no limit on how many you read; a question means a file to open. Once ' +
        'what you have read answers the question, stop reading and answer.)';
    },
    read_reference: async ({ path }) => {
      if (!/^skills\/[\w.\-\/]+\.md$/.test(path)) throw new Error('only skills/**.md may be read');
      return text('/' + path);
    },
    read_model: async () => getModel(),
    write_model: async ({ antimony }) => {
      if (!antimony?.trim()) throw new Error('antimony is empty');
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

async function loop({ chat, system, prompt, tk, schema, emit, signal, maxSteps = 14, stream, cap = resultCap() }){
  const messages = [{ role:'system', content: system }, { role:'user', content: prompt }];
  const run = toolRunner(tk.impl, WRITES);
  const lacks = missingArgs(tk.defs);
  for (let i = 0; i < maxSteps; i++){
    if (signal?.aborted) throw new Error('aborted');
    // On the last step ask with no tools, so the stage ends in an answer rather than
    // in "(kept calling tools without answering)".
    const stuck = run.repeats >= REPEAT_LIMIT;
    const wrapUp = i === maxSteps - 1 || stuck;
    if (wrapUp) emit({ type:'log', text: stuck
      ? 'same call repeated; answering with what it has'
      : 'stage is out of steps; answering with what it has' });
    const m = await chat({ messages, tools: wrapUp ? undefined : tk.defs, onStream: stream });
    messages.push(forHistory(m));
    const calls = m.tool_calls ?? [];
    if (!calls.length){
      if (!schema) return m.content ?? '';
      return constrain({ complete: chat, messages, schema, emit, signal });
    }
    for (const c of calls){
      const name = c.function?.name;
      let args = {}; try { args = JSON.parse(c.function?.arguments || '{}'); } catch {}
      emit({ type:'tools', tools:[{ name, input: args }] });
      const out = lacks(name, args) ?? await run(name, args);
      messages.push(toolResult(c, name, String(out).slice(0, cap)));
    }
  }
  return schema ? constrain({ complete: chat, messages, schema, emit, signal }) : '(kept calling tools without answering)';
}

/** One turn. Returns { kill }. Events mirror the server runtime's shapes. */
export function runBrowserAgent({ cfg, prompt, history = [], getModel, setModel, useWorkflow = true, onEvent }){
  const ctrl = new AbortController();
  const emit = onEvent;
  let open;   // the last tools offered, re-sent closed on wrap-up (see localChat)
  const chat = ({ messages, tools, schema, onStream }) => {
    if (tools?.length) open = tools;
    return localChat({ ...cfg, messages, tools, closedTools: open, schema, signal: ctrl.signal, onStream });
  };

  (async () => {
    try {
      const tk = tools(getModel, setModel, emit);
      const cap = resultCap(cfg?.contextTokens, cfg?.resultPct);
      const STEPS = stepBudget(cfg?.steps);
      const base = localSystem({ tools: TOOL_NAMES, liveModel: await getModel(),
                                 howToRun: HOW_TO_RUN });

      const runWorkflow = async ({ question, needsNumbers = true }) => {
        question = String(question ?? '').trim() || prompt;   // it is always this turn's question
        emit({ type:'workflow_start' });
        const src = await text('/workflows/mca-tellurium.js');
        const body = src.replace(/^\s*export\s+const\s+meta\s*=/m, 'const meta =');
        const agent = async (p, opts = {}) => {
          emit({ type:'phase', phase: opts.phase, label: opts.label });
          return loop({ chat, system: base, prompt: p, tk, schema: opts.schema, emit,
                        signal: ctrl.signal, cap, maxSteps: Math.max(2, STEPS - 2),
                        stream: quiet(emit) });
        };
        const out = await new AsyncFunction('agent','phase','log','args', body)(
          agent,
          t => emit({ type:'phase', phase: t }),
          t => emit({ type:'log', text: String(t) }),
          { question, model: await getModel(), needsNumbers,
            workdir: '(not used — there is no filesystem here)', exec: EXEC_NOTE });
        emit({ type:'workflow_done' });
        return JSON.stringify(out).slice(0, cap);
      };

      const system = base + (useWorkflow
        ? '\n\n## The workflow\n\nYou also have `run_mca_workflow`. Every analysis that needs ' +
          'numbers MUST go through it. Answer directly only for questions needing no computation.'
        : '\n\n## The workflow is off\n\nThe user turned it off because it is slow. Do not ask ' +
          'for it back and do not refuse the work — analyse directly, keeping every rule above.');

      const all = { impl: { ...tk.impl, run_mca_workflow: runWorkflow },
        defs: useWorkflow ? [...tk.defs, { type:'function', function:{
          name:'run_mca_workflow',
          description:'Run the enforced mca-tellurium workflow (frame → plan → execute → validate → interpret → audit).',
          parameters:{ type:'object', properties:{
            question:{type:'string'}, needsNumbers:{type:'boolean'} }, required:['question'] } } }]
          : tk.defs };

      const messages = [{ role:'system', content: system }, ...history, userQuestion(prompt + SKILL_NOTE)];
      const run = toolRunner(all.impl, WRITES);
      const lacks = missingArgs(all.defs);
      let final = '', usedTools = false, computed = false;
      for (let i = 0; i < STEPS; i++){
        if (ctrl.signal.aborted) break;
        const stuck = run.repeats >= REPEAT_LIMIT;
        if (stuck) emit({ type:'log', text:'same call repeated; asking for the answer' });
        const wrapUp = i === STEPS - 1 || stuck;
        const m = await chat({ messages, tools: wrapUp ? undefined : all.defs, onStream: emit });
        messages.push(forHistory(m));
        const calls = m.tool_calls ?? [];
        if (!calls.length){ final = stripToolSyntax(m.content); break; }
        usedTools = true;
        for (const c of calls){
          if (ctrl.signal.aborted) break;   // Stop: the call already in flight finishes, the rest (a write_model, say) never start
          const name = c.function?.name;
          let a = {}; try { a = JSON.parse(c.function?.arguments || '{}'); } catch {}
          emit({ type:'tools', tools:[{ name: name === 'run_mca_workflow' ? 'Workflow' : name, input: a }] });
          if (COMPUTES.has(name)) computed = true;
          const out = lacks(name, a) ?? await run(name, a);
          messages.push(toolResult(c, name, String(out).slice(0, cap)));
        }
      }
      emit({ type:'result', text: final || NO_ANSWER, isError: !final,
             noTools: !usedTools, unverified: !computed && hasNumber(final) });
      emit({ type:'done', code: 0 });
    } catch (e) {
      emit({ type:'fatal', error: String(e.message || e) });
      emit({ type:'done', code: 1 });
    }
  })();

  return { kill: () => ctrl.abort() };
}
