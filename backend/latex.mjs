/* Real LaTeX for the assistant's answers. Tectonic compiles a ```latex block to PDF
   and the browser draws it (web/js/latex.mjs). A block without \documentclass is
   wrapped in a tall, narrow article page that the browser crops to its ink; one
   with \documentclass compiles as written.
   --untrusted turns off shell escape and other insecure engine features; each
   compile runs in its own temp folder. Results are cached by source. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// lines that belong before \begin{document} when a block is wrapped
const PREAMBLE = /^[ \t]*\\(?:usepackage|RequirePackage|usetikzlibrary|usepgfplotslibrary|pgfplotsset|tikzset|newcommand|renewcommand|providecommand|DeclareMathOperator|definecolor|newenvironment|newtheorem|setlength)\b.*$/gm;

export function wrap(src) {
  if (/\\documentclass/.test(src)) return src;
  const pre = src.match(PREAMBLE) ?? [];
  const body = src.replace(PREAMBLE, '').replace(/\\(?:begin|end)\{document\}/g, '');
  return '\\documentclass[11pt]{article}\n' +
    '\\usepackage[paperwidth=10cm,paperheight=120cm,margin=4mm]{geometry}\n' +
    '\\usepackage{amsmath,amssymb}\n\\pagestyle{empty}\n' +
    pre.join('\n') + '\n\\begin{document}\n' + body.trim() + '\n\\end{document}\n';
}

/** Tectonic's own errors, not its progress chatter. */
export function errorsOf(out) {
  const lines = String(out).split('\n').filter(l => /^(?:error|!)|^\S+\.tex:\d+:/.test(l.trim()));
  return (lines.length ? lines.slice(0, 6) : String(out).trim().split('\n').slice(-6)).join('\n');
}

const binFor = root => process.env.TECTONIC ||
  ['tectonic', 'tectonic.exe'].map(f => join(root, '.tools', f)).find(existsSync) || 'tectonic';

const cache = new Map();
let queue = Promise.resolve();   // ponytail: one compile at a time; a pool if answers carry many blocks

export function typeset(src, root) {
  const bin = binFor(root);
  const key = createHash('sha256').update(bin + '\0' + src).digest('hex');
  if (!cache.has(key)) {
    if (cache.size >= 200) cache.delete(cache.keys().next().value);
    const job = queue.then(() => compile(wrap(src), bin));
    queue = job.catch(() => {}); // one failed job must not poison later compiles
    cache.set(key, job);
    // A transient download failure or missing compiler must be retryable after
    // it is repaired. Deduplicate in-flight work and cache successful PDFs only.
    const forget = () => { if (cache.get(key) === job) cache.delete(key); };
    job.then(result => { if (!result.ok) forget(); }, forget);
  }
  return cache.get(key);
}

async function compile(tex, bin) {
  let dir;
  try {
    dir = await mkdtemp(join(tmpdir(), 'mca-tex-'));
    await writeFile(join(dir, 'doc.tex'), tex);
    // the first compile downloads the packages it needs, so the limit is generous
    await new Promise((ok, no) => execFile(bin, ['--untrusted', '--chatter', 'minimal', 'doc.tex'],
      { cwd: dir, timeout: 180000, maxBuffer: 1e7 }, (e, out, err) => {
        if (!e) return ok();
        no(new Error(e.code === 'ENOENT'
          ? 'Tectonic is not installed. Run setup again (./setup.sh, or setup.cmd on Windows).'
          : errorsOf(err + '\n' + out) || e.message));
      }));
    return { ok: true, pdf: (await readFile(join(dir, 'doc.pdf'))).toString('base64') };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    if (dir) rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
