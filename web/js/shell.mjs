import { $, $$, store } from './util.mjs';

/* The notebook shell: which view the rail shows, which tab the workspace shows,
   which pane the inspector shows. No imports from feature modules, so any of
   them can import this without a cycle. */

const NAVS = ['home', 'projects', 'workspace', 'search', 'files'];
const TABS = ['sim', 'model', 'notes', 'meta'];
const SIDES = ['chat', 'outline', 'history', 'info'];

let nav = 'home', tab = 'sim', side = 'chat';
const listeners = [];
/** fn({nav, tab, side}) after every change — panes that draw lazily hook in here. */
export const onShow = fn => { listeners.push(fn); };
export const where = () => ({ nav, tab, side });

function paint(){
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
  // the plot and the editor fill the window's height; every tab has the same side margins
  $('#work').classList.toggle('wide', tab === 'sim' || tab === 'model');
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
  tab = TABS.includes(store.get('tab')) ? store.get('tab') : 'sim';
  side = SIDES.includes(store.get('side')) ? store.get('side') : 'chat';
  // The app always opens on home: no project is open yet, and the workspace without
  // one is an "Untitled project" that a single edit would save. #model, #notes… only
  // choose the tab a project opens on.
  const h = location.hash.slice(1);
  if(TABS.includes(h)) tab = h; else if(SIDES.includes(h)) side = h;
  $$('#rail [data-nav]').forEach(b => b.onclick = () => go(b.dataset.nav));
  $$('#tabs [data-tab]').forEach(b => b.onclick = () => go('workspace', b.dataset.tab));
  $$('#sideTabs [data-side]').forEach(b => b.onclick = () => showSide(b.dataset.side));
  paint();
}
