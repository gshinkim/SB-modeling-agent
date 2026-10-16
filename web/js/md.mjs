/* Markdown for text an agent produced.

   That text is untrusted: it may be relaying a file, a tool result or a web page,
   so the only order that is safe is to escape the entire document first and then
   re-introduce exactly the markup this file chose to emit. Inline SVG is the one
   exception — the agent draws diagrams with it — and it goes through an allowlist
   of elements and attributes, never a blocklist.

   String processing throughout, deliberately: this has to be testable under
   `node --test`, where there is no DOM to parse into. */

const ESC = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' };
const esc = s => String(s).replace(/[&<>"']/g, c => ESC[c]);

/* ------------------------------- svg allowlist ------------------------------- */

const TAGS = 'svg g path rect circle ellipse line polyline polygon text tspan defs marker linearGradient radialGradient stop title desc';
const ATTRS = 'd x y x1 y1 x2 y2 cx cy r rx ry width height points viewBox fill stroke stroke-width stroke-dasharray stroke-linecap stroke-linejoin stroke-opacity fill-opacity transform opacity font-size font-family font-weight text-anchor dominant-baseline class id offset stop-color stop-opacity marker-end marker-start gradientUnits markerWidth markerHeight refX refY orient xmlns';

// SVG names are camelCase (viewBox, linearGradient) but HTML parsing lowercases,
// so match case-insensitively and write back the canonical spelling.
const canon = list => new Map(list.split(' ').map(n => [n.toLowerCase(), n]));
const TAG_OK = canon(TAGS), ATTR_OK = canon(ATTRS);

const BAD_URL = /^\s*(?:javascript|vbscript|data)\s*:/i;

/* A model told to write Markdown sometimes writes HTML anyway. Rendering a safe
   subset is kinder than showing it the source it just produced — same allowlist
   engine as the SVG above, different vocabulary. */
const H_TAGS = 'p br hr h1 h2 h3 h4 h5 h6 b strong i em u s del ins mark small sub sup code pre kbd samp var blockquote ul ol li table thead tbody tfoot tr th td caption a span div figure figcaption';
const H_ATTRS = 'href title colspan rowspan align class start';
const H_BLOCK = 'p h1 h2 h3 h4 h5 h6 blockquote ul ol table pre div figure';
const HTAG_OK = canon(H_TAGS), HATTR_OK = canon(H_ATTRS);
const VOID = new Set(['br', 'hr']);
// a whole block element, open tag through its matching close, possibly multiline
const H_BLOCK_RE = new RegExp('<(' + H_BLOCK.split(' ').join('|') +
  ')\\b[^>]*>[\\s\\S]*?</\\1\\s*>', 'gi');
// and any remaining single tag, which is how <b> and <br> turn up mid-sentence
const H_INLINE_RE = new RegExp('</?(?:' + H_TAGS.split(' ').join('|') +
  ')\\b(?:[^>"\']|"[^"]*"|\'[^\']*\')*/?>', 'gi');

/** Elements whose *contents* are dangerous, not just their tags. */
const NUKE = /<\s*(script|style|foreignObject|iframe|object|embed|animate|set|handler)\b[\s\S]*?(?:<\s*\/\s*\1\s*>|$)/gi;

const ATTR_RE = /([A-Za-z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

// Agent-authored SVG shares the page's DOM. An unprefixed id (or a url(#x) /
// href="#x" reference to one) can collide with the app's own dialog ids
// ($('#sp'), $('#fp'), ...) and break them. Every id this sanitizer lets
// through, and every reference to one, is namespaced so it can never collide.
const NS = v => 'md-' + v;

function attrsFor(raw, ATTR_OK) {
  const out = [];
  for (const m of raw.matchAll(ATTR_RE)) {
    const name = m[1], lower = name.toLowerCase();
    let val = m[2] ?? m[3] ?? m[4] ?? '';
    if (lower.startsWith('on')) continue;              // every event handler, always
    if (!ATTR_OK.has(lower)) continue;
    if (BAD_URL.test(val)) continue;
    // an href may only point somewhere a click can safely go
    if (lower === 'href' && !/^(?:https?:|mailto:|#)/i.test(val)) continue;
    // url(#grad) is the only reference form worth keeping; anything reaching out
    // of the document is not a diagram
    if (/url\s*\(/i.test(val) && !/^[^(]*url\s*\(\s*#/i.test(val)) continue;
    if (lower === 'id') val = NS(val);
    else if (lower === 'href' && val.startsWith('#')) val = '#' + NS(val.slice(1));
    else if (/url\s*\(\s*#/i.test(val)) val = val.replace(/url\s*\(\s*#([^)]*)\)/gi, (_, id) => 'url(#' + NS(id) + ')');
    out.push(ATTR_OK.get(lower) + '="' + esc(val) + '"');
  }
  return out.length ? ' ' + out.join(' ') : '';
}

/** Sanitize a markup run against an allowlist. Anything not on it disappears. */
function sanitize(src, TAG_OK, ATTR_OK, balance = true) {
  let s = String(src).replace(NUKE, '');
  let out = '';
  const open = [];
  const re = /<\s*(\/?)\s*([A-Za-z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)\s*>/g;
  let last = 0, m;
  while ((m = re.exec(s))) {
    out += esc(s.slice(last, m.index));                // text between tags is text
    last = re.lastIndex;
    const [, close, name, attrs, selfShut] = m;
    const key = TAG_OK.get(name.toLowerCase());
    if (!key) continue;                                // unknown element: drop the tag
    if (close) {
      if (!balance) { out += '</' + key + '>'; continue; }
      if (open.at(-1) === key) { open.pop(); out += '</' + key + '>'; }
      continue;
    }
    if (VOID.has(key)) { out += '<' + key + '>'; continue; }
    if (selfShut) { out += '<' + key + attrsFor(attrs, ATTR_OK) + '/>'; continue; }
    if (balance) open.push(key);
    out += '<' + key + attrsFor(attrs, ATTR_OK) + '>';
  }
  out += esc(s.slice(last));
  while (open.length) out += '</' + open.pop() + '>';   // never leak an unclosed tag
  return out;
}

export const sanitizeSvg  = src => sanitize(src, TAG_OK, ATTR_OK);
export const sanitizeHtml = src => sanitize(src, HTAG_OK, HATTR_OK);

/* ---------------------------------- tex ---------------------------------- */
/* Maths is rendered by MathJax (loaded from a CDN in index.html, so absent under
   `node --test`, offline, or for a moment at startup: latex.mjs upgrades what was
   left as source once it loads). Every span is held before markdown runs, so `_`
   and `*` inside it are never read as emphasis. Inline code spans are matched
   first and given back untouched, so `$x$` in backticks stays code. A single `$`
   is a delimiter only in the pandoc shape — no space just inside either `$`, no
   digit right after the closing one — so Antimony's `$X0 -> S1; $X1` and "$5 to
   $10" stay text. A bare \begin{align}…\end{align} (and kin) is display maths. */
const MATH = /(`+)[\s\S]*?\1|\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<![\\$\w])\$(?![\s$])([^$\n]*?[^\s\\$])\$(?![\d$])|(\\begin\{(equation|align|alignat|gather|multline|flalign|eqnarray|CD)\*?\}[\s\S]*?\\end\{\7\*?\})/g;

function tex(src, display) {
  const mj = globalThis.MathJax;
  if (!mj?.tex2svg) return null;
  try { return mj.tex2svg(src, { display }).outerHTML; }
  catch { return null; }
}

function math(s, hold) {
  return s.replace(MATH, (m, code, dd, br, pa, d, env) => {
    if (code) return m;
    const display = pa == null && d == null;
    const src = (env ?? dd ?? br ?? pa ?? d).trim();
    // inline maths gets its own marker so a line of it is still a paragraph
    return hold(tex(src, display) ?? '<span class="math-src" data-tex="' + esc(src) + '"' +
                (display ? ' data-display' : '') + '>' + esc(m) + '</span>', !display);
  });
}

/* Text-mode LaTeX — a closed ```latex fence, or a bare tabular/itemize/… block —
   becomes a <latex-doc> element that latex.mjs has compiled by real LaTeX. Its text
   is the escaped source, which is also what shows until then, or if it fails. */
const LATEX_DOC = /(`+)[\s\S]*?\1|(?:\\documentclass[\s\S]*?)?\\begin\{(document|tabular|tabularx|itemize|enumerate|description|center|quote|quotation|verse|flushleft|flushright|verbatim|minipage|table|figure|tikzpicture)\*?\}[\s\S]*?\\end\{\2\*?\}/g;
const latexDoc = src => '<latex-doc>' + esc(src) + '</latex-doc>';

/* ------------------------------ live diagrams ------------------------------ */
/* A closed ```html fence is an interactive diagram: hover, sliders, clickable
   nodes, d3 or Plotly. It runs, with its scripts, in an iframe sandboxed to an
   opaque origin (no allow-same-origin), so it cannot touch the app's page,
   storage or cookies; its CSP lets scripts come only from inline or the two CDNs
   and blocks fetch, forms and every other way out, so it cannot reach this app's
   server either. It reports its height to latex.mjs so the frame fits it. */
export const LIVE_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; " +
  "style-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://fonts.googleapis.com; " +
  "font-src https://fonts.gstatic.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net data:; img-src data: blob:; " +
  "connect-src 'none'; form-action 'none'; base-uri 'none'";
const LIVE_HEAD = '<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + LIVE_CSP + '">' +
  '<style>html{margin:0;padding:0}body{margin:0;padding:8px;font:13px system-ui,sans-serif;color:#1d1d1f;background:#fff;overflow-x:auto}</style>';
// on load as well as on resize: a page in a background tab does no resize observing
// the body's own height, not the document's (that is never less than the frame)
const LIVE_SIZE = '<script>{const b=document.body,s=()=>parent.postMessage({mcaLive:Math.ceil(b.getBoundingClientRect().height)+2},"*");' +
  'addEventListener("load",s);document.addEventListener("visibilitychange",s);new ResizeObserver(s).observe(b)}<\/script>';
export const liveDoc = code => '<!doctype html><html><head>' + LIVE_HEAD + '</head><body>' + code + LIVE_SIZE + '</body></html>';
const liveFrame = code => '<div class="md-live"><iframe sandbox="allow-scripts" title="Interactive diagram" loading="lazy" srcdoc="' +
  esc(liveDoc(code)) + '"></iframe></div>';

/* --------------------------------- inline --------------------------------- */

const LINK_OK = /^(?:https?:|mailto:)/i;

function inline(t) {
  return esc(t)
    .replace(/`([^`]+)`/g, (_, c) => '<code>' + c + '</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|\W)\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|\W)_([^_\n]+)_/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/==([^=]+)==/g, '<mark>$1</mark>')
    // href was escaped with the rest of the text, so unescape just enough to test it
    .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (m, txt, href) => {
      const u = href.replace(/&amp;/g, '&');
      return LINK_OK.test(u)
        ? '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + txt + '</a>'
        : txt;                                          // keep the words, drop the link
    });
}

/* --------------------------------- blocks --------------------------------- */

const LIST = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/;
// a line that is nothing but held block elements must not be wrapped in <p>
const ONLY_HELD = /^(?:\uE000\d+\uE000\s*)+$/;
const SEP  = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;
const cells = l => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());

function list(lines, i, out) {
  const ordered = !LIST.exec(lines[i])[2];
  const tag = ordered ? 'ol' : 'ul';
  const base = LIST.exec(lines[i])[1].length;
  out.push('<' + tag + '>');
  let depth = 0;
  while (i < lines.length) {
    const m = LIST.exec(lines[i]);
    if (!m) break;
    const ind = m[1].length;
    if (ind > base && !depth) { out.push('<' + tag + '>'); depth = 1; }
    else if (ind <= base && depth) { out.push('</' + tag + '>'); depth = 0; }
    out.push('<li>' + inline(m[4]) + '</li>');
    i++;
  }
  if (depth) out.push('</' + tag + '>');
  out.push('</' + tag + '>');
  return i;
}

function table(lines, i, out) {
  const head = cells(lines[i]);
  out.push('<table><thead><tr>' + head.map(c => '<th>' + inline(c) + '</th>').join('') +
           '</tr></thead><tbody>');
  i += 2;
  while (i < lines.length && lines[i].includes('|')) {
    out.push('<tr>' + cells(lines[i]).map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>');
    i++;
  }
  out.push('</tbody></table>');
  return i;
}

/** renderMarkdown(src) -> HTML string, safe to assign to innerHTML. */
export function renderMarkdown(src, held) {
  // Fences and SVG come out before anything else: their contents must not be
  // read as markdown, and the placeholder survives escaping untouched.
  // A blockquote recurses with the outer `held`, so its placeholders survive.
  const top = !held;
  held ??= [];
  const hold = (html, inl) => { const c = inl ? '\uE001' : '\uE000'; return c + (held.push(html) - 1) + c; };

  let s = String(src ?? '').replace(/\r\n?/g, '\n');
  if (top) s = s.replace(/[\uE000\uE001]/g, '');

  /* Some models wrap the whole reply in a ```markdown fence. Taken literally that
     is a request to show the answer as source, which is never what was meant. */
  const whole = /^\s*```(?:markdown|md)\s*\n([\s\S]*?)```\s*$/i.exec(s);
  if (whole) s = whole[1];

  s = s.replace(/```(\w*)\n?([\s\S]*?)(```|$)/g, (_, lang, code, shut) => shut && /^(?:la)?tex$/i.test(lang) ? hold(latexDoc(code)) :
    shut && /^html$/i.test(lang) ? hold(liveFrame(code)) :
    hold('<pre><code' + (lang ? ' class="lang-' + esc(lang) + '"' : '') + '>' +
         esc(code.replace(/\n$/, '')) + '</code></pre>'));

  s = s.replace(LATEX_DOC, (m, code) => code ? m : hold(latexDoc(m)));   // code spans stay code
  s = math(s, hold);       // after the fences: TeX inside a code block stays literal

  s = s.replace(/<svg[\s\S]*?(?:<\/svg\s*>|$)/gi, m =>
    hold('<figure class="md-svg">' + sanitizeSvg(m) + '</figure>'));

  /* HTML where Markdown was expected. A model that writes <b> or a whole <table>
     meant it to be read as formatting, so render the safe subset instead of
     showing it the source it just produced. Whole blocks first, then any stray
     inline tag; both keep their content, which markdown still parses around. */
  s = s.replace(H_BLOCK_RE, m => hold(sanitizeHtml(m)));
  s = s.replace(H_INLINE_RE, m => hold(sanitize(m, HTAG_OK, HATTR_OK, false)));

  const lines = s.split('\n'), out = [];
  for (let i = 0; i < lines.length;) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    let m;
    if ((m = /^ {0,3}(#{1,6})\s+(.*)$/.exec(l))) {
      out.push('<h' + m[1].length + '>' + inline(m[2].replace(/\s+#+\s*$/, '')) +
               '</h' + m[1].length + '>'); i++; continue;
    }
    if (/^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (/^ {0,3}>/.test(l)) {
      const q = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) q.push(lines[i++].replace(/^ {0,3}>\s?/, ''));
      out.push('<blockquote>' + renderMarkdown(q.join('\n'), held) + '</blockquote>');
      continue;
    }
    if (l.includes('|') && SEP.test(lines[i + 1] ?? '')) { i = table(lines, i, out); continue; }
    if (LIST.test(l)) { i = list(lines, i, out); continue; }
    if (ONLY_HELD.test(l.trim())) { out.push(l.trim()); i++; continue; }
    const p = [];
    while (i < lines.length && lines[i].trim() && !/^ {0,3}(#{1,6}\s|>)/.test(lines[i]) &&
           !LIST.test(lines[i]) && !ONLY_HELD.test(lines[i].trim())) p.push(lines[i++]);
    out.push('<p>' + inline(p.join('\n')).replace(/\n/g, '<br>') + '</p>');
  }

  // held HTML can itself hold placeholders (math inside an HTML table)
  const restore = h => h.replace(/[\uE000\uE001](\d+)[\uE000\uE001]/g, (_, n) => restore(held[+n] ?? ''));
  return top ? restore(out.join('\n')) : out.join('\n');
}
