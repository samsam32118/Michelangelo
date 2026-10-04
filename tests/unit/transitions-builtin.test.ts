import { describe, it, expect } from 'vitest';
import builtin from '../../src/builtin/effects/index.js';
import { runTransition, solid, surface, px, close, diff, transition } from './effects-fixtures.js';

const W = 64, H = 64;
const red = () => solid(W, H, '#ff0000'), blue = () => solid(W, H, '#0000ff');
/** a frame with a distinct left (red) and right (green) half, to see where content moved */
const halves = () => surface(W, H, (x) => { x.fillStyle = '#ff0000'; x.fillRect(0, 0, W / 2, H); x.fillStyle = '#00ff00'; x.fillRect(W / 2, 0, W / 2, H); });

describe('every transition', () => {
  it('shows `from` at 0 and `to` at 1', () => {
    for (const t of builtin.transitions!) {
      const from = red(), to = blue();
      expect(diff(runTransition(t.type, from, to, 0), from), `${t.type}@0`).toBeLessThan(2);
      expect(diff(runTransition(t.type, from, to, 1), to), `${t.type}@1`).toBeLessThan(2);
    }
  });
  it('includes the required set and no iris', () => {
    const types = builtin.transitions!.map((t) => t.type);
    for (const t of ['crossfade', 'dip', 'wipe', 'slide', 'push', 'zoom', 'blur', 'spin', 'flash']) expect(types).toContain(t);
    expect(types).not.toContain('iris');
  });
});

describe('crossfade / dip / flash', () => {
  it('crossfade midpoint is the average and stays opaque', () => {
    const p = px(runTransition('crossfade', red(), blue(), 0.5), 10, 10);
    expect(close(p, [128, 0, 128, 255], 2)).toBe(true);
    const q = px(runTransition('crossfade', red(), blue(), 0.25), 10, 10);
    expect(close(q, [191, 0, 64, 255], 2)).toBe(true);
  });
  it('crossfade of transparent layers fades alpha linearly', () => {
    const empty = surface(W, H, () => {});
    expect(px(runTransition('crossfade', red(), empty, 0.5), 5, 5)[3]).toBeGreaterThan(120);
    expect(px(runTransition('crossfade', red(), empty, 0.5), 5, 5)[3]).toBeLessThan(136);
  });
  it('dip at 0.5 is the colour', () => {
    expect(px(runTransition('dip', red(), blue(), 0.5), 5, 5)).toEqual([0, 0, 0, 255]);
    expect(px(runTransition('dip', red(), blue(), 0.5, { color: 'white' }), 5, 5)).toEqual([255, 255, 255, 255]);
    expect(px(runTransition('dip', red(), blue(), 0.5, { color: '#336699' }), 5, 5)).toEqual([0x33, 0x66, 0x99, 255]);
    const q = px(runTransition('dip', red(), blue(), 0.25), 5, 5);
    expect(q[0]).toBeGreaterThan(110); expect(q[0]).toBeLessThan(145);
    expect(px(runTransition('dip', red(), blue(), 0.75), 5, 5)[2]).toBeGreaterThan(110);
  });
  it('flash peaks at the colour at 0.5', () => {
    expect(px(runTransition('flash', red(), blue(), 0.5), 5, 5)).toEqual([255, 255, 255, 255]);
    const early = px(runTransition('flash', red(), blue(), 0.1), 5, 5);
    expect(early[0]).toBe(255); expect(early[1]).toBeLessThan(60);
  });
});

describe('wipe', () => {
  it('left: at 0.5 the right half shows `to`, the left half `from`', () => {
    const out = runTransition('wipe', red(), blue(), 0.5, { direction: 'left' });
    expect(px(out, 10, 32)).toEqual([255, 0, 0, 255]);
    expect(px(out, 54, 32)).toEqual([0, 0, 255, 255]);
  });
  it('right / down / up go the other ways', () => {
    const r = runTransition('wipe', red(), blue(), 0.25, { direction: 'right' });
    expect(px(r, 10, 32)).toEqual([0, 0, 255, 255]);
    expect(px(r, 30, 32)).toEqual([255, 0, 0, 255]);
    const d = runTransition('wipe', red(), blue(), 0.5, { direction: 'down' });
    expect(px(d, 32, 10)).toEqual([0, 0, 255, 255]);
    expect(px(d, 32, 54)).toEqual([255, 0, 0, 255]);
    const u = runTransition('wipe', red(), blue(), 0.5, { direction: 'up' });
    expect(px(u, 32, 54)).toEqual([0, 0, 255, 255]);
  });
  it('softness blends across the edge', () => {
    const out = runTransition('wipe', red(), blue(), 0.5, { direction: 'right', softness: 0.5 });
    const mid = px(out, 32, 32);
    expect(mid[0]).toBeGreaterThan(90); expect(mid[2]).toBeGreaterThan(90);
    expect(mid[3]).toBe(255);
    expect(px(out, 1, 32)[2]).toBeGreaterThan(200);
  });
});

describe('slide / push / zoom / blur / spin', () => {
  it('slide left: `to` enters from the right over a static `from`', () => {
    const out = runTransition('slide', blue(), halves(), 0.5, { direction: 'left' });
    expect(px(out, 10, 10)).toEqual([0, 0, 255, 255]);
    expect(px(out, 40, 10)).toEqual([255, 0, 0, 255]);
    expect(px(out, 60, 10)).toEqual([255, 0, 0, 255]);
    expect(px(runTransition('slide', blue(), halves(), 0.75, { direction: 'left' }), 60, 10)).toEqual([0, 255, 0, 255]);
  });
  it('push left: `from` leaves to the left as `to` enters', () => {
    const out = runTransition('push', halves(), blue(), 0.5, { direction: 'left' });
    expect(px(out, 10, 10)).toEqual([0, 255, 0, 255]);
    expect(px(out, 50, 10)).toEqual([0, 0, 255, 255]);
    const down = runTransition('push', halves(), blue(), 0.5, { direction: 'down' });
    expect(px(down, 10, 10)).toEqual([0, 0, 255, 255]);
    expect(px(down, 10, 50)).toEqual([255, 0, 0, 255]);
  });
  it('zoom magnifies the outgoing clip around the centre', () => {
    const out = runTransition('zoom', halves(), halves(), 0.5, { scale: 3 });
    expect(px(out, 20, 32)[0]).toBeGreaterThan(200);
    expect(px(out, 44, 32)[1]).toBeGreaterThan(200);
  });
  it('blur softens the cut and crossfades', () => {
    const mid = runTransition('blur', halves(), blue(), 0.5, { radius: 6 });
    const a = px(mid, 31, 32), b = px(mid, 33, 32);
    expect(Math.abs(a[0] - b[0])).toBeLessThan(80);
    expect(px(mid, 2, 32)[2]).toBeGreaterThan(100);
    expect(px(mid, 2, 32)[3]).toBe(255);
  });
  it('spin rotates `from` and grows `to`', () => {
    const q = runTransition('spin', halves(), blue(), 0.25, { turns: 0.5 });
    expect(diff(q, halves())).toBeGreaterThan(20);
    expect(transition('spin').params.parse({}).turns).toBe(1);
  });
});
