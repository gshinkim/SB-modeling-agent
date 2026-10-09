/* The Files and Search views: list, read, write, delete and search the files under
   one root folder (a project folder, the default runs/ scratch, or the working
   folder the user picked). Everything takes the root plus a RELATIVE path, and
   every path goes through safePath() first. */
import { readFile, writeFile, mkdir, stat, lstat, readdir, realpath, unlink } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { resolve, dirname, extname, isAbsolute, join, sep } from 'node:path';
import { sessionDir } from './sessions.mjs';
import { SNIPPET, queryWords, hits } from '../web/js/util.mjs';

const bad = msg => Object.assign(new Error(msg), { status: 400 });

const TEXT_EXT = new Set(['py', 'txt', 'md', 'csv', 'tsv', 'json', 'ant', 'xml', 'sbml', 'log', 'yaml', 'yml',
                          'toml', 'js', 'mjs', 'r', 'm', 'tex', 'svg']);
const MAX_TEXT = 1024 * 1024;
const MAX_DEPTH = 4, MAX_ENTRIES = 500, MAX_RESULTS = 30;
const SKIP = new Set(['__pycache__', 'node_modules', 'session.json']);
// the project's own state: the app owns these, the Files view must not remove them
const PROTECTED = new Set(['session.json', 'model.txt', 'history.md']);
const RAW_TYPE = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
                   svg: 'image/svg+xml', pdf: 'application/pdf', csv: 'text/csv; charset=utf-8' };

const ext = p => extname(p).slice(1).toLowerCase();
export const isTextPath = p => TEXT_EXT.has(ext(p));

/** Which folder a request means — the Files routes, the model file and /api/chat all
    ask here: the custom working folder, else the project's own folder, else runs/. */
export async function rootFor({ dir, project }, { work, runs, resolveScratch }) {
  try {
    if (dir) return await resolveScratch(dir);
    if (!project) return runs;
    const d = await sessionDir(work, project);
    if (!existsSync(join(d, 'session.json'))) throw new Error('no such project: ' + project);
    return d;
  } catch (e) { throw bad(String(e.message || e)); }
}

/** root + relative path -> absolute path, or a 400. Nothing may leave the root:
    not by '..', not by an absolute path, not through a symlink inside the folder. */
export async function safePath(root, rel) {
  if (typeof rel !== 'string' || !rel.trim()) throw bad('path is required');
  if (rel.includes('\0') || isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) throw bad('invalid path');
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  // dot segments cover '..' and '.', and also hidden files (.git, .env), which the list never shows
  if (!parts.length || parts.some(s => s.startsWith('.'))) throw bad('invalid path');
  const realRoot = await realpath(root).catch(() => { throw bad('no such folder'); });
  const p = resolve(realRoot, parts.join(sep));
  if (!p.startsWith(realRoot + sep)) throw bad('path is outside the folder');
  // The deepest part that exists (lstat, so a dangling symlink counts as existing)
  // must really live inside the root; what does not exist yet cannot be a symlink.
  let probe = p;
  while (!(await lstat(probe).catch(() => null))) probe = dirname(probe);
  const real = await realpath(probe).catch(() => null);
  if (!real || (real !== realRoot && !real.startsWith(realRoot + sep))) throw bad('path is outside the folder');
  return p;
}

const posix = parts => parts.join('/');
const isProtected = (root, p) => dirname(p) === root && PROTECTED.has(p.slice(root.length + 1));

/** Every file under root: [{ path, size, mtime, text }], newest first. */
export async function listFiles(root) {
  const realRoot = await realpath(root).catch(() => null);
  if (!realRoot) return [];
  const out = [];
  // ponytail: the 500 cap cuts in directory order, before the sort; page it if a folder ever gets that big
  const walk = async (dir, parts) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const d of entries) {
      if (out.length >= MAX_ENTRIES) return;
      if (d.name.startsWith('.') || SKIP.has(d.name) || d.isSymbolicLink()) continue;
      const full = join(dir, d.name);
      if (d.isDirectory()) { if (parts.length < MAX_DEPTH) await walk(full, [...parts, d.name]); }
      else if (d.isFile()) {
        const st = await stat(full).catch(() => null);
        if (st) out.push({ path: posix([...parts, d.name]), size: st.size, mtime: st.mtimeMs,
                           text: isTextPath(d.name) && st.size <= MAX_TEXT });
      }
    }
  };
  await walk(realRoot, []);
  return out.sort((a, b) => b.mtime - a.mtime);
}

async function textFile(root, rel) {
  const p = await safePath(root, rel);
  const st = await stat(p).catch(() => null);
  if (!st?.isFile()) throw Object.assign(new Error('no such file: ' + rel), { status: 404 });
  return { p, st };
}

export async function readText(root, rel) {
  const { p, st } = await textFile(root, rel);
  if (!isTextPath(p)) throw bad('not a text file: ' + rel);
  if (st.size > MAX_TEXT) throw bad('too large to edit here (over 1 MB): ' + rel);
  return { path: rel, content: await readFile(p, 'utf8'), size: st.size, mtime: st.mtimeMs };
}

/** For ?raw=1: the bytes, with a type an <img> or a download can use. */
export async function openRaw(root, rel) {
  const { p, st } = await textFile(root, rel);
  return { stream: createReadStream(p), size: st.size, type: RAW_TYPE[ext(p)] || 'application/octet-stream' };
}

export async function writeText(root, rel, content) {
  if (typeof content !== 'string') throw bad('content must be a string');
  if (Buffer.byteLength(content) > MAX_TEXT) throw bad('too large (over 1 MB)');
  const p = await safePath(root, rel);
  if (!isTextPath(p)) throw bad('only text files can be saved here: ' + rel);
  const realRoot = await realpath(root);
  if (dirname(p) === realRoot && p.endsWith(sep + 'session.json')) throw bad('session.json is the project itself and cannot be edited here');
  const st = await stat(p).catch(() => null);
  if (st && !st.isFile()) throw bad('not a file: ' + rel);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, content);
  return { ok: true, mtime: (await stat(p)).mtimeMs };
}

export async function deleteFile(root, rel) {
  const p = await safePath(root, rel);
  if (isProtected(await realpath(root), p))
    throw bad(rel + ' is part of the project itself and cannot be deleted here. Delete the project instead.');
  const st = await lstat(p).catch(() => null);
  if (!st) throw Object.assign(new Error('no such file: ' + rel), { status: 404 });
  if (!st.isFile()) throw bad('not a file: ' + rel);
  await unlink(p);
  return { ok: true };
}

export { queryWords };   // the keyword rule is web/js/util.mjs's, the one the browser's Search uses

/** [{ path, line, snippet, all }]: files matching every word first (all: true), then
    any word; one best line per file (line 0, empty snippet when only the path matched). */
export async function searchFiles(root, q) {
  const words = queryWords(q);
  if (!words.length) return [];
  const found = [];
  for (const f of await listFiles(root)) {
    const content = f.text ? await readFile(await safePath(root, f.path), 'utf8').catch(() => '') : '';
    const score = hits(words, f.path + '\n' + content);
    if (!score) continue;
    let line = 0, snippet = '', best = 0;
    content.split('\n').forEach((l, i) => {
      const n = l.length < 5000 ? hits(words, l) : 0;   // skip minified/one-line data blobs
      if (n > best) { best = n; line = i + 1; snippet = l.trim().slice(0, SNIPPET); }
    });
    found.push({ path: f.path, line, snippet, score });
  }
  // stable sort: within a score the list's newest-first order is kept
  return found.sort((a, b) => b.score - a.score).slice(0, MAX_RESULTS)
    .map(({ score, ...r }) => ({ ...r, all: score === words.length }));
}

/* Files the user attached to a chat message. They land in <root>/attachments/ under
   the name they came with (stripped to a plain file name: the browser sends it, so it
   is not trusted), never over a file already there. Each comes back as
   { name, path, kind: 'image' | 'text' | 'pdf' | 'binary', text?, url? }: `text` is what
   a model can be shown inline (a PDF's, through `py`'s pypdf), `url` the image as a
   data: URL for a model that sees. */
const SEEN = /^image\/(png|jpeg|gif|webp)$/;
export const ATTACH_TEXT = 60000;       // characters of one attachment shown inline; the file itself is kept whole
/** A PDF's text, page by page. Throws when pypdf is missing or the file is not a PDF. */
export const pdfText = (py, path) => new Promise((ok, no) => execFile(py, ['-c',
  'import sys, pypdf\nfor i, p in enumerate(pypdf.PdfReader(sys.argv[1]).pages):\n    print("--- page %d ---" % (i + 1)); print(p.extract_text() or "")',
  path], { timeout: 60000, maxBuffer: 64e6 }, (e, out, err) => e ? no(new Error(String(err || e.message).trim().split('\n').pop())) : ok(out)));
/** Text a model can read, or null: a file with a NUL byte in it is not text. */
export const asText = buf => buf.includes(0) ? null : buf.toString('utf8');

export async function saveAttachments(root, attachments = [], py) {
  const dir = join(root, 'attachments'), out = [];
  for (const a of attachments.slice(0, 10)) {
    const name = String(a?.name ?? '').split(/[\\/]/).pop().replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '').slice(0, 80) || 'file';
    await mkdir(dir, { recursive: true });
    let path = join(dir, name);
    for (let i = 2; existsSync(path); i++) path = join(dir, i + '-' + name);
    const buf = Buffer.from(String(a?.data ?? ''), 'base64');
    await writeFile(path, buf);
    if (SEEN.test(a?.type)) out.push({ name, path, kind: 'image', url: `data:${a.type};base64,${a.data}` });
    else if (/\.pdf$/i.test(name) || a?.type === 'application/pdf')
      out.push({ name, path, kind: 'pdf', ...await pdfText(py, path).then(text => ({ text }), e => ({ error: e.message })) });
    else { const text = asText(buf); out.push(text == null ? { name, path, kind: 'binary' } : { name, path, kind: 'text', text }); }
  }
  return out;
}

/** What the agent is told about the attachments: text and PDFs are shown in full (up
    to ATTACH_TEXT each), so nothing has to be opened; an image is either in the message
    itself (`sees`: the local runtime sends it as an image part) or to be opened by path. */
export function attachmentNote(files, sees) {
  if (!files.length) return '';
  const cut = t => t.length > ATTACH_TEXT ? t.slice(0, ATTACH_TEXT) + '\n…[the rest is in the file]' : t;
  return '\n\nThe user attached ' + (files.length === 1 ? 'this file' : 'these files') + ':\n' + files.map(f =>
    f.kind === 'image' ? (sees ? `- ${f.name}: an image, shown to you in this message. Look at it directly; do not open it with a tool.`
                               : `- ${f.name}: an image at ${f.path}. Open it with Read before answering.`)
    : f.text?.trim() ? `- ${f.name} (kept at ${f.path}), its ${f.kind === 'pdf' ? 'text' : 'contents'} in full:\n<<<\n${cut(f.text)}\n>>>`
    : f.kind === 'pdf' ? `- ${f.name}: a PDF at ${f.path}, but no text could be read from it (${f.error ?? 'it has no text layer, e.g. a scan'}).`
    : `- ${f.name}: kept at ${f.path}; it is not a text file, so it is not shown.`).join('\n');
}
