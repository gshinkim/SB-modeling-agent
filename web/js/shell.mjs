import { $, $$, store } from './util.mjs';

/* The notebook shell: which view the rail shows, which tab the workspace shows,
   which pane the inspector shows. No imports from feature modules, so any of
   them can import this without a cycle. */

const NAVS = ['home', 'projects', 'workspace', 'search', 'files'];
const TABS = ['model', 'notes', 'meta'];   // the time course shares the Model tab
const SIDES = ['chat', 'outline', 'history', 'info'];

let nav = 'home', tab = 'model', side = 'chat';
// Agent: the conversation is the page, the model and the plot sit on the right.
// Analysis: the plot and the model are the page, the conversation is on the right.
let layout = store.get('layout', 'agent');
const listeners = [];
/** fn({nav, tab, side}) after every change — panes that draw lazily hook in here. */
export const onShow = fn => { listeners.push(fn); };
export const where = () => ({ nav, tab, side });
/** True while the Model tab is laid out around the conversation. */
export const agentLayout = () => layout === 'agent' && nav === 'workspace' && tab === 'model';

let wasAgent = false;
function paint(){
  // entering the Agent layout shows the conversation, which is what it is for;
  // after that the Outline, History and Details tabs work as anywhere else
  if(agentLayout() && !wasAgent) side = 'chat';
  wasAgent = agentLayout();
  $$('#rail [data-nav]').forEach(b => b.setAttribute('aria-current', b.dataset.nav === nav));
  $$('.view').forEach(v => { v.hidden = v.dataset.view !== nav; });
  $('#wsHead').hidden = nav !== 'workspace';
  // home and the projects list have no project open: nothing to analyse, search or browse, and no one for the assistant to help
  $$('#rail [data-nav]:not([data-nav="home"],[data-nav="projects"]), #inspector')
    .forEach(e => { e.hidden = nav === 'home' || nav === 'projects'; });
  // and inside a project the list of all projects is one step back, through Home
  $('#rail [data-nav="projects"]').hidden = nav !== 'home' && nav !== 'projects';
  $$('#tabs [data-tab]').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === tab));
  $$('.tabpane').forEach(p => { p.hidden = p.dataset.pane !== tab; });
  // Model: the time course (left) and the editor (right) fill the window's height side by side
  $('#work').classList.toggle('wide', tab === 'model');
  $('#work').classList.toggle('split', tab === 'model');
  $('#splitGrip').hidden = tab !== 'model';
  $('#stage').classList.toggle('agent', agentLayout());
  $('#splitGrip').setAttribute('aria-orientation', agentLayout() ? 'horizontal' : 'vertical');
  $('#layoutSeg').hidden = tab !== 'model';
  $$('#layoutSeg [data-layout]').forEach(b => b.setAttribute('aria-pressed', b.dataset.layout === layout));
  $$('#sideTabs [data-side]').forEach(b => b.setAttribute('aria-selected', b.dataset.side === side));
  $$('.side-pane').forEach(p => { p.hidden = p.dataset.sidepane !== side; });
  listeners.forEach(fn => fn({ nav, tab, side }));
}

/** go('files') · go('workspace', 'model') */
export function go(toNav, toTab){
  if(NAVS.includes(toNav)) nav = toNav;
  if(TABS.includes(toTab)) tab = toTab;
  store.set('tab', tab);
  paint();
}
export function showSide(name){
  if(SIDES.includes(name)) side = name;
  store.set('side', side);
  paint();
}

export function initShell(){
  tab = TABS.includes(store.get('tab')) ? store.get('tab') : 'model';
  side = SIDES.includes(store.get('side')) ? store.get('side') : 'chat';
  // The app always opens on home: no project is open yet, and the workspace without
  // one is an "Untitled project" that a single edit would save. #model, #notes… only
  // choose the tab a project opens on.
  const h = location.hash.slice(1);
  if(TABS.includes(h)) tab = h; else if(SIDES.includes(h)) side = h;
  $$('#rail [data-nav]').forEach(b => b.onclick = () => go(b.dataset.nav));
  $$('#tabs [data-tab]').forEach(b => b.onclick = () => go('workspace', b.dataset.tab));
  $$('#sideTabs [data-side]').forEach(b => b.onclick = () => showSide(b.dataset.side));
  $$('#layoutSeg [data-layout]').forEach(b => b.onclick = () => { layout = b.dataset.layout; store.set('layout', layout); paint(); });
  initSplitGrip();
  paint();
}

/* Drag the line between the time course and the model to share the space, as the
   assistant's edge does: side by side in the Analysis layout (the time course's
   share of the width), stacked in the Agent layout (the model's share of the
   height). Arrow keys do the same for anyone not using a pointer. */
function initSplitGrip(){
  const grip = $('#splitGrip'), work = $('#work');
  const vertical = () => $('#stage').classList.contains('agent');
  const prop = () => vertical() ? '--modelH' : '--simW';
  const set = (p, pct) => work.style.setProperty(p, Math.min(80, Math.max(20, pct)).toFixed(1) + '%');
  const save = () => { const p = prop(); store.set(p.slice(2), parseFloat(work.style.getPropertyValue(p))); };
  set('--simW', store.get('simW', 50)); set('--modelH', store.get('modelH', 40));
  grip.onpointerdown = e => {
    e.preventDefault(); grip.setPointerCapture(e.pointerId);
    const p = prop(), a = $(vertical() ? '#tabModel' : '#tabSim').getBoundingClientRect(),
          b = $(vertical() ? '#tabSim' : '#tabModel').getBoundingClientRect();
    grip.onpointermove = e => set(p, vertical() ? (e.clientY - a.top) / (b.bottom - a.top) * 100
                                                 : (e.clientX - a.left) / (b.right - a.left) * 100);
    grip.onpointerup = grip.onpointercancel = () => { grip.onpointermove = grip.onpointerup = null; save(); };
  };
  grip.onkeydown = e => {
    const d = (vertical() ? { ArrowUp: -2, ArrowDown: 2 } : { ArrowLeft: -2, ArrowRight: 2 })[e.key];
    if(d){ e.preventDefault(); const p = prop(); set(p, parseFloat(work.style.getPropertyValue(p)) + d); save(); }
  };
}
