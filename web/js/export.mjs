import { $, css, fmt, slug } from './util.mjs';
import { S } from './state.mjs';

/* The chart is already SVG with literal colours baked into attributes, so export
   is a clone + a background + a font-family away. PNG goes through a canvas. */

const stamp = () => new Date().toISOString().slice(0,16).replace(/[:T]/g,'-');

export function save(blob, name){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 4000);
}

function svgString(scale = 1){
  const src = $('#chart');
  const w = src.clientWidth, h = src.clientHeight;
  const svg = src.cloneNode(true);
  svg.setAttribute('xmlns','http://www.w3.org/2000/svg');
  svg.setAttribute('width', w*scale);
  svg.setAttribute('height', h*scale);
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('font-family','system-ui, -apple-system, Segoe UI, sans-serif');
  // the card behind the plot is the background; a transparent export looks broken
  const bg = document.createElementNS('http://www.w3.org/2000/svg','rect');
  bg.setAttribute('width', w); bg.setAttribute('height', h);
  bg.setAttribute('fill', css('--surface'));
  svg.insertBefore(bg, svg.firstChild);
  svg.querySelectorAll('rect[fill="transparent"]').forEach(r=>r.remove());  // hover hit areas
  return { xml: new XMLSerializer().serializeToString(svg), w, h };
}

export function downloadSVG(){
  const { xml } = svgString();
  save(new Blob([xml], {type:'image/svg+xml'}), `mca-atlas-${stamp()}.svg`);
}

export function downloadPNG(scale = 2){
  const { xml, w, h } = svgString();
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = w*scale; c.height = h*scale;
    const ctx = c.getContext('2d');
    ctx.fillStyle = css('--surface'); ctx.fillRect(0,0,c.width,c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    c.toBlob(b => b && save(b, `mca-atlas-${stamp()}.png`), 'image/png');
  };
  img.onerror = () => downloadSVG();          // fall back rather than fail silently
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
}

/** The Antimony source itself — the thing Tellurium actually loads. */
export function downloadAntimony(){
  const src = document.querySelector('#model').value;
  // the name the user typed wins; otherwise fall back to the model's own id, and
  // only then the clock — a folder of these should stay readable
  const typed = slug(document.querySelector('#projName')?.textContent ?? '');
  const named = (typed && typed !== 'Untitled-project' ? typed : '')
             || src.match(/^\s*model\s+\*?\s*([A-Za-z_]\w*)/m)?.[1];
  save(new Blob([src.endsWith('\n') ? src : src+'\n'], {type:'text/plain'}),
       (named || 'model-' + stamp()) + '.ant');
}

/** The conversation as Markdown — the same source the chat bubbles rendered from,
    so bold, tables and any SVG the agent drew survive the trip to a file. */
export const stampNow = stamp;

export function downloadChat(title, md){
  save(new Blob([md], {type:'text/markdown;charset=utf-8'}),
       (slug(title) || 'chat') + '-chat-' + stamp() + '.md');
}

export function downloadCSV(){
  const r = S.result;
  if(!r) return;
  const head = ['time', ...r.names].join(',');
  const rows = r.t.map((t,i)=> [t, ...r.cols.map(c=>c[i])].join(','));
  save(new Blob([head+'\n'+rows.join('\n')+'\n'], {type:'text/csv'}), `mca-atlas-${stamp()}.csv`);
}

/** Load a .ant / .txt model from disk into the editor. A file input is right here:
    we want the contents, not a path, and it gets the OS picker for free. */
export function initImport(onLoad){
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.ant,.txt,.antimony,.xml,.sbml,text/plain,text/xml'; input.hidden = true;
  document.body.append(input);
  input.onchange = async () => {
    const f = input.files?.[0];
    input.value = '';
    if(!f) return;
    const text = await f.text();
    if(!text.trim()) return alert('That file is empty.');
    onLoad(text, f.name);
  };
  $('#openBtn').onclick = () => input.click();

  // dropping a .ant on the editor is the obvious gesture; support it
  const drop = $('#editorWrap');
  const stop = e => { e.preventDefault(); e.stopPropagation(); };
  ['dragenter','dragover'].forEach(ev => drop.addEventListener(ev, e => {
    stop(e); drop.classList.add('dropping'); }));
  ['dragleave','drop'].forEach(ev => drop.addEventListener(ev, e => {
    stop(e); drop.classList.remove('dropping'); }));
  drop.addEventListener('drop', async e => {
    const f = e.dataTransfer?.files?.[0];
    if(!f) return;
    const text = await f.text();
    if(text.trim()) onLoad(text, f.name);
  });
}

/** `extra` adds menu entries by data-fmt: the control coefficients and the run report. */
export function initExport(extra = {}){
  const btn = $('#dlBtn'), menu = $('#dlMenu');
  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded','false'); };
  btn.onclick = e => {
    e.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open; btn.setAttribute('aria-expanded', open);
  };
  menu.querySelectorAll('button').forEach(b => b.onclick = () => {
    close();
    ({ png: downloadPNG, svg: downloadSVG, csv: downloadCSV, ant: downloadAntimony, ...extra })[b.dataset.fmt]?.();
  });
  addEventListener('click', close);
  addEventListener('keydown', e => { if(e.key === 'Escape') close(); });
}
