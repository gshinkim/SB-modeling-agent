import { $ } from './util.mjs';
import { listSessions } from './session.mjs';

/* The file picker's box, relabelled: same centered card, same scrolling list, a
   search field where the path row was. Reusing .fp means no second modal to keep
   in visual sync with the first. */

let resolveFn = null, rows = [], picked = null, mode = 'open', marked = new Set(), built = false, loadSeq = 0;

/** Name or id, case-insensitively. Exported so it can be tested without a DOM. */
export const matches = (s, q) => {
  const n = String(q ?? '').trim().toLowerCase();
  return !n || String(s.name ?? '').toLowerCase().includes(n)
            || String(s.id ?? '').toLowerCase().includes(n);
};

function ensureDom(){
  // A DOM-presence check (`if($('#sp')) return`) can be spoofed by agent-authored
  // SVG carrying an id="sp" (md.mjs); a module flag can't be.
  if(built) return;
  built = true;
  const d = document.createElement('div');
  d.id = 'sp'; d.className = 'fp'; d.setAttribute('role','dialog');
  d.innerHTML = `
    <div class="fp-hd">
      <strong id="spTitle"></strong>
      <span class="sp" style="flex:1"></span>
      <button class="btn icon ghost sm" id="spClose" aria-label="Cancel">✕</button>
    </div>
    <div class="fp-path"><input id="spQ" class="sp-q" type="search" placeholder="Search projects…"
      autocomplete="off" spellcheck="false" aria-label="Search projects"></div>
    <div class="fp-list" id="spList" tabindex="0"></div>
    <div class="fp-ft">
      <code id="spSel" class="hint"></code>
      <span class="sp" style="flex:1"></span>
      <button class="btn sm" id="spCancel">Cancel</button>
      <button class="btn sm primary" id="spOk" disabled>Open</button>
    </div>`;
  document.body.append(d);
  $('#spClose').onclick = $('#spCancel').onclick = () => close(null);
  $('#spOk').onclick = () => close(mode === 'delete' ? [...marked] : picked);
  $('#spQ').oninput = render;
  $('#scrim').addEventListener('click', () => { if(resolveFn) close(null); });
  addEventListener('keydown', e => { if(e.key === 'Escape' && resolveFn) close(null); });
}

function close(v){
  ++loadSeq;
  $('#sp')?.classList.remove('on');
  $('#scrim').classList.remove('on');
  const f = resolveFn; resolveFn = null; picked = null; marked = new Set();
  f?.(v);
}

const when = ms => !ms ? '' : new Date(ms).toLocaleString();

function render(){
  const L = $('#spList'); L.textContent = '';
  const shown = rows.filter(r => matches(r, $('#spQ').value));
  if(!shown.length){
    L.innerHTML = '<p class="hint" style="padding:12px">No projects'+
                  ($('#spQ').value.trim() ? ' matching that.' : ' yet.')+'</p>';
    $('#spOk').disabled = true; return;
  }
  shown.forEach((s, i) => {
    const b = document.createElement('button');
    b.className = 'fp-row'; b.type = 'button';
    b.innerHTML = '<span class="fp-ic">🗂</span><span class="fp-nm"></span>'+
                  '<span class="sp" style="flex:1"></span><span class="hint sp-when"></span>';
    b.querySelector('.fp-nm').textContent = s.name || s.id;
    b.querySelector('.sp-when').textContent = when(s.updated);
    if(mode === 'delete'){
      // tick any number of rows; the button counts them
      const sync = () => {
        const on = marked.has(s.id);
        b.classList.toggle('sel', on); b.setAttribute('aria-pressed', on);
        b.querySelector('.fp-ic').textContent = on ? '☑' : '☐';
        $('#spOk').disabled = !marked.size;
        $('#spOk').textContent = marked.size ? 'Delete ' + marked.size : 'Delete';
        $('#spSel').textContent = marked.size ? [...marked].join(', ') : '';
      };
      b.onclick = () => { marked.has(s.id) ? marked.delete(s.id) : marked.add(s.id); sync(); };
      sync();
    } else {
      const choose = () => {
        [...L.children].forEach(c => c.classList.remove('sel'));
        b.classList.add('sel'); picked = s.id;
        $('#spSel').textContent = s.id; $('#spOk').disabled = false;
      };
      b.onclick = choose;
      b.ondblclick = () => { choose(); close(picked); };
      if(i === 0) choose();             // the list is newest-first, so this is the most recent
    }
    L.append(b);
  });
}

/** pickSession() → a project id to open, or null if cancelled.
    pickSession({ mode: 'delete' }) → the ids ticked for deletion, or null. */
export function pickSession(opts = {}){
  ensureDom();
  resolveFn?.(null);                 // a new invocation also settles the previous one
  const seq = ++loadSeq, result = new Promise(r => { resolveFn = r; });
  mode = opts.mode === 'delete' ? 'delete' : 'open';
  marked = new Set();
  const title = mode === 'delete' ? 'Delete projects' : 'Load a project';
  $('#spTitle').textContent = title; $('#sp').setAttribute('aria-label', title);
  $('#spOk').className = 'btn sm ' + (mode === 'delete' ? 'danger' : 'primary');
  $('#spOk').textContent = mode === 'delete' ? 'Delete' : 'Open';
  $('#spOk').disabled = true;
  $('#spQ').value = '';
  $('#sp').classList.add('on');
  $('#scrim').classList.add('on');
  rows = []; picked = null;
  $('#spList').textContent = 'Loading…'; $('#spSel').textContent = '';
  listSessions().then(found => {
    if(seq !== loadSeq || !resolveFn) return;  // cancellation while the list was loading is final
    rows = found; render();
    setTimeout(() => { if(seq === loadSeq && resolveFn) $('#spQ').focus(); }, 60);
  });
  return result;
}
