/**
 * What to show under Next: the server's advice (state.advice) when it sends it, else a local summary of the same
 * rules (BOARD.md §7) so the panel is never empty. The model's advise() stays the reference.
 */
import type { Advice, BoardFile } from '../shared/types.js';
import { LEVEL_NAMES } from '../shared/outline.js';

export const briefMissing = (b: BoardFile): string[] => {
  const br = b.brief ?? {};
  return [!br.goal?.trim() && 'goal', !br.audience?.trim() && 'audience', !br.success?.length && 'success'].filter((x): x is string => !!x);
};
export const spentMs = (b: BoardFile): number => (b.spend ?? []).reduce((s, e) => s + (e.ms || 0), 0);
/** the highest decided rung, -1 when nothing is decided */
export const decidedLevel = (b: BoardFile): number => (b.rounds ?? []).filter((r) => r.status === 'decided').reduce((m, r) => Math.max(m, r.fidelity), -1);

export function localAdvice(b: BoardFile): Advice[] {
  const out: Advice[] = [];
  const miss = briefMissing(b);
  if (miss.length) out.push({ level: 'ask', text: `The brief lacks ${miss.join(', ')}. Agree on these before rendering drafts.`, ids: ['brief'] });
  for (const q of b.brief?.questions ?? []) out.push({ level: 'ask', text: `Open question: ${q}`, ids: ['brief'] });
  const budget = b.brief?.budget?.cpuMin;
  if (budget && spentMs(b) / 60000 > budget * 0.8) out.push({ level: 'warn', text: `Spend is over 80 % of the ${budget} render-minute budget.`, ids: ['brief'] });
  for (const r of b.rounds ?? []) {
    if (r.status === 'open' && (r.options?.length ?? 0) < 2) out.push({ level: 'do', text: `Round ${r.id} "${r.goal}" needs 2–3 options with tradeoffs.`, ids: [r.id] });
    if (r.status === 'open' || r.status === 'proposed') for (const o of r.options ?? []) if (!o.tradeoffs?.trim()) out.push({ level: 'do', text: `Option ${o.id} "${o.title}" has no tradeoffs yet.`, ids: [o.id] });
    if (r.status === 'proposed') out.push({ level: 'wait', text: `Round ${r.id} "${r.goal}" is waiting for your choice.`, ids: [r.id] });
  }
  for (const s of b.shapes ?? []) if (s.type === 'pin' && s.status !== 'resolved') out.push({ level: 'do', text: `Pin ${s.id} on ${s.target}: "${s.text ?? ''}"`, ids: [s.id, s.target] });
  const last = (b.log ?? []).at(-1);
  if (last?.by === 'human') out.push({ level: 'do', text: `The person said "${last.text.slice(0, 80)}": waiting for an answer.`, ids: [last.id] });
  if (!out.length) {
    const top = decidedLevel(b);
    out.push({ level: 'do', text: top < 0 ? 'Open a round at level 0 or 1 with 2–3 options.' : top < 4 ? `Level ${top} (${LEVEL_NAMES[top]}) is decided: climb to ${LEVEL_NAMES[top + 1]}.` : 'The final is decided.' });
  }
  const rank = { ask: 0, warn: 1, do: 2, wait: 3 } as const;
  return out.sort((a, c) => rank[a.level] - rank[c.level]);
}

export const adviceFor = (b: BoardFile, server?: Advice[]): Advice[] => (Array.isArray(server) ? server : localAdvice(b));
