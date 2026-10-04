import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { analyzeAudio, estimateTempo, parseSilences } from '../../src/media/analysis.js';
import { trackMotion, centroid } from '../../src/media/track.js';
import { ff, tempDir } from './media-fixtures.js';

const t = tempDir();
const f = (n: string) => join(t.dir, n);

beforeAll(() => {
  ff(['-f', 'lavfi', '-i', "aevalsrc='if(between(t,1,2)+between(t,3,4.5),0,0.3*sin(2*PI*440*t))':s=48000:d=5", f('pattern.wav')]);
  ff(['-f', 'lavfi', '-i', "aevalsrc='if(lt(mod(t,0.5),0.01),0.8*sin(2*PI*2000*t),0)':s=44100:d=8", f('click120.wav')]);
  ff(['-f', 'lavfi', '-i', "color=black:s=320x180:r=25:d=2,format=gray,geq=lum='if(lt(abs(X-(40+T*120)),16)*lt(abs(Y-90),16),235,16)'", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('move.mp4')]);
}, 60_000);
afterAll(() => t.cleanup());

describe('analyzeAudio', () => {
  it('finds silences, loudness and RMS of a tone/silence pattern', async () => {
    const a = await analyzeAudio(f('pattern.wav'), { silenceDb: -50, minSilence: 0.5 });
    expect(a.duration).toBeCloseTo(5, 1);
    expect(a.silences).toHaveLength(2);
    expect(a.silences[0]!.start).toBeCloseTo(1, 1);
    expect(a.silences[0]!.end).toBeCloseTo(2, 1);
    expect(a.silences[1]!.start).toBeCloseTo(3, 1);
    expect(a.silences[1]!.end).toBeCloseTo(4.5, 1);
    expect(a.rms).toHaveLength(50);
    expect(a.rms[5]!).toBeCloseTo(20 * Math.log10(0.3 / Math.SQRT2), 0);
    expect(a.rms[15]!).toBeLessThan(-100);
    expect(a.loudness.integrated).toBeGreaterThan(-20);
    expect(a.loudness.integrated).toBeLessThan(-10);
    expect(a.loudness.truePeak).toBeCloseTo(20 * Math.log10(0.3), 0);
    expect(a.loudness.momentary!.length).toBeGreaterThanOrEqual(45);
  });
  it('detects onsets and the tempo of a 120 BPM click track', async () => {
    const a = await analyzeAudio(f('click120.wav'));
    expect(a.bpm).toBeGreaterThan(118);
    expect(a.bpm).toBeLessThan(122);
    expect(a.beats.length).toBe(16);
    a.beats.forEach((b, i) => expect(Math.abs(b - i * 0.5)).toBeLessThan(0.02));
  });
  it('parsers and tempo edge cases', () => {
    expect(parseSilences('silence_start: 1.5\nsilence_end: 2.25 | silence_duration: 0.75\nsilence_start: 4', 5)).toEqual([{ start: 1.5, end: 2.25 }, { start: 4, end: 5 }]);
    expect(estimateTempo(new Float64Array(10), 0.01)).toBeUndefined();
  });
  it('says when a file has no audio', async () => {
    await expect(analyzeAudio(f('move.mp4'))).rejects.toMatchObject({ code: 'E_NO_AUDIO' });
  });
});

describe('trackMotion', () => {
  it('follows a moving bright square', async () => {
    const pts = await trackMotion(f('move.mp4'), { fps: 5, inFrames: 0, lenFrames: 60, rate: { num: 30, den: 1 } });
    expect(pts.length).toBeGreaterThanOrEqual(9);
    expect(pts[0]!.frame).toBe(0);
    expect(pts[1]!.frame).toBe(6);
    for (const p of pts) expect(p.y).toBeCloseTo(0.5, 1);
    for (let i = 1; i < pts.length; i++) expect(pts[i]!.x).toBeGreaterThanOrEqual(pts[i - 1]!.x - 0.01);
    expect(pts[pts.length - 1]!.x - pts[0]!.x).toBeGreaterThan(0.4);
  });
  it('centroid falls back to brightness without motion', () => {
    const w = 4, h = 2, cur = new Uint8Array([0, 0, 0, 255, 0, 0, 0, 255]);
    expect(centroid(cur, cur, w, h)).toMatchObject({ x: 0.875, y: 0.5 });
    expect(centroid(new Uint8Array(8), null, w, h)).toMatchObject({ x: 0.5, y: 0.5 });
  });
});
