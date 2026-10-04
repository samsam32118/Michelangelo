/** Built-in audio effects (highpass, eq, dehum, compressor, voice, ...): params, filter chains, allowlist, and real ffmpeg renders. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { ProjectFile } from '../../src/core/schema/index.js';
import { builtinRegistry } from '../../src/builtin/index.js';
import { planAudio } from '../../src/media/audio-plan.js';
import { renderAudio } from '../../src/media/audio-render.js';
import { filtersToString } from '../../src/media/filters.js';
import { effect } from './effects-fixtures.js';
import { ff, tempDir } from './media-fixtures.js';

const AUDIO = ['highpass', 'lowpass', 'eq', 'dehum', 'denoise-audio', 'compressor', 'limiter', 'gate', 'deesser', 'voice', 'reverb'];
const chain = (type: string, params: Record<string, unknown> = {}) => { const d = effect(type); return d.audio!(d.params.parse(params) as never); };

describe('audio effect definitions', () => {
  it('every audio effect is audio-stage only, has defaults, and its filters pass the audio allowlist', () => {
    const reg = builtinRegistry();
    for (const t of AUDIO) {
      const d = effect(t);
      expect(d.audio, t).toBeTypeOf('function');
      expect(d.draw ?? d.source, `${t} has no picture stage`).toBeUndefined();
      expect(d.describe).toMatch(/^Audio: /);
      expect(() => filtersToString(chain(t), { stage: 'audio' }), t).not.toThrow();
      expect(reg.effects.get(t), t).toBeDefined();
    }
    // the video denoise is unchanged; the audio one has its own name
    expect(effect('denoise').source).toBeTypeOf('function');
    expect(effect('denoise').audio).toBeUndefined();
  });

  it('builds the expected filter chains', () => {
    expect(chain('highpass')).toEqual([{ filter: 'highpass', args: { f: 80, p: 2 } }]);
    expect(chain('lowpass', { freq: 3000 })).toEqual([{ filter: 'lowpass', args: { f: 3000, p: 2 } }]);
    expect(chain('eq')).toEqual([]);
    expect(chain('eq', { low: -3, high: 2, bands: [{ freq: 3000, gain: 2.5, q: 1.5 }, { freq: 500, gain: 0 }] })).toEqual([
      { filter: 'lowshelf', args: { f: 120, g: -3 } },
      { filter: 'equalizer', args: { f: 3000, t: 'q', w: 1.5, g: 2.5 } },
      { filter: 'highshelf', args: { f: 8000, g: 2 } },
    ]);
    expect(chain('dehum', { freq: 60, harmonics: 3 }).map((f) => f.args!.f)).toEqual([60, 120, 180]);
    expect(chain('dehum').every((f) => f.filter === 'bandreject')).toBe(true);
    expect(chain('denoise-audio', { amount: 0 })).toEqual([]);
    expect(chain('denoise-audio', { amount: 0.5 })).toEqual([{ filter: 'afftdn', args: { nr: 18, nf: -50, tn: true } }]);
    const comp = chain('compressor', { threshold: -20, makeup: 6 })[0]!;
    expect(comp.filter).toBe('acompressor');
    expect(comp.args!.threshold).toBeCloseTo(0.1, 4);
    expect(comp.args!.makeup).toBeCloseTo(1.99526, 4);
    expect(chain('limiter', { ceiling: -6 })[0]).toMatchObject({ filter: 'alimiter', args: { level: false } });
    expect(chain('limiter', { ceiling: -6 })[0]!.args!.limit).toBeCloseTo(0.501187, 5);
    expect(chain('voice').map((f) => f.filter)).toEqual(['highpass', 'acompressor', 'deesser']);
    expect(chain('voice', { compress: 0, deess: 0 }).map((f) => f.filter)).toEqual(['highpass']);
    expect(chain('reverb')[0]!.args!.delays).toMatch(/^\d+\|\d+\|\d+\|\d+$/);
  });

  it('validates ranges with clear errors', () => {
    expect(effect('dehum').params.safeParse({ freq: 55 }).success).toBe(false);
    expect(effect('highpass').params.safeParse({ freq: 5 }).success).toBe(false);
    expect(effect('limiter').params.safeParse({ ceiling: 3 }).success).toBe(false);
    expect(effect('eq').params.safeParse({ bands: [{ freq: 100 }] }).success).toBe(false);
  });
});

let dir: string, cleanup: () => void;
beforeAll(() => {
  ({ dir, cleanup } = tempDir('mgl-builtin-afx-'));
  ff(['-f', 'lavfi', '-i', 'sine=f=40:r=48000:d=1', join(dir, 'rumble.wav')]);
  ff(['-f', 'lavfi', '-i', 'sine=f=8000:r=48000:d=1', join(dir, 'hiss.wav')]);
  ff(['-f', 'lavfi', '-i', 'sine=f=50:r=48000:d=3', join(dir, 'hum.wav')]);
  ff(['-f', 'lavfi', '-i', 'sine=f=1000:r=48000:d=1', '-af', 'volume=7', join(dir, 'loud.wav')]);
});
afterAll(() => cleanup());

function project(asset: string, fx: object[]): ProjectFile {
  return {
    michelangelo: 1,
    assets: [{ id: 'a', src: asset }],
    comps: [{ id: 'main', size: [64, 64], fps: 30 }],
    tracks: [{ id: 'A1', comp: 'main', audio: true }],
    clips: [{ id: 's', track: 'A1', at: 0, len: 30, asset: 'a', fx }],
  } as ProjectFile;
}

function stat(file: string): { rms: number; peak: number } {
  const out = execFileSync('sh', ['-c', `ffmpeg -hide_banner -nostdin -i '${file}' -af astats -f null - 2>&1`]).toString();
  const sect = out.slice(out.lastIndexOf('Overall'));
  const num = (re: RegExp) => { const m = re.exec(sect)?.[1]; return m === undefined ? NaN : m === '-inf' ? -Infinity : Number(m); };
  return { rms: num(/RMS level dB:\s*(-?[\d.]+|-inf)/), peak: num(/Peak level dB:\s*(-?[\d.]+|-inf)/) };
}

async function rendered(asset: string, fx: object[], name: string) {
  const out = join(dir, name);
  await renderAudio(planAudio(project(asset, fx), 'main', { baseDir: dir, registry: builtinRegistry() }), out, { baseDir: dir });
  return stat(out);
}

describe('audio effects change the rendered sound (they were silent no-ops before)', () => {
  it('highpass removes rumble, lowpass removes hiss, dehum notches 50 Hz', async () => {
    const r0 = await rendered('rumble.wav', [], 'r0.wav'), r1 = await rendered('rumble.wav', [{ type: 'highpass', freq: 200 }], 'r1.wav');
    expect(r1.rms).toBeLessThan(r0.rms - 15);
    const h0 = await rendered('hiss.wav', [], 'h0.wav'), h1 = await rendered('hiss.wav', [{ type: 'lowpass', freq: 1000 }], 'h1.wav');
    expect(h1.rms).toBeLessThan(h0.rms - 15);
    const m0 = await rendered('hum.wav', [], 'm0.wav'), m1 = await rendered('hum.wav', [{ type: 'dehum', freq: 50 }], 'm1.wav');
    expect(m1.rms).toBeLessThan(m0.rms - 12);
  });

  it('limiter keeps peaks under the ceiling, voice preset and eq render', async () => {
    const l0 = await rendered('loud.wav', [], 'l0.wav'), l = await rendered('loud.wav', [{ type: 'limiter', ceiling: -6 }], 'l.wav');
    expect(l0.peak).toBeGreaterThan(-2);
    expect(l.peak).toBeLessThan(-5.5);
    expect(l.peak).toBeGreaterThan(-7); // the level is not raised or lowered beyond the ceiling (level=0)
    const e0 = await rendered('hiss.wav', [], 'e0.wav'), e1 = await rendered('hiss.wav', [{ type: 'eq', high: -12, highFreq: 4000 }], 'e1.wav');
    expect(e1.rms).toBeLessThan(e0.rms - 8);
    const v = await rendered('loud.wav', [{ type: 'voice' }, { type: 'reverb' }, { type: 'gate' }, { type: 'denoise-audio' }], 'v.wav');
    expect(v.rms).toBeGreaterThan(l0.rms - 20);
    expect(v.rms).toBeLessThan(0);
  });
});
