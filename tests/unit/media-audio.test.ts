import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { planAudio, sampleOf } from '../../src/media/audio-plan.js';
import { renderAudio, duckParams, atempoChain, volumeFilter } from '../../src/media/audio-render.js';
import { analyzeAudio, rmsWindows } from '../../src/media/analysis.js';
import type { ProjectFile, Clip } from '../../src/core/schema/index.js';
import { ff, ffprobeJson, tempDir } from './media-fixtures.js';

const t = tempDir();
const f = (n: string) => join(t.dir, n);
afterAll(() => t.cleanup());

const NTSC = { num: 30000, den: 1001 };

function project(clips: Partial<Clip>[], extra: Partial<ProjectFile> = {}): ProjectFile {
  return {
    michelangelo: 1,
    assets: [{ id: 'dc', src: 'dc.wav' }, { id: 'vid', src: 'v.mp4' }, { id: 'tone', src: 'tone.wav' }, { id: 'img', src: 'logo.png' }],
    comps: [{ id: 'main', size: [64, 64], fps: 30 }],
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'A1', comp: 'main', audio: true, bus: 'dialogue' }, { id: 'A2', comp: 'main', audio: true, bus: 'music' }],
    clips: clips.map((c, i) => ({ id: `c${i}`, track: 'A1', at: 0, len: 30, asset: 'dc', ...c })) as Clip[],
    ...extra,
  };
}

/** Decode a WAV's 16-bit samples (first channel). */
function pcm(file: string): Int16Array {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 's16le', '-ac', '1', '-af', 'pan=mono|c0=c0', '-'], { maxBuffer: 1 << 30 });
  return new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength >> 1);
}

describe('planAudio', () => {
  it('1000 back-to-back 1-frame clips at 30000/1001 tile the timeline exactly', () => {
    const p = project(Array.from({ length: 1000 }, (_, i) => ({ at: i, len: 1, in: i })), { comps: [{ id: 'main', size: [64, 64], fps: '30000/1001' }] });
    const plan = planAudio(p, 'main', { baseDir: t.dir });
    expect(plan.segments).toHaveLength(1000);
    for (let i = 0; i < 1000; i++) {
      const s = plan.segments[i]!;
      expect(s.start).toBe(i === 0 ? 0 : plan.segments[i - 1]!.end);
      expect(s.end).toBe(Math.floor(((i + 1) * 48000 * 1001) / 30000));
    }
    expect(plan.length).toBe(sampleOf(1000, NTSC));
    expect(plan.segments.reduce((a, s) => a + s.end - s.start, 0)).toBe(plan.length);
  });

  it('routes buses, skips muted clips/tracks, images and silent video; honours range', () => {
    const p = project([
      { id: 'v', track: 'V1', asset: 'vid', at: 0, len: 60 },
      { id: 'logo', track: 'V1', asset: 'img', at: 60, len: 30 },
      { id: 'vm', track: 'V1', asset: 'vid', at: 90, len: 30, muted: true },
      { id: 'd', track: 'A1', at: 30, len: 60, in: 15 },
      { id: 'm', track: 'A2', asset: 'tone', at: 0, len: 120 },
    ], { buses: [{ id: 'music', gain: -6, duck: { by: 'dialogue', db: 9 } }, { id: 'master', loudness: { lufs: -14 } }] });
    const plan = planAudio(p, 'main', { baseDir: t.dir });
    expect(plan.segments.map((s) => `${s.clipId}:${s.bus}`).sort()).toEqual(['d:dialogue', 'm:music', 'v:master']);
    expect(plan.buses.find((b) => b.id === 'music')).toEqual({ id: 'music', gainDb: -6, muted: false, to: 'master', duck: { by: 'dialogue', db: 9, attack: 20, release: 300 } });
    expect(plan.buses.find((b) => b.id === 'master')).toMatchObject({ to: '', loudness: { lufs: -14, peak: -1 } });
    const d = plan.segments.find((s) => s.clipId === 'd')!;
    expect([d.start, d.end, d.sourceFrame]).toEqual([48000, 144000, 15]);
    expect(planAudio(p, 'main', { baseDir: t.dir, hasAudio: () => false }).segments.map((s) => s.clipId).sort()).toEqual(['d', 'm']);
    p.tracks![2]!.muted = true;
    const r = planAudio(p, 'main', { baseDir: t.dir, range: [45, 75] });
    expect(r.length).toBe(48000);
    const rd = r.segments.find((s) => s.clipId === 'd')!;
    expect([rd.start, rd.end, rd.sourceFrame]).toEqual([0, 48000, 30]);
    expect(r.segments.some((s) => s.clipId === 'm')).toBe(false);
  });

  it('speed, freeze, remap, gain keyframes and fades', () => {
    const p = project([
      { id: 'fast', at: 0, len: 30, speed: 2, in: 10 },
      { id: 'frozen', at: 30, len: 30, speed: 0 },
      { id: 'ramp', at: 60, len: 60, remap: [[0, 0], [30, 30], [60, 90]] },
      { id: 'g', track: 'A2', at: 0, len: 60, gain: [[0, -20], [30, 0]], fade: [15, 30] },
    ]);
    const plan = planAudio(p, 'main', { baseDir: t.dir });
    const by = (id: string) => plan.segments.filter((s) => s.clipId === id);
    expect(by('fast')[0]).toMatchObject({ start: 0, end: 48000, speed: { num: 2, den: 1 }, sourceFrame: 10 });
    expect(by('frozen')).toHaveLength(0);
    expect(by('ramp').map((s) => [s.start, s.end, s.sourceFrame, s.speed.num / s.speed.den])).toEqual([[96000, 144000, 0, 1], [144000, 192000, 30, 2]]);
    const g = by('g')[0]!;
    expect(g.gain).toEqual([[0, -20], [48000, 0]]);
    expect([g.fadeIn, g.fadeOut]).toEqual([24000, 48000]);
  });

  it('flattens nested comps with their own rate and speed (DESIGN §16 #5)', () => {
    const p: ProjectFile = {
      michelangelo: 1,
      assets: [{ id: 'dc', src: 'dc.wav' }],
      comps: [{ id: 'main', size: [64, 64], fps: 30, length: 300 }, { id: 'sub', size: [64, 64], fps: 24, length: 48 }],
      tracks: [{ id: 'V1', comp: 'main' }, { id: 'SA', comp: 'sub', audio: true, bus: 'sfx' }],
      clips: [
        { id: 'leaf', track: 'SA', at: 12, len: 24, asset: 'dc', in: 0 },
        { id: 'n1', track: 'V1', at: 30, len: 60, comp: 'sub' },
        { id: 'n2', track: 'V1', at: 120, len: 30, comp: 'sub', speed: 2, in: 24 },
        { id: 'n3', track: 'V1', at: 200, len: 100, comp: 'sub', loop: true },
      ] as Clip[],
    };
    const plan = planAudio(p, 'main', { baseDir: t.dir });
    const segs = plan.segments.map((s) => [s.start, s.end, Math.round(s.sourceFrame * 1000) / 1000, s.speed.num / s.speed.den, s.bus]);
    // n1: sub frame 12 (0.5 s) lands at main 30 + 15 = 45 → 1.5 s; plays 1 s
    expect(segs[0]).toEqual([72000, 120000, 0, 1, 'sfx']);
    // n2: in=24 (sub 1.0 s) at speed 2: leaf (sub 12–36) visible from sub 24 → main 120 → 4.0 s; 12 sub frames at 2× = 0.25 s
    expect(segs[1]).toEqual([192000, 204000, 12, 2, 'sfx']);
    // n3 loops the 2 s sub comp: leaf at 0.5 s and 2.5 s into the clip (200 = 6.667 s)
    expect(segs.slice(2).map((s) => s[0])).toEqual([sampleOf(200, { num: 30, den: 1 }) + 24000, sampleOf(200, { num: 30, den: 1 }) + 24000 + 96000]);
  });
});

describe('renderAudio', () => {
  beforeAll(() => {
    ff(['-f', 'lavfi', '-i', 'aevalsrc=0.5|0.5:s=48000:d=5', '-c:a', 'pcm_s16le', f('dc.wav')]);
    ff(['-f', 'lavfi', '-i', 'sine=f=440:d=6:sample_rate=48000', '-af', 'volume=-10dB', f('tone.wav')]);
    ff(['-f', 'lavfi', '-i', 'sine=f=150:d=8:sample_rate=48000', '-af', 'volume=-12dB', '-ac', '2', f('music.wav')]);
    ff(['-f', 'lavfi', '-i', 'sine=f=3000:d=2:sample_rate=48000', '-af', 'volume=-15dB', f('voice.wav')]);
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=64x64:d=2', '-f', 'lavfi', '-i', 'sine=f=600:d=2', '-shortest', '-c:v', 'libx264', '-c:a', 'aac', f('v.mp4')]);
  }, 60_000);

  it('places segments sample-exactly (30000/1001)', async () => {
    const p = project([{ at: 0, len: 10 }, { at: 20, len: 7, in: 30 }, { at: 27, len: 3 }], { comps: [{ id: 'main', size: [64, 64], fps: '30000/1001', length: 40 }] });
    const plan = planAudio(p, 'main', { baseDir: t.dir });
    await renderAudio(plan, f('exact.wav'), { baseDir: t.dir });
    const s = pcm(f('exact.wav'));
    expect(s.length).toBe(sampleOf(40, NTSC));
    expect(ffprobeJson(f('exact.wav')).streams[0]).toMatchObject({ sample_rate: '48000', channels: 2, codec_name: 'pcm_s16le' });
    const on = (i: number) => Math.abs(s[i]! - 16384) < 40;
    const b10 = sampleOf(10, NTSC), b20 = sampleOf(20, NTSC), b30 = sampleOf(30, NTSC);
    expect(on(0) && on(b10 - 1)).toBe(true);
    expect(s[b10]).toBe(0);
    expect(s[b20 - 1]).toBe(0);
    expect(on(b20) && on(b30 - 1)).toBe(true);
    expect(s[b30]).toBe(0);
    let count = 0;
    for (let i = 0; i < s.length; i++) if (on(i)) count++;
    expect(count).toBe(b10 + (b30 - b20));
  });

  it('time-stretches with speed, keeping exact length, and mixes a video clip\'s audio', async () => {
    const p = project([{ asset: 'tone', at: 0, len: 60, speed: 2 }, { id: 'vv', track: 'V1', asset: 'vid', at: 60, len: 30 }], { comps: [{ id: 'main', size: [64, 64], fps: 30, length: 90 }] });
    const plan = planAudio(p, 'main', { baseDir: t.dir });
    await renderAudio(plan, f('speed.wav'), { baseDir: t.dir });
    const s = pcm(f('speed.wav'));
    expect(s.length).toBe(144000);
    const r = rmsWindows(Float32Array.from(s, (v) => v / 32768), 48000);
    // lavfi sine is −18 dBFS peak; −10 dB → ≈ −31 dBFS RMS, steady for 2 s (4 s of source at 2×)
    expect(Math.min(...r.slice(0, 20))).toBeGreaterThan(-32);
    expect(Math.max(...r.slice(0, 20)) - Math.min(...r.slice(0, 20))).toBeLessThan(0.5);
    expect(Math.min(...r.slice(20, 30))).toBeGreaterThan(-25); // the video's own audio
  });

  it('ducks the music bus while dialogue plays', async () => {
    const p: ProjectFile = {
      michelangelo: 1,
      assets: [{ id: 'music', src: 'music.wav' }, { id: 'voice', src: 'voice.wav' }],
      comps: [{ id: 'main', size: [64, 64], fps: 30, length: 180 }],
      tracks: [{ id: 'A1', comp: 'main', audio: true, bus: 'dialogue' }, { id: 'A2', comp: 'main', audio: true, bus: 'music' }],
      clips: [
        { id: 'bed', track: 'A2', at: 0, len: 180, asset: 'music' },
        { id: 'vo', track: 'A1', at: 60, len: 60, asset: 'voice' },
      ] as Clip[],
      buses: [{ id: 'music', duck: { by: 'dialogue', db: 9, attack: 10, release: 100 } }],
    };
    await renderAudio(planAudio(p, 'main', { baseDir: t.dir }), f('duck.wav'), { baseDir: t.dir });
    // isolate the 150 Hz music with a low-pass, then compare its level before and during the voice
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', f('duck.wav'), '-af', 'lowpass=f=400,lowpass=f=400,pan=mono|c0=c0', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
    const lp = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength >> 2);
    const r = rmsWindows(lp, 48000);
    const before = r[10]!, during = r[30]!, after = r[55]!;
    expect(before - during).toBeGreaterThan(7.5);
    expect(before - during).toBeLessThan(11);
    expect(Math.abs(after - before)).toBeLessThan(1.5);
  });

  it('normalises loudness to −14 LUFS with a true-peak ceiling', async () => {
    const p = project([{ track: 'A2', asset: 'tone', at: 0, len: 150 }], { buses: [{ id: 'master', loudness: { lufs: -14, peak: -1 } }], comps: [{ id: 'main', size: [64, 64], fps: 30 }] });
    await renderAudio(planAudio(p, 'main', { baseDir: t.dir }), f('loud.wav'), { baseDir: t.dir });
    const a = await analyzeAudio(f('loud.wav'));
    expect(Math.abs(a.loudness.integrated + 14)).toBeLessThan(1);
    expect(a.loudness.truePeak).toBeLessThanOrEqual(-0.5);
    expect(pcm(f('loud.wav')).length).toBe(240000);
  });

  it('writes silence of the right length for an empty plan', async () => {
    await renderAudio({ sampleRate: 48000, length: 12345, segments: [], buses: [] }, f('empty.wav'));
    const s = pcm(f('empty.wav'));
    expect(s.length).toBe(12345);
    expect(s.every((v) => v === 0)).toBe(true);
  });

  it('helpers', () => {
    expect(atempoChain(4)).toEqual(['atempo=2', 'atempo=2']);
    expect(atempoChain(0.25)).toEqual(['atempo=0.5', 'atempo=0.5']);
    expect(atempoChain(1)).toEqual([]);
    expect(volumeFilter([[0, 0]])).toBeNull();
    expect(volumeFilter([[0, -6]])).toBe('volume=-6dB');
    expect(volumeFilter([[0, -20], [48000, 0]])).toContain('eval=frame');
    const d = duckParams(9, 20, 300);
    expect(d.ratio).toBeCloseTo(1 / (1 - 9 / 20), 5);
    expect(20 * Math.log10(d.threshold)).toBeCloseTo(-21, 5);
  });
});
