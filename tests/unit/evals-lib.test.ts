// The eval grading library (evals/lib): raw project reading, time forms, captions, pixel and audio measurements.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseProjectText } from '../../src/core/load.js';

let L: any;
const dir = mkdtempSync(join(tmpdir(), 'mgl-evals-lib-'));
const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const img = (w: number, h: number, fill: (x: number, y: number) => number[]) => {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = fill(x, y); data.set([r!, g!, b!, 255], (y * w + x) * 4); }
  return { width: w, height: h, data };
};

beforeAll(async () => { L = await import(pathToFileURL(resolve(__dirname, '../../evals/lib/index.mjs')).href); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('project (raw JSON)', () => {
  it('parses trailing commas and comments outside strings only', () => {
    const p = L.parseLoose('{"a": [1, 2,], "s": "x,]y // not a comment", /* c */ "b": {"c": 1,},\n// line\n}');
    expect(p).toEqual({ a: [1, 2], s: 'x,]y // not a comment', b: { c: 1 } });
  });
  it('converts the time edge forms to frames', () => {
    expect([L.toFrames(75, 30), L.toFrames('2.5s', 30), L.toFrames('1:02.5', 30), L.toFrames('00:01:02:15', 30), L.toFrames('12', 30)]).toEqual([75, 75, 1875, 1875, 12]);
    expect(L.compRate({ fps: '30000/1001' })).toBeCloseTo(29.97, 2);
  });
  it('validates independently: unknown keys, references, overlaps', () => {
    const good = { michelangelo: 1, comps: [{ id: 'main', size: [100, 100], fps: 30 }], tracks: [{ id: 'V1', comp: 'main' }], clips: [{ id: 'a', track: 'V1', at: 0, len: 10, color: '#fff' }, { id: 'b', track: 'V1', at: 10, len: 5, text: 'hi' }] };
    expect(L.validateRaw(good)).toEqual([]);
    const bad = structuredClone(good) as any;
    bad.clips[1].at = 5; bad.clips[0].opactiy = 1; bad.clips.push({ id: 'c', track: 'V9', at: 0, len: 1, text: 'x' });
    const errs = L.validateRaw(bad).join('\n');
    expect(errs).toMatch(/opactiy/);
    bad.clips[0].opacity = 1; delete bad.clips[0].opactiy;
    expect(L.validateRaw(bad).join('\n')).toMatch(/V9[\s\S]*overlap|overlap[\s\S]*V9/);
  });
  it('formats one entity per line, and the library loads the result', () => {
    const p = { michelangelo: 1, comps: [{ id: 'main', size: [1080, 1920], fps: 30, length: 90 }], tracks: [{ id: 'T1', comp: 'main' }], clips: [{ id: 't', track: 'T1', at: 0, len: 90, text: 'a, b], "c"' }] };
    const text = L.formatProject(p);
    expect(text.split('\n').filter((l: string) => l.startsWith('{"id"')).length).toBe(3);
    expect(parseProjectText(text).project.clips![0]!.text).toBe('a, b], "c"');
  });
  it('follows nested comps for absolute spans and resolves styles', () => {
    const p = { michelangelo: 1, project: { main: 'main' }, styles: [{ id: 's', base: 'title', size: 80, color: '#fff' }],
      comps: [{ id: 'main', size: [100, 100], fps: 30 }, { id: 'badge', size: [50, 50], fps: 30 }],
      tracks: [{ id: 'V1', comp: 'main' }, { id: 'B1', comp: 'badge' }],
      clips: [{ id: 'u1', track: 'V1', at: 30, len: 60, comp: 'badge' }, { id: 'txt', track: 'B1', at: 15, len: 300, text: 'NEW', style: { base: 's', color: '#f00' } }] };
    expect(L.absoluteSpans(p, p.clips[1])).toEqual([{ start: 1.5, end: 3 }]);
    expect(L.resolveStyle(p, p.clips[1])).toMatchObject({ size: 80, color: '#f00' });
    expect(L.valueAt([[0, 0], [10, 100]], 5)).toBe(50);
  });
});

describe('captions', () => {
  it('parses SRT and VTT with word timestamps', () => {
    const srt = L.parseCaptions('1\n00:00:01,000 --> 00:00:02,500\nHello <i>there</i>\n\n2\n00:00:03,000 --> 00:00:04,000\nBye\n');
    expect(srt).toEqual([{ start: 1, end: 2.5, text: 'Hello there' }, { start: 3, end: 4, text: 'Bye' }]);
    const vtt = L.parseCaptions('WEBVTT\n\n00:00:03.400 --> 00:00:06.000\nas <00:00:03.800>soon <00:00:04.100>as\n');
    expect(vtt[0]).toEqual({ start: 3.4, end: 6, text: 'as soon as', words: [3.4, 3.8, 4.1] });
  });
  it('reads cues from a project as absolute seconds (cue times local to the captions clip)', () => {
    const p = { comps: [{ id: 'main', fps: 30 }], tracks: [{ id: 'T', comp: 'main' }], clips: [{ id: 'cap', track: 'T', at: 30, len: 300, captions: true }],
      cues: [{ id: 'c', clip: 'cap', at: 15, len: 30, text: 'a b', words: [0, 15] }] };
    expect(L.projectCues(p)).toEqual([{ id: 'c', clip: 'cap', start: 1.5, end: 2.5, text: 'a b', words: [1.5, 2] }]);
  });
});

describe('pixels', () => {
  it('measures colours, components, clusters, levels and glyph density', () => {
    const im = img(100, 50, (x, y) => (x >= 10 && x < 30 && y >= 10 && y < 30 ? [255, 0, 0] : x >= 60 && x < 70 && y >= 5 && y < 15 ? [0, 0, 255] : [0, 0, 0]));
    expect(L.meanColor(im, [10, 10, 20, 20])).toEqual([255, 0, 0]);
    const comps = L.components(L.mask(im, (r: number, g: number, b: number) => r + g + b > 100), 100, 50);
    expect(comps.map((c: any) => c.area)).toEqual([400, 100]);
    expect(comps[0].bbox).toEqual([10, 10, 20, 20]);
    expect(L.colorClusters(im).length).toBe(3);
    const parts = L.mask(img(30, 10, (x) => (x === 5 || x === 9 ? [255, 255, 255] : [0, 0, 0])), (r: number) => r > 100);
    expect(L.components(parts, 30, 10).length).toBe(2);
    expect(L.components(L.dilate(parts, 30, 10, 2), 30, 10).length).toBe(1);
    expect(L.channelLevels(im)).toEqual([2, 1, 2]);
    const text = img(40, 40, (x, y) => (y >= 18 && y < 22 ? [255, 255, 255] : y >= 15 && y < 25 ? [0, 0, 0] : [90, 120, 150]));
    expect(L.glyphDensity(text)).toBeGreaterThan(0.1);
    expect(L.glyphDensity(img(40, 40, () => [90, 120, 150]))).toBe(0);
    expect(L.deltaE([255, 0, 0], L.hex('#ff0000'))).toBe(0);
  });
  it('decodes frames, compares with SSIM and reads the binary counter', async () => {
    await L.counterVideo(join(dir, 'c.mp4'), { d: 2, w: 640, h: 360 });
    const info = await L.probe(join(dir, 'c.mp4'), { countFrames: true });
    expect(info).toMatchObject({ width: 640, height: 360, frames: 60 });
    const f = await L.frameAt(join(dir, 'c.mp4'), 1.5, { width: 320, height: 180 });
    expect(L.readCounter(f)).toBe(45);
    expect(await L.ssim(join(dir, 'c.mp4'), join(dir, 'c.mp4'), { ta: 1, tb: 1 })).toBeGreaterThan(0.99);
    const all = await L.allFrames(join(dir, 'c.mp4'), { width: 96, height: 54 });
    expect(all.map((x: any) => L.readCounter(x))).toEqual(Array.from({ length: 60 }, (_, i) => i));
    expect((await L.assertNotEmpty(join(dir, 'c.mp4'))).pass).toBe(true);
  }, 30_000);
});

describe('audio', () => {
  it('measures tones (Goertzel), loudness, silences, and matches envelopes', async () => {
    const f = join(dir, 'a.wav');
    ff(['-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*440*t)*lt(t,1)+0.5*sin(2*PI*660*t)*gt(t,2)':s=48000:d=3", f]);
    const a = await L.toneLevels(f, [440, 660], { start: 0.2, duration: 0.5 });
    expect(a[440]).toBeGreaterThan(-8);
    expect(a[440] - a[660]).toBeGreaterThan(30);
    const s = await L.silences(f, { db: -40, minDuration: 0.5 });
    expect(s.length).toBe(1);
    expect(s[0].start).toBeCloseTo(1, 1);
    expect((await L.loudness(f)).integrated).toBeGreaterThan(-20);
    const env = [0, 0, 1, 3, 1, 0, 0, 2, 0, 0];
    expect(L.bestMatch(env, [1, 3, 1]).offset).toBe(2);
    const silent = join(dir, 's.wav');
    ff(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=2', silent]);
    expect((await L.assertNotEmpty(silent, { video: false, audio: true })).pass).toBe(false);
  }, 30_000);
});

describe('check recorder', () => {
  it('scores the fraction of checks passed; pass needs all', async () => {
    const g = L.grader();
    g.check('a', true);
    await g.checkAsync('b', async () => { throw new Error('boom'); });
    const r = g.result();
    expect(r).toMatchObject({ pass: false, score: 0.5 });
    expect(r.checks[1].detail).toMatch(/boom/);
    expect(L.grader().result().pass).toBe(false);
  });
});
