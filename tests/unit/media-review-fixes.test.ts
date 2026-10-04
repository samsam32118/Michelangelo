// @vitest-environment node
/** Regressions for the media review (2026-10-04): ms-timebase frame lookup, looped clip audio, eased remap audio. */
import { describe, it, expect } from 'vitest';
import { frameAtTime, sourceFrameAt, frameEpsilon, type FrameIndex } from '../../src/media/probe.js';
import { planAudio, sampleOf } from '../../src/media/audio-plan.js';
import { interpolate } from '../../src/render/keyframes.js';
import type { Clip, ProjectFile } from '../../src/core/schema/index.js';

const R30 = { num: 30, den: 1 };

describe('frame lookup on millisecond time bases (WebM/MKV)', () => {
  const ms = (i: number) => Math.round((i * 1000) / 30) / 1000;
  const idx: FrameIndex = { pts: Array.from({ length: 60 }, (_, i) => ms(i)), offset: 0, vfr: false, frameDur: 1 / 30, tb: 0.001 };
  it('maps comp frame n to source frame n although PTS are rounded up to the millisecond', () => {
    expect([20, 21, 22, 23, 24, 25].map((f) => sourceFrameAt(idx, f, R30).index)).toEqual([20, 21, 22, 23, 24, 25]);
    for (let f = 0; f < 60; f++) expect(sourceFrameAt(idx, f, R30).index).toBe(f);
  });
  it('the tolerance is one tick, never more than a quarter frame', () => {
    expect(frameEpsilon({ frameDur: 1 / 30, tb: 0.001 })).toBe(0.001);
    expect(frameEpsilon({ frameDur: 1 / 30, tb: 1 / 90000 })).toBe(1e-4);
    expect(frameEpsilon({ frameDur: 1 / 1000, tb: 0.001 })).toBe(0.00025);
    expect(frameEpsilon({ frameDur: 1 / 30 })).toBe(1e-4);
  });
  it('still picks the earlier frame for a time clearly between two frames', () => {
    expect(frameAtTime(idx, 0.05)).toBe(1);
  });
});

function project(clips: Partial<Clip>[]): ProjectFile {
  return {
    michelangelo: 1,
    assets: [{ id: 'vid', src: 'v.mp4' }, { id: 'tone', src: 'tone.wav' }],
    comps: [{ id: 'main', size: [64, 64], fps: 30 }],
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'A1', comp: 'main', audio: true }],
    clips: clips.map((c, i) => ({ id: `c${i}`, track: 'V1', at: 0, len: 30, asset: 'vid', ...c })) as Clip[],
  } as ProjectFile;
}

describe('looped clips loop their audio', () => {
  it('a 2 s video in a 4 s looped clip plays its sound twice (wrapping like the picture)', () => {
    const plan = planAudio(project([{ len: 120, loop: true }]), 'main', { baseDir: '/p', duration: (id) => (id === 'vid' ? 2 : undefined) });
    expect(plan.segments.map((s) => [s.start, s.end, s.sourceFrame])).toEqual([[0, sampleOf(60, R30), 0], [sampleOf(60, R30), sampleOf(120, R30), 0]]);
  });
  it('wraps from the clip in point, at speed, over the source period', () => {
    const plan = planAudio(project([{ len: 60, loop: true, in: 40, speed: 2 }]), 'main', { baseDir: '/p', duration: () => 2 });
    // source 40..60 (10 clip frames), then 0..60 (30), then 0..40 (20)
    expect(plan.segments.map((s) => [s.start, s.end, s.sourceFrame])).toEqual([
      [0, sampleOf(10, R30), 40], [sampleOf(10, R30), sampleOf(40, R30), 0], [sampleOf(40, R30), sampleOf(60, R30), 0],
    ]);
  });
  it('without a known duration (or without loop) it stays one segment', () => {
    expect(planAudio(project([{ len: 120, loop: true }]), 'main', { baseDir: '/p' }).segments).toHaveLength(1);
    expect(planAudio(project([{ len: 120 }]), 'main', { baseDir: '/p', duration: () => 2 }).segments).toHaveLength(1);
  });
});

describe('eased remap audio follows the picture', () => {
  it('source position of the audio stays within a frame of the video remap curve', () => {
    const remap: [number, number, string?][] = [[0, 0, 'inCubic'], [60, 60]];
    const plan = planAudio(project([{ len: 60, remap: remap as never }]), 'main', { baseDir: '/p' });
    expect(plan.segments.length).toBeGreaterThan(1);
    const audioAt = (f: number): number | undefined => {
      const s0 = sampleOf(f, R30);
      const seg = plan.segments.find((s) => s.start <= s0 && s0 < s.end);
      if (!seg) return undefined;
      const sp = seg.speed.num / seg.speed.den;
      return seg.sourceFrame + ((s0 - seg.start) / 48000) * 30 * sp;
    };
    for (const f of [15, 30, 45, 55]) {
      const v = interpolate(remap as never, f) as number;
      const a = audioAt(f);
      if (a === undefined) continue; // a silent (near-frozen) frame
      expect(Math.abs(a - v)).toBeLessThanOrEqual(1);
    }
    // mid-ramp audio is no longer at source frame 30 (the old linear plan): the video shows ≈ 7.5 there
    expect(audioAt(30)!).toBeLessThan(10);
  });
  it('linear remaps are still one exact piece per key segment', () => {
    const plan = planAudio(project([{ len: 60, remap: [[0, 0], [60, 120]] as never }]), 'main', { baseDir: '/p' });
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0]!.speed).toEqual({ num: 2, den: 1 });
  });
});
