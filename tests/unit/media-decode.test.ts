import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { grab, openVideo, decodeImage, FfmpegVideoReader, buildVideoFilter } from '../../src/media/decode.js';
import { getFfmpeg } from '../../src/media/ffmpeg.js';
import { getMediaBackend } from '../../src/media/index.js';
import { probe, frameIndex, sourceFrameAt } from '../../src/media/probe.js';
import { ff, makeCounter, readCounter, tempDir } from './media-fixtures.js';

const t = tempDir();
const cacheDir = join(t.dir, 'cache');
const f = (n: string) => join(t.dir, n);

beforeAll(() => {
  makeCounter(f('c24.mp4'), { fps: 24, seconds: 3 });
  makeCounter(f('c30.mp4'), { fps: 30, seconds: 4, w: 1280, h: 720 });
  makeCounter(f('c2997.mp4'), { fps: '30000/1001', seconds: 2 });
  makeCounter(f('hevc0.mp4'), { fps: 25, seconds: 2, w: 320, h: 240, codec: ['-c:v', 'libx265', '-x265-params', 'log-level=error', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p'] });
  ff(['-display_rotation', '90', '-i', f('hevc0.mp4'), '-c', 'copy', f('hevc-rot.mp4')]);
  makeCounter(f('prores.mov'), { fps: 24, seconds: 1, codec: ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le'] });
  // VFR: 10 fps for 1 s then 30 fps for 1 s (counter keeps counting frames)
  makeCounter(f('vfr-src.mkv'), { fps: 30, seconds: 2, codec: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'] });
  ff(['-i', f('vfr-src.mkv'), '-vf', "select='if(lt(n,30),not(mod(n,3)),1)'", '-fps_mode', 'vfr', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('vfr.mp4')]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=200x100:d=1', '-frames:v', '1', f('still.png')]);
  ff(['-f', 'lavfi', '-i', 'sine=f=440:d=1', f('tone.wav')]);
}, 60_000);
afterAll(() => t.cleanup());

describe('probe', () => {
  it('reads an H.264 mp4', async () => {
    const i = await probe(f('c24.mp4'), { cacheDir });
    expect(i).toMatchObject({ kind: 'video', width: 320, height: 180, videoCodec: 'h264', hasAudio: false, hasVideo: true, fps: { num: 24, den: 1 } });
    expect(i.duration).toBeCloseTo(3, 1);
    expect(i.vfr).toBeFalsy();
    // cached: the second call is answered from the JSON cache
    expect(await probe(f('c24.mp4'), { cacheDir })).toEqual(i);
  });
  it('applies HEVC rotation metadata to width/height', async () => {
    const i = await probe(f('hevc-rot.mp4'), { cacheDir });
    expect(i.videoCodec).toBe('hevc');
    expect(i.rotation).toBe(90);
    expect([i.width, i.height]).toEqual([240, 320]);
    const fr = await grab(f('hevc-rot.mp4'), 0, { num: 25, den: 1 }, { cacheDir });
    expect([fr.width, fr.height]).toEqual([240, 320]);
  });
  it('reads ProRes .mov, 29.97, audio and images', async () => {
    expect(await probe(f('prores.mov'), { cacheDir })).toMatchObject({ kind: 'video', videoCodec: 'prores', fps: { num: 24, den: 1 } });
    expect((await probe(f('c2997.mp4'), { cacheDir })).fps).toEqual({ num: 30000, den: 1001 });
    expect(await probe(f('tone.wav'), { cacheDir })).toMatchObject({ kind: 'audio', hasAudio: true, hasVideo: false, sampleRate: 44100 });
    expect(await probe(f('still.png'), { cacheDir })).toMatchObject({ kind: 'image', width: 200, height: 100 });
  });
  it('fails with a fix for a missing file', async () => {
    await expect(probe(f('nope.mp4'), { cacheDir })).rejects.toMatchObject({ code: 'E_MEDIA_MISSING', fix: expect.stringContaining('relink') });
  });
  it('builds a frame index and detects VFR', async () => {
    const idx = await frameIndex(f('c24.mp4'), { cacheDir });
    expect(idx.pts.length).toBe(72);
    expect(idx.vfr).toBe(false);
    expect(idx.pts[1]).toBeCloseTo(1 / 24, 4);
    const v = await frameIndex(f('vfr.mp4'), { cacheDir });
    expect(v.vfr).toBe(true);
    expect(v.pts.length).toBe(40);
    // at 30 fps comp frame 45 (1.5 s): VFR frame 10 + 15 = 25
    expect(sourceFrameAt(v, 45, { num: 30, den: 1 }).index).toBe(25);
  });
});

describe('grab', () => {
  it('returns the exact frame (24 fps, B-frames, mid-GOP)', async () => {
    for (const n of [0, 1, 13, 37, 59, 71]) {
      const fr = await grab(f('c24.mp4'), n, { num: 24, den: 1 }, { cacheDir });
      expect(readCounter(fr)).toBe(n);
    }
  });
  it('maps comp frames at another rate to the source frame on screen', async () => {
    // comp 30 fps: frame 10 = 0.333 s → source frame 8 (8/24 = 0.333)
    expect(readCounter(await grab(f('c24.mp4'), 10, { num: 30, den: 1 }, { cacheDir }))).toBe(8);
    expect(readCounter(await grab(f('c24.mp4'), 11, { num: 30, den: 1 }, { cacheDir }))).toBe(8);
    // 29.97 source at its own rate
    expect(readCounter(await grab(f('c2997.mp4'), 47, { num: 30000, den: 1001 }, { cacheDir }))).toBe(47);
    // ProRes
    expect(readCounter(await grab(f('prores.mov'), 17, { num: 24, den: 1 }, { cacheDir }))).toBe(17);
  });
  it('scales into maxSize keeping aspect, never enlarging', async () => {
    const a = await grab(f('c30.mp4'), 5, { num: 30, den: 1 }, { cacheDir, maxSize: { w: 640, h: 640 } });
    expect([a.width, a.height]).toEqual([640, 360]);
    expect(readCounter(a)).toBe(5);
    const b = await grab(f('c24.mp4'), 5, { num: 24, den: 1 }, { cacheDir, maxSize: { w: 1920, h: 1080 } });
    expect([b.width, b.height]).toEqual([320, 180]);
  });
  it('applies allowed source filters and refuses others', async () => {
    const neg = await grab(f('c24.mp4'), 37, { num: 24, den: 1 }, { cacheDir, filters: [{ filter: 'negate' }] });
    expect(readCounter(neg)).toBe(~37 & 1023);
    // values with commas and quotes survive both escaping levels
    const g = await grab(f('c24.mp4'), 37, { num: 24, den: 1 }, { cacheDir, filters: [{ filter: 'geq', args: { lum: '255-lum(X,Y)', cb: 'cb(X,Y)', cr: 'cr(X,Y)' } }] });
    expect(readCounter(g)).toBe(~37 & 1023);
    await expect(grab(f('c24.mp4'), 0, { num: 24, den: 1 }, { cacheDir, filters: [{ filter: 'movie', args: { filename: '/etc/passwd' } }] })).rejects.toMatchObject({ code: 'E_FILTER' });
  });
});

describe('VideoReader', () => {
  it('streams sequential frames from one process and conforms 24 → 30', async () => {
    const r = (await openVideo(f('c24.mp4'), { rate: { num: 30, den: 1 }, cacheDir })) as FfmpegVideoReader;
    const got: number[] = [];
    for (let i = 0; i < 60; i++) got.push(readCounter(await r.frame(i, { num: 30, den: 1 })));
    expect(got).toEqual(Array.from({ length: 60 }, (_, i) => Math.floor((i * 24) / 30)));
    expect(r.opens).toBe(1);
    expect(r.decoded).toBe(48);
    // backwards → reopen; far forward → reopen
    expect(readCounter(await r.frame(3, { num: 30, den: 1 }))).toBe(2);
    expect(r.opens).toBe(2);
    expect(readCounter(await r.frame(85, { num: 30, den: 1 }))).toBe(68);
    // past the end holds the last frame
    expect(readCounter(await r.frame(500, { num: 30, den: 1 }))).toBe(71);
    await r.close();
  });
  it('handles VFR sources by PTS', async () => {
    const r = await openVideo(f('vfr.mp4'), { rate: { num: 30, den: 1 }, cacheDir });
    // first second: the source shows frames 0,3,6,... at 10 fps (VFR index i shows counter 3i)
    expect(readCounter(await r.frame(0, { num: 30, den: 1 }))).toBe(0);
    expect(readCounter(await r.frame(4, { num: 30, den: 1 }))).toBe(3);
    expect(readCounter(await r.frame(29, { num: 30, den: 1 }))).toBe(27);
    expect(readCounter(await r.frame(45, { num: 30, den: 1 }))).toBe(45);
    await r.close();
  });
  it('decodes images', async () => {
    const img = await decodeImage(f('still.png'));
    expect([img.width, img.height]).toEqual([200, 100]);
    expect(img.data.length).toBe(200 * 100 * 4);
    const small = await decodeImage(f('still.png'), { w: 50, h: 50 });
    expect([small.width, small.height]).toEqual([50, 25]);
  });
});

describe('colour', () => {
  it('picks the input matrix from metadata and size; tone-maps HDR when zscale exists', async () => {
    const ffi = await getFfmpeg();
    const base = { kind: 'video' as const, duration: 1, hasAudio: false, hasVideo: true, size: 1, pixFmt: 'yuv420p' };
    expect(buildVideoFilter({ ...base, width: 1920, height: 1080 }, ffi, {})).toContain('in_color_matrix=bt709');
    expect(buildVideoFilter({ ...base, width: 640, height: 480 }, ffi, {})).toContain('in_color_matrix=bt601');
    expect(buildVideoFilter({ ...base, width: 640, height: 480, colorSpace: 'bt709', colorRange: 'pc' }, ffi, {})).toMatch(/in_color_matrix=bt709:in_range=full/);
    const notes: string[] = [];
    const hdr = buildVideoFilter({ ...base, width: 3840, height: 2160, colorTransfer: 'smpte2084', colorSpace: 'bt2020nc', pixFmt: 'yuv420p10le' }, ffi, {}, notes);
    if (ffi.filters.includes('zscale')) expect(hdr).toContain('tonemap=hable');
    expect(notes[0]).toMatch(/HDR/);
    const noZ = buildVideoFilter({ ...base, width: 3840, height: 2160, colorTransfer: 'arib-std-b67' }, { ...ffi, filters: [] }, {}, notes);
    expect(noZ).not.toContain('tonemap');
    expect(notes[1]).toMatch(/fix: mgl doctor --fetch/);
  });
  it('the backend object wires every method', async () => {
    const mb = getMediaBackend({ cacheDir });
    expect((await mb.info()).ffmpeg).toBeTruthy();
    expect((await mb.probe(f('c24.mp4'))).kind).toBe('video');
    const r = await mb.openVideo(f('c24.mp4'), { rate: { num: 24, den: 1 } });
    expect(readCounter(await r.frame(5, { num: 24, den: 1 }))).toBe(5);
    await r.close();
  });
});
