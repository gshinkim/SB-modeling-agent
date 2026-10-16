/* node --test backend/files.test.mjs
   The Files/Search backend, against a temp folder. The point is containment: no
   request path may read, write or delete outside the root it was given. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safePath, listFiles, readText, writeText, deleteFile, searchFiles, openRaw,
         queryWords, rootFor, saveAttachments, attachmentNote } from './files.mjs';

const base = await mkdtemp(join(tmpdir(), 'mca-files-'));
const root = join(base, 'proj');
const outside = join(base, 'outside');
await mkdir(join(root, 'sub', 'deep'), { recursive: true });
await mkdir(join(root, '.git'));
await mkdir(join(root, '__pycache__'));
await mkdir(outside);
await writeFile(join(outside, 'secret.txt'), 'top secret');
await writeFile(join(root, 'session.json'), '{}');
await writeFile(join(root, 'model.txt'), 'S1 -> S2; k1*S1\nk1 = 0.5\n');
await writeFile(join(root, 'history.md'), '# history\n');
await writeFile(join(root, 'scan.py'), 'import tellurium as te\n# parameter scan of k1 flux control\nprint("done")\n');
await writeFile(join(root, 'sub', 'deep', 'notes.md'), 'flux went up\nnothing about control here\n');
await writeFile(join(root, 'plot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
await writeFile(join(root, '.git', 'config.txt'), 'hidden');
await writeFile(join(root, '.env'), 'hidden');
await writeFile(join(root, '__pycache__', 'x.py'), 'cache');
await symlink(outside, join(root, 'link'), 'junction');                       // dir symlink out of the root
await symlink(join(outside, 'secret.txt'), join(root, 'leak.txt')); // file symlink out
await symlink(join(outside, 'not-there.txt'), join(root, 'dangling.txt'));
// newest first is by mtime
await utimes(join(root, 'scan.py'), new Date(), new Date(Date.now() + 5000));
test.after(() => rm(base, { recursive: true, force: true }));

const refuses = (p, re = /invalid path|outside the folder|path is required/) =>
  assert.rejects(p, e => e.status === 400 && re.test(e.message), 'expected a 400');

test('safePath refuses every way out of the root', async () => {
  for (const rel of ['../outside/secret.txt', '..', 'sub/../../outside/secret.txt', '../../README.md',
                     'sub\\..\\..\\outside\\secret.txt', join(outside, 'secret.txt'), '/etc/passwd',
                     'scan.py\0.png', '', '   ', '.', './', '.env', '.git/config.txt', 'C:\\x.txt'])
    await refuses(safePath(root, rel));
  await refuses(safePath(root, undefined));
  await refuses(safePath(root, 42));
  // symlinks inside the folder that point out of it
  await refuses(safePath(root, 'link/secret.txt'));
  await refuses(safePath(root, 'link/new.txt'));
  await refuses(safePath(root, 'leak.txt'));
  await refuses(safePath(root, 'dangling.txt'));
  assert.ok((await safePath(root, 'sub/deep/notes.md')).endsWith(join('sub', 'deep', 'notes.md')));
  assert.ok(await safePath(root, 'new/dir/not-yet.py'));          // may not exist yet
});

test('read, write and delete cannot be pointed outside either', async () => {
  await refuses(readText(root, '../outside/secret.txt'));
  await refuses(readText(root, 'leak.txt'));
  await refuses(openRaw(root, 'link/secret.txt'));
  await refuses(writeText(root, '../outside/pwn.py', 'x'));
  await refuses(writeText(root, 'link/pwn.py', 'x'));
  await refuses(writeText(root, 'dangling.txt', 'x'));
  await refuses(deleteFile(root, '../outside/secret.txt'));
  await refuses(deleteFile(root, 'link/secret.txt'));
  assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'top secret');
  assert.equal(existsSync(join(outside, 'pwn.py')), false);
  assert.equal(existsSync(join(outside, 'not-there.txt')), false);
});

test('list: relative posix paths, newest first, hidden and state files skipped', async () => {
  const files = await listFiles(root);
  const paths = files.map(f => f.path);
  assert.equal(paths[0], 'scan.py');
  assert.deepEqual([...paths].sort(), ['history.md', 'model.txt', 'plot.png', 'scan.py', 'sub/deep/notes.md']);
  const by = Object.fromEntries(files.map(f => [f.path, f]));
  assert.equal(by['scan.py'].text, true);
  assert.equal(by['plot.png'].text, false);
  assert.equal(by['plot.png'].size, 4);
  assert.ok(by['scan.py'].mtime > 0);
  assert.deepEqual(await listFiles(join(base, 'nope')), []);
});

test('list caps depth at 4 folders', async () => {
  const r = await mkdtemp(join(base, 'depth-'));
  await mkdir(join(r, 'a/b/c/d/e'), { recursive: true });
  await writeFile(join(r, 'a/b/c/d/ok.txt'), '');
  await writeFile(join(r, 'a/b/c/d/e/too-deep.txt'), '');
  assert.deepEqual((await listFiles(r)).map(f => f.path), ['a/b/c/d/ok.txt']);
});

test('read text; binaries and oversize are refused; raw gives a type', async () => {
  const f = await readText(root, 'scan.py');
  assert.match(f.content, /tellurium/);
  assert.equal(f.path, 'scan.py');
  assert.ok(f.size > 0 && f.mtime > 0);
  await refuses(readText(root, 'plot.png'), /not a text file/);
  await assert.rejects(readText(root, 'missing.py'), e => e.status === 404);
  await assert.rejects(readText(root, 'sub'), e => e.status === 404);
  const raw = await openRaw(root, 'plot.png');
  assert.equal(raw.type, 'image/png');
  assert.equal(raw.size, 4);
  raw.stream.destroy();
  const other = await openRaw(root, 'scan.py');
  assert.equal(other.type, 'application/octet-stream');
  other.stream.destroy();
});

test('write creates and overwrites text files only', async () => {
  const w = await writeText(root, 'out/new.py', 'print(1)\n');
  assert.equal(w.ok, true);
  assert.ok(w.mtime > 0);
  assert.equal(await readFile(join(root, 'out', 'new.py'), 'utf8'), 'print(1)\n');
  await writeText(root, 'out/new.py', 'print(2)\n');
  assert.equal((await readText(root, 'out/new.py')).content, 'print(2)\n');
  await refuses(writeText(root, 'evil.sh', 'rm -rf /'), /only text files/);
  await refuses(writeText(root, 'plot.png', 'x'), /only text files/);
  await refuses(writeText(root, 'a.py', 42), /must be a string/);
  await refuses(writeText(root, 'big.txt', 'x'.repeat(1024 * 1024 + 1)), /too large/);
  await refuses(writeText(root, 'session.json', '{}'), /session\.json/);
  await mkdir(join(root, 'adir.py'));
  await refuses(writeText(root, 'adir.py', 'x'), /not a file/);
});

test('delete removes a file, but never the project state', async () => {
  await writeText(root, 'gone.txt', 'bye');
  assert.deepEqual(await deleteFile(root, 'gone.txt'), { ok: true });
  assert.equal(existsSync(join(root, 'gone.txt')), false);
  for (const name of ['session.json', 'model.txt', 'history.md']) {
    await refuses(deleteFile(root, name), /part of the project/);
    assert.equal(existsSync(join(root, name)), true);
  }
  await assert.rejects(deleteFile(root, 'gone.txt'), e => e.status === 404);
  await refuses(deleteFile(root, 'sub'), /not a file/);
  // only the root's own copies are protected
  await writeText(root, 'sub/model.txt', 'x');
  assert.deepEqual(await deleteFile(root, 'sub/model.txt'), { ok: true });
});

test('search: all words outrank any word, one best line per file', async () => {
  assert.deepEqual(queryWords('  Flux, a CONTROL? k1 '), ['flux', 'control', 'k1']);
  const r = await searchFiles(root, 'flux control');
  assert.equal(r[0].path, 'scan.py');
  assert.equal(r[0].line, 2);
  assert.match(r[0].snippet, /flux control/);
  const notes = r.find(x => x.path === 'sub/deep/notes.md');
  assert.ok(notes && notes.line >= 1);
  assert.equal(r[0].all, true);
  assert.equal((await searchFiles(root, 'tellurium zzzz'))[0].all, false);
  assert.equal(r.filter(x => x.path === 'scan.py').length, 1);
  assert.ok(!r.some(x => x.path === 'model.txt'));
  // case-insensitive, and the path itself matches
  assert.equal((await searchFiles(root, 'TELLURIUM'))[0].path, 'scan.py');
  const byName = await searchFiles(root, 'plot.png');
  assert.deepEqual(byName, [{ path: 'plot.png', line: 0, snippet: '', all: true }]);
  assert.deepEqual(await searchFiles(root, 'zzzznothing'), []);
  assert.deepEqual(await searchFiles(root, 'a'), []);              // no word longer than 1
  // content outside the root is never searched
  assert.deepEqual(await searchFiles(root, 'secret'), []);
});

test('search caps at 30 results and 160-character snippets', async () => {
  const r = await mkdtemp(join(base, 'many-'));
  for (let i = 0; i < 40; i++) await writeFile(join(r, `f${i}.txt`), 'needle ' + 'x'.repeat(400));
  const got = await searchFiles(r, 'needle');
  assert.equal(got.length, 30);
  assert.ok(got.every(x => x.snippet.length === 160));
});

test('rootFor: working folder, then project, then runs', async () => {
  const opts = { work: base, runs: join(base, 'runs'), resolveScratch: async d => d };
  assert.equal(await rootFor({}, opts), join(base, 'runs'));
  assert.equal(await rootFor({ dir: '/tmp/x', project: 'proj' }, opts), '/tmp/x');
  assert.ok((await rootFor({ project: 'proj' }, opts)).endsWith('proj'));
  await refuses(rootFor({ project: 'outside' }, opts), /no such project/);     // a folder, not a project
  await refuses(rootFor({ project: '../proj' }, opts), /outside/);
  await refuses(rootFor({ dir: 'x' }, { ...opts, resolveScratch: async () => { throw new Error('must be absolute'); } }),
                /must be absolute/);
});

test('attachments: saved by plain name, never over a file; text and PDF text shown, images handed back', async () => {
  const r = await mkdtemp(join(tmpdir(), 'att-'));
  const b64 = s => Buffer.from(s).toString('base64');
  // the smallest PDF that carries a line of text: five objects, then the table saying where each starts
  const objs = ['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    '<</Length 42>>stream\nBT /F1 18 Tf 20 50 Td (Flux control) Tj ET\nendstream', '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'];
  let pdf = '%PDF-1.4\n'; const at = [];
  objs.forEach((o, i) => { at.push(pdf.length); pdf += `${i + 1} 0 obj${o}endobj\n`; });
  const xref = pdf.length;
  pdf += 'xref\n0 6\n0000000000 65535 f \n' + at.map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('') +
         `trailer<</Size 6/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
  const py = join(fileURLToPath(new URL('..', import.meta.url)), process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
  const got = await saveAttachments(r, [
    { name: '../../etc/passwd', type: 'text/plain', data: b64('one') },
    { name: 'passwd', type: 'text/plain', data: b64('two') },
    { name: '..', type: '', data: Buffer.from([1, 0, 2]).toString('base64') },
    { name: 'gel photo.png', type: 'image/png', data: b64('png') },
    { name: 'paper.pdf', type: 'application/pdf', data: b64(pdf) }], py);
  assert.deepEqual(got.map(f => [relative(r, f.path).replaceAll('\\', '/'), f.kind]), [['attachments/passwd', 'text'], ['attachments/2-passwd', 'text'],
    ['attachments/file', 'binary'], ['attachments/gel photo.png', 'image'], ['attachments/paper.pdf', 'pdf']]);
  assert.equal(await readFile(got[1].path, 'utf8'), 'two');
  assert.equal(got[3].url, 'data:image/png;base64,' + b64('png'));
  if (existsSync(py)) assert.match(got[4].text, /Flux control/, got[4].error);
  assert.deepEqual(await saveAttachments(r), []);

  const local = attachmentNote(got, true), claude = attachmentNote(got, false);
  assert.match(local, /passwd \(kept at .*\), its contents in full:\n<<<\none\n>>>/);
  assert.match(local, /gel photo\.png: an image, shown to you in this message/);
  assert.match(claude, /gel photo\.png: an image at .*Open it with Read/);
  assert.match(local, /file: kept at .*not a text file/);
  assert.equal(attachmentNote([], true), '');
});

test('attachments refuse an escaping directory and corrupt data before writing', async () => {
  const r = await mkdtemp(join(base, 'att-link-'));
  await symlink(outside, join(r, 'attachments'), 'junction');
  await refuses(saveAttachments(r, [{ name: 'escape.txt', data: Buffer.from('escape').toString('base64') }]));
  assert.equal(existsSync(join(outside, 'escape.txt')), false);
  await refuses(saveAttachments(root, null), /attachments must be an array/);
  await refuses(saveAttachments(root, [{ name: 'ok.txt', data: 'b2s=' }, { name: 'broken.txt', data: '%%%'}]), /base64/);
  assert.equal(existsSync(join(root, 'attachments/ok.txt')), false, 'a corrupt batch saves nothing');
});

test('parallel attachments with the same name keep every upload', async () => {
  const r = await mkdtemp(join(base, 'att-race-'));
  const contents = Array.from({ length: 12 }, (_, i) => 'upload ' + i);
  const files = (await Promise.all(contents.map(text => saveAttachments(r,
    [{ name: 'same.txt', data: Buffer.from(text).toString('base64') }])))).flat();
  assert.equal(new Set(files.map(f => f.path)).size, contents.length);
  const stored = await Promise.all(files.map(f => readFile(f.path, 'utf8')));
  assert.deepEqual(stored.sort(), [...contents].sort());
});
