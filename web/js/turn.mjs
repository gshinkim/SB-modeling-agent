// A whole thinking block that merely repeats the deltas just streamed should be
// suppressed. But each workflow phase reasons fresh and often opens with the
// same boilerplate as an earlier phase — comparing against the WHOLE turn's
// `thoughts` buffer would silently drop a genuinely new block over a shared
// opening. Scope the check to the text since the last "— phase —" separator
// (or the whole buffer, for the turn's first phase), i.e. what "immediately
// preceded" this block. Pure so it can be unit-tested without a DOM.
export function isEchoedThought(thoughts, text){
  const t = (text || '').trim();
  if(!t) return false;
  const buf = thoughts || '';
  const sep = /\n\n— [^\n]+ —\n/g;
  let recentStart = 0, m;
  while((m = sep.exec(buf))) recentStart = m.index + m[0].length;
  return buf.slice(recentStart).includes(t.slice(0, 60));
}

/* One chat turn as state. Fed the runtime's events one at a time, it holds what
   send() in chat.mjs then paints; no DOM, so the rules below can be unit-tested.
   `q` is the user's message and `c` the chat: the turn writes c.sessionId and, when
   it ends, c.log and c.history. feed() returns false for an event that changed
   nothing, so the painter skips it. status === null means "no status line".
   Stop is a 'closed' event with `stopped` set: the turn ends there, and whatever the
   runtime still emits afterwards (the hosted agent cannot be interrupted inside a
   tool call) is ignored instead of repainting or logging a turn the user ended. */
export function newTurn(q, c){
  const t = { body:'', thoughts:'', lastPhase:'', status:null, failed:false, logged:false, stopped:false,
              seen:new Set(), chips:new Map(), warns:[] };

  const addTool = tl => {
    const label = tl.name==='Workflow'    ? 'workflow: mca-tellurium'
                : tl.name==='run_python' || tl.name==='python' ? 'python'
                : tl.name==='load_skill'  ? 'skill: '+(tl.input?.name ?? '?')+(tl.input?.by ? ' ('+tl.input.by+')' : '')
                : tl.name==='Skill'       ? 'skill: '+(tl.input?.skill ?? '?')
                : tl.name==='read_file'   ? 'read'
                : tl.name==='write_file'  ? 'write'
                : tl.name==='Bash'        ? 'bash'
                : tl.name.toLowerCase();
    // A repeated call used to render as the same single chip, so a model looping
    // ten times on one tool looked identical to one that worked first time.
    t.chips.set(label, (t.chips.get(label) ?? 0) + 1);
    t.seen.add(label);
  };

  t.feed = ev => {
    if(t.stopped) return false;
    if(ev.type==='session') c.sessionId = ev.sessionId;
    else if(ev.type==='init') t.status = 'Agent started…';
    else if(ev.type==='workflow_start') t.status = 'Running mca-tellurium…';
    else if(ev.type==='workflow_done') t.status = 'Workflow finished, composing the answer…';
    else if(ev.type==='phase'){
      if(ev.phase) t.seen.add('phase:'+ev.phase);
      // Each stage reasons from a fresh context, so without a heading the panel
      // reads as one model repeating itself instead of seven stages making progress.
      if(ev.phase && ev.phase !== t.lastPhase && t.thoughts) t.thoughts += '\n\n— '+ev.phase+' —\n';
      t.lastPhase = ev.phase || t.lastPhase;
      t.status = ev.phase ? 'Phase: '+ev.phase : 'Working…';
    }
    else if(ev.type==='log') t.status = ev.text;
    else if(ev.type==='heartbeat'){
      const m=Math.floor(ev.seconds/60), sec=ev.seconds%60;
      t.status = (t.lastPhase?'Phase: '+t.lastPhase+' · ':'Working · ')+(m?m+'m ':'')+sec+'s';
    }
    else if(ev.type==='tools'){
      ev.tools.forEach(tl=>addTool(tl));
      t.body='';    // preamble before a tool call is not the answer
    }
    else if(ev.type==='unthink'){
      // the model's template pre-opened <think>: what streamed as the answer
      // was really the scratchpad, so move it into the thinking panel
      t.thoughts += t.body; t.body='';
    }
    else if(ev.type==='thinking'){
      // a whole block repeats what the deltas already streamed this phase
      if(ev.whole && isEchoedThought(t.thoughts, ev.text)) return false;
      if(ev.tools) ev.tools.forEach(tl=>addTool(tl));
      // streamed deltas concatenate; only whole blocks get a separator, or every
      // token lands on its own line
      t.thoughts += (ev.whole && t.thoughts && !t.thoughts.endsWith('\n') ? '\n\n' : '') + ev.text;
    }
    else if(ev.type==='delta'){ t.body += ev.text; t.status = null; }
    else if(ev.type==='result'){
      if(ev.text) t.body = ev.text;
      t.status = null;
      t.warns = [];
      if(ev.unverified && t.body)
        t.warns.push('No computation was run this turn — any number above came from '+
                     'the model, not from Tellurium.');
      if(ev.noTools && t.body)
        // a model that answers a question about the model without ever reading it
        t.warns.push('No tools were called — nothing here was checked against the '+
                     'model or Tellurium.');
    }
    else if(ev.type==='fatal') t.failed = true;
    else if(ev.type==='done' || ev.type==='closed'){
      // 'done' (agent) and 'closed' (stream end) both arrive on the server path
      t.status = null;
      // The page is only leaving this turn (another project was opened): the turn runs on
      // at the server and is logged whole when a page comes back to it, so nothing now.
      if(ev.detached){ t.stopped = t.logged = true; return true; }
      if(ev.stopped) t.stopped = true;
      if(!t.logged){
        t.logged = true;
        // A turn stopped before it produced anything, or one that failed outright,
        // is not a real exchange — don't persist a "(no answer)" pair for it.
        if(!t.failed && (t.body || ev.type === 'done')){
          c.log.push({ q, a: t.body, tools: [...t.seen].filter(x => !x.startsWith('phase:')) });
          const acts = [...t.seen].filter(x => !x.startsWith('phase:'));
          c.history.push({ role:'user', content: q });
          c.history.push({ role:'assistant', content: (t.body || '(no answer)') +
            (acts.length ? '\n\n[tools used this turn: '+acts.join(', ')+']' : '') });
          // The server path keeps memory in history.md and never reads this; only the
          // hosted in-browser agent does, so keep it bounded.
          if(c.history.length > 24) c.history.splice(0, c.history.length - 24);
        }
      }
    }
    return true;
  };
  return t;
}
