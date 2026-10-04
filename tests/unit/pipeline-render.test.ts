import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectFile } from '../../src/core/schema/index.js';
import { estimate, formatSubtitles, render, renderDetached, renderStatus, renderStills, splitRange, subtitleCues, outputSize, formatEstimate } from '../../src/render/pipeline.js';
import { ff, ffprobeJson, tempDir } from './media-fixtures.js';

let dir: string, cleanup: () => void;

beforeAll(() => {
  ({ dir, cleanup } = tempDir('mgl-pipeline-'));
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=14', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=14', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', '-c:a', 'aac', join(dir, 'clip.mp4')]);
  ff(['-f', 'lavfi', '-i', 'sine=f=330:r=48000:d=3', join(dir, 'tone.wav')]);
  ff(['-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', join(dir, 'logo.png')]);
});
afterAll(() => cleanup());

const W = 320, H = 240;

function solidText(len = 60): ProjectFile {
  return {
    michelangelo: 1,
    comps: [{ id: 'main', size: [W, H], fps: 30, bg: '#000000' }],
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'V2', comp: 'main' }],
    clips: [
      { id: 'bg', track: 'V1', at: 0, len, color: '#2050c0' },
      { id: 'title', track: 'V2', at: 0, len, text: 'Hello', style: { size: 48 }, opacity: [[0, 0], [15, 1]] },
    ],
  } as ProjectFile;
}

function withMedia(len = 60): ProjectFile {
  return {
    michelangelo: 1,
    assets: [{ id: 'clip', src: 'clip.mp4' }, { id: 'tone', src: 'tone.wav' }, { id: 'logo', src: 'logo.png' }],
    comps: [{ id: 'main', size: [W, H], fps: 30, bg: '#000000' }],
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'V2', comp: 'main' }, { id: 'A1', comp: 'main', audio: true }],
    clips: [
      { id: 'vid', track: 'V1', at: 0, len, asset: 'clip', muted: true },
      { id: 'pip', track: 'V2', at: 0, len, asset: 'logo', x: 260, y: 60, scale: 0.5 },
      { id: 'music', track: 'A1', at: 0, len, asset: 'tone', loop: true },
    ],
  } as ProjectFile;
}

function countFrames(file: string): number {
  return Number(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file]).toString().trim());
}

describe('render to files', () => {
  it('renders a 2 s solid + text project to mp4 (h264, size, duration) with an estimate', async () => {
    const out = join(dir, 'st.mp4');
    let note = '';
    const r = await render(solidText(), out, { baseDir: dir, onEstimate: (e) => { note = e.note; } });
    expect(note).toMatch(/^est\. [\d.]+ s \(final 320x240, 2\.0 s, ≈[\d.]+x real time\)$/);
    expect(r).toMatchObject({ frames: 60, width: W, height: H, codec: 'h264', segments: 1 });
    expect(r.audioCodec).toBeUndefined();
    const p = ffprobeJson(out);
    const v = p.streams.find((s) => s.codec_type === 'video')!;
    expect([v.codec_name, v.width, v.height]).toEqual(['h264', W, H]);
    expect(Number(p.format.duration)).toBeCloseTo(2, 1);
    expect(countFrames(out)).toBe(60);
    expect(r.bytes).toBeGreaterThan(0);
  });

  it('draft renders at half size with even dimensions', async () => {
    expect(outputSize(1080, 1920, 'draft')).toEqual({ width: 540, height: 960 });
    expect(outputSize(3840, 2160, 'draft')).toEqual({ width: 960, height: 540 });
    expect(outputSize(1080, 1920, 'final')).toEqual({ width: 1080, height: 1920 });
    const r = await render(solidText(30), join(dir, 'draft.mp4'), { baseDir: dir, quality: 'draft' });
    expect([r.width, r.height]).toEqual([160, 120]);
  });

  it('muxes the mixed audio into video and renders media layers', async () => {
    const out = join(dir, 'media.mp4');
    const r = await render(withMedia(), out, { baseDir: dir });
    expect(r.codec).toBe('h264');
    expect(r.audioCodec).toBe('aac');
    expect(r.probe!.streams.map((s) => s.type).sort()).toEqual(['audio', 'video']);
    expect(Math.abs(r.probe!.duration - 2)).toBeLessThan(0.1);
  });

  it('writes audio-only wav and mp3', async () => {
    const wav = await render(withMedia(), join(dir, 'mix.wav'), { baseDir: dir });
    expect(wav.codec).toBe('pcm_s16le');
    expect(wav.seconds).toBe(2);
    expect(wav.probe!.duration).toBeCloseTo(2, 2);
    const mp3 = await render(withMedia(), join(dir, 'mix.mp3'), { baseDir: dir, range: [0, 45] });
    expect(mp3.codec).toBe('mp3');
    expect(Math.abs(mp3.probe!.duration - 1.5)).toBeLessThan(0.1);
  });

  it('writes a gif and a png still', async () => {
    const gif = await render(solidText(30), join(dir, 'a.gif'), { baseDir: dir });
    expect(gif.codec).toBe('gif');
    const png = await render(solidText(), join(dir, 'still.png'), { baseDir: dir, still: 30 });
    expect([png.codec, png.width, png.height, png.frames]).toEqual(['png', W, H, 1]);
    const rgb = execFileSync('ffmpeg', ['-v', 'error', '-i', join(dir, 'still.png'), '-vf', 'crop=1:1:2:2', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    expect([...rgb]).toEqual([0x20, 0x50, 0xc0]);
  });

  it('exports caption cues as srt/vtt at absolute times', async () => {
    const p = solidText(90);
    p.tracks!.push({ id: 'C1', comp: 'main' });
    p.clips!.push({ id: 'subs', track: 'C1', at: 30, len: 60, captions: true } as never);
    p.cues = [
      { id: 'c1', clip: 'subs', at: 0, len: 15, text: 'first line' },
      { id: 'c2', clip: 'subs', at: 15, len: 60, text: 'second' },
    ];
    expect(subtitleCues(p, 'main')).toEqual([{ start: 1, end: 1.5, text: 'first line' }, { start: 1.5, end: 3, text: 'second' }]);
    const r = await render(p, join(dir, 'subs.srt'), { baseDir: dir });
    expect(r.codec).toBe('subrip');
    expect(readFileSync(join(dir, 'subs.srt'), 'utf8')).toBe('1\n00:00:01,000 --> 00:00:01,500\nfirst line\n\n2\n00:00:01,500 --> 00:00:03,000\nsecond\n');
    await render(p, join(dir, 'subs.vtt'), { baseDir: dir });
    expect(readFileSync(join(dir, 'subs.vtt'), 'utf8')).toMatch(/^WEBVTT\n\n00:00:01\.000 --> 00:00:01\.500\nfirst line\n/);
    expect(formatSubtitles([], 'vtt')).toBe('WEBVTT\n\n');
    expect(formatSubtitles([{ start: 0, end: 1, text: 'Three *big* wins' }], 'srt')).toBe('1\n00:00:00,000 --> 00:00:01,000\nThree big wins\n');
    await expect(render(solidText(), join(dir, 'none.srt'), { baseDir: dir })).rejects.toMatchObject({ code: 'E_NO_CUES' });
  });

  it('rejects unknown formats and alpha in mp4 with a fix', async () => {
    await expect(render(solidText(), join(dir, 'x.avi'), { baseDir: dir })).rejects.toMatchObject({ code: 'E_FORMAT', fix: expect.stringContaining('.mp4') });
    await expect(render(solidText(), join(dir, 'x.mp4'), { baseDir: dir, alpha: true })).rejects.toMatchObject({ code: 'E_ALPHA' });
  });
});

describe('segments', () => {
  it('splits ranges contiguously and exactly', () => {
    expect(splitRange([0, 10], 3)).toEqual([[0, 3], [3, 6], [6, 10]]);
    expect(splitRange([5, 7], 4)).toEqual([[5, 6], [6, 7]]);
  });

  it('segmented render has the same frame count and duration as one process', async () => {
    const p = withMedia(330); // 11 s
    const one = await render(p, join(dir, 'one.mp4'), { baseDir: dir, quality: 'draft', segments: 1 });
    const progress: number[] = [];
    const four = await render(p, join(dir, 'four.mp4'), { baseDir: dir, quality: 'draft', segments: 3, onProgress: (x) => progress.push(x.frame) });
    expect(four.segments).toBe(3);
    expect(countFrames(join(dir, 'one.mp4'))).toBe(330);
    expect(countFrames(join(dir, 'four.mp4'))).toBe(330);
    expect(four.audioCodec).toBe('aac');
    expect(Math.abs(four.probe!.duration - one.probe!.duration)).toBeLessThan(0.05);
    expect(progress[progress.length - 1]).toBe(330);
  }, 60_000);
});

describe('stills and estimate', () => {
  it('renders stills at a scale with layer boxes in comp px', async () => {
    const st = await renderStills(withMedia(), { baseDir: dir, frames: [0, 15, 45], scale: 0.5 });
    expect(st.map((s) => [s.frame, s.image.width, s.image.height])).toEqual([[0, 160, 120], [15, 160, 120], [45, 160, 120]]);
    const pip = st[0]!.layers.find((l) => l.clipId === 'pip')!;
    expect(pip.kind).toBe('image');
    expect(pip.box).toEqual([200, 0, 120, 120]); // contain-fit to the comp, then scale 0.5
    // the logo (red) sits at its place in the half-size image
    const img = st[0]!.image, x = 130, y = 30, i = (y * img.width + x) * 4;
    expect(img.data[i]).toBeGreaterThan(240);
    expect(img.data[i + 1]! + img.data[i + 2]!).toBeLessThan(20);
    // the video differs between frames
    expect(Buffer.compare(Buffer.from(st[0]!.image.data), Buffer.from(st[2]!.image.data))).not.toBe(0);
    const t = await renderStills(solidText(), { baseDir: dir, frames: [20] });
    expect(t[0]!.layers.find((l) => l.clipId === 'title')).toMatchObject({ kind: 'text', text: 'Hello' });
  });

  it('estimates from sample frames and prints one line', async () => {
    const e = await estimate(withMedia(), { baseDir: dir, quality: 'final' });
    expect(e.frames).toBe(60);
    expect(e.perFrameMs).toBeGreaterThan(0);
    expect(e.decodeMs).toBeGreaterThan(0);
    expect(e.seconds).toBeGreaterThan(0);
    expect(e.note).toBe(formatEstimate(e));
    expect(formatEstimate({ seconds: 24.2, quality: 'final', width: 1080, height: 1920, duration: 30, realtimeFactor: 0.81 })).toBe('est. 24 s (final 1080x1920, 30.0 s, ≈0.8x real time)');
  });
});

describe('detached renders', () => {
  it('runs in a separate process and reports through render.json', async () => {
    const file = join(dir, 'det.mgl.json');
    writeFileSync(file, JSON.stringify(solidText(30)));
    expect(() => renderStatus(file)).toThrow(expect.objectContaining({ code: 'E_NO_RENDER' }));
    const s = await renderDetached(file, join(dir, 'det.mp4'));
    expect(s.status).toBe('running');
    expect(s.statusFile).toBe(join(dir, '.mgl', 'det', 'render.json'));
    const t0 = Date.now();
    let st = renderStatus(file);
    while (st.status === 'running' && Date.now() - t0 < 30_000) { await new Promise((r) => setTimeout(r, 200)); st = renderStatus(file); }
    expect(st.error).toBeUndefined();
    expect(st.status).toBe('done');
    expect(st.result).toMatchObject({ frames: 30, codec: 'h264' });
    expect(existsSync(join(dir, 'det.mp4'))).toBe(true);
  }, 40_000);
});
