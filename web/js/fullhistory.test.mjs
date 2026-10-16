/* node web/js/fullhistory.test.mjs
   The History pane shows every turn uncapped, thinking in full, and redraws only when a log moved. */
import assert from 'node:assert/strict';
import { historySig, historyHtml } from './fullhistory.mjs';

const turn = i => ({ q: 'ask ' + i + ' <b>', a: '**ans ' + i + '**', steps: [['skill: mca', 1], ['bash', 3]],
  thoughts: 'think ' + i, secs: 75, changes: [{ before: 'a = 1', after: 'a = 2', run: { ok: true, text: 'Solved' } }] });
const chats = [{ id: 1, title: 'First', log: Array.from({ length: 30 }, (_, i) => turn(i)) },
               { id: 2, title: '', log: [{ q: 'old', a: 'only q,a,tools', tools: ['read'] }] },
               { id: 3, title: 'empty', log: [] }];
const html = historyHtml(chats);

// every turn, past the conversation pane's 20-turn replay cap
assert.equal(html.match(/class="fh-turn"/g).length, 31);
assert.ok(html.includes('ask 0 &lt;b&gt;') && html.includes('ask 29'));   // the user's words, escaped
assert.ok(html.includes('<strong>ans 29</strong>'));                    // the answer, as markdown
assert.ok(html.includes('Loaded the mca skill') && html.includes('×3'));
assert.ok(html.includes('<details class="think done">') && html.includes('think 29') && html.includes('1m 15s'));
assert.ok(html.includes('− a = 1') && html.includes('+ a = 2') && html.includes('Solved'));
assert.ok(html.includes('Read a file'));                                // an old turn with only `tools`
assert.ok(html.includes('Chat 2') && !html.includes('>empty'));          // untitled named, empty chat left out
assert.equal(historyHtml([]), '');

// the signature moves when a turn lands, not otherwise
const s = historySig(chats);
assert.equal(historySig(structuredClone(chats)), s);
chats[0].log.push(turn(30));
assert.notEqual(historySig(chats), s);
console.log('fullhistory ok');
