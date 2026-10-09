import { describe, it, expect } from 'vitest';
import { advise, applyOps, parseBoardText, ladderGap } from '../../src/board/model/index.js';
import type { BoardFile, BoardOp } from '../../src/board/shared/types.js';
import { OUTLINE, SAMPLE } from './board-model-fixtures.js';

const base = () => parseBoardText(SAMPLE);
const with_ = (ops: unknown[], b: BoardFile = base(), by: 'ai' | 'human' = 'ai') => applyOps(b, ops as BoardOp[], { by, outline: OUTLINE }).board;
const texts = (b: BoardFile) => advise(b, OUTLINE).map((a) => `${a.level}: ${a.text}`);

describe('advise', () => {
  it('asks for missing brief fields and open questions first', () => {
    const b = with_([{ op: 'brief.set', audience: null, success: null, questions: ['calm or energetic?'] }]);
    const a = advise(b, OUTLINE);
    expect(a[0]).toMatchObject({ level: 'ask' });
    expect(a[0]!.text).toContain('audience, success');
    expect(a[0]!.text).toContain('no draft or final');
    expect(a[1]!.text).toContain('"calm or energetic?"');
    expect(advise({ michelangeloBoard: 1 }, null)[0]!.text).toContain('goal, audience, success');
  });
  it('rounds: too few options, missing tradeoffs, proposed → wait', () => {
    const b = with_([{ op: 'round.open', goal: 'look', fidelity: 2 }, { op: 'round.option', round: 'r2', option: { title: 'A' } }]);
    const t = texts(b);
    expect(t.some((x) => x.startsWith('do: round r2') && x.includes('1 option'))).toBe(true);
    expect(t.some((x) => x.startsWith('do: option r2a') && x.includes('no tradeoffs'))).toBe(true);
    const p = with_([{ op: 'round.option', round: 'r2', option: { title: 'B', tradeoffs: 'x' } }], b);
    const tp = texts(p);
    expect(tp.at(-1)).toMatch(/^wait: round r2 .* proposed \(r2a, r2b\)/);
  });
  it('open pins with time and visible clips', () => {
    const b = with_([{ op: 'still.add', t: '2.5s' }, { op: 'pin.add', target: 's2', text: 'logo clashes' }]);
    const t = texts(b);
    expect(t).toContain('do: pin p1 on s1 @ 0s [clips: bg, t1]: "title too small" (by human): fix it, then pin.resolve p1 reply="what changed"');
    expect(t.some((x) => x.includes('pin p2 on s2 @ 2.5s [clips: bg, t2]'))).toBe(true);
  });
  it('warns on skipped rungs and on spend over 80 % of the budget', () => {
    const b = with_([{ op: 'round.open', goal: 'draft', fidelity: 3 }]);
    expect(texts(b).some((x) => x.startsWith('warn: round r2 works at level 3'))).toBe(true);
    expect(ladderGap(base(), 2)).toBeUndefined();
    expect(ladderGap(base(), 3)).toContain('nothing decided at level 2');
    const s = with_([{ op: 'spend.add', level: 1, what: 'x', ms: 500_000 }]);
    expect(texts(s).find((x) => x.includes('render min'))).toMatch(/^warn: spend 8\.3 of 10 render min \(83 %\)/);
    const r = with_([{ op: 'spend.add', level: 4, what: 'final', ms: 100 }]);
    expect(texts(r).some((x) => x.startsWith('warn: the last render (final) was at level 4'))).toBe(true);
  });
  it('answers the person, orders ask > warn > do > wait, suggests the next rung', () => {
    const b = with_([{ op: 'say', text: 'can it be warmer?' }], base(), 'human');
    expect(texts(b)).toContain('do: the person said "can it be warmer?" (m2): answer it (mgl board say "..." re=m2)');
    expect(texts(with_([{ op: 'say', text: 'yes', re: 'm2' }], b)).some((x) => x.includes('the person said'))).toBe(false);
    const order = advise(with_([{ op: 'brief.set', goal: null }, { op: 'round.open', goal: 'g', fidelity: 3 }, { op: 'round.option', round: 'r2', option: { title: 'a', tradeoffs: 't' } }, { op: 'round.option', round: 'r2', option: { title: 'b', tradeoffs: 't' } }]), OUTLINE).map((a) => a.level);
    expect(order).toEqual([...order].sort((x, y) => ['ask', 'warn', 'do', 'wait'].indexOf(x) - ['ask', 'warn', 'do', 'wait'].indexOf(y)));
    expect(order[0]).toBe('ask');
    expect(order.at(-1)).toBe('wait');
    const resolved = with_([{ op: 'pin.resolve', id: 'p1', reply: 'bigger' }]);
    expect(texts(resolved)).toEqual(['do: level 1 (frames) is decided: climb to level 2 (sheet): open a round (round.open "..." fidelity=2)']);
  });
  it('tracks every unanswered message by id: a racing ai message is not an answer', () => {
    const at = (b: BoardFile, ops: unknown[], by: 'ai' | 'human', now: string) => applyOps(b, ops as BoardOp[], { by, outline: OUTLINE, now }).board;
    let b = at(base(), [{ op: 'say', text: 'here is the whole brief' }], 'human', '2026-10-09T10:00:00.000Z');
    b = at(b, [{ op: 'say', text: 'unrelated status' }], 'ai', '2026-10-09T10:00:00.800Z'); // typed while m2 arrived
    expect(texts(b).some((x) => x.includes('(m2): answer it'))).toBe(true);
    b = at(b, [{ op: 'say', text: 'keep the music quiet' }], 'human', '2026-10-09T10:00:05.000Z');
    expect(texts(b).filter((x) => x.includes('the person said')).length).toBe(2);
    const named = at(b, [{ op: 'say', text: 'on the brief: yes', re: ['m2'] }], 'ai', '2026-10-09T10:00:05.100Z');
    expect(texts(named).filter((x) => x.includes('the person said')).map((x) => /\((m\d+)\)/.exec(x)?.[1])).toEqual(['m4']);
    const later = at(b, [{ op: 'say', text: 'both noted' }], 'ai', '2026-10-09T10:00:07.000Z');
    expect(texts(later).some((x) => x.includes('the person said'))).toBe(false);
    expect(() => at(b, [{ op: 'say', text: 'x', re: 'm99' }], 'ai', '2026-10-09T10:00:07.000Z')).toThrow(/re "m99"/);
  });
  it('a render counts as reaching its rung: after the final, share it instead of climbing', () => {
    // r1 (level 1) is decided in the sample; render a draft and then the final, charged to r1
    const resolved = with_([{ op: 'pin.resolve', id: 'p1', reply: 'bigger' }]);
    const draft = with_([{ op: 'spend.add', level: 3, what: 'draft draft-1.mp4', ms: 9000, round: 'r1' }], resolved);
    expect(texts(draft).find((x) => x.startsWith('do: level 3'))).toContain('level 3 (draft) is rendered (draft-1.mp4');
    const fin = with_([{ op: 'spend.add', level: 4, what: 'final final-1.mp4', ms: 26000, round: 'r1' }], draft);
    const t = texts(fin);
    expect(t.some((x) => x.includes('climb to level'))).toBe(false);
    expect(t.find((x) => x.startsWith('do: done:'))).toContain('final-1.mp4 is rendered (c');
  });
});
