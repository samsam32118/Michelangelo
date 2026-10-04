import { describe, it, expect, beforeAll } from 'vitest';
import { registerFonts } from '../../src/render/text.js';
import { formatCounter } from '../../src/builtin/effects/generators/counter.js';
import { runGenerator, generator, px, diff, close } from './effects-fixtures.js';
import type { Surface } from '../../src/plugin/api.js';

beforeAll(() => { registerFonts(); });

const lit = (s: Surface) => { const d = s.pixels(); let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]! > 0) n++; return n; };

describe('gradient', () => {
  it('linear angle 0 runs left to right, 90 top to bottom', () => {
    const g = runGenerator('gradient', 64, 64, { colors: ['#ff0000', '#0000ff'], angle: 0 });
    expect(px(g, 0, 32)[0]).toBeGreaterThan(240); expect(px(g, 63, 32)[2]).toBeGreaterThan(240);
    const v = runGenerator('gradient', 64, 64, { colors: ['#ff0000', '#0000ff'], angle: 90 });
    expect(px(v, 32, 0)[0]).toBeGreaterThan(240); expect(px(v, 32, 63)[2]).toBeGreaterThan(240);
    expect(close(px(v, 0, 32), px(v, 63, 32), 1)).toBe(true);
  });
  it('three colours, radial, animated rotation', () => {
    const g = runGenerator('gradient', 64, 64, { colors: ['#000', '#fff', '#000'], angle: 0 });
    expect(px(g, 32, 32)[0]).toBeGreaterThan(240);
    const r = runGenerator('gradient', 64, 64, { colors: ['#ffffff', '#000000'], shape: 'radial' });
    expect(px(r, 32, 32)[0]).toBeGreaterThan(240); expect(px(r, 0, 0)[0]).toBeLessThan(15);
    const a = runGenerator('gradient', 64, 64, { colors: ['#f00', '#00f'], animate: 90 }, 0), b = runGenerator('gradient', 64, 64, { colors: ['#f00', '#00f'], animate: 90 }, 30);
    expect(diff(a, b)).toBeGreaterThan(20);
    expect(generator('gradient').params.safeParse({ colors: ['#fff'] }).success).toBe(false);
  });
});

describe('noise', () => {
  it('is deterministic, evolves with time and maps onto the ramp', () => {
    const p = { scale: 16, speed: 1, colors: ['#000000', '#ff0000'] };
    const a = runGenerator('noise', 64, 64, p, 3), b = runGenerator('noise', 64, 64, p, 3);
    expect(diff(a, b)).toBe(0);
    expect(diff(a, runGenerator('noise', 64, 64, p, 20))).toBeGreaterThan(3);
    expect(diff(a, runGenerator('noise', 64, 64, { ...p, seed: 9 }, 3))).toBeGreaterThan(3);
    const q = px(a, 10, 10);
    expect(q[1]).toBe(0); expect(q[2]).toBe(0); expect(q[3]).toBe(255);
    expect(diff(runGenerator('noise', 64, 64, { ...p, speed: 0 }, 0), runGenerator('noise', 64, 64, { ...p, speed: 0 }, 50))).toBe(0);
  });
});

describe('particles', () => {
  it('draws deterministic particles that move over time', () => {
    const p = { count: 40, size: 4, speed: 60 };
    const a = runGenerator('particles', 128, 128, p, 10);
    expect(lit(a)).toBeGreaterThan(40);
    expect(diff(a, runGenerator('particles', 128, 128, p, 10))).toBe(0);
    expect(diff(a, runGenerator('particles', 128, 128, p, 20))).toBeGreaterThan(0.5);
    expect(diff(a, runGenerator('particles', 128, 128, { ...p, seed: 3 }, 10))).toBeGreaterThan(0.5);
    expect(lit(runGenerator('particles', 128, 128, { ...p, count: 200 }, 10))).toBeGreaterThan(lit(a));
  });
});

describe('progress-bar', () => {
  it('fills over duration frames at the chosen edge', () => {
    const p = { duration: 101, height: 8, color: '#ff0000', background: 'rgba(0,0,0,0)' };
    const f0 = runGenerator('progress-bar', 100, 50, p, 0);
    expect(lit(f0)).toBe(0);
    const half = runGenerator('progress-bar', 100, 50, p, 50);
    expect(px(half, 45, 46)).toEqual([255, 0, 0, 255]);
    expect(px(half, 55, 46)[3]).toBe(0);
    expect(px(half, 45, 40)[3]).toBe(0);
    expect(px(runGenerator('progress-bar', 100, 50, p, 100), 99, 46)).toEqual([255, 0, 0, 255]);
    expect(px(runGenerator('progress-bar', 100, 50, p, 500), 99, 46)).toEqual([255, 0, 0, 255]);
    const top = runGenerator('progress-bar', 100, 50, { ...p, position: 'top' }, 50);
    expect(px(top, 10, 3)).toEqual([255, 0, 0, 255]);
  });
});

describe('counter', () => {
  it('formats numbers', () => {
    const base = { from: 0, to: 0, decimals: 0, prefix: '', suffix: '', separator: '' };
    expect(formatCounter({ ...base, prefix: '$', separator: ',' }, 1234567.4)).toBe('$1,234,567');
    expect(formatCounter({ ...base, decimals: 1, suffix: '%' }, 99.94)).toBe('99.9%');
    expect(formatCounter({ ...base }, -3.2)).toBe('-3');
    expect(formatCounter({ ...base }, -0.2)).toBe('0');
  });
  it('sizes its box and draws text that changes over time', () => {
    const def = generator('counter'), p = def.params.parse({ from: 0, to: 1000, duration: 30, size: 40 });
    const [w, h] = def.size!(p as never, { width: 1080, height: 1920 });
    expect(w).toBeGreaterThan(80); expect(h).toBeGreaterThan(40);
    const a = runGenerator('counter', w, h, p, 0), b = runGenerator('counter', w, h, p, 29);
    expect(lit(a)).toBeGreaterThan(20);
    expect(lit(b)).toBeGreaterThan(lit(a));
    expect(diff(b, runGenerator('counter', w, h, p, 60))).toBe(0);
  });
});

describe('checker and pattern', () => {
  it('checker alternates cells', () => {
    const c = runGenerator('checker', 64, 64, { size: 16, colors: ['#000000', '#ffffff'] });
    const a = px(c, 32 + 8, 32 + 8), b = px(c, 32 + 24, 32 + 8), d = px(c, 32 + 24, 32 + 24);
    expect(a).not.toEqual(b); expect(a).toEqual(d);
    expect(diff(c, runGenerator('checker', 64, 64, { size: 16, colors: ['#000000', '#ffffff'], speed: 8 }, 30))).toBeGreaterThan(10);
  });
  it('every pattern kind uses both colours', () => {
    for (const kind of ['checker', 'stripes', 'dots', 'grid']) {
      const s = runGenerator('pattern', 96, 96, { kind, size: 24, colors: ['#000000', '#ffffff'], lineWidth: 3 }), d = s.pixels();
      let white = 0, black = 0;
      for (let i = 0; i < d.length; i += 4) { if (d[i]! > 200) white++; else if (d[i]! < 50) black++; }
      expect(white, kind).toBeGreaterThan(50); expect(black, kind).toBeGreaterThan(50);
    }
  });
});

describe('speed at 1080x1920', () => {
  it('generators stay fast', () => {
    const times: Record<string, number> = {};
    for (const [t, p] of [['gradient', {}], ['noise', {}], ['particles', { count: 1000 }], ['pattern', { size: 4 }], ['progress-bar', {}]] as const) {
      const t0 = performance.now();
      runGenerator(t, 1080, 1920, p as Record<string, unknown>, 15).pixels();
      times[t] = Math.round(performance.now() - t0);
    }
    console.log('generator ms @1080x1920', times);
    for (const [t, ms] of Object.entries(times)) expect(ms, t).toBeLessThan(1500);
  });
});
