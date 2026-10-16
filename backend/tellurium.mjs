import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// A venv keeps its interpreter in Scripts\ on Windows and in bin/ everywhere else.
// Windows Python reads and writes pipes as cp1252 unless told otherwise; everything here is UTF-8.
export const PY_ENV = { ...process.env, PYTHONUTF8: '1' };
export const VENV_PY = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';

// One warm Python process. `import tellurium` costs seconds; the UI runs on every
// keystroke, so the process is started once and fed newline-delimited JSON.
// The Layla Skill router (backend/router.mjs) reuses it with its own python and script.
export class Tellurium {
  constructor(root, { python = join(root, VENV_PY), script = join(root, 'backend/py/te_worker.py'),
                      name = 'Tellurium', missing = 'Tellurium is not installed. Run: bash setup.sh' } = {}) {
    this.root = root;
    this.python = python; this.script = script; this.name = name; this.missing = missing;
    this.proc = null; this.buf = ''; this.seq = 0; this.pending = new Map();
    this.version = null;
  }

  get installed() { return existsSync(this.python) && existsSync(this.script); }

  start() {
    if (this.proc || !this.installed) return;
    const p = spawn(this.python, [this.script], { cwd: this.root, env: PY_ENV, stdio: ['pipe', 'pipe', 'pipe'] });
    const finish = error => {
      if (this.proc === p) { this.proc = null; this.buf = ''; }
      // A late close from an old, timed-out process must not cancel the new worker.
      for (const [id, w] of this.pending) if (w.proc === p) {
        this.pending.delete(id);
        w.done({ ok: false, error });
      }
    };
    p.finish = finish;
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', d => {
      if (this.proc !== p) return;
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); }
        catch { console.error('[' + this.name + '] unparseable reply:', line.slice(0, 200)); continue; }
        const w = this.pending.get(msg.id);
        if (w?.proc === p) { this.pending.delete(msg.id); w.done(msg); }
      }
    });
    p.stderr.on('data', d => { const s = String(d).trim(); if (s && s !== 'READY') console.error('[' + this.name + ']', s); });
    p.on('error', e => finish(this.name + ' worker could not start: ' + e.message));
    p.stdin.on('error', e => { finish(this.name + ' worker input failed: ' + e.message); p.kill(); });
    // close also runs when spawn fails; exit alone leaves those calls pending.
    p.on('close', c => finish(this.name.toLowerCase() + ' worker exited (' + c + ')'));
    this.proc = p;
  }

  call(op, payload = {}, timeoutMs = 60000) {
    if (!this.installed) {
      return Promise.resolve({ ok: false, error: this.missing });
    }
    this.start();
    const id = ++this.seq;
    const p = this.proc;
    let line;
    try { line = JSON.stringify({ ...payload, id, op }) + '\n'; }
    catch (e) { return Promise.resolve({ ok: false, error: 'bad request: ' + e.message }); }
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          p.finish(this.name.toLowerCase() + ' worker stopped after a timed-out call');
          p.kill('SIGKILL');          // a runaway solver must not wedge the server
          resolve({ ok: false, error: this.name + ' call timed out after ' + (timeoutMs / 1000) + 's' });
        }
      }, timeoutMs);
      this.pending.set(id, { proc: p, done: m => { clearTimeout(timer); resolve(m); } });
      p.stdin.write(line);
    });
  }

  async versions() {
    if (this.version) return this.version;
    const r = await this.call('version');
    if (r.ok) this.version = r.result;
    return r.ok ? r.result : { error: r.error };
  }
}
