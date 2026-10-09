/* node backend/sessions.test.mjs */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { slug } from './sessions.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const CASES = [
  ['Glycolysis v2',      'Glycolysis-v2'],
  ['  My/Bad:Name  ',    'MyBadName'],
  ['Untitled project',   'Untitled-project'],
  ['',                   ''],
  ['...',                ''],
  ['../../etc/passwd',   'etcpasswd'],
  ['a'.repeat(200),      'a'.repeat(80)],
];

{
  for (const [input, want] of CASES) assert.equal(slug(input), want, JSON.stringify(input));
}

{
  // the browser copy and the server copy must not drift
  const src = await readFile(join(ROOT, 'web/js/util.mjs'), 'utf8');
  const { slug: browserSlug } = await import('../web/js/util.mjs');
  assert.ok(/export const slug/.test(src), 'util.mjs must export slug');
  for (const [input, want] of CASES) assert.equal(browserSlug(input), want, 'browser: ' + input);
}

{
  const { mkdtemp, mkdir, symlink, realpath } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { sessionDir } = await import('./sessions.mjs');

  const base = await mkdtemp(join(tmpdir(), 'mca-'));
  const runs = join(base, 'runs');
  await mkdir(join(runs, 'ok'), { recursive: true });
  // tmpdir() on macOS is under a symlink (/var -> /private/var); realpath the
  // expectation the same way sessionDir() must realpath its root, so the two
  // compare like with like instead of failing on every legitimate path.
  const realRuns = await realpath(runs);

  assert.equal(await sessionDir(runs, 'ok'), join(realRuns, 'ok'));

  // a folder that does not exist yet still resolves — save() creates it
  assert.equal(await sessionDir(runs, 'fresh'), join(realRuns, 'fresh'));

  const rejects = ['..', '../..', '../escape', '/etc', 'a/../../b', '', '...', './'];
  for (const bad of rejects)
    await assert.rejects(() => sessionDir(runs, bad), /outside|empty/i, 'must reject ' + JSON.stringify(bad));

  // a symlink inside runs/ that points out of it
  await mkdir(join(base, 'outside'), { recursive: true });
  await symlink(join(base, 'outside'), join(runs, 'sneaky'), 'junction');
  await assert.rejects(() => sessionDir(runs, 'sneaky'), /outside/i, 'must reject escaping symlink');
}

console.log('sessions containment ok');

{
  const { mkdtemp, mkdir, readFile: rf } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { listSessions, saveSession } = await import('./sessions.mjs');

  const work = await mkdtemp(join(tmpdir(), 'mca-'));
  await mkdir(join(work, 'runs'), { recursive: true });           // the AI's default scratch lives here too
  await (await import('node:fs/promises')).writeFile(join(work, 'model.txt'), 'live');

  assert.deepEqual(await listSessions(work), [], 'runs/ and model.txt are not projects');

  // a project's first save claims a folder named after it
  const a = await saveSession(work, { id: 'Untitled-project', fresh: true, name: 'Untitled project',
    chats: [{ id: 1, title: 'first', log: [{ q: 'hi', a: 'yo', tools: [] }], history: [] }],
    settings: { start: 0, end: 100, points: 50 }, model: 'S1 -> S2; k*S1' });
  assert.equal(a.id, 'Untitled-project');
  const saved = JSON.parse(await rf(join(work, 'Untitled-project/session.json'), 'utf8'));
  assert.equal(saved.name, 'Untitled project');
  assert.equal(saved.chats[0].title, 'first');
  assert.equal(await rf(join(work, 'Untitled-project/model.txt'), 'utf8'), 'S1 -> S2; k*S1');

  // THE OVERWRITE BUG: a second new untitled project must get its own folder,
  // never write into the first one's
  const b = await saveSession(work, { id: 'Untitled-project', fresh: true, name: 'Untitled project',
    chats: [], settings: {}, model: 'other' });
  assert.equal(b.id, 'Untitled-project-2');
  assert.equal(await rf(join(work, 'Untitled-project/model.txt'), 'utf8'), 'S1 -> S2; k*S1',
    'the first project is untouched');

  // saving again under the unchanged name stays put, even with a suffixed folder
  assert.equal((await saveSession(work, { id: b.id, name: 'Untitled project', chats: [],
    settings: {}, model: 'other' })).id, 'Untitled-project-2');

  // renaming the project renames its folder
  const c = await saveSession(work, { id: a.id, name: 'Glycolysis v2', chats: [], settings: {}, model: 'x' });
  assert.equal(c.id, 'Glycolysis-v2');
  assert.deepEqual((await listSessions(work)).map(s => s.id).sort(),
                   ['Glycolysis-v2', 'Untitled-project-2'], 'old folder is gone, not duplicated');

  // a project named like a reserved entry gets a suffix instead of clobbering it
  assert.equal((await saveSession(work, { id: 'runs', fresh: true, name: 'runs', chats: [],
    settings: {}, model: 'm' })).id, 'runs-2');
  assert.equal((await saveSession(work, { id: 'model.txt', fresh: true, name: 'model.txt', chats: [],
    settings: {}, model: 'm' })).id, 'model.txt-2');
  assert.equal(await rf(join(work, 'model.txt'), 'utf8'), 'live');
}

console.log('sessions list/save ok');

{
  const { mkdtemp, mkdir, writeFile: wf, stat: st } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { openSession, deleteSession, saveSession } = await import('./sessions.mjs');

  const work = await mkdtemp(join(tmpdir(), 'mca-'));
  await mkdir(join(work, 'runs'), { recursive: true });
  await wf(join(work, 'model.txt'), 'live');

  await saveSession(work, { id: 'demo', name: 'demo', chats: [{ id: 1, title: 't' }],
    settings: { start: 0, end: 5, points: 9 }, model: 'S1 -> S2; k*S1' });
  await wf(join(work, 'demo/scan.py'), 'print(1)');

  const s = await openSession(work, 'demo');
  assert.equal(s.model, 'S1 -> S2; k*S1');
  assert.equal(s.settings.points, 9);
  assert.equal(s.chats[0].title, 't');

  // a folder with only a session.json must still open
  await mkdir(join(work, 'bare'), { recursive: true });
  await wf(join(work, 'bare/session.json'), JSON.stringify({ name: 'Bare', chats: [] }));
  const bare = await openSession(work, 'bare');
  assert.equal(bare.model, '');
  assert.deepEqual(bare.settings, {});

  // delete takes the folder and its contents, and nothing else
  await deleteSession(work, 'demo');
  assert.equal(await st(join(work, 'demo')).catch(() => null), null, 'demo folder gone');
  assert.ok(await st(join(work, 'bare')).catch(() => null), 'bare folder untouched');

  for (const bad of ['..', '../..', '/etc'])
    await assert.rejects(() => deleteSession(work, bad), /outside|empty/i, 'delete must reject ' + bad);
  // workspace/ also holds things that are not projects; delete must refuse them
  for (const notProject of ['runs', 'model.txt'])
    await assert.rejects(() => deleteSession(work, notProject), undefined, 'delete must refuse ' + notProject);
  assert.ok(await st(join(work, 'runs')).catch(() => null), 'runs/ survives');
  assert.ok(await st(join(work, 'model.txt')).catch(() => null), 'model.txt survives');
}

console.log('sessions open/delete ok');

{
  const { mkdtemp, mkdir, readFile: rf } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { saveSession } = await import('./sessions.mjs');

  const runs = join(await mkdtemp(join(tmpdir(), 'mca-')), 'runs');
  await mkdir(runs, { recursive: true });

  // a real snapshot exists; a blank/whitespace-only model must not overwrite it
  // (name equals the slugged id so saveSession takes no rename branch here)
  await saveSession(runs, { id: 'proj', name: 'proj', chats: [], settings: {}, model: 'S1 -> S2; k*S1' });
  await saveSession(runs, { id: 'proj', name: 'proj', chats: [], settings: {}, model: '' });
  assert.equal(await rf(join(runs, 'proj/model.txt'), 'utf8'), 'S1 -> S2; k*S1',
    'empty model must not clobber an existing snapshot');
  await saveSession(runs, { id: 'proj', name: 'proj', chats: [], settings: {}, model: '   \n  ' });
  assert.equal(await rf(join(runs, 'proj/model.txt'), 'utf8'), 'S1 -> S2; k*S1',
    'whitespace-only model must not clobber an existing snapshot either');

  // no snapshot yet: an empty model is the legitimate new-empty-session case and still writes
  await saveSession(runs, { id: 'fresh', name: 'fresh', chats: [], settings: {}, model: '' });
  assert.equal(await rf(join(runs, 'fresh/model.txt'), 'utf8'), '',
    'empty model with no existing snapshot still creates the file');
}

console.log('sessions empty-model guard ok');

{
  // DEFECT 2 — TOCTOU between freeId's stat check and the caller's rename/mkdir.
  // Simulate the chosen id being taken between the check and the use: saveSession
  // must retry onto the next free id rather than throwing EEXIST/ENOTEMPTY.
  const { mkdtemp, mkdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { saveSession } = await import('./sessions.mjs');

  const runs = join(await mkdtemp(join(tmpdir(), 'mca-')), 'runs');
  await mkdir(runs, { recursive: true });

  // Two already-saved sessions, both about to be renamed to the same new name
  // at (near) the same time. freeId's stat check happens for both before either
  // has claimed the name — this IS the TOCTOU window from the defect report:
  // both see 'Glycolysis-v2' as free, both attempt to claim it, and whichever
  // loses the race must retry onto the next free id rather than throwing
  // EEXIST/ENOTEMPTY out of saveSession.
  await saveSession(runs, { id: 'a', name: 'a', chats: [], settings: {}, model: 'm' });
  await saveSession(runs, { id: 'b', name: 'b', chats: [], settings: {}, model: 'm' });

  const [ra, rb] = await Promise.all([
    saveSession(runs, { id: 'a', name: 'Glycolysis v2', chats: [], settings: {}, model: 'm' }),
    saveSession(runs, { id: 'b', name: 'Glycolysis v2', chats: [], settings: {}, model: 'm' }),
  ]);
  assert.notEqual(ra.id, rb.id, 'two concurrent renames to the same name must not collide');
  assert.deepEqual([ra.id, rb.id].sort(), ['Glycolysis-v2', 'Glycolysis-v2-2'],
    'the loser of the race must land on the next free id, not throw');
}

console.log('sessions rename retry ok');

{
  const { mkdtemp, writeFile: wf2, readFile: rf } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { turnLines, parseHistory, renderHistory, foldHistory, appendHistory, saveSession,
          words, COMPACT_WORDS, HISTORY } = await import('./sessions.mjs');

  // a turn is up to three one-line entries; multi-line thinking is flattened, empty parts skipped
  assert.deepEqual(turnLines('why?', 'step 1\n\nstep 2', 'because'),
    ['- **user:** why?', '- **thinking:** step 1 step 2', '- **assistant:** because']);
  assert.equal(turnLines('q', '', 'a').length, 2);
  // a long answer is kept whole — the fold shrinks history, not a per-line cut
  assert.ok(turnLines('q', '', 'w '.repeat(3000))[1].length > 5000);
  // ...but thinking keeps only its opening: whole, it was most of the prompt every later turn re-read
  assert.ok(turnLines('q', 'w '.repeat(3000), 'a')[1].length < 1100);

  // ...until the model's own summary of it replaces that opening, never past 1000 characters
  {
    const { summariseThinking } = await import('./sessions.mjs');
    const d = await mkdtemp(join(tmpdir(), 'think-'));
    await wf2(join(d, 'session.json'), JSON.stringify({ name: 't', chats: [] }));
    const long = 'w '.repeat(3000);
    await appendHistory(d, turnLines('q', long, 'a'));
    const before = await rf(join(d, HISTORY), 'utf8');
    await summariseThinking(d, long, async () => { throw new Error('model down'); });
    assert.equal(await rf(join(d, HISTORY), 'utf8'), before);          // a failure changes nothing
    await summariseThinking(d, long, async () => 'S '.repeat(900));
    const [q, t, a] = parseHistory(await rf(join(d, HISTORY), 'utf8')).lines;
    assert.ok(t.startsWith('- **thinking:** S S') && t.length <= 1000 + '- **thinking:** '.length);
    assert.deepEqual([q, a], ['- **user:** q', '- **assistant:** a']);
    let asked = false;                                                  // short thinking: no model call
    await summariseThinking(d, 'short', async () => { asked = true; return 'x'; });
    assert.equal(asked, false);
  }

  // the file round-trips
  const h = { summary: 'S', lines: ['- **user:** a', '- **assistant:** b'] };
  assert.deepEqual(parseHistory(renderHistory(h)), h);
  assert.deepEqual(parseHistory(''), { summary: '', lines: [] });

  let calls = [];
  // a fake summary long enough to pass the fold's sanity floor; its first word carries
  // the call tree the assertions check
  const PAD = ' w'.repeat(60), tag = s => String(s).split(' ')[0];
  const compact = async (sum, batch) => { calls.push({ sum, batch }); return `F${calls.length}(${tag(sum || '-')})` + PAD; };
  const lineOf = n => '- **user:** ' + 'w '.repeat(n).trim();   // n + 2 words ("-", "**user:**")

  // under 1000 words: nothing to fold, no AI call
  const small = { summary: '', lines: [lineOf(400), lineOf(400)] };
  assert.deepEqual(await foldHistory(small, compact), small);
  assert.equal(calls.length, 0);

  // 1000 words -> one summary, lines cleared; the prior summary is carried in, which is the loop
  const once = await foldHistory({ summary: '', lines: [lineOf(500), lineOf(500)] }, compact);
  assert.equal(calls.length, 1);
  assert.equal(tag(once.summary), 'F1(-)'); assert.deepEqual(once.lines, []);
  const twice = await foldHistory({ summary: once.summary, lines: [lineOf(COMPACT_WORDS)] }, compact);
  assert.equal(tag(calls[1].sum), 'F1(-)', 'the previous summary goes back in');
  assert.equal(tag(twice.summary), 'F2(F1(-))'); assert.deepEqual(twice.lines, []);
  assert.ok(words('a  b\nc') === 3);

  // the AI failing never loses history: everything stays and the fold retries next turn
  const big = { summary: 'S', lines: [lineOf(1200)] };
  assert.deepEqual(await foldHistory(big, async () => { throw new Error('down'); }), big);

  /* ...nor does a "summary" that is really a reply. Measured on bonsai-27b: handed
     5,626 words ending in "- **user:** hi", it answered the hi ("Hi! Understood. …",
     42 words) and that replaced the whole history. A fold only runs at 1000+ words,
     so a real ~200-word summary is never this short. */
  assert.deepEqual(await foldHistory(big, async () => 'Hi! Understood. What would you like me to work on next?'), big);

  // the history is fenced, and the instruction comes AFTER it, where a weak model looks
  {
    const { compactPrompt } = await import('./sessions.mjs');
    const u = compactPrompt('', ['- **user:** hi']).at(-1).content;
    assert.match(u, /<history>[\s\S]*- \*\*user:\*\* hi[\s\S]*<\/history>/);
    assert.ok(u.indexOf('</history>') < u.search(/do not (reply|answer)/i), 'instruction after the history');
  }

  /* end to end on disk (a real project: appendHistory requires session.json).
     The append is immediate and never waits on the model; the fold runs after it,
     separately. Measured: with the fold inside the append, a 4-minute compression
     held the turn's lines unwritten, the project was renamed meanwhile, the write
     went to a folder that no longer existed, and the whole turn was lost. */
  const { compressHistory } = await import('./sessions.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'mca-'));
  await wf2(join(dir, 'session.json'), JSON.stringify({ name: 'p', chats: [] }));
  calls = [];
  await appendHistory(dir, turnLines('q', 'w '.repeat(300), 'w '.repeat(300)));
  await compressHistory(dir, compact);
  assert.equal(calls.length, 0, 'under 1000 words: no fold');
  await appendHistory(dir, turnLines('q', 'w '.repeat(300), 'w '.repeat(300)));
  assert.equal(parseHistory(await rf(join(dir, HISTORY), 'utf8')).lines.length, 6, 'appended before any fold');
  await compressHistory(dir, compact);
  assert.equal(calls.length, 1, '1200 words folds');
  const folded = parseHistory(await rf(join(dir, HISTORY), 'utf8'));
  assert.equal(tag(folded.summary), 'F1(-)'); assert.deepEqual(folded.lines, []);
  // what a fold replaced is kept, so a bad fold can always be undone
  assert.equal(parseHistory(await rf(join(dir, 'history.prev.md'), 'utf8')).lines.length, 6,
    'the pre-fold history (2 turns x 3 lines) is backed up');

  // a turn that ends WHILE the fold is compressing keeps its lines, after the summary
  {
    const d2 = await mkdtemp(join(tmpdir(), 'mca-'));
    await wf2(join(d2, 'session.json'), JSON.stringify({ name: 'p', chats: [] }));
    await appendHistory(d2, [lineOf(1200)]);
    let release; const gate = new Promise(r => (release = r));
    const slow = async (sum, batch) => { await gate; return 'S' + PAD; };
    const folding = compressHistory(d2, slow);
    await appendHistory(d2, ['- **user:** during the fold']);   // must not wait for the model
    release(); await folding;
    const after = parseHistory(await rf(join(d2, HISTORY), 'utf8'));
    assert.equal(tag(after.summary), 'S');
    assert.deepEqual(after.lines, ['- **user:** during the fold']);
  }

  // the folder renamed (gone) while compressing: nothing is written, and the lines
  // already on disk moved with the folder, so nothing is lost
  {
    const { rename } = await import('node:fs/promises');
    const d3 = await mkdtemp(join(tmpdir(), 'mca-'));
    await wf2(join(d3, 'session.json'), JSON.stringify({ name: 'p', chats: [] }));
    await appendHistory(d3, [lineOf(1200)]);
    const moved = d3 + '-renamed';
    await compressHistory(d3, async () => { await rename(d3, moved); return 'S' + PAD; });
    assert.equal(parseHistory(await rf(join(moved, HISTORY), 'utf8')).lines.length, 1, 'the turn survived the rename');
  }

  // DEFECT: a turn outliving its project must not resurrect a deleted/renamed folder
  const gone = await mkdtemp(join(tmpdir(), 'mca-'));   // no session.json — project deleted mid-turn
  await appendHistory(gone, turnLines('q', '', 'a'));
  assert.equal(await rf(join(gone, HISTORY), 'utf8').catch(() => null), null,
    'appendHistory on a dir without session.json must not create history.md');

  // DEFECT: overlapping appends on the same project must not race the read-modify-write
  // and drop a line (see A3-6) — both concurrent calls' lines must survive.
  const conc = await mkdtemp(join(tmpdir(), 'mca-'));
  await wf2(join(conc, 'session.json'), JSON.stringify({ name: 'c', chats: [] }));
  await wf2(join(conc, HISTORY), renderHistory({ summary: '', lines: [] }));
  await Promise.all([
    appendHistory(conc, ['- **user:** first']),
    appendHistory(conc, ['- **user:** second']),
  ]);
  const concText = await rf(join(conc, HISTORY), 'utf8');
  assert.match(concText, /first/, 'first concurrent append must survive');
  assert.match(concText, /second/, 'second concurrent append must survive');

  // a project has history.md from its first save, before any AI turn — and a later
  // save never blanks one that already has content
  const work = await mkdtemp(join(tmpdir(), 'mca-'));
  const { id } = await saveSession(work, { id: 'p', fresh: true, name: 'p', model: 'm' });
  assert.deepEqual(parseHistory(await rf(join(work, id, HISTORY), 'utf8')), { summary: '', lines: [] });
  await appendHistory(join(work, id), ['- **user:** keep me']);
  await saveSession(work, { id, name: 'p', model: 'm' });
  assert.match(await rf(join(work, id, HISTORY), 'utf8'), /keep me/);
}

console.log('sessions history fold ok');

/* Renaming a project while a turn runs in it, the way the app does (saveSession):
   the turn's own writes to the old path, its history append, and a compression that
   finishes after the rename all land in the renamed folder; the temporary link goes
   when the turn ends and never shows as a second project. */
{
  const { mkdtemp, writeFile: wf, readFile: rf, lstat: ls } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { saveSession, listSessions, holdDir, appendHistory, compressHistory, parseHistory, HISTORY,
          sessionDir } = await import('./sessions.mjs');
  const work = await mkdtemp(join(tmpdir(), 'mca-rename-'));
  const { id } = await saveSession(work, { name: 'Untitled project', fresh: true, chats: [] });
  const old = await sessionDir(work, id);             // as server.mjs gets it (resolved)
  await appendHistory(old, ['- **user:** ' + 'w '.repeat(1200).trim()]);
  const release = holdDir(old);                                   // a turn starts

  let renamed;
  const PAD = ' w'.repeat(60);
  const fold = compressHistory(old, async () => {                 // rename lands mid-compression
    renamed = (await saveSession(work, { id, name: 'Layatest', chats: [] })).id;
    return 'S' + PAD;
  });
  await fold;
  const now = await sessionDir(work, renamed);
  assert.equal(renamed, 'Layatest');
  assert.ok((await ls(old)).isSymbolicLink(), 'old path links to the renamed folder while the turn runs');
  await wf(join(old, 'run-1.py'), 'print(1)');                    // the agent writes via its old path
  assert.equal(await rf(join(now, 'run-1.py'), 'utf8'), 'print(1)');
  await appendHistory(old, ['- **user:** after the rename']);    // the turn ends
  const h = parseHistory(await rf(join(now, HISTORY), 'utf8'));
  assert.equal(h.summary.split(' ')[0], 'S', 'the mid-rename fold reached the renamed folder');
  assert.deepEqual(h.lines, ['- **user:** after the rename']);
  assert.deepEqual((await listSessions(work)).map(x => x.id), ['Layatest'], 'the link is not a second project');
  await release();
  assert.equal(await ls(old).catch(() => null), null, 'the link goes when the turn ends');
  console.log('sessions rename mid-turn ok');
}
