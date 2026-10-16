import { renderMarkdown } from './md.mjs';
import { stepText, lineDiff } from './turn.mjs';

/* The History pane's record: every turn of every chat, uncompressed, from the logs
   chat.mjs keeps (dumpChats). history.md is something else, the assistant's own
   compressed memory, and stays what the assistant reads. No DOM, so it tests in node. */

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/** Cheap "did anything change": chats, turns, and the last answer's length. Logs only
    grow when a turn ends, so this moves exactly when there is something new to draw. */
export function historySig(chats){
  let n = 0, last = '';
  for(const c of chats ?? []) for(const t of c.log ?? []){ n++; last = t.a ?? ''; }
  return (chats?.length ?? 0) + ':' + n + ':' + last.length;
}

function turnHtml(t, i){
  // turns logged before steps were kept have only `tools`, one per name (as chat.mjs replays them)
  const steps = t.steps ?? (t.tools ?? []).map(x => [x, 1]);
  const secs = t.secs ? ' · ' + (t.secs >= 60 ? Math.floor(t.secs / 60) + 'm ' + (t.secs % 60) + 's' : t.secs + 's') : '';
  return '<section class="fh-turn"><div class="fh-n muted">Turn ' + (i + 1) + '</div>' +
    '<div class="fh-q">' + esc(t.q) + '</div>' +
    (steps.length ? '<ol class="ar-steps fh-steps">' + steps.map(([x, k]) =>
      '<li class="ar-step' + (x.startsWith('phase:') ? ' phase' : '') + '">' + esc(stepText(x)) +
      (k > 1 ? ' <span class="muted">×' + k + '</span>' : '') + '</li>').join('') + '</ol>' : '') +
    // closed <details>: long thinking costs no layout until someone opens it
    (t.thoughts ? '<details class="think done"><summary><span class="tk-dot"></span><span class="tk-label">Thinking' +
      secs + ' · ' + t.thoughts.length.toLocaleString() + ' chars</span></summary><div class="tk-body">' +
      esc(t.thoughts) + '</div></details>' : '') +
    (t.changes ?? []).map(ch => {
      const { removed, added } = lineDiff(ch.before, ch.after);
      return '<div class="change-card"><div class="cc-hd"><span class="cc-t">Model change</span><span class="cc-n mono">' +
        '<span class="add">+' + added.length + '</span> <span class="del">−' + removed.length + '</span></span></div>' +
        '<div class="cc-diff mono">' + ([...removed.map(l => '<div class="del">− ' + esc(l) + '</div>'),
          ...added.map(l => '<div class="add">+ ' + esc(l) + '</div>')].join('') ||
          '<div class="muted">Only the order of lines changed</div>') + '</div>' +
        (ch.run ? '<div class="cc-run ' + (ch.run.ok ? 'ok' : 'bad') + '">' + esc(ch.run.text) + '</div>' : '') + '</div>';
    }).join('') +
    '<div class="txt fh-a">' + renderMarkdown(t.a || '*(no answer)*') + '</div></section>';
}

/** Every chat, titled, every turn in order. '' when nothing has been said yet. */
export function historyHtml(chats){
  const withTurns = (chats ?? []).filter(c => c.log?.length);
  return withTurns.map((c, ci) => '<div class="fh-chat"><h3 class="fh-title">' +
    esc(c.title || 'Chat ' + (ci + 1)) + ' <span class="muted">' + c.log.length +
    (c.log.length === 1 ? ' turn' : ' turns') + '</span></h3>' + c.log.map(turnHtml).join('') + '</div>').join('');
}
