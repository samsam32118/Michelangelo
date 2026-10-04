import { afterAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { encode, transcodeAudio, concat, encodeArgs } from '../../src/media/encode.js';
import { getFfmpeg } from '../../src/media/ffmpeg.js';
import { grab } from '../../src/media/decode.js';
import type { RGBAFrame } from '../../src/render/types.js';
import { ff, ffprobeJson, tempDir } from './media-fixtures.js';

const t = tempDir();
const f = (n: string) => join(t.dir, n);
afterAll(() => t.cleanup());

const rate = { num: 30, den: 1 };
function frame(w: number, h: number, i: number, alpha = 255): RGBAFrame {
  const data = Buffer.alloc(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    const x = p % w;
    data[p * 4] = x < w / 2 ? 200 : 20;
    data[p * 4 + 1] = (i * 8) & 255;
    data[p * 4 + 2] = 60;
    data[p * 4 + 3] = x < w / 4 ? 0 : alpha;
  }
  return { width: w, height: h, data };
}
async function writeAll(o: Parameters<typeof encode>[0], n: number) {
  const sink = await encode(o);
  for (let i = 0; i < n; i++) await sink.write(frame(o.width, o.height, i));
  await sink.finish();
}
const video = (file: string) => ffprobeJson(file).streams.find((s) => s.codec_type === 'video')!;

describe('encode', () => {
  it('mp4: H.264 yuv420p BT.709 tagged with AAC audio', async () => {
    ff(['-f', 'lavfi', '-i', 'sine=f=440:d=1:sample_rate=48000', '-ac', '2', f('a.wav')]);
    await writeAll({ out: f('o.mp4'), width: 160, height: 90, rate, format: 'mp4', quality: 'draft', audio: f('a.wav') }, 30);
    const j = ffprobeJson(f('o.mp4'));
    const v = j.streams.find((s) => s.codec_type === 'video')!;
    expect(v).toMatchObject({ codec_name: 'h264', pix_fmt: 'yuv420p', width: 160, height: 90, color_space: 'bt709', color_primaries: 'bt709', color_transfer: 'bt709', color_range: 'tv', nb_frames: '30' });
    expect(j.streams.find((s) => s.codec_type === 'audio')).toMatchObject({ codec_name: 'aac', sample_rate: '48000' });
    // colour round trip: the left half (R=200, G=0, B=60) decodes back within a few levels
    const back = await grab(f('o.mp4'), 0, rate, { noCache: true });
    const px = back.data.subarray((45 * 160 + 60) * 4, (45 * 160 + 60) * 4 + 3);
    expect(Math.abs(px[0]! - 200)).toBeLessThan(6);
    expect(Math.abs(px[1]! - 0)).toBeLessThan(6);
    expect(Math.abs(px[2]! - 60)).toBeLessThan(6);
  });
  it('webm VP9 (with alpha), ProRes mov (422 and 4444), gif, png', async () => {
    await writeAll({ out: f('o.webm'), width: 64, height: 48, rate, format: 'webm', quality: 'draft', alpha: true }, 10);
    expect(video(f('o.webm'))).toMatchObject({ codec_name: 'vp9', width: 64, height: 48 });
    expect(ffprobeJson(f('o.webm')).streams[0]!.tags?.alpha_mode ?? ffprobeJson(f('o.webm')).streams[0]!.tags?.ALPHA_MODE).toBe('1');
    const a = await grab(f('o.webm'), 2, rate, { noCache: true });
    expect(a.data[(10 * 64 + 2) * 4 + 3]).toBeLessThan(30); // transparent quarter survives
    expect(a.data[(10 * 64 + 40) * 4 + 3]).toBeGreaterThan(220);

    await writeAll({ out: f('o.mov'), width: 64, height: 48, rate, format: 'mov', quality: 'final' }, 5);
    expect(video(f('o.mov'))).toMatchObject({ codec_name: 'prores', profile: 'HQ', pix_fmt: 'yuv422p10le' });
    await writeAll({ out: f('a.mov'), width: 64, height: 48, rate, format: 'mov', quality: 'final', alpha: true }, 5);
    expect(video(f('a.mov'))).toMatchObject({ codec_name: 'prores', profile: '4444', pix_fmt: expect.stringMatching(/^yuva444p1[02]le$/) });
    const m = await grab(f('a.mov'), 1, rate, { noCache: true });
    expect(m.data[(10 * 64 + 2) * 4 + 3]).toBeLessThan(10);

    await writeAll({ out: f('o.gif'), width: 64, height: 48, rate, format: 'gif', quality: 'final', gif: { fps: 10, width: 32, loop: true } }, 30);
    const g = video(f('o.gif'));
    expect(g).toMatchObject({ codec_name: 'gif', width: 32, height: 24 });
    expect(Number(g.nb_frames ?? 10)).toBeLessThanOrEqual(11);

    await writeAll({ out: f('o.png'), width: 64, height: 48, rate, format: 'png', quality: 'final' }, 3);
    expect(video(f('o.png'))).toMatchObject({ codec_name: 'png', width: 64, height: 48 });
  });
  it('rejects frames of the wrong size and surfaces encoder failures', async () => {
    const sink = await encode({ out: f('bad.mp4'), width: 64, height: 48, rate, format: 'mp4', quality: 'draft' });
    await expect(sink.write(frame(32, 32, 0))).rejects.toMatchObject({ code: 'E_ENCODE' });
    await sink.abort();
    expect(existsSync(f('bad.mp4'))).toBe(false);
    const s2 = await encode({ out: join(t.dir, 'no/such/dir/x.mp4'), width: 64, height: 48, rate, format: 'mp4', quality: 'draft' });
    let err: unknown;
    try { for (let i = 0; i < 200; i++) await s2.write(frame(64, 48, i)); await s2.finish(); } catch (e) { err = e; }
    expect(err).toMatchObject({ code: 'E_MEDIA' });
  });
  it('x264 presets by quality', async () => {
    const ffi = await getFfmpeg();
    const args = (q: 'draft' | 'final' | 'hq') => encodeArgs({ out: 'x.mp4', width: 2, height: 2, rate, format: 'mp4', quality: q }, ffi).join(' ');
    expect(args('draft')).toContain('-preset ultrafast -crf 28');
    expect(args('final')).toContain('-preset veryfast -crf 20');
    expect(args('hq')).toContain('-preset medium -crf 18');
    expect(args('final')).toContain('out_color_matrix=bt709:out_range=tv');
    expect(args('final')).toContain('+faststart');
  });
});

describe('audio transcode and concat', () => {
  it('transcodes a WAV to mp3, m4a, opus, flac', async () => {
    ff(['-f', 'lavfi', '-i', 'sine=f=440:d=1:sample_rate=48000', '-ac', '2', f('t.wav')]);
    const want: Record<string, string> = { 'x.mp3': 'mp3', 'x.m4a': 'aac', 'x.opus': 'opus', 'x.flac': 'flac', 'x.wav': 'pcm_s16le' };
    for (const [file, codec] of Object.entries(want)) {
      await transcodeAudio(f('t.wav'), f(file));
      expect(ffprobeJson(f(file)).streams[0]!.codec_name).toBe(codec);
    }
    await expect(transcodeAudio(f('t.wav'), f('x.xyz'))).rejects.toMatchObject({ code: 'E_FORMAT' });
  });
  it('joins segments without re-encoding', async () => {
    await writeAll({ out: f('s1.mp4'), width: 64, height: 48, rate, format: 'mp4', quality: 'draft' }, 15);
    await writeAll({ out: f('s2.mp4'), width: 64, height: 48, rate, format: 'mp4', quality: 'draft' }, 15);
    await concat([f('s1.mp4'), f('s2.mp4')], f('joined.mp4'));
    expect(video(f('joined.mp4')).nb_frames).toBe('30');
    expect(statSync(f('joined.mp4')).size).toBeGreaterThan(0);
  });
});
