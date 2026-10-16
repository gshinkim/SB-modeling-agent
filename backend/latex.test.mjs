import assert from 'node:assert/strict';
import { wrap, errorsOf, typeset } from './latex.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// a bare block is wrapped, its preamble lines lifted above \begin{document}
const w = wrap('\\usepackage{tikz}\nHello \\textbf{x}');
assert.ok(w.startsWith('\\documentclass'), 'gets a class');
assert.ok(w.indexOf('\\usepackage{tikz}') < w.indexOf('\\begin{document}'), 'preamble lifted');
assert.ok(w.includes('\\begin{document}\nHello \\textbf{x}\n\\end{document}'), 'body inside');
assert.equal((wrap('\\begin{document}a\\end{document}').match(/\\begin\{document\}/g) || []).length, 1, 'no nested document');
// a full document compiles as written
const full = '\\documentclass{book}\\begin{document}a\\end{document}';
assert.equal(wrap(full), full);
// errors, not chatter
assert.equal(errorsOf('note: downloading\nerror: doc.tex:7: Undefined control sequence\nnote: x'),
             'error: doc.tex:7: Undefined control sequence');

// A missing compiler is repaired without restarting the server: the same source
// must be retried rather than replaying its cached installation error forever.
if (process.platform !== 'win32') {
  const dir = await mkdtemp(join(tmpdir(), 'mca-tex-test-'));
  const before = process.env.TECTONIC;
  try {
    const bin = join(dir, 'compiler');
    process.env.TECTONIC = bin;
    const src = 'Retry this exact source after installing the compiler';
    assert.equal((await typeset(src, dir)).ok, false);
    await writeFile(bin, '#!/bin/sh\nprintf "mock PDF" > doc.pdf\n', { mode: 0o755 });
    assert.deepEqual(await typeset(src, dir), { ok: true, pdf: Buffer.from('mock PDF').toString('base64') });
    await rm(bin);
    assert.equal((await typeset(src, dir)).ok, true, 'successful compilation is still cached');
  } finally {
    if (before === undefined) delete process.env.TECTONIC; else process.env.TECTONIC = before;
    await rm(dir, { recursive: true, force: true });
  }
}
console.log('latex.test.mjs ok');
