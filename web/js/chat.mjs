import { $, store, flash, esc } from './util.mjs';
import { S } from './state.mjs';
import * as api from './api.mjs';
import { resolveModel, useWorkflow, scratchDir, router, web, initWeb, openSettings } from './settings.mjs';
import { runBrowserAgent } from './agent.mjs';
import { renderMarkdown } from './md.mjs';
import './latex.mjs';            // <latex-doc> and late MathJax upgrades for what renderMarkdown emits
import { downloadChat } from './export.mjs';
import { currentId, savedId, saveSoon, openSessionById, deleteSessionById } from './session.mjs';
import { pickSession } from './sessionpicker.mjs';
import { showSide, go } from './shell.mjs';
import { newTurn, stepText, lineDiff } from './turn.mjs';


let abort = null, onModelChanged = () => {};
export const setOnModelChanged = fn => { onModelChanged = fn; };

/* Conversations live in this module: no localStorage. On a local install session.mjs
   saves them with the project (dumpChats) and opening the project brings them back
   (loadChats); hosted keeps nothing, so there a reload or a closed tab loses every log. */
const chats = [];
let active = null, seq = 0;
const cur = () => chats.find(c => c.id === active);

/* Sessions persist conversations to disk, so the array stops being private to this
   module. `thread` is a live DOM node and never travels; everything else does.
   No `summary` field: the real rolling memory lives server-side in summary.md,
   keyed by sessionDirId — a per-chat `summary` was dead weight nothing ever read
   back, left over from before that server-side memory existed. Pure, so the
   persisted shape is testable without a DOM; dumpChats calls this directly rather
   than re-implementing the mapping. */
export function chatSnapshot(list){
  return list.map(({ id, title, history, sessionId, log }) => ({ id, title, history, sessionId, log }));
}
export const dumpChats = () => chatSnapshot(chats);

// Replaying a session re-parses markdown and builds DOM for every turn ever logged
// (log, unlike history, is never trimmed). Cap what gets REPLAYED on open; the full
// log stays on disk for export. Pure so it can be unit-tested without a DOM.
export const REPLAY_CAP = 20;
export function replaySlice(log, cap = REPLAY_CAP){
  const turns = log ?? [];
  if(turns.length <= cap) return { turns, skipped: 0 };
  return { turns: turns.slice(-cap), skipped: turns.length - cap };
}

/* Project switching stops the running turn first: session.mjs does that through this
   (main.mjs hands it over), so no caller has to remember to. */
export const stopTurn = (real = true) => { if(abort){ abort(real); abort=null; $('#send').textContent='Send'; } };

export function loadChats(saved){
  chats.forEach(c => c.thread.remove());
  chats.length = 0; active = null;
  for(const s of saved ?? []){
    const thread = document.createElement('div');
    thread.className = 'thread';
    $('#msgs').append(thread);
    chats.push({ ...s, thread });
    seq = Math.max(seq, s.id ?? 0);
    const { turns, skipped } = replaySlice(s.log);
    if(skipped){
      const m = document.createElement('div'); m.className = 'meta';
      m.textContent = skipped + (skipped === 1 ? ' earlier turn is' : ' earlier turns are') +
                      ' not shown here — still in the full log this chat exports.';
      thread.append(m);
    }
    for(const turn of turns){
      const d = document.createElement('div'); d.className = 'msg me';
      d.textContent = turn.q; thread.append(d);
      thread.append(replayAnswer(turn));
    }
  }
  if(!chats.length) makeChat(); else show(chats.at(-1).id);
}

/* Called by main.mjs's setAll after loadChats(), when the session just opened had
   no saved model snapshot. main.mjs deliberately leaves the editor untouched in
   that case — but that means the editor is silently
   still showing whatever project was open before. Flag it, the same way an
   unverified answer or a tool-less turn already gets flagged above. */
export function noteNoModel(){
  const d = document.createElement('div'); d.className = 'meta warn';
  d.textContent = 'This session has no saved model — the editor still shows the '+
                  'previous project’s model, not this session’s.';
  (cur()?.thread ?? $('#msgs')).append(d);
  $('#msgs').scrollTop = 1e9;
}

function makeChat(){
  const thread = document.createElement('div');
  thread.className = 'thread';
  $('#msgs').append(thread);
  const c = { id: ++seq, title: 'New chat', thread, history: [], sessionId: null, log: [] };
  chats.push(c);
  show(c.id);
  return c;                                    // an empty thread shows the logo and a prompt (app.css .thread:empty)
}

/* Deletes the chat on screen. The project's history.md, the AI's memory of the
   project, is kept: it is one record for the whole project, not per chat. */
function deleteChat(){
  const c = cur(); if(!c) return;
  if(c.history.length && !confirm('Delete the chat "' + c.title + '"?\n\nIts messages are removed ' +
       'from this project. The project history the AI remembers is kept.')) return;
  stopTurn();
  c.thread.remove();
  chats.splice(chats.indexOf(c), 1);
  if(chats.length) show(chats.at(-1).id); else makeChat();
  // a saved project must forget it; an unsaved one has nothing on disk to update,
  // and a touching saveSoon() would create a folder for it
  saveSoon(false);
}

function show(id){
  active = id;
  chats.forEach(c => { c.thread.hidden = c.id !== id; });
  renderChatPick();
  $('#msgs').scrollTop = 1e9;
}

/** Open a search hit's conversation, including one that is not currently selected. */
export function openChat(id){
  const c = chats.find(chat => String(chat.id) === String(id));
  if(!c) return false;
  if(active !== c.id) stopTurn();
  go('workspace'); showSide('chat'); show(c.id);
  return true;
}

function renderChatPick(){
  const sel = $('#chatPick'); if(!sel) return;
  sel.textContent = '';
  chats.forEach(c => {
    const o = document.createElement('option');
    o.value = c.id; o.textContent = c.title; sel.append(o);
  });
  sel.value = active;
}

function bubble(who, html){
  const d=document.createElement('div'); d.className='msg '+who; d.innerHTML=html;
  (cur()?.thread ?? $('#msgs')).append(d); $('#msgs').scrollTop=1e9; return d;
}

/* The chat is docked in the inspector: opening it means showing that pane. */
export function toggleChat(force){
  if(force === false) return;
  showSide('chat');
  setTimeout(()=>$('#ask').focus(),120);
}

/** Send `text` as the user's next message — Search's "ask the assistant". */
export function ask(text){
  toggleChat(true);
  $('#ask').value = text;
  send();
}

/* ---------------- attachments: files and photos sent with the next message ---------------- */
const ATT_MAX = 10, ATT_BYTES = 8e6;      // the server stops at 10 too; 8 MB is a large phone photo
let attached = [];
function renderAttached(note = ''){
  const L = $('#attList');
  L.hidden = !attached.length && !note;
  L.innerHTML = attached.map((f, i) =>
    `<span class="att">${esc(f.name)}<button type="button" data-i="${i}" aria-label="Remove ${esc(f.name)}">×</button></span>`).join('') +
    (note ? `<span class="att-note">${esc(note)}</span>` : '');
}
function attach(files){
  const big = [...files].filter(f => f.size > ATT_BYTES).map(f => f.name);
  attached = [...attached, ...[...files].filter(f => f.size <= ATT_BYTES)].slice(0, ATT_MAX);
  renderAttached(big.length ? big.join(', ') + (big.length === 1 ? ' is' : ' are') + ' over 8 MB and was not attached' : '');
}
const base64 = f => new Promise((ok, no) => { const r = new FileReader();
  r.onload = () => ok({ name: f.name, type: f.type, data: String(r.result).split(',')[1] ?? '' });
  r.onerror = () => no(r.error); r.readAsDataURL(f); });

/* The assistant's side of one turn on screen: its bubble, thinking panel, tool chips
   and status line, painted from the events fed to the returned handle(). send() uses
   it for a turn it starts, resumeLive() for one found already running. `started` is
   when the turn began, for the "Thought for" time. */
/* The pieces of an answer, shared by a live turn (turnUi) and one replayed when a
   project is reopened (loadChats), so both look the same. */
function stepsEl(){
  const el = document.createElement('div'); el.className = 'agent-run'; el.hidden = true;
  el.innerHTML = '<div class="ar-hd">Agent execution</div><ol class="ar-steps"></ol>';
  return el;
}
function stepLi(label, n){
  const li = document.createElement('li');
  li.className = label.startsWith('phase:') ? 'ar-step phase' : 'ar-step';
  li.title = label.startsWith('phase:') ? '' : label;
  li.textContent = stepText(label) + (n > 1 ? ' ×' + n : '');
  return li;
}
function thinkEl(){
  // native <details>: free keyboard access, free open/close state, no JS
  const el = document.createElement('details'); el.className = 'think'; el.hidden = true;
  el.innerHTML = '<summary><span class="tk-dot"></span><span class="tk-label">Thinking</span>' +
                 '<span class="tk-time"></span></summary><div class="tk-body"></div>';
  return el;
}
const thoughtFor = secs => 'Thought for ' + (secs >= 60 ? Math.floor(secs / 60) + 'm ' + (secs % 60) + 's' : secs + 's');

/** A logged turn's answer, as it looked when it ran. Turns saved before steps were
    logged have only `tools`, one per name. */
function replayAnswer(turn){
  const a = document.createElement('div'); a.className = 'msg ai';
  const steps = turn.steps ?? (turn.tools ?? []).map(x => [x, 1]);
  if(steps.length){
    const run = stepsEl(); run.hidden = false; run.classList.add('ended');
    const ol = run.querySelector('ol'); for(const [x, n] of steps) ol.append(stepLi(x, n));
    a.append(run);
  }
  if(turn.thoughts){
    const tk = thinkEl(); tk.hidden = false; tk.classList.add('done');
    tk.querySelector('.tk-label').textContent = turn.secs ? thoughtFor(turn.secs) : 'Thinking';
    tk.querySelector('.tk-body').textContent = turn.thoughts;
    a.append(tk);
  }
  for(const ch of turn.changes ?? []) a.append(changeCard(ch.before, ch.after, ch));
  const txt = document.createElement('div'); txt.className = 'txt';
  txt.innerHTML = renderMarkdown(turn.a || '*(no answer)*');
  a.append(txt);
  return a;
}

/* The agent's model edit, shown where it happened: the lines it changed, what
   Tellurium made of the new model (main.mjs announces each run as 'mca:run'), and
   a way back to the model as it was. */
function changeCard(before, after, rec = { before, after, run: null }){
  const { removed, added } = lineDiff(before, after);
  const lines = [...removed.map(l => '<div class="del">− ' + esc(l) + '</div>'),
                 ...added.map(l => '<div class="add">+ ' + esc(l) + '</div>')];
  const card = document.createElement('div'); card.className = 'change-card';
  card.innerHTML = '<div class="cc-hd"><span class="cc-t">Model change</span>' +
    '<span class="cc-n mono"><span class="add">+' + added.length + '</span> <span class="del">−' + removed.length + '</span></span>' +
    '<span class="spacer"></span><button class="btn sm" type="button" data-revert>Revert</button></div>' +
    '<div class="cc-diff mono">' + (lines.slice(0, 14).join('') || '<div class="muted">Only the order of lines changed</div>') +
    (lines.length > 14 ? '<div class="muted">… ' + (lines.length - 14) + ' more</div>' : '') + '</div>' +
    '<div class="cc-run"></div>';
  const run = card.querySelector('.cc-run');
  // `rec` is what the turn's log keeps of this card: a replayed card shows the saved result
  const showRun = r => { run.textContent = r.text; run.classList.add(r.ok ? 'ok' : 'bad'); };
  if(rec.run) showRun(rec.run);
  else {
    run.textContent = 'Re-solving with Tellurium…';
    addEventListener('mca:run', e => { rec.run = e.detail; showRun(e.detail); saveSoon(); }, { once: true });
  }
  card.querySelector('[data-revert]').onclick = e => {
    if(!onModelChanged(before)) return;
    e.target.disabled = true; e.target.textContent = 'Reverted';
  };
  return card;
}

function turnUi(c, v, started = Date.now()){
  $('#send').textContent='Stop';
  const wrap = bubble('ai','');
  // what the agent did, as a checklist: the last step spins until the turn ends
  const phase = stepsEl(), steps = phase.querySelector('ol');
  wrap.append(phase);
  const think = thinkEl();
  wrap.append(think);
  const tkBody = think.querySelector('.tk-body');
  const tkLabel = think.querySelector('.tk-label');
  const tkTime = think.querySelector('.tk-time');

  const text = document.createElement('div'); text.className='txt'; wrap.append(text);
  // its own line: status used to be written into `text`, so one 'log' event
  // mid-stream erased everything the model had already said
  const stat = document.createElement('div'); stat.className='stat-line'; wrap.append(stat);
  const t = newTurn(v, c);
  t.started = started;
  const els = new Map();
  let shown;

  const paintChips = () => {
    for(const x of t.seen){
      const isPhase = x.startsWith('phase:'), n = t.chips.get(x);
      let el = els.get(x);
      if(!el){ el = stepLi(x, n); steps.append(el); els.set(x, el); phase.hidden = false; }
      el.textContent = stepText(x) + (n > 1 ? ' ×'+n : '');
    }
  };
  // only when it changed: rewriting the line restarts its dots animation
  const paintStatus = () => {
    if(t.status === shown) return;
    shown = t.status;
    if(shown === null) stat.textContent='';
    else stat.innerHTML = '<span class="thinking">'+esc(shown)+'</span>';
  };
  const paintThoughts = () => { if(tkBody.textContent !== t.thoughts) tkBody.textContent = t.thoughts; };
  t.status = useWorkflow() ? 'Starting the model-scientist agent…'
                           : 'Starting the model-scientist agent (workflow off)…';
  paintStatus();

  // Stop ends this turn now and only then tells the runtime, which may answer late
  // or not at all. `abort` is this one function for the whole turn, so the turn can
  // tell whether it is still the running one before it clears the global.
  // `real` false only leaves the turn (another project is being opened): the server
  // keeps running it, and resumeLive() picks it up when this project is opened again.
  const ui = { kill: null, t };
  const stop = (real = true) => { handle({ type:'closed', stopped:true, detached:!real }); ui.kill?.(real); };
  abort = stop;

  // turn.mjs decides what the event means; this only paints the result
  const handle = ev => {
      if(!t.feed(ev)) return;
      paintStatus();
      if(ev.type==='phase'){ paintChips(); paintThoughts(); return; }
      if(ev.type==='tools'){ paintChips(); text.textContent=''; $('#msgs').scrollTop=1e9; return; }
      if(ev.type==='unthink'){ text.textContent=''; think.hidden=false; paintThoughts(); return; }
      if(ev.type==='thinking'){
        paintChips();
        think.hidden = false;
        paintThoughts();
        if(think.open) $('#msgs').scrollTop=1e9;
        return;
      }
      if(ev.type==='delta'){ text.textContent = t.body; $('#msgs').scrollTop=1e9; return; }
      if(ev.type==='result'){
        if(t.body) text.innerHTML = renderMarkdown(t.body);
        else text.textContent = '(no answer returned)';
        if(t.thoughts){
          const secs = Math.max(1, Math.round((Date.now()-started)/1000));
          tkLabel.textContent = thoughtFor(secs);
          tkTime.textContent = '';
          think.classList.add('done');
        }
        for(const msg of t.warns){
          const w=document.createElement('div'); w.className='meta warn';
          w.textContent=msg;
          wrap.append(w);
        }
        if(ev.ms) { const m=document.createElement('div'); m.className='meta';
                    m.textContent = (ev.ms/1000).toFixed(1)+'s · '+(ev.turns??0)+' turns'; wrap.append(m); }
        return;
      }
      if(ev.type==='model_changed'){
        const before = $('#model').value;
        if(onModelChanged(ev.src)){ const rec = { before, after: ev.src, run: null }; t.changes.push(rec);
                                    wrap.insertBefore(changeCard(before, ev.src, rec), text); }
        return;
      }
      if(ev.type==='fatal'){ text.innerHTML = '<span class="err">'+esc(ev.error)+'</span>'; return; }
      if(ev.type==='done' || ev.type==='closed'){
        phase.classList.add('ended');
        if(t.body && !text.innerHTML.trim()) text.innerHTML = renderMarkdown(t.body);
        if(t.thoughts && !think.classList.contains('done')){
          const secs = Math.max(1, Math.round((Date.now()-started)/1000));
          tkLabel.textContent = thoughtFor(secs);
          think.classList.add('done');
        }
        if(!t.body && !t.failed && ev.type==='done' && ev.code) text.innerHTML =
          '<span class="err">The agent exited with code '+ev.code+'. Check the server log.</span>';
        // a finished turn's late 'closed' must not clear the stop handle of the next one
        if(abort === stop){ abort=null; $('#send').textContent='Send'; }
        $('#msgs').scrollTop=1e9;
        saveSoon();
      }
  };
  ui.handle = handle;
  return ui;
}

function send(){
  const files = attached;
  // a photo on its own is a question too
  const v = $('#ask').value.trim() || (files.length ? 'Look at what I attached.' : '');
  if(!v || abort) return;
  const c = cur() ?? makeChat();
  if(!c.history.length){                       // name the conversation by its opening line
    c.title = v.length > 34 ? v.slice(0,33)+'…' : v;
    renderChatPick();
  }
  bubble('me', esc(v) + (files.length ? '<div class="att-sent">' + files.map(f => esc(f.name)).join(' · ') + '</div>' : ''));
  attached = []; renderAttached();
  $('#ask').value=''; $('#ask').style.height='auto';

  const rt  = resolveModel(store.get('modelSel','cc:'));
  const ui = turnUi(c, v);

  if(rt.runtime === 'openai' && S.env?.hosted){
    // Hosted: this server is not the user's machine, so it cannot reach their model
    // runtime. The agent runs in the page instead — which is why a hosted setup still
    // needs the model server to allow this origin. Locally we never take that path.
    const a = runBrowserAgent({
      cfg: rt.chatCfg, prompt: v, history: c.history, useWorkflow: useWorkflow(),
      getModel: () => $('#model').value,
      setModel: src => { $('#model').value = src;
                         $('#model').dispatchEvent(new Event('input',{bubbles:true})); },
      onEvent: ui.handle,
    });
    ui.kill = () => a.kill();
  } else {
    // Save first: the turn's memory (history.md) and files go in the project's folder,
    // which must exist — and have its final name — before the agent starts.
    Promise.all([Promise.all(files.map(base64)), savedId()]).then(([attachments, project]) => {
      if(ui.t.stopped) return;
      const off = api.chat({ message: v, chat: c.id, sessionId: c.sessionId, sessionDirId: project,
                         resume: !!c.sessionId, ...rt, scratchDir: scratchDir(),
                         useWorkflow: useWorkflow(), router: router(), web: web(), attachments }, ui.handle);
      // closing the stream no longer stops the turn: Stop has to ask the server
      ui.kill = real => { if(real) api.stopChat(project); off(); };
    }, e => ui.handle({ type: 'fatal', error: 'Could not read the attachment: ' + (e?.message ?? e) }));
  }
}

/* A page closed or reloaded mid-turn left the agent working (backend/live.mjs). Called
   when a project is opened: if its turn is still running, or finished unseen, show the
   question again and replay the whole turn into a fresh bubble, then follow it live. */
export function resumeLive(){
  const project = currentId();
  if(abort || !project || S.env?.hosted) return;
  let ui = null;
  const off = api.live(project, ev => {
    if(ev.type === 'none' || currentId() !== project) return;
    if(ev.type === 'live'){
      if(abort) return off();                          // a turn was started here in the meantime
      const c = chats.find(x => x.id === ev.chat) ?? cur() ?? makeChat();
      show(c.id);
      bubble('me', esc(ev.q) + (ev.files?.length ? '<div class="att-sent">' + ev.files.map(esc).join(' · ') + '</div>' : ''));
      ui = turnUi(c, ev.q, ev.at);
      ui.kill = real => { if(real) api.stopChat(project); off(); };
      return;
    }
    ui?.handle(ev);
  });
}

/* The log is the markdown the model actually sent, not a scrape of the rendered
   DOM: what gets saved is the source, so it re-renders anywhere. */
function exportChat(){
  const c = cur();
  if(!c?.log.length) return flash($('#chatSave'), '—');
  const proj = document.querySelector('#projName')?.textContent.trim() || 'MCA Atlas';
  const out = ['# ' + proj + ' — ' + c.title, '', '*' + new Date().toLocaleString() + '*', ''];
  for(const t of c.log){
    out.push('## ' + t.q, '', t.a || '*(no answer)*', '');
    if(t.tools.length) out.push('`tools: ' + t.tools.join(', ') + '`', '');
  }
  downloadChat(proj, out.join('\n'));
}

/* The whole chat as a PDF: the rendered thread in its own window, then the
   browser's print-to-PDF. A popup sidesteps the docked pane's fixed height,
   which would clip a long chat to one page. */
function exportPdf(){
  if(!cur()?.log.length) return flash($('#chatPdf'), '—');
  const w = open('', '_blank');
  if(!w) return flash($('#chatPdf'), 'popup blocked');
  const css = [...document.querySelectorAll('link[rel=stylesheet]')].map(l => l.outerHTML).join('');
  w.document.write('<!doctype html><html data-theme="' + (document.documentElement.dataset.theme || '') + '"><head><title>' +
    esc(document.querySelector('#projName')?.textContent.trim() || 'Chat') + '</title><base href="' + location.origin + '/">' + css +
    '<style>body{overflow:visible;height:auto}#msgs{overflow:visible;height:auto}*{print-color-adjust:exact;-webkit-print-color-adjust:exact}</style></head><body>' +
    $('#msgs').outerHTML + '</body></html>');
  w.document.close();
  w.onload = () => { w.print(); w.onafterprint = () => w.close(); };
}

/* Asked once, on a local install, before the AI has written anything anywhere.
   Declining is a real answer: the default folder inside the app works fine. */
export function offerScratchSetup(){
  if(S.env?.hosted || scratchDir() || store.get('scratchAsked', false)) return;
  const d = bubble('ai', 'Before I run anything \u2014 where should I keep my work? '+
    'Every script, table and result I produce goes in one folder of your choosing, '+
    'so it lands with your other files instead of inside the app.');
  const row = document.createElement('div');
  row.className = 'tools'; row.style.marginTop = '8px';
  const pick = document.createElement('button');
  pick.className = 'btn sm primary'; pick.textContent = 'Choose a folder\u2026';
  pick.onclick = () => { store.set('scratchAsked', true); row.remove(); openSettings(); };
  const skip = document.createElement('button');
  skip.className = 'btn sm ghost'; skip.textContent = 'Use the default';
  skip.onclick = () => { store.set('scratchAsked', true); row.remove(); };
  row.append(pick, skip); d.append(row);
}

export async function openProject(id){
  try { await openSessionById(id); return true; }
  catch(e){ alert('Could not open that project: ' + e.message); return false; }
}
export async function deleteProjects(ids){
  const failed = [];
  for(const id of ids){
    const isCurrent = id === currentId();
    const r = await deleteSessionById(id);
    if(r.error){ failed.push(id + ': ' + r.error); continue; }
    if(isCurrent) go('home');                // nothing is open now: back to home, not an Untitled workspace
  }
  if(failed.length) alert('Could not delete:\n' + failed.join('\n'));
}

/* The inspector's left edge is a drag handle. Width lives in --inspector (app.css)
   set on the element itself; the chart listens for window resize to redraw. */
/* One handle between the conversation and the rest. In the Analysis layout it sits
   on the inspector's left edge and sizes the inspector; in the Agent layout the
   conversation is the middle and the handle, on its right edge, sizes the
   model-and-plot column (--rightW) instead. */
function initResize(){
  const side = $('#inspector'), stage = $('#stage'), right = $('#viewWorkspace'), grip = document.createElement('div');
  grip.className = 'side-grip'; grip.tabIndex = 0; grip.title = 'Drag to resize';
  grip.setAttribute('role', 'separator'); grip.setAttribute('aria-orientation', 'vertical');
  grip.setAttribute('aria-label', 'Resize side panel');
  side.prepend(grip);
  const size = w => side.style.setProperty('--inspector',
    Math.round(Math.min(Math.max(w, 280), Math.max(280, innerWidth * .6))) + 'px');
  const sizeRight = w => stage.style.setProperty('--rightW',
    Math.round(Math.min(Math.max(w, 320), Math.max(320, innerWidth * .7))) + 'px');
  const agent = () => stage.classList.contains('agent');
  // the width being dragged, and how a pointer moving right changes it
  const width = () => agent() ? right.offsetWidth : side.offsetWidth;
  const set = w => { (agent() ? sizeRight : size)(w); dispatchEvent(new Event('resize')); };
  const save = () => agent() ? store.set('rightW', right.offsetWidth) : store.set('inspectorW', side.offsetWidth);
  const w = store.get('inspectorW', 0); if(w) size(w);
  const rw = store.get('rightW', 0); if(rw) sizeRight(rw);
  grip.onpointerdown = e => {
    e.preventDefault(); grip.setPointerCapture(e.pointerId);
    const x0 = e.clientX, w0 = width();
    grip.onpointermove = e => set(w0 + x0 - e.clientX);
    grip.onpointerup = grip.onpointercancel = () => { grip.onpointermove = grip.onpointerup = null; save(); };
  };
  grip.onkeydown = e => {
    const d = { ArrowLeft: 20, ArrowRight: -20 }[e.key];
    if(d){ e.preventDefault(); set(width() + d); save(); }
  };
}

export function initChat(){
  initResize();
  $('#chatSave').onclick = exportChat;
  $('#chatPdf').onclick = exportPdf;
  $('#newChat').onclick = ()=>{ stopTurn(); makeChat(); $('#ask').focus(); };
  $('#delChat').onclick = deleteChat;
  $('#loadSession').onclick = async () => {
    const id = await pickSession();
    if(id) openProject(id);
  };
  $('#delProjects').onclick = async () => {
    const ids = await pickSession({ mode: 'delete' });
    if(!ids?.length) return;
    if(!confirm('Delete ' + (ids.length === 1 ? 'this project' : ids.length + ' projects') + '?\n\n' +
                ids.map(id => 'workspace/' + id).join('\n') + '\n\nEach folder goes with everything in '+
                'it — the conversation, history.md, the model snapshot and every file the AI wrote. '+
                'This cannot be undone.')) return;
    deleteProjects(ids);
  };
  $('#chatPick').onchange = e => { stopTurn(); show(+e.target.value); };
  $('#send').onclick = ()=>{ if(abort) stopTurn(); else send(); };
  $('#attach').onclick = () => $('#attachInput').click();
  initWeb();
  $('#attachInput').onchange = e => { attach(e.target.files); e.target.value = ''; };
  $('#attList').onclick = e => { const i = e.target.dataset.i; if(i != null){ attached.splice(+i, 1); renderAttached(); } };
  $('#ask').addEventListener('keydown',e=>{ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); send(); } });
  $('#ask').addEventListener('input',e=>{
    e.target.style.height='auto'; e.target.style.height=Math.min(110,e.target.scrollHeight)+'px'; });
  makeChat();
}
