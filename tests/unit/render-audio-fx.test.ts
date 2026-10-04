/** Audio-stage effects (plugin API 1.1), stems and audio delivery settings: planAudio → renderAudio → render. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { ProjectFile } from '../../src/core/schema/index.js';
import { builtinRegistry } from '../../src/builtin/index.js';
import { defineEffect, definePlugin, z } from '../../src/plugin/api.js';
import { planAudio } from '../../src/media/audio-plan.js';
import { buildMixGraph, renderAudio, stemBuses } from '../../src/media/audio-render.js';
import { filterToString } from '../../src/media/filters.js';
import { render } from '../../src/render/pipeline.js';
import { ff, ffprobeJson, tempDir } from './media-fixtures.js';

let dir: string, cleanup: () => void;
beforeAll(() => {
  ({ dir, cleanup } = tempDir('mgl-audiofx-'));
  ff(['-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=2', join(dir, 'low.wav')]);
  ff(['-f', 'lavfi', '-i', 'sine=f=6000:r=48000:d=2', join(dir, 'high.wav')]);
  ff(['-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=30:d=2', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=2', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(dir, 'v.mp4')]);
});
afterAll(() => cleanup());

const registry = () => builtinRegistry().add(definePlugin({
  name: 'audio-test',
  effects: [
    defineEffect({ type: 'quieter', describe: 'audio gain', params: z.object({ db: z.number().default(-20) }), audio: (p) => [{ filter: 'volume', args: { volume: `${p.db}dB` } }] }),
    defineEffect({ type: 'muffle', describe: 'lowpass', params: z.object({ hz: z.number().default(800) }), audio: (p) => [{ filter: 'lowpass', args: { f: p.hz } }] }),
    defineEffect({ type: 'monoize', describe: 'pan to mono', params: z.object({}), audio: () => [{ filter: 'pan', args: { args: 'mono|c0=c0' } }] }),
    defineEffect({ type: 'badaudio', describe: 'video filter in audio()', params: z.object({}), audio: () => [{ filter: 'hue', args: { s: 0 } }] }),
    defineEffect({ type: 'srconly', describe: 'source only', params: z.object({}), source: () => [{ filter: 'hue', args: { s: 0 } }] }),
  ],
}), 'test');

function project(clips: object[], buses?: object[]): ProjectFile {
  return {
    michelangelo: 1,
    assets: [{ id: 'low', src: 'low.wav' }, { id: 'high', src: 'high.wav' }, { id: 'v', src: 'v.mp4' }],
    comps: [{ id: 'main', size: [64, 64], fps: 30 }],
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'A1', comp: 'main', audio: true, bus: 'dialogue' }, { id: 'A2', comp: 'main', audio: true, bus: 'music' }],
    clips,
    ...(buses ? { buses } : {}),
  } as ProjectFile;
}

/** Overall RMS and peak dBFS of an audio file (ffmpeg astats). */
function stat(file: string): { rms: number; peak: number } {
  const out = execFileSync('sh', ['-c', `ffmpeg -hide_banner -nostdin -i '${file}' -af astats -f null - 2>&1`]).toString();
  const sect = out.slice(out.lastIndexOf('Overall'));
  const num = (re: RegExp) => { const m = re.exec(sect)?.[1]; return m === undefined ? NaN : m === '-inf' ? -Infinity : Number(m); };
  return { rms: num(/RMS level dB:\s*(-?[\d.]+|-inf)/), peak: num(/Peak level dB:\s*(-?[\d.]+|-inf)/) };
}

describe('audio-stage effects in planAudio', () => {
  it('fills segment.filters from clip fx with an audio stage, and bus filters from Bus.fx', () => {
    const p = project([{ id: 'vo', track: 'A1', at: 0, len: 30, asset: 'low', fx: [{ type: 'quieter', db: -12 }, { type: 'muffle' }] }], [{ id: 'music', fx: [{ type: 'muffle', hz: 2000 }] }]);
    const plan = planAudio(p, 'main', { baseDir: dir, registry: registry() });
    expect(plan.segments[0]!.filters).toEqual([{ filter: 'volume', args: { volume: '-12dB' } }, { filter: 'lowpass', args: { f: 800 } }]);
    expect(plan.buses.find((b) => b.id === 'music')!.filters).toEqual([{ filter: 'lowpass', args: { f: 2000 } }]);
    // without a registry nothing changes (pure planning stays registry-free)
    expect(planAudio(p, 'main', { baseDir: dir }).segments[0]!.filters).toBeUndefined();
  });

  it('a source-only (or layer-only) effect on an audio clip is E_FX_STAGE with a fix, not a silent no-op', () => {
    for (const type of ['srconly', 'blur']) {
      const p = project([{ id: 'vo', track: 'A1', at: 0, len: 30, asset: 'low', fx: [{ type }] }]);
      expect(() => planAudio(p, 'main', { baseDir: dir, registry: registry() })).toThrowError(expect.objectContaining({ code: 'E_FX_STAGE', fix: expect.stringContaining('fx.remove vo fx=0') }));
    }
    // on a video clip the same effect works on the picture: no error
    const pv = project([{ id: 'cam', track: 'V1', at: 0, len: 30, asset: 'v', fx: [{ type: 'srconly' }] }]);
    expect(planAudio(pv, 'main', { baseDir: dir, registry: registry() }).segments[0]!.filters).toBeUndefined();
    // on a bus too
    const pb = project([{ id: 'vo', track: 'A1', at: 0, len: 30, asset: 'low' }], [{ id: 'dialogue', fx: [{ type: 'blur' }] }]);
    expect(() => planAudio(pb, 'main', { baseDir: dir, registry: registry() })).toThrowError(expect.objectContaining({ code: 'E_FX_STAGE' }));
  });

  it('unknown audio effects and bad params fail with fixes', () => {
    const p = project([{ id: 'vo', track: 'A1', at: 0, len: 30, asset: 'low', fx: [{ type: 'quietr' }] }]);
    expect(() => planAudio(p, 'main', { baseDir: dir, registry: registry() })).toThrowError(expect.objectContaining({ code: 'E_UNKNOWN_EFFECT', fix: expect.stringContaining('quieter') }));
    const q = project([{ id: 'vo', track: 'A1', at: 0, len: 30, asset: 'low', fx: [{ type: 'quieter', db: 'loud' }] }]);
    expect(() => planAudio(q, 'main', { baseDir: dir, registry: registry() })).toThrowError(expect.objectContaining({ code: 'E_PARAMS' }));
  });
});

describe('audio filter allowlist', () => {
  it('allows audio filters in the audio stage only, and refuses file/command filters', () => {
    expect(filterToString({ filter: 'highpass', args: { f: 80 } }, { stage: 'audio' })).toBe('highpass=f=80');
    expect(filterToString({ filter: 'pan', args: { args: 'mono|c0=c0' } }, { stage: 'audio' })).toBe('pan=args=mono|c0=c0');
    expect(() => filterToString({ filter: 'amovie', args: { filename: '/etc/passwd' } }, { stage: 'audio' })).toThrowError(expect.objectContaining({ code: 'E_FILTER' }));
    expect(() => filterToString({ filter: 'ladspa', args: { file: 'x.so' } }, { stage: 'audio' })).toThrowError(expect.objectContaining({ code: 'E_FILTER' }));
    expect(() => filterToString({ filter: 'hue' }, { stage: 'audio' })).toThrowError(expect.objectContaining({ code: 'E_FILTER', fix: expect.stringContaining('source()') }));
    expect(() => filterToString({ filter: 'lowpass' })).toThrowError(expect.objectContaining({ code: 'E_FILTER', fix: expect.stringContaining('audio()') }));
  });
});

describe('renderAudio applies audio-stage filters', () => {
  it('per segment (gain, lowpass, a mono pan back to stereo) and per bus', async () => {
    const reg = registry();
    const base = project([{ id: 'm', track: 'A2', at: 0, len: 60, asset: 'high' }]);
    const plain = join(dir, 'plain.wav');
    await renderAudio(planAudio(base, 'main', { baseDir: dir, registry: reg }), plain, { baseDir: dir });
    const muffled = join(dir, 'muffled.wav');
    await renderAudio(planAudio(project([{ id: 'm', track: 'A2', at: 0, len: 60, asset: 'high', fx: [{ type: 'muffle', hz: 500 }, { type: 'monoize' }] }]), 'main', { baseDir: dir, registry: reg }), muffled, { baseDir: dir });
    const busfx = join(dir, 'busfx.wav');
    await renderAudio(planAudio(project([{ id: 'm', track: 'A2', at: 0, len: 60, asset: 'high' }], [{ id: 'music', fx: [{ type: 'quieter', db: -20 }] }]), 'main', { baseDir: dir, registry: reg }), busfx, { baseDir: dir });
    const a = stat(plain), b = stat(muffled), c = stat(busfx);
    expect(b.rms).toBeLessThan(a.rms - 20); // a 6 kHz tone through a 500 Hz lowpass
    expect(c.rms).toBeCloseTo(a.rms - 20, 0);
    const s = ffprobeJson(muffled).streams[0]!;
    expect([s.channels, Number(s.sample_rate), Number(s.duration_ts)]).toEqual([2, 48000, 96000]);
  });

  it('render() refuses a video filter returned by audio() before drawing any frame', async () => {
    const p = project([{ id: 'cam', track: 'V1', at: 0, len: 30, asset: 'v', fx: [{ type: 'badaudio' }] }]);
    await expect(render(p, join(dir, 'bad.mp4'), { baseDir: dir, registry: registry() })).rejects.toMatchObject({ code: 'E_FILTER' });
  });

  it('render() of a sound-only clip with a source-only effect is E_FX_STAGE', async () => {
    const p = project([{ id: 'vo', track: 'A1', at: 0, len: 30, asset: 'low', fx: [{ type: 'srconly' }] }]);
    await expect(render(p, join(dir, 'bad.wav'), { baseDir: dir, registry: registry() })).rejects.toMatchObject({ code: 'E_FX_STAGE' });
  });
});

describe('stems', () => {
  const mix = () => project([
    { id: 'vo', track: 'A1', at: 0, len: 60, asset: 'low' },
    { id: 'm', track: 'A2', at: 0, len: 60, asset: 'high', gain: -6 },
  ], [{ id: 'master', loudness: { lufs: -16, peak: -1 } }]);

  it('soloes one bus (others muted) in the graph, keeping every bus built', async () => {
    const plan = planAudio(mix(), 'main', { baseDir: dir });
    const g = await buildMixGraph(plan, { solo: 'music' } as never);
    expect(g.script).toMatch(/bus_dialogue_mix\]anullsink|anullsink/);
    expect(stemBuses(plan)).toEqual(['dialogue', 'music']);
    await expect(buildMixGraph(plan, { solo: 'nope' } as never)).rejects.toMatchObject({ code: 'E_REF' });
  });

  it('a stem gets the full mix loudness gain (not its own normalisation) so stems sum to the mix; "all" writes one pair per bus', async () => {
    const reg = registry();
    const full = join(dir, 'full.wav'), voStem = join(dir, 'vo.wav'), mStem = join(dir, 'm.wav'), all = join(dir, 'all.wav');
    const r0 = await render(mix(), full, { baseDir: dir, registry: reg });
    const r1 = await render(mix(), voStem, { baseDir: dir, registry: reg, bus: 'dialogue' });
    await render(mix(), mStem, { baseDir: dir, registry: reg, bus: 'music' });
    const r3 = await render(mix(), all, { baseDir: dir, registry: reg, bus: 'all', pcmDepth: 24 });
    expect(r0.notes.join(' ')).not.toMatch(/stem/);
    expect(r1.notes.join(' ')).toMatch(/not loudness-normalised on its own: the full mix's master gain/);
    // sum of stems vs mix: the difference is far below the signal
    const diff = execFileSync('sh', ['-c', `ffmpeg -hide_banner -nostdin -i '${voStem}' -i '${mStem}' -i '${full}' -filter_complex '[0:a][1:a]amix=inputs=2:normalize=0[s];[2:a]volume=-1[n];[s][n]amix=inputs=2:normalize=0,astats' -f null - 2>&1`]).toString();
    const resid = Number(/RMS level dB:\s*(-?[\d.]+|-inf)/.exec(diff.slice(diff.lastIndexOf('Overall')))?.[1] ?? '-inf');
    expect(resid === -Infinity || resid < stat(full).rms - 40).toBe(true);
    const s = ffprobeJson(all).streams[0]!;
    expect([s.channels, s.codec_name]).toEqual([4, 'pcm_s24le']);
    expect(r3.notes.join(' ')).toMatch(/4 channels: 1-2 dialogue, 3-4 music/);
  });

  it('a stem of a bus with no sound (embedded audio on a track sending to master) is silence with a note, not an ffmpeg error', async () => {
    const p = project([{ id: 'vid', track: 'V1', at: 0, len: 60, asset: 'v' }]);
    const plan = planAudio(p, 'main', { baseDir: dir });
    const g = await buildMixGraph(plan, { solo: 'dialogue' } as never);
    expect(g.script).toMatch(/\[lane0\]anullsink/);
    const out = join(dir, 'empty-stem.wav'), all = join(dir, 'empty-all.wav');
    const r = await render(p, out, { baseDir: dir, bus: 'dialogue' });
    expect(r.notes.join(' ')).toMatch(/bus dialogue has no sound/);
    expect(stat(out).rms).toBe(-Infinity);
    const r2 = await render(p, all, { baseDir: dir, bus: 'all' });
    expect(ffprobeJson(all).streams[0]!.channels).toBe(6);
    expect(r2.notes.join(' ')).toMatch(/master \(tracks sent straight to master\)/);
  });

  it('bus applies to audio outputs only', async () => {
    await expect(render(mix(), join(dir, 'x.mp4'), { baseDir: dir, bus: 'music' })).rejects.toMatchObject({ code: 'E_ARG' });
    await expect(render(mix(), join(dir, 'x.mp3'), { baseDir: dir, bus: 'all' })).rejects.toMatchObject({ code: 'E_ARG' });
  });
});
