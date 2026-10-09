export const $  = s => document.querySelector(s);
export const $$ = s => [...document.querySelectorAll(s)];
export const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

export const SERIES = ['--s1','--s2','--s3','--s4','--s5','--s6','--s7','--s8'];

export const store = {
  get:(k,d)=>{ try{ return JSON.parse(localStorage.getItem('mca.'+k)) ?? d }catch{ return d } },
  set:(k,v)=>{ try{ localStorage.setItem('mca.'+k, JSON.stringify(v)) }catch{} },
};

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const SVG = 'http://www.w3.org/2000/svg';
export const el = (n,a={}) => { const e=document.createElementNS(SVG,n);
  for(const k in a) e.setAttribute(k,a[k]); return e; };

export const fmt = v =>
  Math.abs(v)>=1000 || (Math.abs(v)<0.01 && v!==0)
    ? v.toExponential(2)
    : (+v.toFixed(3)).toLocaleString();

export const numText = v => String(+(+v).toPrecision(6));

export function ticks(lo,hi,n){
  const raw=(hi-lo)/n, mag=Math.pow(10,Math.floor(Math.log10(raw||1)));
  const step=([1,2,2.5,5,10].find(m=>m*mag>=raw) ?? 10)*mag;
  const out=[]; for(let v=Math.ceil(lo/step)*step; v<=hi+step*1e-9; v+=step) out.push(+v.toFixed(10));
  return out;
}

/** Run `fn` at once on every call; a call that arrives while it is running is
    picked up the moment it returns, and any number of such calls collapse into
    that one follow-up — which reads the latest state, so nothing is lost.

    For the sliders. A debounce, even one with a ceiling, delayed each movement,
    and letting a newer run discard the one before meant that a steady drag drew
    nothing until the slider was let go. */
export function latestOnly(fn){
  let busy = false, again = false;
  return async () => {
    if(busy){ again = true; return; }
    busy = true;
    try { do { again = false; try { await fn(); } catch (e) { console.error(e); } } while(again); }
    finally { busy = false; }
  };
}

export function flash(btn, text, ms=900){
  const old=btn.textContent; btn.textContent=text; btn.disabled=true;
  setTimeout(()=>{ btn.textContent=old; btn.disabled=false; }, ms);
}

/** Filesystem-safe name, for filenames and session folder names alike. Must stay
    identical to slug() in backend/sessions.mjs — backend/sessions.test.mjs pins them. */
export const slug = s => String(s).replace(/[\/\\:*?"<>|\x00-\x1f]/g, '').replace(/\s+/g, '-')
                                  .replace(/^[.\-]+|[.\-]+$/g, '').slice(0, 80);

/* ---- the keyword rule Search uses on both tiers (web/js/search.mjs, backend/files.mjs) ---- */
export const SNIPPET = 160;
/** The query's words: lower-cased, longer than one character, no duplicates. */
export const queryWords = q => [...new Set(String(q ?? '').toLowerCase().split(/[^\p{L}\p{N}_.]+/u)
  .map(w => w.replace(/^\.+|\.+$/g, '')).filter(w => w.length > 1))];
/** How many of `words` occur in `text` (case-insensitive substring). */
export const hits = (words, text) => { const t = String(text ?? '').toLowerCase(); return words.filter(w => t.includes(w)).length; };
