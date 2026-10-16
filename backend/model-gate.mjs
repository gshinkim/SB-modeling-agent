/* The Claude CLI's counterpart of local-agent.mjs's modelGate. A PreToolUse hook
   (wired in agent.mjs buildArgs) on Edit/Write of the live model: refused until this
   session has loaded pathway-modeling AND opened one of its reference files with Read.
   Loading the index alone does not pass - stopping at SKILL.md is the failure this
   exists for. Grep hits do not count either: a section relied on is a section read. */
import { readFileSync } from 'node:fs';
import { resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const REF = /[\\/]pathway-modeling[\\/]references[\\/]/;
// router.mjs autoBlock puts the index in the prompt instead of a Skill call
const ROUTED = "The pathway-modeling Skill's index is below";

/** Transcript JSONL → why the write is refused, or '' when it may go ahead. Pure. */
export function missing(jsonl) {
  let loaded = false, read = false;
  const pending = new Map();
  for (const line of String(jsonl).split('\n')) {
    if (line.includes(ROUTED)) loaded = true;
    let m; try { m = JSON.parse(line); } catch { continue; }
    const content = m?.message?.content;
    for (const c of Array.isArray(content) ? content : []) {
      if (c?.type === 'tool_use' && c.id) {
        if (c.name === 'Skill' && /(^|:)pathway-modeling$/.test(c.input?.skill ?? '')) pending.set(c.id, 'skill');
        const path = posix.normalize(String(c.input?.file_path ?? '').replaceAll('\\', '/'));
        if (c.name === 'Read' && REF.test(path) && path.endsWith('.md')) pending.set(c.id, 'reference');
      }
      if (c?.type === 'tool_result' && pending.has(c.tool_use_id)) {
        const kind = pending.get(c.tool_use_id);
        pending.delete(c.tool_use_id);
        const text = typeof c.content === 'string' ? c.content
          : (Array.isArray(c.content) ? c.content.map(p => p?.text ?? '').join('') : '');
        if (!c.is_error && text.trim()) {
          if (kind === 'skill') loaded = true;
          else read = true;
        }
      }
    }
  }
  if (loaded && read) return '';
  return 'REFUSED - building or changing the model needs the pathway-modeling Skill, used, not just loaded. ' +
    (loaded ? '' : 'It has not been loaded in this session. ') +
    (read ? '' : 'None of its reference files has been opened with Read (SKILL.md and Grep hits do not count). ') +
    'Call Skill(pathway-modeling), open with Read the reference files its table routes this change to ' +
    '(rate laws: 02_kinetics_in_a_nutshell.md, appendix_e_enzyme_kinetics_in_a_nutshell.md; ' +
    'stoichiometry and the system equation: 03_stoichiometric_networks.md; feedback, steady state, ' +
    'stability: 12_the_steady_state.md, 13_stability.md), then make this edit again.';
}

/* Hook entry: node model-gate.mjs <absolute live model path>, hook JSON on stdin.
   Exit 2 blocks the tool and hands stderr to the agent. An unreadable hook payload or
   transcript is the harness's fault, not the agent's: let the write through. */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let raw = '';
  for await (const c of process.stdin) raw += c;
  let h; try { h = JSON.parse(raw); } catch { process.exit(0); }
  const p = h?.tool_input?.file_path;
  if (!p || resolve(h.cwd ?? '.', p) !== resolve(process.argv[2] ?? '')) process.exit(0);
  let t; try { t = readFileSync(h.transcript_path, 'utf8'); } catch { process.exit(0); }
  const why = missing(t);
  if (why) { process.stderr.write(why); process.exit(2); }
}
