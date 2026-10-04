import { describe, it, expect } from 'vitest';
import builtin from '../../src/builtin/effects/index.js';
import { effect, runEffect, px, square, solid, surface, bars, close, luma, diff, createSurface } from './effects-fixtures.js';

describe('built-in plugin shape', () => {
  it('has ≥12 effects, ≥9 transitions, ≥4 generators with one-sentence descriptions', () => {
    expect(builtin.name).toBe('builtin-effects');
    expect(builtin.effects!.length).toBeGreaterThanOrEqual(12);
    expect(builtin.transitions!.length).toBeGreaterThanOrEqual(9);
    expect(builtin.generators!.length).toBeGreaterThanOrEqual(4);
    for (const d of [...builtin.effects!, ...builtin.transitions!, ...builtin.generators!]) {
      expect(d.describe, d.type).toMatch(/^[A-Z][^]*\.$/);
      expect(d.describe.replace(/\b(e\.g|i\.e)\./g, '').slice(0, -1), d.type).not.toMatch(/\.\s/);
    }
    for (const t of ['blur', 'glow', 'shadow', 'vignette', 'chroma-key', 'color', 'lut', 'denoise', 'sharpen', 'grain', 'pixelate', 'stroke']) expect(builtin.effects!.map((e) => e.type)).toContain(t);
  });

  it('every params schema parses its defaults (lut needs a file)', () => {
    for (const d of [...builtin.effects!, ...builtin.transitions!, ...builtin.generators!]) {
      if (d.type === 'lut') {
        expect(d.params.safeParse({}).success).toBe(false);
        expect(d.params.parse({ file: 'look.cube' })).toEqual({ file: 'look.cube', interp: 'tetrahedral' });
      } else expect(d.params.safeParse({}).success, d.type).toBe(true);
    }
  });

  it('rejects out-of-range values and bad colours', () => {
    expect(effect('blur').params.safeParse({ radius: -1 }).success).toBe(false);
    expect(effect('shadow').params.safeParse({ color: 'not a colour!' }).success).toBe(false);
    expect(effect('shadow').params.safeParse({ color: 'rgba(0,0,0,0.5)' }).success).toBe(true);
  });
});

describe('blur', () => {
  it('reduces edge contrast', () => {
    const src = square(64), out = runEffect('blur', src, { radius: 3 });
    const before = luma(px(src, 16, 32)) - luma(px(src, 15, 32));
    const after = luma(px(out, 16, 32)) - luma(px(out, 15, 32));
    expect(before).toBeGreaterThan(250);
    expect(after).toBeLessThan(before / 2);
    expect(after).toBeGreaterThan(0);
  });
  it('keeps opaque borders with edges=extend and fades them with transparent', () => {
    const src = solid(64, 64, '#808080');
    expect(px(runEffect('blur', src, { radius: 6 }), 0, 0)[3]).toBe(255);
    expect(px(runEffect('blur', src, { radius: 6, edges: 'transparent' }), 0, 0)[3]).toBeLessThan(200);
    expect(effect('blur').margin!({ radius: 10, edges: 'transparent' } as never)).toBeGreaterThan(0);
  });
  it('large radii blur a downscaled copy but stay smooth and centred', () => {
    const out = runEffect('blur', square(256), { radius: 60 });
    const row = [0, 32, 64, 96, 128].map((x) => luma(px(out, x, 128)));
    for (let i = 1; i < row.length; i++) expect(row[i]).toBeGreaterThanOrEqual(row[i - 1]! - 1);
    expect(Math.abs(luma(px(out, 100, 128)) - luma(px(out, 156, 128)))).toBeLessThan(6);
  });
});

describe('glow, shadow, vignette, stroke', () => {
  it('glow spreads light outside the shape and keeps it inside', () => {
    const src = square(64, null), out = runEffect('glow', src, { radius: 4 });
    expect(px(src, 12, 32)[3]).toBe(0);
    expect(px(out, 12, 32)[3]).toBeGreaterThan(10);
    expect(close(px(out, 32, 32), [255, 255, 255, 255])).toBe(true);
    const tinted = runEffect('glow', src, { radius: 4, color: '#ff0000' });
    const p = px(tinted, 12, 32);
    expect(p[0]).toBeGreaterThan(200);
    expect(p[1]).toBeLessThan(30);
  });
  it('glow threshold excludes dark pixels', () => {
    const src = surface(64, 64, (x) => { x.fillStyle = '#333'; x.fillRect(0, 0, 32, 64); });
    const out = runEffect('glow', src, { radius: 4, threshold: 0.5 });
    expect(px(out, 40, 32)[3]).toBe(0);
  });
  it('shadow is offset, coloured and semi-transparent', () => {
    const src = square(64, null), out = runEffect('shadow', src, { x: 10, y: 0, blur: 0, color: '#ff0000', opacity: 0.5 });
    const p = px(out, 52, 32);
    expect(p[0]).toBeGreaterThan(200);
    expect(p[3]).toBeGreaterThan(110);
    expect(p[3]).toBeLessThan(140);
    expect(px(out, 32, 32)).toEqual([255, 255, 255, 255]);
    expect(effect('shadow').margin!(effect('shadow').params.parse({}) as never)).toBeGreaterThan(8);
  });
  it('vignette darkens corners, not the centre, and only where the layer is', () => {
    const out = runEffect('vignette', solid(64, 64, '#fff'), { amount: 1, softness: 0.5 });
    expect(luma(px(out, 32, 32))).toBeGreaterThan(250);
    expect(luma(px(out, 0, 0))).toBeLessThan(40);
    expect(px(runEffect('vignette', square(64, null)), 0, 0)[3]).toBe(0);
  });
  it('stroke outlines the alpha with the given width and colour', () => {
    const src = square(64, null), out = runEffect('stroke', src, { width: 4, color: '#ff0000' });
    expect(px(out, 32, 32)).toEqual([255, 255, 255, 255]);
    expect(px(out, 14, 32)).toEqual([255, 0, 0, 255]);
    expect(px(out, 13, 32)[3]).toBeGreaterThan(100);
    expect(px(out, 10, 32)[3]).toBe(0);
    // corner is rounded: (16-3, 16-3) is ~4.2 px away
    expect(px(out, 12, 12)[3]).toBeLessThan(200);
    expect(effect('stroke').margin!({ width: 4 } as never)).toBeGreaterThanOrEqual(4);
  });
});

describe('chroma-key', () => {
  it('removes #00ff00 and keeps magenta', () => {
    const src = surface(64, 64, (x) => { x.fillStyle = '#00ff00'; x.fillRect(0, 0, 32, 64); x.fillStyle = '#ff00ff'; x.fillRect(32, 0, 32, 64); });
    const out = runEffect('chroma-key', src);
    expect(px(out, 10, 10)[3]).toBe(0);
    expect(px(out, 50, 10)).toEqual([255, 0, 255, 255]);
  });
  it('keeps neutral greys and suppresses green spill', () => {
    const src = surface(64, 64, (x) => { x.fillStyle = '#808080'; x.fillRect(0, 0, 32, 64); x.fillStyle = 'rgb(180,200,170)'; x.fillRect(32, 0, 32, 64); });
    const out = runEffect('chroma-key', src, { spill: 1 });
    expect(px(out, 10, 10)).toEqual([128, 128, 128, 255]);
    const p = px(out, 50, 10);
    expect(p[3]).toBe(255);
    expect(p[1]).toBeLessThanOrEqual(180);
  });
  it('keys blue screens too', () => {
    const src = solid(16, 16, '#0000ff');
    expect(px(runEffect('chroma-key', src, { color: '#0000ff' }), 8, 8)[3]).toBe(0);
    expect(px(runEffect('chroma-key', src), 8, 8)[3]).toBe(255);
  });
});

describe('grain', () => {
  it('is deterministic per seed and frame, and changes across frames and seeds', () => {
    const src = solid(64, 64, '#808080');
    const a = runEffect('grain', src, { amount: 0.3 }, 5, 7), b = runEffect('grain', src, { amount: 0.3 }, 5, 7);
    expect(diff(a, b)).toBe(0);
    expect(diff(a, runEffect('grain', src, { amount: 0.3 }, 6, 7))).toBeGreaterThan(5);
    expect(diff(a, runEffect('grain', src, { amount: 0.3 }, 5, 8))).toBeGreaterThan(5);
    expect(diff(a, runEffect('grain', src, { amount: 0.3, seed: 2 }, 5, 7))).toBeGreaterThan(5);
    expect(diff(a, src)).toBeGreaterThan(5);
  });
  it('mono grain is grey, size groups pixels, alpha is untouched', () => {
    const out = runEffect('grain', solid(32, 32, '#808080'), { amount: 0.5, size: 4 });
    const p = px(out, 1, 1);
    expect(p[0]).toBe(p[1]);
    expect(px(out, 0, 0)).toEqual(px(out, 3, 3));
    expect(p[3]).toBe(255);
    expect(px(runEffect('grain', square(32, null), { amount: 0.5 }), 0, 0)[3]).toBe(0);
  });
});

describe('pixelate, mirror, invert, rgb-split, sharpen, denoise', () => {
  it('pixelate makes uniform blocks that average the source', () => {
    const src = surface(64, 64, (x) => { for (let i = 0; i < 64; i += 2) { x.fillStyle = i % 4 ? '#fff' : '#000'; x.fillRect(i, 0, 2, 64); } });
    const out = runEffect('pixelate', src, { size: 8 });
    const a = px(out, 0, 0);
    for (const [x, y] of [[7, 7], [3, 5], [7, 0]]) expect(px(out, x!, y!)).toEqual(a);
    expect(a[0]).toBeGreaterThan(90);
    expect(a[0]).toBeLessThan(170);
  });
  it('mirror flips and reflects', () => {
    const src = surface(64, 64, (x) => { x.fillStyle = '#f00'; x.fillRect(0, 0, 32, 64); x.fillStyle = '#00f'; x.fillRect(32, 0, 32, 64); });
    const f = runEffect('mirror', src);
    expect(px(f, 5, 5)).toEqual([0, 0, 255, 255]);
    expect(px(f, 60, 5)).toEqual([255, 0, 0, 255]);
    const r = runEffect('mirror', src, { mode: 'reflect' });
    expect(px(r, 60, 5)).toEqual([255, 0, 0, 255]);
    expect(px(r, 5, 5)).toEqual([255, 0, 0, 255]);
    const v = runEffect('mirror', surface(8, 8, (x) => { x.fillStyle = '#f00'; x.fillRect(0, 0, 8, 4); }), { axis: 'vertical' });
    expect(px(v, 2, 7)[0]).toBe(255);
    expect(px(v, 2, 0)[3]).toBe(0);
  });
  it('invert negates colours and keeps alpha', () => {
    const out = runEffect('invert', square(32, null));
    expect(px(out, 16, 16)).toEqual([0, 0, 0, 255]);
    expect(px(out, 0, 0)[3]).toBe(0);
    expect(close(px(runEffect('invert', solid(4, 4, '#ff8000'), { amount: 0.5 }), 1, 1), [128, 128, 128, 255], 2)).toBe(true);
  });
  it('rgb-split separates red and blue around edges', () => {
    const out = runEffect('rgb-split', square(64, '#000'), { amount: 4 });
    const left = px(out, 17, 32), right = px(out, 47, 32);
    expect(left[0]).toBeLessThan(10); expect(left[2]).toBeGreaterThan(200);
    expect(right[0]).toBeGreaterThan(200); expect(right[2]).toBeLessThan(10);
    expect(px(out, 32, 32)).toEqual([255, 255, 255, 255]);
  });
  it('sharpen increases edge contrast; denoise smooths', () => {
    const src = surface(64, 64, (x) => { x.fillStyle = '#404040'; x.fillRect(0, 0, 64, 64); x.fillStyle = '#c0c0c0'; x.fillRect(32, 0, 32, 64); });
    const s = runEffect('sharpen', src, { amount: 1 });
    expect(luma(px(s, 31, 10))).toBeLessThan(0x40 - 10);
    expect(luma(px(s, 32, 10))).toBeGreaterThan(0xc0 + 10);
    expect(luma(px(s, 5, 10))).toBeCloseTo(0x40, 0);
    const d = runEffect('denoise', src, { strength: 1 });
    expect(luma(px(d, 32, 10)) - luma(px(d, 31, 10))).toBeLessThan(0x80);
  });
});

describe('speed at 1080x1920', () => {
  it('per-pixel effects stay fast', () => {
    const big = createSurface(1080, 1920);
    big.ctx.drawImage(bars(256, 256).canvas, 0, 0, 1080, 1920);
    const times: Record<string, number> = {};
    for (const [t, p] of [['blur', { radius: 40 }], ['color', { saturation: 1.4, hue: 20, contrast: 1.2 }], ['chroma-key', {}], ['grain', {}], ['stroke', { width: 8 }], ['glow', { radius: 30, threshold: 0.5 }], ['sharpen', {}], ['rgb-split', {}]] as const) {
      const t0 = performance.now();
      runEffect(t, big, p as Record<string, unknown>);
      times[t] = Math.round(performance.now() - t0);
    }
    console.log('effect ms @1080x1920', times);
    for (const [t, ms] of Object.entries(times)) expect(ms, t).toBeLessThan(2500);
  });
});
