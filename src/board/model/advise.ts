/**
 * Advice (docs/plans/BOARD.md §7): what the agent and the person should do next, one line each, ordered
 * ask > warn > do > wait. Pure.
 */
import type { Advice, BoardFile, LogEntry, Outline, Presence, Round, Shape, SpendEntry, Who } from '../shared/types.js';
import { clipsAt, compOf, timeToFrames } from './outline.js';

const RANK: Record<Advice['level'], number> = { ask: 0, warn: 1, do: 2, wait: 3 };
const LEVEL_NAME = ['sketch', 'frames', 'sheet', 'draft', 'final'];

/** Brief fields that must exist before the work starts; goal and success also gate draft and final renders. */
export function briefMissing(b: BoardFile): string[] {
  const br = b.brief ?? {};
  const out: string[] = [];
  if (!br.goal?.trim()) out.push('goal');
  if (!br.audience?.trim()) out.push('audience');
  if (!br.success?.length) out.push('success');
  return out;
}

/** Total measured spend in ms. */
export function spentMs(b: BoardFile): number { return (b.spend ?? []).reduce((s, e) => s + e.ms, 0); }

/** Where a pin points: the still's time and the clips visible there (when the target is a still and a project is linked). */
export function pinContext(b: BoardFile, outline: Outline | null, pin: Shape & { type: 'pin' }): { t?: string; frame?: number; clips?: string[] } {
  const target = (b.shapes ?? []).find((s) => s.id === pin.target);
  if (!target || target.type !== 'still') return {};
  const t = String(target.t);
  if (!outline) return { t };
  const c = compOf(outline, target.comp);
  if (!c) return { t };
  try {
    const frame = timeToFrames(target.t, c.fps);
    return { t, frame, clips: clipsAt(outline, c.id, frame) };
  } catch { return { t }; }
}

/** Would a render at `level` skip a rung (nothing decided at level - 1)? The text of the warning, or undefined. */
export function ladderGap(b: BoardFile, level: number): string | undefined {
  if (level < 2) return undefined;
  const decided = (b.rounds ?? []).filter((r) => r.status === 'decided');
  if (decided.some((r) => r.fidelity >= level - 1)) return undefined;
  const top = decided.reduce((m, r) => Math.max(m, r.fidelity), -1);
  return `level ${level} (${LEVEL_NAME[level]}) with nothing decided at level ${level - 1} (${LEVEL_NAME[level - 1]})${top >= 0 ? `; highest decided: ${top}` : ''}: skipping rungs wastes renders`;
}

/** An ai message answers a person's message it names (`re`), or, naming none, one at least this much older (a reply
 * typed while the person's message was arriving is not an answer to it). */
export const ANSWER_GAP_MS = 1000;

/** The person's messages no agent message has answered yet (oldest first). */
export function unanswered(b: BoardFile): LogEntry[] {
  const log = b.log ?? [];
  const at = (m: LogEntry) => (m.at ? Date.parse(m.at) : NaN);
  return log.filter((h, i) => h.by === 'human' && !log.some((a, j) => {
    if (a.by !== 'ai') return false;
    if (a.re?.length) return a.re.includes(h.id);
    if (j < i) return false;
    const dt = at(a) - at(h);
    return Number.isNaN(dt) ? j > i : dt >= ANSWER_GAP_MS;
  }));
}

/** The highest rung reached since the last decision: renders charged to the last decided round (or, before any round, all). */
export function reachedBySpend(b: BoardFile): SpendEntry | undefined {
  const decided = (b.rounds ?? []).filter((r) => r.status === 'decided').at(-1);
  const rows = (b.spend ?? []).filter((e) => (decided ? e.round === decided.id : true));
  return rows.reduce<SpendEntry | undefined>((m, e) => (!m || e.level >= m.level ? e : m), undefined);
}

/** "final-1.mp4" from a spend row's text, else the text */
const spendFile = (e: SpendEntry) => /\S+\.(mp4|png|mov|webm)/.exec(e.what)?.[0] ?? e.what;

const optionList = (r: Round) => (r.options ?? []).map((o) => o.id).join(', ');

export function advise(b: BoardFile, outline: Outline | null, view?: Partial<Record<Who, Presence>>): Advice[] {
  const out: Advice[] = [];
  const rounds = b.rounds ?? [];
  const missing = briefMissing(b);
  if (missing.length) {
    const gate = missing.includes('goal') || missing.includes('success') ? ' (no draft or final render until goal and success exist)' : '';
    out.push({ level: 'ask', text: `brief lacks ${missing.join(', ')}: ask the person${gate}`, ids: ['brief'] });
  }
  const qs = b.brief?.questions ?? [];
  if (qs.length) out.push({ level: 'ask', text: `open question${qs.length > 1 ? 's' : ''} for the person: ${qs.map((q) => `"${q}"`).join('; ')}`, ids: ['brief'] });

  for (const r of rounds) {
    if (r.status === 'open' && (r.options?.length ?? 0) < 2) {
      out.push({ level: 'do', text: `round ${r.id} "${r.goal}" has ${r.options?.length ?? 0} option${r.options?.length === 1 ? '' : 's'}: propose 2-3 alternatives with tradeoffs (round.option ${r.id} title=... tradeoffs=...)`, ids: [r.id] });
    }
    if (r.status === 'open' || r.status === 'proposed') for (const o of r.options ?? []) {
      if (!o.tradeoffs?.trim()) out.push({ level: 'do', text: `option ${o.id} "${o.title}" has no tradeoffs: say what it costs and what it gives up (round.option ${r.id} id=${o.id} tradeoffs=...)`, ids: [o.id] });
    }
    if (r.status === 'proposed') out.push({ level: 'wait', text: `round ${r.id} "${r.goal}" is proposed (${optionList(r)}): wait for the person's choice; do not climb the ladder`, ids: [r.id] });
    if ((r.status === 'open' || r.status === 'proposed')) {
      const gap = ladderGap(b, r.fidelity);
      if (gap) out.push({ level: 'warn', text: `round ${r.id} works at ${gap}`, ids: [r.id] });
    }
  }

  for (const s of b.shapes ?? []) {
    if (s.type !== 'pin' || s.status === 'resolved') continue;
    const c = pinContext(b, outline, s);
    const where = c.t !== undefined ? ` @ ${c.t}${c.clips ? ` [clips: ${c.clips.join(', ') || 'none'}]` : ''}` : '';
    out.push({ level: 'do', text: `pin ${s.id} on ${s.target}${where}: "${s.text ?? ''}" (by ${s.by ?? 'human'}): fix it, then pin.resolve ${s.id} reply="what changed"`, ids: [s.id, s.target] });
  }

  // the latest render must not have skipped a rung
  const lastSpend = (b.spend ?? []).at(-1);
  if (lastSpend) {
    const gap = ladderGap(b, lastSpend.level);
    if (gap) out.push({ level: 'warn', text: `the last render (${lastSpend.what}) was at ${gap}`, ids: [lastSpend.id] });
  }

  const budget = b.brief?.budget?.cpuMin;
  if (budget !== undefined && budget >= 0) {
    const ms = spentMs(b), pct = budget > 0 ? (ms / 60000 / budget) * 100 : Infinity;
    if (pct > 80) out.push({ level: 'warn', text: `spend ${(ms / 60000).toFixed(1)} of ${budget} render min (${Number.isFinite(pct) ? Math.round(pct) : '∞'} %): agree with the person before rendering more`, ids: ['brief'] });
  }
  const maxLevel = b.brief?.budget?.maxLevel;
  if (maxLevel !== undefined) for (const r of rounds) if ((r.status === 'open' || r.status === 'proposed') && r.fidelity > maxLevel) {
    out.push({ level: 'warn', text: `round ${r.id} is at level ${r.fidelity}, above the brief's maxLevel ${maxLevel}`, ids: [r.id] });
  }

  const open = unanswered(b);
  for (const m of open.slice(-3)) out.push({ level: 'do', text: `the person said "${m.text.length > 80 ? m.text.slice(0, 79) + '…' : m.text}" (${m.id}): answer it (mgl board say "..." re=${m.id})`, ids: [m.id] });
  if (open.length > 3) out.push({ level: 'do', text: `${open.length - 3} older message${open.length > 4 ? 's' : ''} from the person also unanswered (${open.slice(0, -3).map((m) => m.id).join(', ')})`, ids: open.slice(0, -3).map((m) => m.id) });

  // the loop: brief → round with options → decide → climb
  const active = rounds.filter((r) => r.status === 'open' || r.status === 'proposed');
  if (!active.length && !missing.length) {
    const top = rounds.filter((r) => r.status === 'decided').reduce((m, r) => Math.max(m, r.fidelity), -1);
    // a render counts as reaching its rung: after the final render the advice is to share it, not to climb again
    const spent = reachedBySpend(b);
    if (spent && spent.level >= 4 && top < 4) out.push({ level: 'do', text: `done: ${spendFile(spent)} is rendered (${spent.id}): share it and ask the person to approve it (round.open "approve the final" fidelity=4, an option for it, then their round.decide)`, ids: [spent.id] });
    else if (spent && spent.level >= 2 && spent.level > top && top < 4) out.push({ level: 'do', text: `level ${spent.level} (${LEVEL_NAME[spent.level]}) is rendered (${spendFile(spent)}, ${spent.id}): show the person, then open a round at level ${spent.level} to review it (round.open "..." fidelity=${spent.level})`, ids: [spent.id] });
    else if (top < 0) out.push({ level: 'do', text: 'brief is set: open a round at level 0 or 1 (round.open "..." fidelity=1) and propose 2-3 options with tradeoffs and taste' });
    else if (top < 4) out.push({ level: 'do', text: `level ${top} (${LEVEL_NAME[top]}) is decided: climb to level ${top + 1} (${LEVEL_NAME[top + 1]}): open a round (round.open "..." fidelity=${top + 1})` });
  }
  // the person's view (selection) is shown by `mgl board show`; it does not change the advice yet
  void view;
  return out.map((a, i) => ({ a, i })).sort((x, y) => RANK[x.a.level] - RANK[y.a.level] || x.i - y.i).map((x) => x.a);
}
