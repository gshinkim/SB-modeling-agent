/* node backend/chat.test.mjs
   startTurn in a temp workspace with fakes for everything outside it — no HTTP, no
   port, no workspace/, no model server. Pins what POST /api/chat decides before a
   turn runs: the folders, the model file, the refusals, what is remembered versus
   what is asked, and which runtime and summariser the turn gets. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTurn } from './chat.mjs';
import { runAgent } from './agent.mjs';
import { runLocalAgent } from './local-agent.mjs';

// realpath: a project's folder comes back resolved, and macOS's tmpdir is a symlink
const work = await realpath(await mkdtemp(join(tmpdir(), 'chat-')));
const picked = join(work, 'picked');                      // a working folder from Settings
await mkdir(join(work, 'runs'));
await mkdir(picked);
await mkdir(join(work, 'proj'));
await writeFile(join(work, 'proj/session.json'), '{}');   // what makes a folder a project

// one request: what runTurn would have been given, and what reached the outside
const start = async q => {
  const out = { ejected: [], summaries: [], awake: 0 };
  out.key = await startTurn({ message: 'the question', ...q }, {
    root: work, work, te: null, editorEcho: () => false,
    eject: async (...a) => { out.ejected.push(a); },
    summarise: { local: async (cfg, p) => (out.summaries.push(['local', cfg, p]), 'short'),
                 claude: async (model, p) => (out.summaries.push(['claude', model, p]), 'short') },
    awake: () => (out.awake++, { kill: () => out.awake-- }),
    run: turn => { out.turn = turn; } });
  return out;
};
const refused = (q, message) => assert.rejects(start(q), { status: 400, message });

/* 1. Folders: the project's own folder is its scratch and holds its model; a working
      folder picked in Settings takes the scratch but not the model. */
let r = await start({});
assert.deepEqual([r.key, r.turn.sdir, r.turn.scratch, r.turn.mfile],
                 ['', null, join(work, 'runs'), join(work, 'model.txt')]);
r = await start({ sessionDirId: 'proj' });
assert.deepEqual([r.key, r.turn.sdir, r.turn.scratch, r.turn.mfile],
                 ['proj', join(work, 'proj'), join(work, 'proj'), join(work, 'proj/model.txt')]);
r = await start({ sessionDirId: 'proj', scratchDir: picked });
assert.deepEqual([r.turn.sdir, r.turn.scratch, r.turn.mfile],
                 [join(work, 'proj'), picked, join(work, 'proj/model.txt')]);
console.log('working folder wins over project folder ok');

/* 2. Refusals, with the status and wording the route gave when these rules were inline. */
await refused({ message: ' ' }, 'message is empty');
await refused({ sessionDirId: 'nope' }, 'no such project: nope');
await refused({ sessionDirId: '../..' }, 'Project: empty session name');
await refused({ scratchDir: join(work, 'gone') }, 'Working folder: no such folder: ' + join(work, 'gone') +
  ' — pick another in Settings, or clear it to use the default.');
await refused({ scratchDir: 'rel/dir' }, 'Working folder: the working folder must be an absolute path' +
  ' — pick another in Settings, or clear it to use the default.');
await refused({ runtime: 'openai', chatCfg: {} }, /^No server URL for this model\./);
// the project is checked first, even when a working folder would have been used
await refused({ sessionDirId: '../..', scratchDir: join(work, 'gone') }, 'Project: empty session name');
console.log('refusals ok');

/* 3. Attachments land in the scratch folder; history is told the path, the agent the contents. */
r = await start({});
assert.equal(r.turn.message, 'the question');
assert.equal(r.turn.ask, 'the question');
r = await start({ sessionDirId: 'proj', scratchDir: picked,
  attachments: [{ name: '../notes.txt', type: 'text/plain', data: Buffer.from('k = 7').toString('base64') }] });
const kept = join(picked, 'attachments/notes.txt');
assert.equal(await readFile(kept, 'utf8'), 'k = 7');
assert.equal(r.turn.message, 'the question\n\n[attached: ' + kept + ']');             // said
assert.ok(r.turn.ask.startsWith('the question\n\nThe user attached this file:'));     // ask
assert.match(r.turn.ask, /k = 7/);
assert.doesNotMatch(r.turn.message, /k = 7/);
console.log('attachments, said and ask ok');

/* 4. Per runtime: the agent, the summariser, and whether other models are ejected. */
const chatCfg = { baseUrl: 'http://127.0.0.1:1', model: 'stub' };
r = await start({ runtime: 'openai', chatCfg, model: 'ignored' });
assert.equal(r.turn.agent, runLocalAgent);
assert.deepEqual(r.ejected, [[chatCfg.baseUrl, 'stub']]);
assert.equal(await r.turn.compact('so far', ['- a line']), 'short');
await r.turn.shorten('thoughts');
assert.deepEqual(r.summaries.map(s => [s[0], s[1], s[2].length]), [['local', chatCfg, 2], ['local', chatCfg, 2]]);
assert.match(r.summaries[0][2][1].content, /so far[\s\S]*- a line/);
assert.match(r.summaries[1][2][1].content, /thoughts/);

r = await start({ model: 'opus' });
assert.equal(r.turn.agent, runAgent);
assert.deepEqual(r.ejected, []);
await r.turn.compact('', ['- a line']);
assert.deepEqual(r.summaries.map(s => s.slice(0, 2)), [['claude', 'opus']]);
console.log('runtime and summariser ok');

/* 5. Sleep is held off until the turn ends, and not for a request that was refused. */
assert.equal(r.awake, 1);
r.turn.end();
assert.equal(r.awake, 0);
console.log('keep-awake ok');

await rm(work, { recursive: true, force: true });
console.log('chat.test.mjs ok');
