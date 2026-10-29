/* The Claude CLI's counterpart of local-agent.mjs's modelGate and runGate. PreToolUse
   hooks (wired in agent.mjs buildArgs):
   - Edit/Write of the live model: refused until this session has loaded
     pathway-modeling AND opened one of its reference files with Read.
   - Bash running Python: refused until this session has opened at least one Skill
     file (references/, workflows/ or examples/ of mca, tellurium or pathway-modeling)
     with Read, so an analysis is never run on what the model merely remembers.
   Loading the index alone does not pass - stopping at SKILL.md is the failure this
   exists for. Grep hits do not count either: a section relied on is a section read. */
import { readFileSync } from 'node:fs';
import { resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const REF = /[\\/]pathway-modeling[\\/]references[\\/]/;
const ANY_REF = /[\\/]skills[\\/](mca|tellurium|pathway-modeling)[\\/](references|workflows|examples)[\\/]/;
// router.mjs autoBlock puts the index in the prompt instead of a Skill call
const ROUTED = "The pathway-modeling Skill's index is below";

/** Transcript JSONL → { loaded: pathway-modeling loaded, read: one of its references
    read, readAny: any Skill file read }. Only successful, non-empty results count. */
function scan(jsonl) {
  let loaded = false, read = false, readAny = false;
  const pending = new Map();
  for (const line of String(jsonl).split('\n')) {
    if (line.includes(ROUTED)) loaded = true;
    let m; try { m = JSON.parse(line); } catch { continue; }
    const content = m?.message?.content;
    for (const c of Array.isArray(content) ? content : []) {
      if (c?.type === 'tool_use' && c.id) {
        if (c.name === 'Skill' && /(^|:)pathway-modeling$/.test(c.input?.skill ?? '')) pending.set(c.id, 'skill');
        const path = posix.normalize(String(c.input?.file_path ?? '').replaceAll('\\', '/'));
        if (c.name === 'Read' && ANY_REF.test(path) && path.endsWith('.md'))
          pending.set(c.id, REF.test(path) ? 'reference' : 'other');
      }
      if (c?.type === 'tool_result' && pending.has(c.tool_use_id)) {
        const kind = pending.get(c.tool_use_id);
        pending.delete(c.tool_use_id);
        const text = typeof c.content === 'string' ? c.content
          : (Array.isArray(c.content) ? c.content.map(p => p?.text ?? '').join('') : '');
        if (!c.is_error && text.trim()) {
          if (kind === 'skill') loaded = true;
          else { readAny = true; if (kind === 'reference') read = true; }
        }
      }
    }
  }
  return { loaded, read, readAny };
}

/** Transcript JSONL → why the model write is refused, or '' when it may go ahead. Pure. */
export function missing(jsonl) {
  const { loaded, read } = scan(jsonl);
  if (loaded && read) return '';
  return 'REFUSED - building or changing the model needs the pathway-modeling Skill, used, not just loaded. ' +
    (loaded ? '' : 'It has not been loaded in this session. ') +
    (read ? '' : 'None of its reference files has been opened with Read (SKILL.md and Grep hits do not count). ') +
    'Call Skill(pathway-modeling), open with Read the reference files its table routes this change to ' +
    '(rate laws: 02_kinetics_in_a_nutshell.md, appendix_e_enzyme_kinetics_in_a_nutshell.md; ' +
    'stoichiometry and the system equation: 03_stoichiometric_networks.md; feedback, steady state, ' +
    'stability: 12_the_steady_state.md, 13_stability.md), then make this edit again.';
}

/** Transcript JSONL → why running an analysis is refused, or '' when it may go ahead. Pure. */
export function unread(jsonl) {
  return scan(jsonl).readAny ? '' :
    'REFUSED - read the Skills before running an analysis. No Skill file has been opened with Read in ' +
    'this session (loading a Skill, SKILL.md, Glob and Grep hits do not count). Load the Skill this ' +
    'request needs (mca, tellurium or pathway-modeling), open with Read the reference files its routing ' +
    'table points to (skills/<name>/references/<file>.md), then run this again.';
}

/** Python run by Bash, other than the web-access helper. */
export const isAnalysis = cmd => /python/i.test(cmd ?? '') && !/backend[\\/]py[\\/]web\.py/.test(cmd);

/* Hook entry: node model-gate.mjs <absolute live model path>, hook JSON on stdin.
   Exit 2 blocks the tool and hands stderr to the agent. An unreadable hook payload or
   transcript is the harness's fault, not the agent's: let the write through. */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let raw = '';
  for await (const c of process.stdin) raw += c;
  let h; try { h = JSON.parse(raw); } catch { process.exit(0); }
  const bash = h?.tool_name === 'Bash';
  if (bash ? !isAnalysis(h.tool_input?.command) : (() => {
    const p = h?.tool_input?.file_path;
    return !p || resolve(h.cwd ?? '.', p) !== resolve(process.argv[2] ?? '');
  })()) process.exit(0);
  let t; try { t = readFileSync(h.transcript_path, 'utf8'); } catch { process.exit(0); }
  const why = bash ? unread(t) : missing(t);
  if (why) { process.stderr.write(why); process.exit(2); }
}
