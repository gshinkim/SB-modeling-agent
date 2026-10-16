/* The Search view: keyword search over the project's files (backend/files.mjs) and,
   built here at query time, the model's reactions, species and parameters and the
   chat turns. Keyword matching, not semantic: the assistant is a full agent that can
   run for minutes, so it is only asked when the user presses the button. */
import { $, esc, SNIPPET, queryWords, hits } from './util.mjs';
import { go, onShow } from './shell.mjs';
import { currentId } from './session.mjs';
import { scratchDir } from './settings.mjs';
import { S } from './state.mjs';
import { dumpChats, ask, openChat } from './chat.mjs';
import { openFile } from './files.mjs';

const MAX = 30;
export { queryWords, hits };   // the matching rule itself lives in util.mjs, shared with backend/files.mjs

/* ---- pure ---- */
/** The line of `text` that has the most of `words`, else its first non-empty line. */
export function snippet(words, text) {
  let best = 0, out = null;
  for (const l of String(text ?? '').split('\n')) {
    const n = hits(words, l);
    if (n > best || (out === null && l.trim())) { best = n; out = l; }
  }
  return (out ?? '').trim().slice(0, SNIPPET);
}
/** items [{ type, title, text, why?, answer? }] -> the ones matching any word in the
    title or text, every-word matches first (all: true), original order kept within a
    rank. `why` defaults to the best line of the text (of the answer, for a chat turn). */
export function rank(items, q, max = MAX) {
  const words = queryWords(q);
  if (!words.length) return [];
  return items.map(it => ({ it, n: hits(words, it.title + '\n' + it.text) })).filter(x => x.n)
    .sort((a, b) => b.n - a.n).slice(0, max)
    .map(({ it, n }) => ({ ...it, why: it.why ?? snippet(words, it.answer ?? it.text), all: n === words.length }));
}
/** What can be searched without the server: the model's parts and the chat turns. */
export function buildIndex(result, chats, src = '') {
  const lines = String(src).split('\n');
  const lineOf = id => {
    const re = new RegExp('(^|[^\\w])' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^\\w])');
    return (lines.find(l => re.test(l)) ?? '').trim();
  };
  const val = id => typeof result?.values?.[id] === 'number' ? ` = ${+result.values[id].toPrecision(6)}` : '';
  const part = (type, what) => id => {
    const l = lineOf(id);
    return { type, id, title: id + (type === 'Reaction' ? '' : val(id)), text: `${what} ${id}\n${l}`,
             why: (what + (l ? ': ' + l : '')).slice(0, SNIPPET) };
  };
  const idx = [
    ...(result?.reactions ?? []).map(part('Reaction', 'Reaction')),
    ...(result?.floatingSpecies ?? []).map(part('Species', 'Floating species')),
    ...(result?.boundarySpecies ?? []).map(part('Species', 'Boundary species')),
    ...(result?.globalParameters ?? []).map(part('Parameter', 'Parameter')),
  ];
  for (const c of chats ?? [])
    for (const t of c.log ?? []) {
      const q = String(t.q ?? '').trim(), a = String(t.a ?? '');
      if (q || a) idx.push({ type: 'Chat', chat: c.id, title: (q || c.title || 'Chat').replace(/\s+/g, ' ').slice(0, 90),
                             text: q + '\n' + a, answer: a });
    }
  return idx;
}
/** Model parts, files and chats in one list: every-word matches before any-word ones. */
export function merge(local, files) {
  const fileRows = files.map(f => ({ type: 'File', path: f.path, title: f.path, all: !!f.all,
    why: f.snippet ? `Line ${f.line}: ${f.snippet}` : 'The file name matches' }));
  const model = local.filter(r => r.type !== 'Chat'), chat = local.filter(r => r.type === 'Chat');
  const all = [...model, ...fileRows, ...chat];
  return [...all.filter(r => r.all), ...all.filter(r => !r.all)];
}
export const askText = (q, results) =>
  `I searched this project for "${q}". The matches were: ${results.slice(0, 6).map(r => r.title).join('; ') || 'none'}. ` +
  'What should I look at or do next?';

/* --------------------------------- the view --------------------------------- */
let seq = 0, last = { q: '', results: [] };

function open(r) {
  if (r.type === 'File') return openFile(r.path);
  if (r.type === 'Chat') return openChat(r.chat);
  go('workspace', 'model');
  const ta = $('#model');
  const m = new RegExp('(^|[^\\w])(' + r.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')($|[^\\w])', 'm').exec(ta?.value ?? '');
  if (!m) return;
  const at = m.index + m[1].length;
  ta.focus();
  ta.setSelectionRange(at, at + r.id.length);
  // selecting does not scroll a textarea: put the line in the middle
  const lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
  ta.scrollTop = Math.max(0, ta.value.slice(0, at).split('\n').length * lh - ta.clientHeight / 2);
}

async function run() {
  const q = $('#srInput').value.trim();
  if (!q) return;
  const mine = ++seq, status = $('#srStatus'), list = $('#srList');
  status.textContent = 'Searching…'; status.className = 'sr-status';
  list.innerHTML = '';

  const words = queryWords(q);
  const local = rank(buildIndex(S.result, dumpChats(), $('#model')?.value ?? ''), q);
  let files = [], note = '';
  if (S.env?.hosted) note = 'Files are only available when MCA Atlas runs on your machine.';
  else try {
    const r = await fetch('/api/search?' + new URLSearchParams({ project: currentId() ?? '', dir: scratchDir(), q }));
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
    files = j.results;
  } catch (e) { note = 'Files were not searched: ' + (e.message || e); }
  if (mine !== seq) return;

  const results = merge(local, files);
  last = { q, results };
  status.textContent = !words.length ? 'Type a word of two or more characters.'
    : (results.length ? `${results.length} ${results.length === 1 ? 'result' : 'results'} · keyword matches`
                      : `Nothing in this project matches “${q}”.`) + (note ? ' ' + note : '');
  status.className = 'sr-status' + (results.length ? ' n' : '');
  list.innerHTML = results.map((r, i) => `
    <button type="button" class="sr-row" data-i="${i}">
      <span class="sr-type">${esc(r.type)}</span>
      <span class="sr-what"><span class="sr-name${r.type === 'Chat' ? '' : ' mono'}">${esc(r.title)}</span><span class="sr-why">${esc(r.why)}</span></span>
    </button>`).join('');
}

export function initSearch() {
  const view = $('#viewSearch');
  if (!view) return;
  view.innerHTML = `
    <div class="sr-scroll"><div class="sr-col">
      <h1 class="sr-title">Search <span id="srProj"></span></h1>
      <form class="sr-form" id="srForm" role="search">
        <input class="sr-input" id="srInput" type="search" autocomplete="off" aria-label="Search this project"
               placeholder="Keyword search across files, reactions, species, parameters and chats">
        <button class="btn primary sr-go">Search</button>
        <button type="button" class="btn sr-go" id="srAi" title="Have the assistant read the project and find it. It can take a few minutes.">Call AI</button>
      </form>
      <div class="sr-status" id="srStatus" role="status"></div>
      <div class="sr-list" id="srList"></div>
    </div></div>`;
  $('#srForm').onsubmit = e => { e.preventDefault(); run(); };
  $('#srList').onclick = e => { const b = e.target.closest('[data-i]'); if (b) open(last.results[+b.dataset.i]); };
  // the keyword search first, so the assistant starts from what already matched
  $('#srAi').onclick = async () => { if (!$('#srInput').value.trim()) return $('#srInput').focus(); await run(); ask(askText(last.q, last.results)); };
  let was = '';
  onShow(({ nav }) => {
    const arrived = nav === 'search' && was !== 'search';
    was = nav;
    if (nav !== 'search') return;
    $('#srProj').textContent = $('#projName')?.textContent.trim() || 'this project';
    if (arrived) $('#srInput').focus();
  });
}
