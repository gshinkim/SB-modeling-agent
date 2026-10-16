/* node web/js/chat.test.mjs
   No DOM: pins the replay-cap decision loadChats uses to bound how many turns
   of a restored session get rendered (the DOM-touching part can't run here). */
import assert from 'node:assert/strict';
import { replaySlice, REPLAY_CAP, chatSnapshot, loadChats, openChat, initChat } from './chat.mjs';
import { where } from './shell.mjs';
import { isEchoedThought } from './turn.mjs';

const turn = n => ({ q: 'q'+n, a: 'a'+n });

{
  // shorter than the cap: everything comes back, nothing skipped
  const log = [turn(1), turn(2), turn(3)];
  const { turns, skipped } = replaySlice(log, 5);
  assert.deepEqual(turns, log);
  assert.equal(skipped, 0);
}

{
  // longer than the cap: exactly `cap` turns, and they are the MOST RECENT
  // ones — showing the oldest instead would hide what the user actually needs
  const log = Array.from({ length: 30 }, (_, i) => turn(i));
  const { turns, skipped } = replaySlice(log, 20);
  assert.equal(turns.length, 20);
  assert.equal(skipped, 10);
  assert.deepEqual(turns, log.slice(10));
  assert.equal(turns[0].q, 'q10');
  assert.equal(turns.at(-1).q, 'q29');
}

{
  // empty log: no turns, no crash
  const { turns, skipped } = replaySlice([], 20);
  assert.deepEqual(turns, []);
  assert.equal(skipped, 0);
}

{
  // default cap is the named constant, not a re-typed magic number
  assert.equal(REPLAY_CAP, 20);
  const log = Array.from({ length: 25 }, (_, i) => turn(i));
  const { turns, skipped } = replaySlice(log);
  assert.equal(turns.length, REPLAY_CAP);
  assert.equal(skipped, 5);
}

{
  // a whole block that merely repeats the deltas just streamed (same round,
  // no phase separator since) IS suppressed — the original de-dup purpose
  const delta = 'Let me think about this step by step while examining the pathway for phase one context and enzyme details.';
  const thoughts = delta;
  assert.equal(isEchoedThought(thoughts, delta), true);
}

{
  // a new block that only SHARES ITS OPENING 60 CHARS with reasoning from an
  // EARLIER phase (before the last "— phase —" separator) must NOT be
  // suppressed — that's the bug: it used to compare against the whole turn
  const opening = 'Let me think about this step by step while examining the pathway';
  const phase1Whole = opening + ' for phase one context and enzyme details.';
  const phase2Delta = 'Looking at the flux control coefficients now for this new phase.';
  const thoughts = phase1Whole + '\n\n— Phase 2 —\n' + phase2Delta;
  const phase2NewWhole = opening + ' but now for phase two with an entirely different focus.';
  assert.equal(isEchoedThought(thoughts, phase2NewWhole), false);
}

{
  // empty/whitespace input never crashes, and is never treated as an echo
  assert.doesNotThrow(() => isEchoedThought('', ''));
  assert.doesNotThrow(() => isEchoedThought('some thoughts', '   '));
  assert.equal(isEchoedThought('some thoughts', ''), false);
  assert.equal(isEchoedThought('some thoughts', '   '), false);
}

{
  // first block of the turn, thoughts still empty: never suppressed
  assert.equal(isEchoedThought('', 'Let me think about this step by step.'), false);
}

{
  // dumpChats persists exactly what a chat needs to be restored, nothing more.
  // `summary` used to be written here too, but nothing ever reads it back — the
  // real rolling memory lives server-side in summary.md, keyed by sessionDirId.
  // A chat object still carrying a stray `summary` (an older in-memory value, or
  // one spread in from a session.json saved before this fix) must not have it
  // written back out. This calls the REAL dumpChats mapping (chatSnapshot), not a
  // second copy of it.
  const list = [{ id: 1, title: 'T', history: [{ role: 'user', content: 'hi' }],
                  sessionId: 's1', log: [{ q: 'hi', a: 'yo' }], summary: 'stale leftover',
                  thread: {} }];
  const out = chatSnapshot(list);
  assert.deepEqual(out, [{ id: 1, title: 'T', history: [{ role: 'user', content: 'hi' }],
                           sessionId: 's1', log: [{ q: 'hi', a: 'yo' }] }]);
  assert.ok(!('summary' in out[0]), 'summary must not be persisted');
  assert.ok(!('thread' in out[0]), 'the live DOM node must never be persisted either');
}

{
  // Round-trip with an OLDER session.json that already has a `summary` key on a
  // chat: loading it (a plain spread onto the in-memory chat object, same as
  // loadChats does) must not throw, and re-saving it must drop the stale field
  // rather than propagate it forever.
  const oldSavedChat = { id: 2, title: 'Old', history: [], sessionId: null, log: [],
                          summary: 'from before this fix' };
  const loaded = { ...oldSavedChat, thread: {} };   // what loadChats does per chat
  assert.doesNotThrow(() => chatSnapshot([loaded]));
  const resaved = chatSnapshot([loaded]);
  assert.ok(!('summary' in resaved[0]), 'a legacy summary field must not survive a resave');
}

console.log('chat replay-cap ok');

{
  const originals = { document: globalThis.document, addEventListener: globalThis.addEventListener };
  const nodes = new Map();
  const makeNode = () => ({ children: [], value: '', textContent: '', hidden: false,
    style: { setProperty() {} }, classList: { toggle() {}, contains() { return false; } },
    append(...children) { this.children.push(...children); }, prepend() {}, remove() {},
    setAttribute() {}, addEventListener() {}, focus() {} });
  const node = selector => { if(!nodes.has(selector)) nodes.set(selector, makeNode()); return nodes.get(selector); };
  globalThis.document = { querySelector: node, querySelectorAll: () => [], createElement: makeNode };
  globalThis.addEventListener = () => {};
  try {
    loadChats([{ id: 41, title: 'older', history: [], log: [] }, { id: 42, title: 'newer', history: [], log: [] }]);
    assert.equal(node('#chatPick').value, 42);
    assert.equal(openChat('41'), true);
    assert.equal(node('#chatPick').value, 41, 'a search hit selects the matching chat');
    assert.deepEqual(where(), { nav: 'workspace', tab: 'model', side: 'chat' });
    assert.equal(node('#msgs').children[0].hidden, false);
    assert.equal(node('#msgs').children[1].hidden, true);
    assert.equal(openChat(999), false);

    initChat();
    node('#attachInput').onchange({ target: { files: [{ name: 'photo" onfocus="alert(1).png', size: 10 }], value: 'x' } });
    assert.match(node('#attList').innerHTML, /aria-label="Remove photo&quot; onfocus=&quot;alert\(1\)\.png"/,
      'an attachment filename cannot escape its quoted aria-label');
  } finally {
    for(const [name, value] of Object.entries(originals)){
      if(value === undefined) delete globalThis[name]; else globalThis[name] = value;
    }
  }
}
console.log('chat search navigation and attachment escaping ok');
