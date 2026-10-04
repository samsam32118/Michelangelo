// @vitest-environment node
/** Built-in motion presets: valid keys for every length, rest restored, loops seamless, small default moves. */
import { describe, it, expect } from 'vitest';
import { motionPresets, mirror, reverseEase } from '../../src/builtin/motion/index.js';
import { builtinRegistry } from '../../src/builtin/index.js';
import { EASINGS } from '../../src/core/schema/index.js';
import type { MotionPresetDef } from '../../src/plugin/api.js';

const comp = { width: 1080, height: 1920 };
const REST: Record<string, number> = { x: 0, y: 0, rotate: 0, scale: 1, opacity: 1 };
const keysOf = (p: MotionPresetDef, len: number, params: Record<string, unknown> = {}) =>
  p.keys({ len, fps: 30, seed: 7, params: p.params ? (p.params.parse(params) as Record<string, unknown>) : params, size: { w: 600, h: 200 }, comp });
const SUSTAINED = new Set(['ken-burns-in', 'ken-burns-out']);

describe('built-in motion presets', () => {
  it('ship ~30+ presets across all four phases, with unique ids, registered in the built-in registry', () => {
    expect(motionPresets.length).toBeGreaterThanOrEqual(30);
    expect(new Set(motionPresets.map((p) => p.id)).size).toBe(motionPresets.length);
    for (const ph of ['in', 'out', 'emphasis', 'loop']) expect(motionPresets.filter((p) => p.phase === ph).length, ph).toBeGreaterThanOrEqual(7);
    const reg = builtinRegistry();
    for (const p of motionPresets) expect(reg.motionPresets.get(p.id)).toBe(p);
    for (const id of ['fade-in', 'pop-in', 'slide-up-in', 'whip-in', 'drop-out', 'pulse', 'shake', 'wiggle', 'punch', 'flash', 'float', 'breathe', 'sway', 'spin', 'drift', 'ken-burns-in']) expect(reg.motionPresets.has(id), id).toBe(true);
  });

  for (const p of motionPresets) {
    it(`${p.id} (${p.phase}): integer rising keys from 0 to len, valid easings, rest kept`, () => {
      expect(p.describe.length).toBeGreaterThan(10);
      if (p.params) expect(p.params.safeParse({}).success).toBe(true);
      for (const len of [1, 2, 5, 12, 45, 180]) {
        const out = keysOf(p, len);
        const props = Object.keys(out);
        expect(props.length).toBeGreaterThan(0);
        for (const [prop, ks] of Object.entries(out)) {
          expect(Object.keys(REST)).toContain(prop);
          expect(ks![0]![0], `${prop} starts at 0`).toBe(0);
          expect(ks![ks!.length - 1]![0], `${prop} ends at len`).toBe(len);
          for (let i = 0; i < ks!.length; i++) {
            const [f, v, e] = ks![i]!;
            expect(Number.isInteger(f)).toBe(true);
            if (i) expect(f).toBeGreaterThan(ks![i - 1]![0]);
            expect(Number.isFinite(v)).toBe(true);
            if (e !== undefined) expect(EASINGS as readonly string[]).toContain(e);
            if (prop === 'opacity') { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
            if (prop === 'scale') expect(v).toBeGreaterThan(0);
          }
          const first = ks![0]![1], last = ks![ks!.length - 1]![1];
          if (p.phase === 'in') expect(last, `${prop} ends at rest`).toBe(REST[prop]);
          if (p.phase === 'out') expect(first, `${prop} starts at rest`).toBe(REST[prop]);
          if (p.phase === 'emphasis') { expect(first).toBe(REST[prop]); expect(last).toBe(REST[prop]); }
          if (p.phase === 'loop' && !SUSTAINED.has(p.id)) {
            expect(first, `${prop} loop starts at rest`).toBe(REST[prop]);
            if (prop === 'rotate') expect(Math.abs((last - first) % 360)).toBe(0); else expect(last, `${prop} loop is seamless`).toBe(first);
          }
        }
        // pure: same inputs, same keys
        expect(keysOf(p, len)).toEqual(out);
      }
    });
  }

  it('default moves stay small (inside the frame); offscreen=true slides start fully outside it', () => {
    const short = Math.min(comp.width, comp.height);
    for (const p of motionPresets) {
      if (p.id.startsWith('whip')) continue; // whips are off-frame by design
      for (const [prop, ks] of Object.entries(keysOf(p, 30))) {
        if (prop !== 'x' && prop !== 'y') continue;
        for (const [, v] of ks!) expect(Math.abs(v), `${p.id} ${prop}`).toBeLessThanOrEqual(short * 0.2 + 1);
      }
    }
    const up = motionPresets.find((p) => p.id === 'slide-up-in')!;
    expect(keysOf(up, 15, { offscreen: true }).y![0]![1]).toBeGreaterThanOrEqual(comp.height);
    expect(keysOf(up, 15, { offscreen: true }).opacity).toBeUndefined();
    expect(keysOf(up, 15, { distance: 300 }).y![0]![1]).toBe(300);
    const left = motionPresets.find((p) => p.id === 'slide-left-out')!;
    // an out slide moving left ends to the left of rest
    expect(keysOf(left, 15).x!.at(-1)![1]).toBeLessThan(0);
    const whip = motionPresets.find((p) => p.id === 'whip-in')!;
    expect(keysOf(whip, 12).x![0]![1]).toBeGreaterThanOrEqual(comp.width);
    expect(keysOf(whip, 12, { direction: 'right' }).x![0]![1]).toBeLessThanOrEqual(-comp.width);
    expect(keysOf(motionPresets.find((p) => p.id === 'whip-out')!, 12).x!.at(-1)![1]).toBeLessThanOrEqual(-comp.width);
  });

  it('amount scales the strength', () => {
    const pulse = motionPresets.find((p) => p.id === 'pulse')!;
    const peak = (a: number) => Math.max(...keysOf(pulse, 15, { amount: a }).scale!.map((k) => k[1]));
    expect(peak(2) - 1).toBeCloseTo(2 * (peak(1) - 1), 4);
  });

  it('mirror plays keys backwards with reversed easings', () => {
    expect(reverseEase('outBack')).toBe('inBack');
    expect(reverseEase('inCubic')).toBe('outCubic');
    expect(reverseEase('inOutSine')).toBe('inOutSine');
    expect(mirror({ opacity: [[0, 0, 'outQuad'], [6, 1, 'linear'], [10, 1]] }, 10)).toEqual({ opacity: [[0, 1, 'linear'], [4, 1, 'inQuad'], [10, 0]] });
  });
});
