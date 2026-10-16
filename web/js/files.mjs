/* The Files view: what the assistant wrote into this project's folder (scripts,
   CSVs, plots), with a plain text editor. Backend: backend/files.mjs. */
import { $, esc } from './util.mjs';
import { go, onShow } from './shell.mjs';
import { currentId } from './session.mjs';
import { scratchDir } from './settings.mjs';
import { S } from './state.mjs';

const TYPES = { py: 'Python', txt: 'Text', md: 'Markdown', csv: 'CSV', tsv: 'TSV', json: 'JSON', ant: 'Antimony',
  xml: 'XML', sbml: 'SBML', log: 'Log', yaml: 'YAML', yml: 'YAML', toml: 'TOML', js: 'JavaScript',
  mjs: 'JavaScript', r: 'R', m: 'MATLAB', tex: 'LaTeX', svg: 'SVG image', png: 'PNG image',
  jpg: 'JPEG image', jpeg: 'JPEG image', gif: 'GIF image', pdf: 'PDF' };
const IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'svg'];
// the project's own state: the server refuses to delete these
const OWN = ['model.txt', 'history.md'];

const ext = p => (/\.([^./]+)$/.exec(p)?.[1] ?? '').toLowerCase();
const typeOf = p => TYPES[ext(p)] ?? (ext(p) ? ext(p).toUpperCase() + ' file' : 'File');
const size = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
const when = t => {
  const s = (Date.now() - t) / 1000;
  return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + ' min ago' : s < 86400 ? Math.floor(s / 3600) + ' h ago'
    : new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

let files = [], root = null;
// The open file. `where` is the folder it was opened from, kept so that Save still
// goes there if the project is switched while there are unsaved edits.
let cur = null;        // { path, where, kind: 'text'|'image'|'bin', saved, mtime, size, readonly, stale }
let pending = null;    // openFile() before the list has loaded
let loadSeq = 0, showSeq = 0, listWhere = null, armed = false;

const where = () => ({ project: currentId() ?? '', dir: scratchDir() });
const context = q => JSON.stringify(q);
const url = (path, q, extra = {}) => path + '?' + new URLSearchParams({ ...q, ...extra });
async function api(u, opts) {
  const r = await fetch(u, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
}

const ta = () => $('#flText');
const dirty = () => cur?.kind === 'text' && !cur.readonly && ta().value !== cur.saved;

/* ------------------------------- the list ------------------------------- */
function renderList(error) {
  const n = files.length;
  $('#flCount').textContent = n ? n + (n === 1 ? ' file' : ' files') : '';
  $('#flRoot').textContent = $('#flRoot').title = root ?? '';
  const sameRoot = cur && JSON.stringify(cur.where) === JSON.stringify(where());
  $('#flList').innerHTML = error ? `<div class="fl-none fl-err">${esc(error)}</div>`
    : !n ? '<div class="fl-none">No files yet. Scripts and results the assistant writes for this project are saved here.</div>'
    : files.map(f => {
        const i = f.path.lastIndexOf('/');
        return `<button type="button" class="fl-item" data-path="${esc(f.path)}"
                  aria-current="${sameRoot && f.path === cur.path}" title="${esc(f.path)}">
          <span class="fl-row"><span class="fl-name">${esc(f.path.slice(i + 1))}</span><span class="fl-when">${esc(when(f.mtime))}</span></span>
          <span class="fl-sub">${i > 0 ? esc(f.path.slice(0, i)) + '/ · ' : ''}${size(f.size)}</span>
        </button>`;
      }).join('');
}

async function load() {
  const seq = ++loadSeq, q = where();
  if (listWhere !== context(q)) {
    // The old list belongs to another folder. Invalidate pending reads before a
    // click or a late response can show its contents under the new project.
    ++showSeq; listWhere = context(q); files = []; root = null;
    if (cur && !dirty()) cur = null;
    renderList(); paint();
  }
  if (S.env?.hosted) { files = []; root = null; return renderList('Files are only available when MCA Atlas runs on your machine'); }
  let r;
  try { r = await api(url('/api/files', q)); }
  catch (e) { if (seq === loadSeq) { files = []; renderList(String(e.message || e)); } return; }
  if (seq !== loadSeq || context(q) !== context(where())) return;
  const moved = root !== null && r.root !== root;
  ({ files, root } = r);
  // the project's own three files lead, in this order; the rest keep the server's newest-first order (sort is stable)
  const PINNED = ['model.txt', 'settings.json', 'history.md'], rank = f => (PINNED.indexOf(f.path) + 1) || PINNED.length + 1;
  files.sort((a, b) => rank(a) - rank(b));
  if (cur && JSON.stringify(cur.where) === JSON.stringify(q)) {
    const f = files.find(x => x.path === cur.path);
    // changed on disk (the assistant rewrote it): reload unless that would drop edits
    if (f && f.mtime !== cur.mtime) { if (dirty()) cur.stale = true; else await show(cur.path, f, q); }
    else if (!f && !dirty()) cur = null;
  } else if (cur && moved && !dirty()) cur = null;   // another project's file, nothing to lose
  if (seq !== loadSeq || context(q) !== context(where())) return;
  renderList(); paint();
  if (pending) { const p = pending; pending = null; select(p); }
}

/* ------------------------------ the editor ------------------------------ */
function gutter() {
  const n = ta().value.split('\n').length, g = $('#flGutter');
  if (g.dataset.n !== String(n)) {
    g.dataset.n = n;
    g.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n');
  }
  g.scrollTop = ta().scrollTop;
}

/** Everything right of the list, from `cur`. */
function paint(msg) {
  const has = !!cur;
  $('#flBar').hidden = !has;
  $('#flEditor').hidden = cur?.kind !== 'text';
  $('#flPreview').hidden = !has || cur.kind === 'text';
  $('#flBlank').hidden = has;
  $('#flNote').hidden = !cur?.readonly;
  $('#flBlank').textContent = msg ?? 'Select a file to view or edit it.';
  if (!has) return;
  const raw = url('/api/file', cur.where, { path: cur.path, raw: 1, t: cur.mtime });
  $('#flName').textContent = cur.path;
  const dl = $('#flDownload');
  dl.href = raw; dl.download = cur.path.split('/').pop();
  if (cur.kind === 'text') { ta().readOnly = cur.readonly; gutter(); }
  else $('#flPreview').innerHTML = cur.kind === 'image'
    ? `<img class="fl-img" src="${esc(raw)}" alt="${esc(cur.path)}">`
    : `<div class="fl-bin"><div>${esc(typeOf(cur.path))}, ${size(cur.size)}</div>
         <div class="muted">${cur.tooBig ? 'Too large to edit here.' : 'This file cannot be shown here.'} Download it to open it.</div></div>`;
  status();
}

function status(error) {
  if (!cur) return;
  const d = dirty(), text = cur.kind === 'text';
  $('#flMeta').textContent = typeOf(cur.path) + ', ' +
    (text ? (n => n + (n === 1 ? ' line' : ' lines'))(ta().value.split('\n').length) : size(cur.size));
  const st = $('#flStatus');
  st.textContent = error ?? (!text || cur.readonly ? '' : d ? 'Unsaved changes' + (cur.stale ? ' (the file also changed on disk)' : '') : 'Saved');
  st.className = 'fl-status' + (error ? ' err' : d ? ' dirty' : '');
  $('#flSave').disabled = !d;
  $('#flRevert').disabled = !d;
  const own = !cur.path.includes('/') && OWN.includes(cur.path);
  $('#flDelete').disabled = own;
  $('#flDelete').title = own ? 'Part of the project itself — delete the project instead' : '';
  disarm();
}

function disarm() {
  armed = false;
  const b = $('#flDelete');
  b.textContent = 'Delete'; b.classList.remove('danger');
}

/** Load `path` into the right-hand side. `f` is its list entry. */
async function show(path, f, q = where()) {
  const seq = ++showSeq, before = cur, contents = ta().value;
  const current = () => seq === showSeq && context(q) === context(where());
  const next = { path, where: q, mtime: f.mtime, size: f.size, saved: '', stale: false,
                 kind: IMAGE.includes(ext(path)) ? 'image' : f.text ? 'text' : 'bin',
                 tooBig: !f.text && f.size > 1048576,
                 // the live model is edited in the Model tab, which also re-runs it
                 readonly: path === 'model.txt' && !!q.project && !q.dir };
  if (next.kind === 'text') {
    try {
      const r = await api(url('/api/file', q, { path }));
      if (!current()) return;
      // Typing while this read is in flight must not discard those new edits.
      if (cur === before && ta().value !== contents) return;
      next.saved = r.content; next.mtime = r.mtime; next.size = r.size;
    } catch (e) { if (current()) { cur = null; renderList(); paint(String(e.message || e)); } return; }
    ta().value = next.saved;
    ta().scrollTop = ta().scrollLeft = 0;
  }
  cur = next;
  renderList(); paint();
}

async function select(path) {
  if (listWhere !== context(where())) { pending = path; return load(); }
  if (cur && path === cur.path && JSON.stringify(cur.where) === JSON.stringify(where())) return;
  if (dirty() && !confirm(`Discard unsaved changes to ${cur.path}?`)) return;
  const f = files.find(x => x.path === path);
  if (!f) { ++showSeq; cur = null; renderList(); return paint(`There is no file “${path}” in this folder.`); }
  await show(path, f);
}

async function save() {
  if (!dirty()) return;
  const content = ta().value, c = cur;
  try {
    const r = await api('/api/file', { method: 'PUT', headers: { 'content-type': 'application/json' },
                                       body: JSON.stringify({ ...c.where, path: c.path, content }) });
    c.saved = content; c.mtime = r.mtime; c.stale = false;
    if (cur === c) status();
    load();
  } catch (e) { if (cur === c) status('Not saved: ' + (e.message || e)); }
}

async function del() {
  if (!cur) return;
  if (!armed) {
    armed = true;
    const b = $('#flDelete');
    b.textContent = 'Confirm delete'; b.classList.add('danger');
    return;
  }
  const c = cur;
  try {
    await api(url('/api/file', c.where, { path: c.path }), { method: 'DELETE' });
    if (cur === c) { ++showSeq; cur = null; paint(); }
    load();
  } catch (e) { if (cur === c) status('Not deleted: ' + (e.message || e)); }
}

/* -------------------------------- public -------------------------------- */
export function initFiles() {
  const view = $('#viewFiles');
  if (!view) return;
  view.innerHTML = `
    <div class="fl-side">
      <div class="fl-hd">
        <div class="fl-hd-row"><h2 class="fl-title">Files</h2><span class="fl-count" id="flCount"></span>
          <button type="button" class="btn sm" id="flRefresh">Refresh</button></div>
        <div class="fl-root mono" id="flRoot"></div>
      </div>
      <div class="fl-list" id="flList"></div>
    </div>
    <div class="fl-main">
      <div class="fl-bar" id="flBar" hidden>
        <span class="fl-cur mono" id="flName"></span>
        <span class="fl-meta" id="flMeta"></span>
        <span class="fl-status" id="flStatus" role="status"></span>
        <span class="fl-grow"></span>
        <a class="btn" id="flDownload">Download</a>
        <button type="button" class="btn fl-del" id="flDelete">Delete</button>
        <button type="button" class="btn" id="flRevert">Revert</button>
        <button type="button" class="btn primary" id="flSave">Save</button>
      </div>
      <div class="fl-note" id="flNote" hidden>The live model is edited in the Model tab, so this copy is read-only.
        <button type="button" class="fl-link" id="flToModel">Open the Model tab</button></div>
      <div class="fl-editor" id="flEditor" hidden>
        <div class="fl-gutter" id="flGutter" aria-hidden="true"></div>
        <textarea class="fl-text" id="flText" spellcheck="false" wrap="off" autocapitalize="off"
                  autocomplete="off" aria-label="File contents"></textarea>
      </div>
      <div class="fl-preview" id="flPreview" hidden></div>
      <div class="fl-blank" id="flBlank">Select a file to view or edit it.</div>
    </div>`;

  $('#flList').onclick = e => { const b = e.target.closest('[data-path]'); if (b) select(b.dataset.path); };
  $('#flRefresh').onclick = load;
  ta().oninput = () => { gutter(); status(); };
  ta().onscroll = () => { $('#flGutter').scrollTop = ta().scrollTop; };
  $('#flSave').onclick = save;
  $('#flRevert').onclick = () => { if (!dirty()) return; ta().value = cur.saved; gutter(); status(); };
  $('#flDelete').onclick = del;
  $('#flDelete').onblur = disarm;
  $('#flToModel').onclick = () => go('workspace', 'model');
  addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 's' && !view.hidden) { e.preventDefault(); save(); }
  });
  addEventListener('beforeunload', e => { if (dirty()) e.preventDefault(); });
  // the project may have changed, and the assistant may have written files
  onShow(({ nav }) => { if (nav === 'files') load(); });
}

/** Show the Files view with `path` (relative to the project folder) selected. */
export function openFile(path) {
  pending = String(path ?? '').replace(/^\.\//, '') || null;
  go('files');   // -> onShow -> load() -> select(pending)
}
