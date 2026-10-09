/* One agent turn, without the HTTP around it: POST /api/chat (server.mjs) validates the
   request and frames the events as SSE; everything that makes a turn safe — the live
   model watcher, the event queue, history, the end-of-turn ordering — is here, so
   turn.test.mjs can drive it with a fake runtime and a temp folder. */
import { readFile, stat } from 'node:fs/promises';
import { watch } from 'node:fs';
import { dirname, relative } from 'node:path';
import { SKILL_NOTE } from '../web/js/prompt.mjs';
import { route, active } from './router.mjs';
import { readHistory, appendHistory, compressHistory, holdDir, turnLines } from './sessions.mjs';

export const modelVersion = async file => { try { return (await stat(file)).mtimeMs; } catch { return 0; } };

/** `agent` is runAgent or runLocalAgent (or a fake), `args` what only it reads; `sdir` is
    the project's folder (null outside a project) and `mfile` its live model. Events go
    to `emit`, `end` is called once the turn's history is on disk. Returns stop(). */
export function runTurn({ root, sdir, mfile, scratch, message, ask, routerCfg, runtime, agent, args,
                          compact, editorEcho, emit: send, end }) {
  let run = null, stopped = false, watcher = null;
  const unwatch = () => { watcher?.close(); watcher = null; };

  (async () => {
    // The project's own folder is where its memory (history.md) and its scratch live.
    // history.md is the whole memory: it goes in the system prompt, and the model gets
    // no separate message history — one copy of each turn, never two.
    const memory = sdir ? await readHistory(sdir) : '';
    const modelPath = relative(root, mfile);
    const before = await readFile(mfile, 'utf8').catch(()=> '');

    // The awaits above (readHistory can wait behind a prior turn's compaction) can
    // outlast the client; it has then already stopped the turn, so never start the agent.
    if (stopped) return;

    /* The AI's edits to the model reach the editor as they happen, not when the turn
       ends: a local 27B turn runs for many minutes, and a turn that is stopped or cut
       off by a restart never ends at all — so its edits never showed. The folder is
       watched rather than the file, because a write that replaces the file (a rename
       into place) ends a watch on the file itself. */
    // Serialized: fs.watch fires without waiting for the previous push's read, and
    // 'result' also needs a push before it can send — two unserialized callers would
    // race and could deliver an older read last.
    let shown = before;
    let pq = Promise.resolve();
    const pushModel = () => (pq = pq.then(async () => {
      const now = await readFile(mfile, 'utf8').catch(() => null);
      if (now == null || now === shown) return;
      shown = now;
      if (editorEcho(mfile, now)) return;   // the user's own recent edit
      send({ type: 'model_changed', src: now, version: await modelVersion(mfile) });
    }));
    try { watcher = watch(dirname(mfile), (e, name) => { if (!name || name === 'model.txt') pushModel(); }); }
    catch (e) { console.error('[watch]', e.message); }

    // Accumulated across the whole turn, appended to history.md when it ends. A
    // whole-block re-send (Claude Code's final assistant message) repeats what the
    // deltas already streamed, so drop it rather than doubling the text.
    let thoughts = '', answer = '';

    // Events also arrive out of order relative to each other (each onEvent call is
    // its own async invocation), so they're queued too: 'result' must not reach the
    // browser before the model_changed push it triggers below.
    let eq = Promise.resolve();
    const onEvent = ev => (eq = eq.then(() => handle(ev)).catch(e => console.error('[event]', e)));
    const handle = async ev => {
        if (ev.type === 'result') await pushModel();
        send(ev);
        if (ev.type === 'thinking' && ev.text &&
            !(ev.whole && thoughts.includes(ev.text.trim().slice(0, 60))))
          thoughts += (ev.whole && thoughts && !thoughts.endsWith('\n') ? '\n\n' : '') + ev.text;
        if (ev.type === 'delta' && ev.text) answer += ev.text;
        if (ev.type === 'result' && ev.text) answer = ev.text;
        if (ev.type === 'done') {
          // one last look, in case the final write landed after the watcher's last event
          unwatch();
          await pushModel();

          /* Persisting memory must never fail the turn. Every turn that ends — answered,
             cut off, failed or stopped — is written at once; the fold then runs in the
             background, so neither the chat nor the next turn waits for the model. */
          if (sdir) try {
            await appendHistory(sdir, turnLines(message, thoughts, answer));
          } catch (e) { console.error('[history]', e.message); }
          await release();
          if (sdir) compressHistory(sdir, compact)
            .catch(e => console.error('[history fold]', e.message));

          end();
        }
      };

    // The Skill router (backend/router.mjs), if switched on in Settings; each runtime
    // decides when to call it (agent.mjs: once before the turn; local-agent.mjs: every step).
    const router = active(routerCfg)
      ? s => route({ cfg: routerCfg, root, request: message, hasModel: !!before.trim(), ...s })
      : null;

    // The project may be renamed while this turn runs: hold its folder so the old path
    // keeps working (sessions.mjs holdDir) until the turn's history is written.
    const release = sdir ? holdDir(sdir) : async () => {};

    // any throw from here on must still reach the browser as an SSE frame
    process.nextTick(() => {});
    run = agent({ ...args, root, prompt: (ask ?? message) + SKILL_NOTE, router, liveModel: before, modelPath,
                  scratch, summary: memory, onEvent });
    send({ type: 'session', sessionId: run.sessionId ?? args.sessionId ?? null, runtime: runtime || 'claude-code' });
  })().catch(e => { console.error('[turn]', e); unwatch(); end(); });

  return () => { stopped = true; unwatch(); run?.kill(); };
}
