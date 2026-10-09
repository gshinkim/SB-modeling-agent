import { $, esc, store } from './util.mjs';
import { S } from './state.mjs';
import { onShow, where, go } from './shell.mjs';
import { listSessions, currentId } from './session.mjs';
import { openProject, deleteProjects, startNewProject } from './chat.mjs';
import { scratchDir, useWorkflow } from './settings.mjs';

/* The small panes around the document: the projects popover on the rail, and the
   inspector's History and Details, and the Metadata tab. Each one only reads
   state that already exists elsewhere. */

let getName = () => '', rename = () => {}, blank = () => {};


const day = ms => !ms ? '' : new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/* ---------------- projects popover ---------------- */
let confirming = null;
const pop = () => $('#projPop');
function closePop(){ pop().hidden = true; $('#projBadge').setAttribute('aria-expanded', 'false'); confirming = null; }

/* The Projects page can tick several rows and delete them in one go. */
const picked = new Set(); let confirmMany = false;

/** The popover's list, and the Projects page's: `done` runs once a row's project is the open one.
    `multi` adds a checkbox to every row and a bar that deletes the ticked ones together. */
async function renderProjects(L = $('#projList'), done = closePop, multi = false){
  const cur = currentId();
  const rows = await listSessions();
  const again = () => renderProjects(L, done, multi);
  L.textContent = '';
  if(multi && rows.length){
    [...picked].forEach(id => { if(!rows.some(s => s.id === id)) picked.delete(id); });   // gone since it was ticked
    const n = picked.size, bar = document.createElement('div');
    bar.className = 'pp-bar';
    bar.innerHTML = '<label><input type="checkbox"' + (n === rows.length ? ' checked' : '') + '> Select all</label><span class="spacer"></span>' +
      (confirmMany && n
        ? '<span class="pp-ask">Delete ' + n + (n === 1 ? ' project' : ' projects') + ' with every conversation, history and file in ' +
          (n === 1 ? 'it' : 'them') + '? This can’t be undone.</span>' +
          '<button class="btn sm danger" data-yes>Delete ' + n + '</button><button class="btn sm" data-no>Cancel</button>'
        : '<button class="btn sm" data-ask' + (n ? '' : ' disabled') + '>Delete selected' + (n ? ' (' + n + ')' : '') + '</button>');
    bar.querySelector('input').onchange = e => { picked.clear(); if(e.target.checked) rows.forEach(s => picked.add(s.id)); confirmMany = false; again(); };
    bar.querySelector('[data-ask]')?.addEventListener('click', () => { confirmMany = true; again(); });
    bar.querySelector('[data-no]')?.addEventListener('click', () => { confirmMany = false; again(); });
    bar.querySelector('[data-yes]')?.addEventListener('click', async () => {
      const ids = [...picked]; picked.clear(); confirmMany = false;
      await deleteProjects(ids); again();
    });
    L.append(bar);
  }
  for(const s of rows){
    const isCur = s.id === cur;
    const d = document.createElement('div');
    d.className = 'pp-row' + (isCur ? ' cur' : '') + (confirming === s.id && s.id ? ' confirm' : '');
    d.innerHTML =
      '<div class="pp-main">' + (multi ? '<input type="checkbox" class="pp-pick"' + (picked.has(s.id) ? ' checked' : '') +
        ' aria-label="Select ' + esc(s.name || s.id) + '">' : '') + '<button class="pp-open" type="button">' +
        '<span class="pp-txt"><span class="pp-nm">' + esc(s.name || s.id) + '</span>' +
        '<span class="pp-meta">' + esc('updated ' + day(s.updated)) + '</span></span>' +
      '</button>' + (isCur ? '<span class="pp-meta">Open</span>' : '') +
      (s.id ? '<button class="pp-del" type="button">Delete</button>' : '') + '</div>' +
      (confirming === s.id && s.id
        ? '<div class="pp-confirm"><div>Delete ' + esc(s.name || s.id) + ' with its conversation, ' +
          'history and every file the assistant wrote? This can’t be undone.</div><div class="row">' +
          '<button class="btn sm danger" data-yes>Delete project</button>' +
          '<button class="btn sm" data-no>Cancel</button></div></div>' : '');
    d.querySelector('.pp-open').onclick = async () => {
      if(isCur || await openProject(s.id)) done();
    };
    d.querySelector('.pp-pick')?.addEventListener('change', e => {
      e.target.checked ? picked.add(s.id) : picked.delete(s.id); confirmMany = false; again(); });
    const del = d.querySelector('.pp-del');
    if(del) del.onclick = () => { confirming = s.id; again(); };
    d.querySelector('[data-no]')?.addEventListener('click', () => { confirming = null; again(); });
    d.querySelector('[data-yes]')?.addEventListener('click', async () => {
      confirming = null; await deleteProjects([s.id]); again();
    });
    L.append(d);
  }
}

function initProjects(){
  $('#projBadge').onclick = e => {
    e.stopPropagation();
    const open = pop().hidden;
    pop().hidden = !open; $('#projBadge').setAttribute('aria-expanded', open);
    if(open && !S.env?.hosted) renderProjects();
  };
  pop().onclick = e => e.stopPropagation();
  addEventListener('click', () => { if(!pop().hidden) closePop(); });
  addEventListener('keydown', e => { if(e.key === 'Escape' && !pop().hidden) closePop(); });
  const create = async () => {
    const nm = $('#newProjName').value.trim();
    if(!nm) return $('#newProjName').focus();        // a project starts with a name, here as on home
    await createProject(nm);
    $('#newProjName').value = '';
    closePop();
  };
  $('#newProject').onclick = create;
  $('#newProjName').addEventListener('keydown', e => { if(e.key === 'Enter') create(); });
  $('#importBtn').onclick = () => { closePop(); $('#openBtn').click(); };
  // the modal pickers open over the page; the popover would sit on top of them
  ['#loadSession', '#delProjects'].forEach(s => $(s).addEventListener('click', closePop));
}

/** A new project is empty: no chats, no model. It lands on the editor, where the model gets written. */
async function createProject(nm){
  await startNewProject();
  blank();
  if(nm) rename(nm);              // a named project is a touched one: it gets its folder now
  go('workspace', 'model');
}

/* ---------------- home: the page the app opens on ---------------- */
const HOME_MAX = 6;               // Hick's law: a short list to choose from; the rest is one click away
async function renderHome(){
  const rows = S.env?.hosted ? [] : (await listSessions()).sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
  $('#homeTitle').textContent = rows.length ? 'Welcome back' : 'Welcome to MCA Atlas';
  $('#homeRecentSect').hidden = !rows.length;
  const cur = currentId();
  $('#homeRecent').innerHTML = rows.slice(0, HOME_MAX).map(s =>
    `<button class="home-card" data-id="${esc(s.id)}">
       <span class="pp-txt"><span class="pp-nm">${esc(s.name || s.id)}</span>
         <span class="pp-meta">${esc((s.id === cur ? 'Open now · ' : '') + 'updated ' + day(s.updated))}</span></span>
     </button>`).join('');
}
function initHome(){
  $('#homeRecent').onclick = async e => {
    const id = e.target.closest('[data-id]')?.dataset.id;
    if(id && (id === currentId() || await openProject(id))) go('workspace');
  };
  $('#homeAll').onclick = () => go('projects');
  $('#homeNew').onsubmit = async e => {            // `required` on the input: no name, no project
    e.preventDefault();
    const nm = $('#homeName').value.trim();
    if(!nm) return;
    $('#homeName').value = '';
    await createProject(nm);
  };
  $('#railNew').onclick = () => { go('home'); $('#homeName').focus(); };
  const show = ({ nav }) => {
    if(nav === 'home') renderHome();
    if(nav === 'projects' && !S.env?.hosted){ confirming = null; picked.clear(); confirmMany = false; renderProjects($('#projAll'), () => go('workspace'), true); }
  };
  onShow(show);
  show(where());                                  // the shell painted before this hooked in
}

/* ---------------- header + details: everything that shows the project's identity ---------------- */
export function syncIdentity(){
  const name = getName(), id = currentId();
  $('#projBadge').title = name + ': switch, create, import or delete projects';
  $('#runId').textContent = id ?? '';
  $('#modelFile').textContent = 'model.txt';
  $('#modelFile').title = id ? 'workspace/' + id + '/model.txt' : 'workspace/model.txt';
  $('#docMeta').textContent = (id ? 'workspace/' + id : 'Not saved yet, a folder is created on the first edit') +
    ' · ' + new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  if(document.activeElement !== $('#infoName')) $('#infoName').value = name;
  $('#infoFolder').textContent = id ? 'workspace/' + id : 'not saved yet';
  $('#infoFolder').title = $('#infoFolder').textContent;
  $('#infoDelete').disabled = !id;
  document.title = (where().nav === 'home' ? '' : name + ' · ') + 'MCA Atlas';   // no project is open on home
}

/* ---------------- metadata tab ---------------- */
let caption = '';                               // the last run's caption, as main.mjs described it
export function renderMeta(c = caption){
  caption = c;
  const r = S.result, e = S.env, sel = $('#modelPick2');
  const rows = [
    ['Run ID', currentId() ?? 'unsaved'],
    ['Model', r ? [r.floatingSpecies.length + ' floating species', r.boundarySpecies.length + ' boundary species',
                   r.reactions.length + ' reactions', r.globalParameters.length + ' parameters'].join(', ')
                : 'not loaded'],
    ['Run', caption],
    ['Solver', r?.engine ? 'tellurium ' + r.engine.tellurium + ', roadrunner ' + r.engine.roadrunner +
                           (e?.tellurium?.python ? ', python ' + e.tellurium.python : '') : ''],
    ['Last run', S.lastRunMs ? S.lastRunMs.toFixed(0) + ' ms' : ''],
    ['Assistant', sel?.selectedOptions[0]?.textContent ?? ''],
    ['Workflow', useWorkflow() ? 'mca-tellurium (seven enforced stages)' : 'off, the agent analyses directly'],
    ['Skills', (e?.skills ?? []).join(', ')],
    ['Working folder', scratchDir() || (currentId() ? 'workspace/' + currentId() : 'workspace/runs')],
    ['Deployment', e ? (e.hosted ? 'hosted: Tellurium only, the assistant runs in this browser' : 'local') : ''],
  ];
  $('#tabMeta').innerHTML = '<div class="meta-grid">' + rows.filter(([, v]) => v).map(([k, v]) =>
    '<div class="k">' + esc(k) + '</div><div>' + esc(v) + '</div>').join('') + '</div>';
}

/* ---------------- history pane: history.md, the assistant's memory of the project ---------------- */
async function renderHistory(){
  const P = $('#historyPane'), id = currentId();
  const h = id ? await fetch('/api/history?project=' + encodeURIComponent(id)).then(r => r.json()).catch(() => null) : null;
  if(where().side !== 'history') return;
  if(!h?.summary && !h?.lines?.length){
    P.innerHTML = '<p class="muted" style="margin:0;font-size:13px;line-height:1.5">No history yet. Every assistant ' +
      'turn in this project is recorded in its <code>history.md</code>. That file is what the assistant remembers.</p>';
    return;
  }
  // newest first; each line is "- **who:** text"
  const items = h.lines.map(l => /^- \*\*(\w+):\*\* ?(.*)$/.exec(l)).filter(Boolean).reverse();
  P.innerHTML = (h.summary ? '<div class="hist-sum"><span class="hist-item" style="border:0;padding:0">' +
      '<span class="who">Summary of earlier turns</span></span>' + esc(h.summary) + '</div>' : '') +
    '<div>' + items.map(m => '<div class="hist-item ' + esc(m[1]) + '"><span class="who">' + esc(m[1]) +
      '</span>' + esc(m[2]) + '</div>').join('') + '</div>';
}

export function initPanes(hooks){
  ({ getName, rename, blank } = hooks);
  initProjects(); initHome();
  $('#infoName').addEventListener('change', e => rename(e.target.value));
  $('#infoName').addEventListener('keydown', e => { if(e.key === 'Enter') e.target.blur(); });
  $('#infoDelete').onclick = () => {
    const id = currentId(); if(!id) return;
    if(confirm('Delete this project?\n\nworkspace/' + id + '\n\nThe folder goes with everything in it: the ' +
               'conversation, history.md, the model snapshot and every file the AI wrote. This cannot be undone.'))
      deleteProjects([id]);
  };
  onShow(({ side, tab }) => {
    syncIdentity();
    if(side === 'history') renderHistory();
    if(tab === 'meta') renderMeta();
  });
  syncIdentity();                 // the name hook has only now arrived; an empty model runs nothing that would do it
}
