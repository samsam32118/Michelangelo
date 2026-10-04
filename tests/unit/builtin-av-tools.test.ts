/**
 * Built-ins added from the exploration reports: counter rounding/easing, timecode, waveform/spectrum, bars, countdown
 * leader, letterbox, legalize, the bars-and-tone / slate / countdown templates, and readable title/lower-third styles.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { registerFonts } from '../../src/render/text.js';
import { counterValue } from '../../src/builtin/effects/generators/counter.js';
import { formatTimecode, parseTimecode, timecodeText } from '../../src/builtin/effects/generators/timecode.js';
import { rmsAt, spectrumAt } from '../../src/builtin/effects/generators/audio.js';
import { matteBars } from '../../src/builtin/effects/fx/letterbox.js';
import { legalizePixel } from '../../src/builtin/effects/fx/legalize.js';
import { createSurface, generator, info, px, runEffect, runGenerator, solid, diff } from './effects-fixtures.js';
import { builtinRegistry } from '../../src/builtin/index.js';
import { makeContext, runStage, projectLayers, restFrames } from '../../src/qa/check.js';
import { makeProject } from './text-fixtures.js';
import type { AudioLevels, Surface } from '../../src/plugin/api.js';

beforeAll(() => { registerFonts(); });
const lit = (s: Surface) => { const d = s.pixels(); let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]! > 0) n++; return n; };

describe('counter rounding and easing', () => {
  const base = { from: 3, to: 1, duration: 90, decimals: 0, easing: 'linear', rounding: 'step' as const };
  it('step gives a 3-2-1 countdown equal holds (round gave 13/25/13 frames)', () => {
    const shown = Array.from({ length: 90 }, (_, f) => counterValue(base, f));
    expect(shown.filter((v) => v === 3).length).toBe(30);
    expect(shown.filter((v) => v === 2).length).toBe(30);
    expect(shown.filter((v) => v === 1).length).toBe(30);
    expect(counterValue(base, 200)).toBe(1);
    // counting up in tenths
    expect(counterValue({ ...base, from: 0, to: 1, decimals: 1, duration: 110 }, 55)).toBeCloseTo(0.5, 9);
  });
  it('floor / ceil / round', () => {
    const p = { ...base, from: 2, to: 0, duration: 61 };
    expect(counterValue({ ...p, rounding: 'ceil' }, 15)).toBe(2);
    expect(counterValue({ ...p, rounding: 'floor' }, 15)).toBe(1);
    expect(counterValue({ ...p, rounding: 'round' }, 15)).toBeCloseTo(1.5, 9);
    expect(counterValue({ ...p, rounding: 'ceil' }, 60)).toBe(0);
  });
  it('accepts the keyframe easing names and the old aliases', () => {
    const def = generator('counter');
    for (const e of ['outCubic', 'outBack', 'inOutQuad', 'linear', 'ease-out', 'ease-in-out']) expect(def.params.safeParse({ easing: e }).success, e).toBe(true);
    expect(def.params.safeParse({ easing: 'bouncy' }).success).toBe(false);
    const v = (easing: string, f: number) => counterValue({ from: 0, to: 100, duration: 31, decimals: 0, easing, rounding: 'round' }, f);
    expect(v('ease-out', 10)).toBeCloseTo(v('outCubic', 10), 9);
    expect(Math.max(...Array.from({ length: 31 }, (_, f) => v('outBack', f)))).toBeGreaterThan(100); // overshoots
    expect(def.params.parse({}).rounding).toBe('round');
  });
});

describe('timecode', () => {
  it('formats and parses SMPTE timecode (non-drop and drop-frame)', () => {
    expect(formatTimecode(0, 25)).toBe('00:00:00:00');
    expect(formatTimecode(25 * 3600 + 24, 25)).toBe('01:00:00:24');
    expect(parseTimecode('10:00:00:00', 25)).toBe(900000);
    expect(formatTimecode(1800, 30000 / 1001, true)).toBe('00:01:00;02');
    expect(formatTimecode(17982, 30000 / 1001, true)).toBe('00:10:00;00');
    for (const f of [0, 1799, 1800, 17981, 17982, 123456]) expect(parseTimecode(formatTimecode(f, 30000 / 1001, true), 30000 / 1001, true)).toBe(f);
  });
  it('shows start + clip frame in each format', () => {
    const p = { start: '10:00:00:00', format: 'smpte' as const, drop: false, prefix: 'TC ' };
    expect(timecodeText(p, 26, 25)).toBe('TC 10:00:01:01');
    expect(timecodeText({ ...p, format: 'clock', prefix: '' }, 25 * 61, 25)).toBe('10:01:01');
    expect(timecodeText({ ...p, start: '00:00:00:00', format: 'seconds', prefix: '' }, 45, 30)).toBe('1.50s');
    expect(timecodeText({ ...p, start: '00:00:01:00', format: 'frames', prefix: '' }, 5, 30)).toBe('35');
  });
  it('draws a box with changing text, sized from the font size', () => {
    const def = generator('timecode'), p = def.params.parse({ size: 40 });
    const [w, h] = def.size!(p as never, { width: 1920, height: 1080 });
    expect(w).toBeGreaterThan(200); expect(h).toBeGreaterThan(40);
    const a = runGenerator('timecode', w, h, p, 0), b = runGenerator('timecode', w, h, p, 7);
    expect(lit(a)).toBe(w * h); // the box
    expect(diff(a, b)).toBeGreaterThan(0.1);
    expect(def.params.safeParse({ start: '10:00' }).success).toBe(false);
  });
});

describe('waveform and spectrum', () => {
  const frames = 60, bands = 16;
  const levels = (frame: number): AudioLevels => {
    const rms = new Float32Array(frames), spectrum = new Float32Array(frames * bands);
    for (let f = 0; f < frames; f++) {
      rms[f] = f < 30 ? 0.05 : 0.9;
      for (let b = 0; b < bands; b++) spectrum[f * bands + b] = b < 4 ? 0.9 : 0.1;
    }
    return { rms, spectrum, bands, frame };
  };
  const draw = (type: string, params: Record<string, unknown>, audio?: AudioLevels, w = 200, h = 80) => {
    const def = generator(type), dst = createSurface(w, h);
    def.draw({ dst, params: def.params.parse(params) as never, ...(audio ? { audio } : {}), ...info(audio?.frame ?? 0) });
    return dst;
  };
  it('follows the asset named in params (audioSource) and requires it', () => {
    expect(generator('waveform').audioSource!({ asset: 'vo' } as never)).toBe('vo');
    expect(generator('spectrum').audioSource!({ asset: 'music' } as never)).toBe('music');
    expect(generator('waveform').params.safeParse({}).success).toBe(false);
    expect(generator('waveform').size!(generator('waveform').params.parse({ asset: 'a' }) as never, { width: 1000, height: 1000 })).toEqual([800, 150]);
  });
  it('rmsAt / spectrumAt average neighbouring frames and resample bands', () => {
    const a = levels(40);
    expect(rmsAt(a, 40, 0)).toBeCloseTo(0.9, 5);
    expect(rmsAt(a, 30, 1)).toBeCloseTo((0.05 + 0.9 + 0.9) / 3, 5);
    expect(rmsAt(a, 500, 0)).toBe(0);
    expect(rmsAt(undefined, 3, 2)).toBe(0);
    const s = spectrumAt(a, 40, 0, 32);
    expect(s.length).toBe(32);
    expect(s[0]).toBeCloseTo(0.9, 5); expect(s[31]).toBeCloseTo(0.1, 5);
  });
  it('loud sound draws taller bars than quiet sound, in every style; no sound draws a flat baseline', () => {
    for (const style of ['bars', 'mirror', 'line']) {
      const quiet = draw('waveform', { asset: 'a', style, window: 0.5, smoothing: 0 }, levels(5));
      const loud = draw('waveform', { asset: 'a', style, window: 0.5, smoothing: 0 }, levels(50));
      expect(lit(loud), style).toBeGreaterThan(lit(quiet) * (style === 'line' ? 0.5 : 3));
      if (style === 'line') expect(diff(loud, quiet)).toBeGreaterThan(0.5);
      expect(lit(draw('waveform', { asset: 'a', style }))).toBeGreaterThan(0);
    }
    // bars grow up from the bottom
    const b = draw('waveform', { asset: 'a', style: 'bars', window: 0.5, smoothing: 0, color: '#ff0000' }, levels(50));
    const rowLit = (y: number) => { let n = 0; for (let x = 0; x < 200; x++) if (px(b, x, y)[3] > 0) n++; return n; };
    expect(rowLit(79)).toBeGreaterThan(100);
    expect(rowLit(2)).toBe(0);
  });
  it('spectrum: low bands (left) are taller when the sound is bassy', () => {
    const s = draw('spectrum', { asset: 'a', bands: 8, smoothing: 0, gap: 0 }, levels(10));
    const colLit = (x: number) => { let n = 0; for (let y = 0; y < 80; y++) if (px(s, x, y)[3] > 0) n++; return n; };
    expect(colLit(10)).toBeGreaterThan(colLit(190) * 4);
  });
});

describe('smpte-bars and countdown-leader', () => {
  it('draws 75% SMPTE bars and EBU bars', () => {
    const s = runGenerator('smpte-bars', 140, 100, {});
    expect(px(s, 5, 10).slice(0, 3)).toEqual([191, 191, 191]);
    expect(px(s, 25, 10).slice(0, 3)).toEqual([191, 191, 0]);
    expect(px(s, 135, 10).slice(0, 3)).toEqual([0, 0, 191]);
    expect(px(s, 5, 70).slice(0, 3)).toEqual([0, 0, 191]); // castellation under grey
    const e = runGenerator('smpte-bars', 160, 90, { standard: 'ebu', level: 100 });
    expect(px(e, 5, 80).slice(0, 3)).toEqual([255, 255, 255]);
    expect(px(e, 155, 80).slice(0, 3)).toEqual([0, 0, 0]);
  });
  it('the leader shows a different number each second and nothing after the last', () => {
    const p = { from: 3 };
    const a = runGenerator('countdown-leader', 160, 90, p, 0), b = runGenerator('countdown-leader', 160, 90, p, 31), c = runGenerator('countdown-leader', 160, 90, p, 95);
    expect(diff(a, b)).toBeGreaterThan(1);
    expect(px(c, 80, 45).slice(0, 3)).toEqual([32, 32, 32]);
    expect(lit(c)).toBe(160 * 90);
  });
});

describe('letterbox', () => {
  it('computes letterbox and pillarbox bars', () => {
    expect(matteBars(1920, 1080, 2.39)).toEqual([[0, 0, 1920, 138], [0, 942, 1920, 138]]);
    expect(matteBars(1920, 1080, 4 / 3)).toEqual([[0, 0, 240, 1080], [1680, 0, 240, 1080]]);
    expect(matteBars(1920, 1080, 16 / 9)).toEqual([]);
  });
  it('mattes the layer (or the comp below on an adjustment layer) in the chosen colour', () => {
    const out = runEffect('letterbox', solid(192, 108, '#ffffff'), { ratio: 2.39, color: '#ff0000' });
    expect(px(out, 96, 2)).toEqual([255, 0, 0, 255]);
    expect(px(out, 96, 105)).toEqual([255, 0, 0, 255]);
    expect(px(out, 96, 54)).toEqual([255, 255, 255, 255]);
  });
});

describe('legalize', () => {
  const base = { mode: 'clamp' as const, range: 'pc' as const, black: 16, white: 235, chroma: 240 };
  it('clamps full-range black/white to legal luma for a pc-range delivery and leaves mid grey alone', () => {
    expect(legalizePixel(255, 255, 255, base)).toEqual([235, 235, 235]);
    expect(legalizePixel(0, 0, 0, base)).toEqual([16, 16, 16]);
    expect(legalizePixel(128, 128, 128, base)).toEqual([128, 128, 128]);
  });
  it('limit compresses the whole range (mid tones move too), clamp only clips', () => {
    const l = legalizePixel(200, 200, 200, { ...base, mode: 'limit' });
    expect(l[0]).toBeLessThan(200); expect(l[0]).toBeGreaterThan(180);
    expect(legalizePixel(200, 200, 200, base)).toEqual([200, 200, 200]);
  });
  it('tv range: in-range pixels unchanged by default, a safety margin pulls the extremes in', () => {
    expect(legalizePixel(255, 255, 255, { ...base, range: 'tv' })).toEqual([255, 255, 255]);
    const w = legalizePixel(255, 255, 255, { ...base, range: 'tv', white: 225 });
    expect(16 + (219 * w[0]) / 255).toBeLessThanOrEqual(225.6);
  });
  it('limits saturated chroma', () => {
    const [r, g, b] = legalizePixel(0, 0, 255, { ...base, chroma: 200 });
    expect(b).toBeLessThan(255); expect(r + g).toBeGreaterThan(0);
  });
  it('runs as a layer effect and keeps alpha', () => {
    const out = runEffect('legalize', solid(8, 8, 'rgba(255,255,255,0.5)'), { range: 'pc' });
    const p = px(out, 4, 4);
    expect(p[3]).toBeGreaterThan(120); expect(p[3]).toBeLessThan(135);
    expect(p[0]).toBeLessThanOrEqual(236);
  });
});

describe('leader templates', () => {
  it('bars-and-tone: full-frame bars generator, optional ident, says the tone is separate', async () => {
    const { project, edit } = makeProject({ size: [1920, 1080], fps: 25 });
    const r = await edit({ op: 'template.apply', template: 'bars-and-tone', at: 0, params: { ident: 'My Show' } });
    expect(project.clip('bars-and-tone-bars')!.gen).toMatchObject({ type: 'smpte-bars', standard: 'smpte', level: 75 });
    expect(project.clip('bars-and-tone-bars')!.len).toBe(250);
    expect(project.clip('bars-and-tone-ident')!.text).toBe('My Show');
    expect(JSON.stringify(r.out)).toMatch(/tone/);
  });
  it('slate: title plus only the given detail lines', async () => {
    const { project, edit } = makeProject({ size: [1920, 1080] });
    await edit({ op: 'template.apply', template: 'slate', at: 0, params: { title: 'Demo', version: 'v3', duration: '00:01:30' } });
    expect(project.clip('slate-title')!.text).toBe('Demo');
    expect(project.clip('slate-details')!.text).toBe('Version: v3\nDuration: 00:01:30');
  });
  it('countdown: one leader clip `from` seconds long', async () => {
    const { project, edit } = makeProject({ size: [1920, 1080], fps: 24 });
    await edit({ op: 'template.apply', template: 'countdown', at: 0, params: { from: 3 } });
    const c = project.clip('countdown-leader')!;
    expect(c.len).toBe(72);
    expect(c.gen).toMatchObject({ type: 'countdown-leader', from: 3 });
  });
});

describe('title and lower-third styles are readable on every aspect', () => {
  const registry = builtinRegistry();
  const SIZES: [number, number][] = [[1080, 1920], [720, 1280], [1920, 1080], [1080, 1080], [3840, 2160], [1280, 720]];
  for (const size of SIZES) for (const style of ['title', 'lower-third']) {
    it(`${style} at ${size.join('x')}: no tiny-text or text-outside-safe`, async () => {
      for (const text of ['Hello', 'Three tips to focus better every single day']) {
        const { project, edit, dir } = makeProject({ size });
        await edit({ op: 'clip.add', text, id: 't', track: 'T1', at: 0, len: '3s', style });
        const p = project.data;
        const layers = await projectLayers(p, 'main', restFrames(p, 'main'), { baseDir: dir, registry });
        const f = await runStage(registry, 'project', makeContext(p, 'main', size[1] > size[0] ? 'shorts' : 'none', { layers }));
        expect(f.filter((x) => x.clip === 't' && /tiny-text|text-outside-safe/.test(x.rule)), text).toEqual([]);
      }
    });
  }
});
