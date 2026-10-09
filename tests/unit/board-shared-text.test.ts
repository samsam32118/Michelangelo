import { describe, expect, it } from 'vitest';
import { ellipsize, wrapText } from '../../src/board/shared/text.js';
import { FakeCtx } from './board-shared-fakectx.js';

describe('board shared text', () => {
  const ctx = new FakeCtx();
  ctx.font = '10px sans'; // 6 px per character
  it('wraps words to the width and keeps newlines', () => {
    expect(wrapText(ctx, 'the quick brown fox jumps', 60)).toEqual(['the quick', 'brown fox', 'jumps']);
    expect(wrapText(ctx, 'a\nb c', 600)).toEqual(['a', 'b c']);
    expect(wrapText(ctx, '', 60)).toEqual(['']);
    for (const l of wrapText(ctx, 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do', 90)) expect(l.length * 6).toBeLessThanOrEqual(90);
  });
  it('breaks words longer than the line', () => {
    const lines = wrapText(ctx, 'go supercalifragilistic now', 48);
    expect(lines.join('').replace(/ /g, '')).toBe('gosupercalifragilisticnow');
    expect(lines.length).toBeGreaterThan(3);
    for (const l of lines) expect(l.length * 6).toBeLessThanOrEqual(48);
  });
  it('caches by font', () => {
    const a = wrapText(ctx, 'cache me please', 50);
    expect(wrapText(ctx, 'cache me please', 50)).toBe(a);
    ctx.font = '20px sans';
    expect(wrapText(ctx, 'cache me please', 50)).not.toBe(a);
    ctx.font = '10px sans';
  });
  it('ellipsizes', () => {
    expect(ellipsize(ctx, 'short', 100)).toBe('short');
    const e = ellipsize(ctx, 'a long title that will not fit', 60);
    expect(e.endsWith('…')).toBe(true);
    expect(e.length * 6).toBeLessThanOrEqual(60);
  });
});
