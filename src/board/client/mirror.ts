/**
 * The DOM mirror of the canvas (BOARD.md §8.1): #mgl-outline lists every shape as text (type, id, label or text, who,
 * frame; stills with time and visible clips; pins with status), then the brief, rounds and next advice, so a browser
 * that reads the page as text sees the whole board. Also keeps document.title informative.
 */
import type { Shape } from '../shared/types.js';
import { clipsAt, LEVEL_NAMES, stillAt } from '../shared/outline.js';
import { formatTime } from '../shared/time.js';
import type { App } from './app.js';
import { h } from './dom.js';
import { adviceFor, briefMissing } from './advice.js';

export function boardName(app: App): string {
  const p = app.store.board.project ?? app.store.project?.file;
  return p ? p.split(/[\\/]/).pop()!.replace(/\.mgl\.json$/, '') : 'board';
}

export function describe(app: App, s: Shape): string {
  const parts = [`${s.type} ${s.id}`];
  const text = 'text' in s && s.text ? s.text : s.label;
  if (text) parts.push(`"${text.length > 120 ? text.slice(0, 119) + '…' : text}"`);
  if (s.type === 'still') {
    const at = stillAt(app.store.project, s);
    parts.push(at ? `at ${formatTime(at.frame, at.fps)}${app.store.project ? ` clips: ${clipsAt(app.store.project, at.comp, at.frame).join(', ') || 'none'}` : ''}` : `at ${s.t}`);
    parts.push(s.fidelity ?? 'thumb');
  }
  if (s.type === 'arrow') parts.push(`from ${Array.isArray(s.from) ? s.from.join(',') : s.from ?? '?'} to ${Array.isArray(s.to) ? s.to.join(',') : s.to ?? '?'}`);
  if (s.type === 'pin') { parts.push(`on ${s.target}${pinTime(app, s.target)}`, s.status ?? 'open'); if (s.reply) parts.push(`reply: "${s.reply}"`); }
  if (s.type === 'image') parts.push(s.src);
  if (s.parent) parts.push(`in ${s.parent}`);
  if (s.by) parts.push(`by ${s.by}`);
  return parts.join(' · ');
}

/** " at 0:01.15 (clips: a, b)" when a pin's target is a still: the time the feedback is about */
function pinTime(app: App, target: string): string {
  const t = app.store.get(target);
  if (!t || t.type !== 'still') return '';
  const at = stillAt(app.store.project, t);
  if (!at) return ` at ${t.t}`;
  return ` at ${formatTime(at.frame, at.fps)} (clips: ${clipsAt(app.store.project!, at.comp, at.frame).join(', ') || 'none'})`;
}

export function installMirror(app: App, root: HTMLElement): void {
  let queued = false;
  const render = () => {
    queued = false;
    const b = app.store.board, shapes = b.shapes ?? [];
    const br = b.brief ?? {}, miss = briefMissing(b);
    const openPins = shapes.filter((s): s is Shape & { type: 'pin' } => s.type === 'pin' && s.status !== 'resolved');
    const briefLines = Object.entries(br).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join('; ') : typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
    root.replaceChildren(
      h('h2', {}, `Board ${boardName(app)} (version ${app.store.version}, ${shapes.length} shapes)`),
      h('h3', {}, 'Shapes'),
      h('ul', {}, ...shapes.map((s) => h('li', { 'data-id': s.id }, describe(app, s)))),
      h('h3', {}, 'Open pins'),
      h('ul', {}, ...(openPins.length ? openPins.map((p) => h('li', {}, `${p.id} on ${p.target}${pinTime(app, p.target)}: "${p.text ?? ''}" by ${p.by ?? 'human'}`)) : [h('li', {}, 'none')])),
      h('h3', {}, 'Brief'),
      h('ul', {}, ...briefLines.map((l) => h('li', {}, l)), miss.length ? h('li', {}, `missing: ${miss.join(', ')}`) : null),
      h('h3', {}, 'Rounds'),
      h('ul', {}, ...(b.rounds ?? []).map((r) => h('li', {}, `${r.id} "${r.goal}" level ${r.fidelity} (${LEVEL_NAMES[r.fidelity]}) ${r.status}${r.chosen ? `, chosen ${r.chosen}` : ''}${r.why ? ` because ${r.why}` : ''}`,
        h('ul', {}, ...(r.options ?? []).map((o) => h('li', {}, `${o.id}: ${o.title}${o.summary ? ` (${o.summary})` : ''}${o.tradeoffs ? `; tradeoffs: ${o.tradeoffs}` : ''}${o.cost ? `; cost: ${o.cost}` : ''}${o.taste ? `; taste: ${o.taste}` : ''}`)))))),
      h('h3', {}, 'Next'),
      h('ul', {}, ...adviceFor(b, app.store.advice).map((a) => h('li', {}, `${a.level}: ${a.text}`))),
      ...(app.store.detached ? [h('h3', {}, 'Changes to apply (this page is detached)'),
        h('p', {}, app.store.pending.length ? `${app.store.pending.length} queued; as JSONL for mgl board edit <file> --batch changes.jsonl --by human:` : 'none queued yet'),
        ...(app.store.pending.length ? [h('pre', { 'data-mgl': 'pending-jsonl' }, app.store.pending.map((p) => JSON.stringify(p.op)).join('\n'))] : [])] : []),
      h('h3', {}, 'Recent messages'),
      h('ul', {}, ...(b.log ?? []).slice(-5).map((m) => h('li', {}, `${m.by}: ${m.text}`))),
    );
    const pins = openPins.length;
    const waiting = (b.rounds ?? []).filter((r) => r.status === 'proposed').length;
    document.title = `Board · ${boardName(app)}${pins ? ` · ${pins} open pin${pins > 1 ? 's' : ''}` : ''}${waiting ? ` · ${waiting} to choose` : ''}`;
  };
  app.store.on((c) => { if ((c === 'board' || c === 'advice' || c === 'project') && !queued) { queued = true; setTimeout(render, 50); } });
  render();
}
