import { $, $$, store, fmt, flash, latestOnly, esc, slug } from './util.mjs';
import { S } from './state.mjs';
import * as api from './api.mjs';
import { draw, initChartInteractions, showTable } from './chart.mjs';
import { renderControls, initAccordions, setOnChange } from './panel.mjs';
import { initSettings, fillModels, closeSettings, refreshEnv, refreshLocal } from './settings.mjs';
import { initChat, setOnModelChanged, setOnSessionDeleted, offerScratchSetup, dumpChats, loadChats, noteNoModel, resumeLive } from './chat.mjs';
import { initExport, initImport, save, stampNow } from './export.mjs';
import { initShell, go, where } from './shell.mjs';
import { initPanes, syncIdentity, renderMeta } from './panes.mjs';
import { initAnalysis, onRun, coefficientsCSV, reportMarkdown, describeRun } from './analysis.mjs';
import { initFiles } from './files.mjs';
import { initSearch } from './search.mjs';
import { initSession, saveSoon, currentId, saveIdle } from './session.mjs';

const editor = $('#model');

const status = (kind, text) => {
  $('#runDot').className = 'dot' + (kind==='busy'?' busy':kind==='err'?' err':'');
  $('#runStat').textContent = text;
};

/* line numbers beside the editor; rebuilt only when the line count changes */
const gutter = $('#gutter'); let gutterLines = 0;
function syncGutter(){
  const n = editor.value.split('\n').length;
  if(n !== gutterLines){ gutterLines = n; gutter.textContent = Array.from({length:n}, (_, i) => i+1).join('\n'); }
  gutter.scrollTop = editor.scrollTop;
}
editor.addEventListener('scroll', syncGutter);

const cfg = () => ({ start:+$('#tStart').value||0, end:+$('#tEnd').value||100,
                     points:+$('#nPts').value||50 });

/* ---------------- run ----------------
   Two modes, both solved by Tellurium: a fixed window, or "keep going until the
   steady-state solver is satisfied". Nothing is computed in the browser. */
let runSeq = 0, busyTimer = null;
let steadyMode = store.get('steadyMode', false);

async function run(){
  const c = cfg();
  if(!steadyMode && c.end <= c.start) return status('err','End time must exceed start');
  const seq = ++runSeq;
  syncGutter();
  if(!editor.value.trim()){                        // nothing to ask Tellurium yet: not an error
    clearTimeout(busyTimer);
    S.result = null; draw(); onRun(null);
    $('#parseMsg').textContent = $('#zoomParse').textContent = $('#plotSub').textContent = $('#plotSub2').textContent = '';
    return status('', 'No model yet');
  }
  const t0 = performance.now();
  clearTimeout(busyTimer);
  busyTimer = setTimeout(()=>{ if(seq===runSeq)
    status('busy', steadyMode ? 'Solving for steady state…' : 'Running…'); }, 120);

  const r = steadyMode
    ? await api.settle({ model: editor.value, points: c.points, end: c.end })
    : await api.simulate({ model: editor.value, ...c });
  if(seq !== runSeq) return;                       // a newer run already won
  clearTimeout(busyTimer);
  S.lastRunMs = performance.now()-t0;

  if(!r.ok){
    status('err', steadyMode ? 'No steady state' : 'Tellurium error');
    $('#parseMsg').innerHTML = '<span class="err">⚠ '+esc(String(r.error).split('\n')[0])+'</span>';
    $('#zoomParse').innerHTML = '<span class="err">error</span>';
    S.result = null; draw(); onRun(null);
    return;
  }
  S.result = r.result;
  S.hidden = new Set([...S.hidden].filter(n=>S.result.names.includes(n)));
  if(S.view && (S.view.t0 < S.result.t[0] || S.view.t1 > S.result.t.at(-1))) S.view = null;

  renderControls(editor, S.result);
  const i = S.result, d = describeRun(i, steadyMode, c, S.lastRunMs);
  $('#parseMsg').innerHTML = '<span class="chip">'+d.summary+'</span>'+
    (i.note ? ' <span class="warn">⚠ '+esc(i.note)+'</span>' : '');
  $('#zoomParse').textContent = i.reactions.length+' reactions';
  $('#plotSub').textContent = $('#plotSub2').textContent = d.caption;
  status(d.kind, d.status);
  if(steadyMode && i.note)
    $('#parseMsg').innerHTML = '<span class="chip">'+d.summary+'</span> <span class="err">'+esc(i.note)+'</span>';
  captureDefault();
  draw();
  syncIdentity(); renderMeta(d.caption);
  onRun(S.result);
}

let commitT;
async function commit(){
  clearTimeout(commitT);
  editing = false;
  // A rename or first save still in flight must land before the model PUT below,
  // or the PUT can hit the old folder id (rename) or the shared default file
  // (first save not yet claimed its id).
  await saveIdle();
  // simulate at once; the save to disk runs alongside instead of in front of it
  const [put] = await Promise.all([api.putModel(editor.value, currentId()), run(), api.putSettings(cfg())]);
  if(put?.error) status('err', 'Model not saved: ' + put.error);
  // Direct edits (editor input, tStart/tEnd/nPts) all funnel through here, same as
  // a chat turn or a rename — without this, editing a session's model without ever
  // sending a chat message never reaches its runs/ snapshot (worthSaving still
  // guards against creating a folder for a session with no completed turns).
  saveSoon();
}

// sliders re-simulate on every movement, not on release (see latestOnly)
setOnChange(latestOnly(commit));

/* ---------------- project name ----------------
   Click the breadcrumb and type. Read back as textContent everywhere, so a paste
   that smuggles markup can only ever be text. Not persisted: every fresh load
   starts at PROJ_DEF, and only opening a saved session (setAll) sets it from disk.
   `lastCommitted` is in-memory only, for the Escape-to-revert handler. */
const proj = $('#projName');
const PROJ_DEF = 'Untitled project';
const projName = () => proj.textContent.replace(/\s+/g,' ').trim() || PROJ_DEF;
let lastCommitted = PROJ_DEF;
function setProjName(n, save = true){
  proj.textContent = n || PROJ_DEF;
  if(save) lastCommitted = projName();
  syncIdentity();
}
setProjName(PROJ_DEF, false);
proj.addEventListener('keydown', e=>{
  if(e.key==='Enter'){ e.preventDefault(); proj.blur(); }
  if(e.key==='Escape'){ setProjName(lastCommitted, false); proj.blur(); }
});
proj.addEventListener('blur', ()=>{ setProjName(projName()); saveSoon(); });

/* ---------------- default config: captured once, replaced only on request ---------------- */
const snapshot = () => ({ src: editor.value, ...cfg() });
function captureDefault(){
  if(S.defaultCfg) return;
  S.defaultCfg = snapshot(); store.set('default', S.defaultCfg);
}
$('#setDefault').onclick = ()=>{
  S.defaultCfg = snapshot(); store.set('default', S.defaultCfg);
  flash($('#setDefault'), 'Saved ✓');
};
$('#resetAll').onclick = ()=>{
  if(!S.defaultCfg) return flash($('#resetAll'),'No default yet');
  editor.value = S.defaultCfg.src;
  $('#tStart').value=S.defaultCfg.start; $('#tEnd').value=S.defaultCfg.end; $('#nPts').value=S.defaultCfg.points;
  S.view=null; commit();
};

/* ---------------- editor ---------------- */
let deb;
// True from a keystroke until commit() picks it up: an AI edit arriving in that
// window must not replace what the user is typing (see setOnModelChanged).
let editing = false;
editor.addEventListener('input', ()=>{
  editing = true;
  syncGutter();
  status('busy','Editing…');
  clearTimeout(deb); deb=setTimeout(commit, 300);
});
$('#rerunBtn').onclick = ()=>{ clearTimeout(deb); clearTimeout(commitT); commit(); };
/* Revert: back to the text this model had when it was opened (boot, project open,
   import or an AI edit) — edits autosave, so this is the only way back. */
let opened = '';
const setOpened = () => { opened = editor.value; };
$('#revertBtn').onclick = ()=>{
  if(editor.value === opened) return flash($('#revertBtn'), 'No edits');
  editor.value = opened; S.view = null; commit();
};
$('#zoomRerun').onclick = ()=>$('#rerunBtn').click();

/* ---------------- full-screen editor / plot ---------------- */
function zoomEditor(force){
  const w=$('#editorWrap'), on = force ?? !w.classList.contains('zoom');
  w.classList.toggle('zoom',on);
  $('#scrim').classList.toggle('on', on || $('#settings').classList.contains('on'));
  $('#zoomBtn').setAttribute('aria-expanded',on);
  if(on) setTimeout(()=>editor.focus(),80);
  setTimeout(draw,60);
}
function zoomPlot(force){
  const c=$('#plotCard'), on = force ?? !c.classList.contains('zoom');
  c.classList.toggle('zoom',on);
  $('#scrim').classList.toggle('on', on || $('#settings').classList.contains('on'));
  $('#plotZoomBtn').setAttribute('aria-expanded',on);
  setTimeout(draw,60);
}
$('#zoomBtn').onclick=()=>zoomEditor();
$('#zoomDone').onclick=()=>zoomEditor(false);
$('#plotZoomBtn').onclick=()=>zoomPlot();
$('#plotZoomDone').onclick=()=>zoomPlot(false);
$('#scrim').onclick=()=>{ if(document.querySelector('#fp')?.classList.contains('on')) return;
  zoomEditor(false); zoomPlot(false); closeSettings(); };

/* ---------------- side panel ---------------- */
/* The parameters popover floats over the plot, so it lives on the Time course tab. */
function togglePanel(force){
  const p=$('#side'), on = force ?? p.hidden;
  if(on) go('workspace','sim');
  p.hidden = !on;
  $('#panelBtn').setAttribute('aria-expanded',on);
}
/* steady-state mode */
function setSteady(on){
  steadyMode = on;
  $('#steadyBtn').setAttribute('aria-pressed', on);
  $$('#tStart, #tEnd').forEach(el=>{ el.disabled = on; el.title = on
    ? 'Ignored in steady-state mode — Tellurium chooses the horizon' : ''; });
  $('#tEnd').closest('div').querySelector('.lb').textContent = on ? 'End (auto)' : 'End';
  store.set('steadyMode', on);
  S.view = null;
  run();
}
$('#steadyBtn').onclick = ()=> setSteady($('#steadyBtn').getAttribute('aria-pressed')!=='true');

$('#panelBtn').onclick=()=>togglePanel();
$('#closePanel').onclick=()=>togglePanel(false);
['tStart','tEnd','nPts'].forEach(id=>$('#'+id).addEventListener('input',()=>{
  clearTimeout(commitT); commitT=setTimeout(commit,150);
}));

/* ---------------- theme, shortcuts ---------------- */
const applyTheme = t => { t ? document.documentElement.setAttribute('data-theme',t)
                            : document.documentElement.removeAttribute('data-theme'); draw(); };
$('#themeBtn').onclick=()=>{
  const cur=document.documentElement.getAttribute('data-theme');
  const dark = cur ? cur==='dark' : matchMedia('(prefers-color-scheme:dark)').matches;
  const next = dark?'light':'dark'; store.set('theme',next); applyTheme(next);
};
$('#helpBtn').onclick=()=>alert(
  '⌘/Ctrl + ⏎   rerun\n⌘/Ctrl + B   toggle side panel\nScroll on plot  zoom time axis\nDrag plot     pan (when zoomed)\nEsc           close overlays');
addEventListener('keydown',e=>{
  if(where().nav === 'home') return;             // no project open: nothing to rerun, no panel to show
  if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){ e.preventDefault(); $('#rerunBtn').click(); }
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='b'){ e.preventDefault(); togglePanel(); }
  if(e.key==='Escape'){
    if(!$('#tablePage').hidden) return showTable(false);
    if($('#editorWrap').classList.contains('zoom')) return zoomEditor(false);
    if($('#plotCard').classList.contains('zoom')) return zoomPlot(false);
    if(!$('#side').hidden) return togglePanel(false);
    closeSettings();
  }
});

/* ---------------- boot ---------------- */
// the AI's edits arrive while its turn is still running; one that matches what the
// editor already shows changes nothing, so it must not reset the cursor either.
// A user who is mid-keystroke wins outright — the AI's edit is dropped, not queued,
// since applying it after the fact would still clobber whatever they typed next.
setOnModelChanged(src=>{
  if(src === editor.value) return;
  if(editing) return status('err', 'AI edited the model while you were typing — kept your text');
  editor.value = src; setOpened(); run();
});
// a deleted session's name must not survive to regenerate the folder it named
setOnSessionDeleted(()=> setProjName(PROJ_DEF));

(async function boot(){
  const savedTheme = store.get('theme',null); if(savedTheme) applyTheme(savedTheme);
  matchMedia('(prefers-color-scheme:dark)').addEventListener('change',()=>draw());

  initShell();
  initAccordions(); initSettings(); initChartInteractions(); initChat();
  const report = () => save(new Blob([reportMarkdown()], {type:'text/markdown;charset=utf-8'}),
                            (slug(projName()) || 'mca-atlas') + '-report-' + stampNow() + '.md');
  const coef = () => { const csv = coefficientsCSV();
    if(!csv) return status('err', 'No control coefficients yet: the model needs a steady state');
    save(new Blob([csv], {type:'text/csv'}), (slug(projName()) || 'mca-atlas') + '-coefficients-' + stampNow() + '.csv'); };
  initExport({ coef, report });
  $('#infoReport').onclick = report; $('#infoCoef').onclick = coef;
  // no accounts and no server to share through: Share hands over the run as Markdown
  $('#shareBtn').onclick = async () => {
    try { await navigator.clipboard.writeText(reportMarkdown()); flash($('#shareBtn'), 'Report copied'); }
    catch { report(); }
  };
  initPanes({ getName: projName, rename: n => { setProjName(n); saveSoon(); },
              // not commit(): that arms a save, and an unnamed project must not get a folder for being created
              blank: () => { editor.value = ''; setOpened(); S.view = null; api.putModel('', currentId()); run(); } });
  initAnalysis({ getModel: () => editor.value,
                 setModel: src => { editor.value = src; setOpened(); S.view = null; commit(); },
                 importFile: () => $('#openBtn').click(), report, coef });
  initFiles(); initSearch();
  initSession({
    getName: projName,
    getModel: () => editor.value,
    getSettings: cfg,
    getChats: dumpChats,
    setAll: s => {
      setProjName(s.name, true);
      // Deliberately not cleared when empty: that would diverge from
      // workspace/model.txt, which the server also leaves alone on an empty
      // snapshot (backend/server.mjs's own `if (s.model)` skip). Diverging the
      // editor from the live file on disk is worse than the alternative below.
      if(s.model) editor.value = s.model;
      if(s.settings?.points){ $('#tStart').value = s.settings.start ?? 0;
                              $('#tEnd').value = s.settings.end ?? 100;
                              $('#nPts').value = s.settings.points; }
      loadChats(s.chats);
      resumeLive();                                // its turn may still be running from before the page closed
      // The editor above was left showing whatever project was open before —
      // flag it, so the user is never silently shown another project's model
      // while believing it belongs to the session they just opened.
      if(!s.model) noteNoModel();
      setOpened();
      S.view = null; run();
    },
  });
  initImport(async (text, name) => {           // loading a file replaces the live model
    // SBML is converted by Tellurium; the editor only ever holds Antimony
    if(/^\s*<(\?xml|sbml)/.test(text)){
      status('busy', 'Converting SBML…');
      const r = await api.convert(text);
      if(!r.ok) return status('err', 'Could not read that SBML file: ' + String(r.error).split('\n')[0]);
      text = r.result.antimony;
    }
    editor.value = text; setOpened();
    setProjName(name.replace(/\.(ant|txt|antimony|xml|sbml)$/i,''));
    S.view = null; commit();
    go('workspace', 'model');                    // importing from home starts a project named after the file
  });
  fillModels();

  S.defaultCfg = store.get('default', null);
  $('#steadyBtn').setAttribute('aria-pressed', steadyMode);
  $$('#tStart, #tEnd').forEach(el=>{ el.disabled = steadyMode; });
  const m = await api.getModel();
  editor.value = m.src; setOpened();

  // workspace/settings.json is the last-committed simulation window; without this
  // a reload with no session open falls back to the HTML defaults while the file
  // (and whatever the AI reads) still has the real one.
  const st = await api.getSettings().catch(() => null);
  if(st?.points){ $('#tStart').value = st.start ?? 0; $('#tEnd').value = st.end ?? 100; $('#nPts').value = st.points; }

  refreshLocal();          // whatever is already running here lands in the picker

  api.getEnv().then(e=>{
    // the picker is built before this resolves, and on a hosted deployment the
    // built-in Claude models must drop out of it
    S.env = e; refreshEnv(); fillModels(); offerScratchSetup();
    if(e.hosted) ['#projList','#newProject','#newProjName','#loadSession','#delProjects','#infoDelete','#attach']
      .forEach(s => $(s).hidden = true);
    if(!e.telluriumInstalled) status('err','Tellurium not installed — run: bash setup.sh');
    if(e.claude.error) $('#modelPick2').title = e.claude.error;
  });

  run();
})();
