/* LaTeX in the assistant's answers, the browser half of md.mjs's tex section.
   - <latex-doc>: a ```latex block (or a bare tabular/itemize/… run). The server
     compiles it with real LaTeX (Tectonic, POST /api/latex); pdf.js draws each
     page, cropped to its ink, as an image in a shadow root. Until then, and if it
     fails, the element's own text, the source, shows; a failure says why.
   - Maths that rendered before MathJax finished loading was left as source
     (.math-src[data-tex]); it is upgraded as soon as MathJax is ready.
   - A live diagram (md.mjs liveFrame) reports its height; its frame is sized to it. */
import * as api from './api.mjs';

const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/';
let pdfjs = null;
async function pdfLib(){
  return pdfjs ??= import(PDFJS + 'pdf.min.mjs').then(m => {
    // a cross-origin worker script can't be started directly; a same-origin stub can import it
    const stub = URL.createObjectURL(new Blob(['import "' + PDFJS + 'pdf.worker.min.mjs";'], { type: 'text/javascript' }));
    m.GlobalWorkerOptions.workerPort = new Worker(stub, { type: 'module' });
    return m;
  });
}

/** The page's ink, in PDF points, from a coarse render: its x extent, and the bands
    of rows that hold ink. The wrapped page is 120cm tall and a footnote sits at its
    foot, so a blank stretch over GAP points is dropped rather than drawn. */
const GAP = 36;
async function ink(page){
  const k = 0.5, vp = page.getViewport({ scale: k });
  const c = Object.assign(document.createElement('canvas'), { width: Math.ceil(vp.width), height: Math.ceil(vp.height) });
  const g = c.getContext('2d', { willReadFrequently: true });
  await page.render({ canvasContext: g, viewport: vp }).promise;
  const { data, width, height } = g.getImageData(0, 0, c.width, c.height);
  let x0 = width, x1 = -1;
  const bands = [];
  for(let y = 0; y < height; y++){
    let hit = false;
    for(let x = 0; x < width; x++){
      const i = (y * width + x) * 4;
      if(data[i + 3] > 20 && (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245)){
        hit = true; if(x < x0) x0 = x; if(x > x1) x1 = x;
      }
    }
    if(!hit) continue;
    const last = bands.at(-1);
    if(last && y - last.y1 <= GAP * k) last.y1 = y; else bands.push({ y0: y, y1: y });
  }
  return x1 < 0 ? null : { x: x0 / k, w: (x1 - x0 + 1) / k, bands: bands.map(b => ({ y: b.y0 / k, h: (b.y1 - b.y0 + 1) / k })) };
}

/** One page to a PNG of just its ink, bands stacked with a small margin, drawn sharp. */
async function pageImage(page){
  const box = await ink(page);
  if(!box) return null;                                    // a blank page
  const zoom = 2 * (devicePixelRatio || 1), pad = 6, gap = 10;
  const W = box.w + 2 * pad, H = box.bands.reduce((n, b) => n + b.h, 0) + 2 * pad + gap * (box.bands.length - 1);
  const c = Object.assign(document.createElement('canvas'), { width: Math.ceil(W * zoom), height: Math.ceil(H * zoom) });
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  let at = pad;
  for(const b of box.bands){
    const part = Object.assign(document.createElement('canvas'), { width: c.width, height: Math.ceil((b.h + 2) * zoom) });
    const pg = part.getContext('2d');
    pg.fillStyle = '#fff'; pg.fillRect(0, 0, part.width, part.height);
    await page.render({ canvasContext: pg, viewport: page.getViewport({ scale: zoom,
      offsetX: -(box.x - pad) * zoom, offsetY: -(b.y - 1) * zoom }) }).promise;
    g.drawImage(part, 0, Math.round((at - 1) * zoom));
    at += b.h + gap;
  }
  return { src: c.toDataURL('image/png'), width: W * 1.25 };   // CSS px: 1pt = 1.25px reads like the chat text
}

// the answer re-renders on every streamed token: compile and draw each block once
const done = new Map();
function typeset(src){
  if(!done.has(src)) done.set(src, (async () => {
    const r = await api.latex(src);
    if(!r.ok) throw new Error(r.error || 'LaTeX failed');
    const lib = await pdfLib();
    const pdf = await lib.getDocument({ data: Uint8Array.from(atob(r.pdf), ch => ch.charCodeAt(0)) }).promise;
    const pages = [];
    for(let n = 1; n <= pdf.numPages; n++){ const p = await pageImage(await pdf.getPage(n)); if(p) pages.push(p); }
    return pages;
  })().catch(e => { done.delete(src); throw e; }));   // a later render tries again
  return done.get(src);
}

const STYLE = '<style>:host{display:block;margin:.4em 0;max-width:100%;overflow-x:auto}' +
  'img{display:block;max-width:100%;height:auto;border-radius:6px;margin:0 0 6px}' +
  '.e{font:12px var(--mono, monospace);color:var(--crit, #b00);white-space:pre-wrap;margin-top:4px}</style>';

const LatexDoc = globalThis.HTMLElement && class extends HTMLElement {   // absent under node --test
  async connectedCallback(){
    if(this.shadowRoot || this.busy || !this.textContent.trim()) return;
    this.busy = true;
    try {
      const pages = await typeset(this.textContent);
      this.attachShadow({ mode: 'open' }).innerHTML = STYLE +
        pages.map(p => '<img alt="LaTeX" style="width:' + p.width.toFixed(0) + 'px" src="' + p.src + '">').join('');
    } catch(e){
      const sh = this.attachShadow({ mode: 'open' });
      sh.innerHTML = STYLE + '<slot></slot><div class="e"></div>';
      sh.querySelector('.e').textContent = 'LaTeX did not compile: ' + (e?.message ?? e);
    }
    this.classList.add('done');
  }
}
if(LatexDoc && !customElements.get('latex-doc')) customElements.define('latex-doc', LatexDoc);

function upgradeMath(){
  for(const el of document.querySelectorAll('.math-src[data-tex]')){
    try { el.replaceWith(MathJax.tex2svg(el.dataset.tex, { display: el.hasAttribute('data-display') })); }
    catch {}
  }
}
if(LatexDoc){
  addEventListener('mathjax-ready', upgradeMath);
  if(globalThis.MathJax?.tex2svg) upgradeMath();
}

if(LatexDoc){
  // only a frame's own report counts, matched by window, never by what the message claims
  addEventListener('message', e => {
    const h = e.data?.mcaLive;
    if(typeof h !== 'number') return;
    for(const f of document.querySelectorAll('.md-live iframe'))
      if(f.contentWindow === e.source) f.style.height = Math.min(Math.max(h, 60), 1200) + 'px';
  });
}
