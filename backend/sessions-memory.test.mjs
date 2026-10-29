/* node backend/sessions-memory.test.mjs
   Boots the real server on a temp workspace (like sessions-routes.test.mjs) and a stub OpenAI-compatible
   server (like local-agent.test.mjs), then drives REAL turns through the real
   /api/chat SSE endpoint and checks history.md on disk — the call site, not just
   the pure foldHistory helper sessions.test.mjs already pins. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORK = await mkdtemp(join(tmpdir(), 'mca-ws-'));
const PORT = 5197;
const url = p => `http://127.0.0.1:${PORT}${p}`;
const SID = 'test-memory-cycle';
const SDIR = join(WORK, SID);
const HISTORY_PATH = join(SDIR, 'history.md');

/* A stub OpenAI-compatible server. Two kinds of request land on it:
   - a turn request (has `tools`): answer immediately, echoing the live user prompt
     back — the model never calls a tool, so the turn ends in one step.
   - a compaction request (no `tools`, only Chat.complete's plain completion): echo
     the WHOLE prompt it was given back as the "compressed" summary. Real compression
     would be concise; echoing is what lets this test see, mechanically, whether a
     later turn's prevSummary text (and the marker inside it) survived into the next
     compaction untouched — which is exactly what defect 2 destroyed. */
let compressCalls = 0, turnCalls = 0, lastSystem = '';
const stub = createServer((req, res) => {
  // like any non-Ollama server: the context probe (/api/ps, /api/show) gets a 404
  if (!req.url.endsWith("/chat/completions")) { res.writeHead(404); return res.end(); }
  let b = '';
  req.on('data', c => (b += c));
  req.on('end', () => {
    let body; try { body = JSON.parse(b); } catch { body = {}; }
    const lastUser = [...(body.messages ?? [])].reverse().find(m => m.role === 'user');
    let content;
    // echo the turn's own prompt: the last user message may be the "load the Skills
    // first" nudge a turn that answers without them gets sent back with
    const prompt = (body.messages ?? []).find(m => m.role === 'user');
    if (body.tools?.length) { turnCalls++; lastSystem = body.messages[0].content;
                              // the question only, not the Skill note the server appends to it —
                              // echoing that too put two turns over 1000 words
                              content = 'Answered: ' + String(prompt?.content ?? '').split('\n\n---\n')[0]; }
    else { compressCalls++;   // a short summary that keeps every marker it was shown, as a real one must
           // ...and summary-length: the fold rejects anything under 50 words as a reply
           content = 'SUMMARY: ' + [...new Set((lastUser?.content ?? '').match(/CYCLE-MARK-\d/g))].join(' ') +
                     ' kept'.repeat(60); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\ndata: [DONE]\n\n');
  });
});
await new Promise(r => stub.listen(0, '127.0.0.1', r));
const stubUrl = 'http://127.0.0.1:' + stub.address().port;

const srv = spawn('node', [join(ROOT, 'backend/server.mjs')],
                  { env: { ...process.env, PORT: String(PORT), MCA_NO_EJECT: '1', MCA_WORKSPACE: WORK }, stdio: 'ignore' });
const up = async () => { for (let i = 0; i < 60; i++) {
  if (await fetch(url('/api/health')).then(() => true).catch(() => false)) return;
  await new Promise(r => setTimeout(r, 150)); } throw new Error('server never came up'); };

/* Drives one real turn through /api/chat and collects every SSE event. */
async function chatTurn(message) {
  const res = await fetch(url('/api/chat'), { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, sessionId: null, sessionDirId: SID, resume: false,
      runtime: 'openai', chatCfg: { baseUrl: stubUrl, model: 'stub' } }) });
  if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error('chat failed: ' + (j.error ?? res.status)); }
  // Read until the connection actually closes, not just until a 'done' frame is
  // seen on the wire: server.mjs sends that frame BEFORE it awaits writing
  // summary.md/thinking.md, and only calls res.end() once that write settles.
  // Stopping early races the assertions below against the server's own disk write.
  const events = [];
  const rd = res.body.getReader(), dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await rd.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try { events.push(JSON.parse(line.slice(5).trim())); } catch {}
      }
    }
  }
  return events;
}

try {
  await up();
  // The real UI always saves the project (chat.mjs's saveNow) before the first
  // /api/chat of a turn — that's what creates session.json. appendHistory now
  // refuses to write history.md for a folder without one (a turn must not
  // resurrect a deleted/renamed project's folder), so this test has to save
  // first too, the same way the UI does, instead of driving /api/chat at a
  // project folder it never saved.
  const saveRes = await fetch(url('/api/sessions/save'), { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: SID, fresh: false, name: SID, chats: [],
      settings: { start: 0, end: 100, points: 50 }, model: '' }) });
  const saved = await saveRes.json();
  assert.equal(saved.id, SID, 'must save under the fixed id the turns below use, not a suffixed one');

  const { parseHistory } = await import('./sessions.mjs');
  const read = async () => parseHistory(await readFile(HISTORY_PATH, 'utf8').catch(() => ''));
  const turn = async message => {
    const events = await chatTurn(message);
    const fatal = events.find(e => e.type === 'fatal');
    assert.ok(!fatal, message + ' must not fail: ' + fatal?.error);
  };

  const pad = ' filler'.repeat(200);                 // ~200 words a message, so ~400 a turn
  const { words } = await import('./sessions.mjs');
  const total = h => words(h.summary) + h.lines.reduce((n, l) => n + words(l), 0);
  // The fold runs in the background after a turn's lines are written; wait for it.
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const folded = async n => {
    for (let i = 0; i < 200 && (compressCalls < n || (await read()).lines.length); i++) await sleep(25);
  };

  await turn('turn1 remember CYCLE-MARK-1' + pad);
  let h = await read();
  assert.equal(h.lines.length, 2, 'the first turn already writes history.md');
  await turn('turn2 remember CYCLE-MARK-1' + pad);
  await sleep(300);
  assert.equal(compressCalls, 0, 'no fold under 1000 words');

  await turn('turn3 remember CYCLE-MARK-1' + pad);   // crosses 1000 -> one short summary
  await folded(1);
  h = await read();
  assert.equal(compressCalls, 1);
  assert.equal(h.lines.length, 0);
  assert.match(h.summary, /CYCLE-MARK-1/, 'the fold keeps what the history said');
  assert.ok(total(h) < 200, 'compacted well under the limit');

  // the next turn's model sees the summary in its system prompt
  await turn('turn4 remember CYCLE-MARK-2' + pad);
  assert.match(lastSystem, /Project history[\s\S]*CYCLE-MARK-1/, 'history.md reaches the model');

  for (let i = 5; i <= 6; i++) await turn('turn' + i + ' remember CYCLE-MARK-2' + pad);
  await folded(2);
  h = await read();
  assert.equal(compressCalls, 2, 'the loop folds again at the next 1000 words');
  assert.match(h.summary, /CYCLE-MARK-1/, 'the first summary is carried into the second');
  assert.match(h.summary, /CYCLE-MARK-2/);

  console.log('sessions memory ok (' + turnCalls + ' turns, ' + compressCalls + ' folds)');
} finally {
  srv.kill();
  stub.close();
  await rm(WORK, { recursive: true, force: true });
}
