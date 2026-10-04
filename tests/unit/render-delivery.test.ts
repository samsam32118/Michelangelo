/** Delivery settings, chapters export, alpha warnings, estimate calibration and the full-frame passthrough path. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectFile } from '../../src/core/schema/index.js';
import { checkDelivery, encodeArgs } from '../../src/media/encode.js';
import type { FfmpegInfo } from '../../src/media/types.js';
import { chapterList, formatChaptersVtt, formatChaptersYouTube, ytStamp } from '../../src/render/chapters.js';
import { encodeFps, isOpaqueColor, passthroughSource, render } from '../../src/render/pipeline.js';
import type { DisplayList, LayerNode } from '../../src/render/types.js';
import { ff, ffprobeJson, tempDir } from './media-fixtures.js';

let dir: string, cleanup: () => void;
beforeAll(() => {
  ({ dir, cleanup } = tempDir('mgl-delivery-'));
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=30:d=2', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=2', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(dir, 'clip.mp4')]);
});
afterAll(() => cleanup());

const FF = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', version: 'x', source: 'system', encoders: ['libx264', 'libvpx-vp9', 'prores_ks', 'libopus'], decoders: [], filters: [], licence: '' } as FfmpegInfo;
const enc = (format: 'mp4' | 'webm' | 'mov', delivery: object, alpha = false) => encodeArgs({ out: 'o', width: 160, height: 90, rate: { num: 30, den: 1 }, format, quality: 'final', alpha, delivery }, FF).join(' ');

describe('delivery settings', () => {
  it('map to encoder arguments', () => {
    expect(enc('mp4', { crf: 16 })).toMatch(/-crf 16 /);
    expect(enc('mp4', { bitrate: '8M' })).toMatch(/-b:v 8M -maxrate 8M -bufsize 16M/);
    expect(enc('mp4', { crf: 18, bitrate: '8M' })).toMatch(/-crf 18 -maxrate 8M -bufsize 16M/);
    expect(enc('webm', { bitrate: '2M' })).toMatch(/-b:v 2M -deadline/);
    expect(enc('webm', { crf: 30 })).toMatch(/-b:v 0 -crf 30/);
    expect(enc('mov', { prores: 'proxy' })).toMatch(/-profile:v 0 -pix_fmt yuv422p10le/);
    expect(enc('mov', { prores: '4444' })).toMatch(/-profile:v 4 -pix_fmt yuv444p10le/);
    expect(enc('mov', {}, true)).toMatch(/-profile:v 4 -pix_fmt yuva444p10le/);
    expect(enc('mov', {})).toMatch(/-profile:v 3 /);
    expect(enc('mp4', { colorRange: 'pc' })).toMatch(/out_range=pc.*-color_range pc/);
    expect(enc('mp4', {})).toMatch(/-color_range tv/);
    expect(enc('mov', { timecode: '10:00:00:00' })).toMatch(/-timecode 10:00:00:00/);
  });

  it('are checked against the format with fixes', () => {
    const r30 = { num: 30, den: 1 }, r2997 = { num: 30000, den: 1001 };
    const bad: [object, string, boolean?][] = [
      [{ crf: 60 }, 'mp4'], [{ crf: 20 }, 'mov'], [{ bitrate: 'fast' }, 'mp4'], [{ prores: 'hq' }, 'mp4'], [{ prores: 'lt' }, 'mov', true],
      [{ timecode: '10:00:00' }, 'mov'], [{ timecode: '10:00:00:30' }, 'mov'], [{ timecode: '10:00:00;00' }, 'mov'], [{ timecode: '01:00:00:00' }, 'webm'], [{ pcmDepth: 32 }, 'mov'],
    ];
    for (const [d, f, alpha] of bad) expect(() => checkDelivery(d, f as 'mp4', r30, alpha), JSON.stringify(d)).toThrowError(expect.objectContaining({ fix: expect.any(String) }));
    expect(() => checkDelivery({ timecode: '01:00:00;00' }, 'mov', r2997)).not.toThrow();
    expect(() => checkDelivery({ crf: 0, bitrate: '2500k', audioBitrate: '320k', pcmDepth: 24, timecode: '00:59:59:29', colorRange: 'pc' }, 'mp4', r30)).not.toThrow();
  });

  it('render writes the start timecode, audio bitrate and 24-bit mov audio', async () => {
    const p: ProjectFile = {
      michelangelo: 1, assets: [{ id: 'clip', src: 'clip.mp4' }], comps: [{ id: 'main', size: [160, 90], fps: 30 }],
      tracks: [{ id: 'V1', comp: 'main' }], clips: [{ id: 'c', track: 'V1', at: 0, len: 30, asset: 'clip' }],
    } as ProjectFile;
    const mp4 = join(dir, 'tc.mp4');
    const r = await render(p, mp4, { baseDir: dir, timecode: '10:00:00:00', audioBitrate: '96k', crf: 30 });
    expect(r.notes).toContain('start timecode 10:00:00:00');
    const j = ffprobeJson(mp4);
    const tags = JSON.stringify(j.streams.map((s) => s.tags ?? {})) + JSON.stringify(j.format.tags ?? {});
    expect(tags).toContain('10:00:00:00');
    const a = j.streams.find((s) => s.codec_type === 'audio')!;
    expect(Number(a.bit_rate)).toBeLessThan(130_000);
    const mov = join(dir, 'p.mov');
    await render(p, mov, { baseDir: dir, prores: 'proxy', pcmDepth: 24, quality: 'draft' });
    const m = ffprobeJson(mov);
    expect(m.streams.find((s) => s.codec_type === 'video')!.profile).toMatch(/Proxy/i);
    expect(m.streams.find((s) => s.codec_type === 'audio')!.codec_name).toBe('pcm_s24le');
    // a timecode without audio still reaches the file
    const silent = { ...p, clips: [{ ...p.clips![0]!, muted: true }] } as ProjectFile;
    const tc2 = join(dir, 'tc2.mov');
    await render(silent, tc2, { baseDir: dir, timecode: '01:00:00:00', quality: 'draft' });
    expect(JSON.stringify(ffprobeJson(tc2))).toContain('01:00:00:00');
    await expect(render(p, join(dir, 'x.png'), { baseDir: dir, crf: 20 })).rejects.toMatchObject({ code: 'E_ARG' });
  });
});

describe('alpha output', () => {
  it('warns when an opaque comp bg makes the alpha channel opaque', async () => {
    expect(isOpaqueColor('#000')).toBe(true);
    expect(isOpaqueColor('#00000080')).toBe(false);
    expect(isOpaqueColor('rgba(0,0,0,0.5)')).toBe(false);
    expect(isOpaqueColor('transparent')).toBe(false);
    const p = { michelangelo: 1, comps: [{ id: 'main', size: [64, 64], fps: 30, bg: '#102030' }], tracks: [{ id: 'V1', comp: 'main' }], clips: [{ id: 't', track: 'V1', at: 0, len: 10, color: '#ff0000', scale: 0.5 }] } as ProjectFile;
    const r = await render(p, join(dir, 'a.mov'), { baseDir: dir, alpha: true, quality: 'draft' });
    expect(r.notes.join(' ')).toMatch(/opaque bg .*comp\.set main bg=null/);
  });
});

describe('chapters export', () => {
  const p = (markers: object[]) => ({ michelangelo: 1, comps: [{ id: 'main', size: [64, 64], fps: 30, length: 3600 }], tracks: [], clips: [], markers } as unknown as ProjectFile);

  it('YouTube lines from markers with notes, sorted; adds 0:00 when missing; warns on < 3 or < 10 s', () => {
    const r = chapterList(p([{ id: 'b', comp: 'main', at: 1800, note: 'Second' }, { id: 'a', comp: 'main', at: 600, note: 'First' }, { id: 'x', comp: 'main', at: 900 }]), 'main');
    expect(formatChaptersYouTube(r.chapters)).toBe('0:00 Intro\n0:20 First\n1:00 Second\n');
    expect(r.notes.join(' | ')).toMatch(/added an "Intro" chapter at 0:00/);
    expect(r.notes.join(' | ')).toMatch(/1 marker without a note skipped/);
    expect(r.notes.join(' | ')).not.toMatch(/at least 3/);
    const few = chapterList(p([{ id: 'a', comp: 'main', at: 0, note: 'Start' }, { id: 'b', comp: 'main', at: 150, note: 'Quick' }]), 'main');
    expect(few.notes.join(' | ')).toMatch(/2 chapters; YouTube needs at least 3/);
    expect(few.notes.join(' | ')).toMatch(/"Start" \(0:00\) is shorter than 10 s/);
    expect(ytStamp(3723)).toBe('1:02:03');
    expect(() => chapterList(p([{ id: 'x', comp: 'main', at: 10 }]), 'main')).toThrowError(expect.objectContaining({ code: 'E_NO_CHAPTERS', fix: expect.stringContaining('marker.add') }));
  });

  it('WebVTT chapters end where the next starts', () => {
    const vtt = formatChaptersVtt([{ start: 0, title: 'A' }, { start: 20, title: 'B' }], 65.5);
    expect(vtt).toBe('WEBVTT\n\n1\n00:00:00.000 --> 00:00:20.000\nA\n\n2\n00:00:20.000 --> 00:01:05.500\nB\n');
  });

  it('render to .chapters.txt and .chapters.vtt', async () => {
    const proj = p([{ id: 'a', comp: 'main', at: 0, note: 'Intro' }, { id: 'b', comp: 'main', at: 900, note: 'Main' }, { id: 'c', comp: 'main', at: 2700, note: 'Outro' }]);
    const r = await render(proj, join(dir, 'v.chapters.txt'), { baseDir: dir });
    expect(readFileSync(join(dir, 'v.chapters.txt'), 'utf8')).toBe('0:00 Intro\n0:30 Main\n1:30 Outro\n');
    expect(r.notes).toContain('3 chapters');
    await render(proj, join(dir, 'v.chapters.vtt'), { baseDir: dir });
    expect(readFileSync(join(dir, 'v.chapters.vtt'), 'utf8')).toMatch(/^WEBVTT\n\n1\n00:00:00\.000 --> 00:00:30\.000\nIntro\n/);
  });
});

describe('estimate calibration', () => {
  it('ProRes is about 3.5× slower than x264 final, alpha and profiles adjust it', () => {
    const x = encodeFps('mp4', 'final', 1080, 1920), pr = encodeFps('mov', 'final', 1080, 1920);
    expect(x / pr).toBeGreaterThan(3);
    expect(x / pr).toBeLessThan(4);
    expect(encodeFps('mov', 'final', 1080, 1920, { alpha: true })).toBeLessThan(pr);
    expect(encodeFps('mov', 'final', 1080, 1920, { prores: 'proxy' })).toBeGreaterThan(pr);
  });
});

describe('full-frame passthrough', () => {
  const info = new Map([['v', { kind: 'video', duration: 2, hasAudio: false, hasVideo: true, size: 1, pixFmt: 'yuv420p', width: 1920, height: 1080 }]]) as never;
  const node = (o: Partial<LayerNode> = {}): LayerNode => ({
    type: 'layer', clipId: 'c', box: { w: 1920, h: 1080 }, matrix: [1, 0, 0, 1, 0, 0], opacity: 1, blend: 'normal', fx: [], masks: [], localFrame: 0, seed: 1,
    source: { type: 'media', assetId: 'v', src: 'v.mp4', kind: 'video', sourceFrame: 0, rate: { num: 30, den: 1 }, filters: [], fit: 'cover', size: { w: 1920, h: 1080 } },
    ...o,
  });
  const list = (n: LayerNode[]): DisplayList => ({ compId: 'main', width: 1920, height: 1080, frame: 0, rate: { num: 30, den: 1 }, nodes: n });
  const prep = { W: 1920, H: 1080, info };

  it('takes a single opaque full-frame video layer straight to the encoder (also at draft size)', () => {
    expect(passthroughSource(prep, list([node()]), 1920, 1080)?.size).toEqual({ w: 1920, h: 1080 });
    expect(passthroughSource(prep, list([node()]), 960, 540)?.size).toEqual({ w: 960, h: 540 });
  });

  it('composites anything else', () => {
    for (const n of [node({ opacity: 0.9 }), node({ matrix: [1.1, 0, 0, 1.1, -96, -54] }), node({ blend: 'screen' }), node({ fx: [{ type: 'blur', params: {} }] }), node({ masks: [{ shape: 'rect', box: [0, 0, 10, 10] }] })]) {
      expect(passthroughSource(prep, list([n]), 1920, 1080)).toBeNull();
    }
    expect(passthroughSource(prep, list([node(), node()]), 1920, 1080)).toBeNull();
    const sq = node({ source: { ...(node().source as never as object), size: { w: 1080, h: 1080 }, fit: 'contain' } as never });
    expect(passthroughSource(prep, list([sq]), 1920, 1080)).toBeNull(); // letterboxed
    const alphaInfo = new Map([['v', { kind: 'video', pixFmt: 'yuva420p' }]]) as never;
    expect(passthroughSource({ ...prep, info: alphaInfo }, list([node()]), 1920, 1080)).toBeNull();
  });

  it('renders the same frames as compositing', async () => {
    const p: ProjectFile = {
      michelangelo: 1, assets: [{ id: 'clip', src: 'clip.mp4' }], comps: [{ id: 'main', size: [160, 90], fps: 30 }],
      tracks: [{ id: 'V1', comp: 'main' }], clips: [{ id: 'c', track: 'V1', at: 0, len: 20, asset: 'clip', muted: true }],
    } as ProjectFile;
    // opacity 0.999 forces compositing; the decoded frames are otherwise identical
    const q = { ...p, clips: [{ ...p.clips![0]!, opacity: 0.999 }] } as ProjectFile;
    const a = join(dir, 'fast.webm'), b = join(dir, 'slow.webm');
    await render(p, a, { baseDir: dir, crf: 0 });
    await render(q, b, { baseDir: dir, crf: 0 });
    const { execFileSync } = await import('node:child_process');
    const psnr = execFileSync('sh', ['-c', `ffmpeg -hide_banner -nostdin -i '${a}' -i '${b}' -lavfi psnr -f null - 2>&1`]).toString();
    const avg = /average:(inf|[\d.]+)/.exec(psnr)?.[1];
    expect(avg === 'inf' || Number(avg) > 45).toBe(true);
  });
});
