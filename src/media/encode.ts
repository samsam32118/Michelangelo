/** Encoding: raw RGBA frames piped to one ffmpeg process; audio transcode; concat without re-encoding. */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fail } from '../core/errors.js';
import { rateToString } from '../core/time.js';
import type { RGBAFrame } from '../render/types.js';
import { getFfmpeg } from './ffmpeg.js';
import { procError, run } from './proc.js';
import type { EncodeOptions, FfmpegInfo, FrameSink } from './types.js';

const X264: Record<EncodeOptions['quality'], { preset: string; crf: number; abr: string }> = {
  draft: { preset: 'ultrafast', crf: 28, abr: '96k' },
  final: { preset: 'veryfast', crf: 20, abr: '192k' },
  hq: { preset: 'medium', crf: 18, abr: '192k' },
};
const VP9: Record<EncodeOptions['quality'], { deadline: string; cpu: string; crf: number }> = {
  draft: { deadline: 'realtime', cpu: '8', crf: 40 },
  final: { deadline: 'good', cpu: '4', crf: 32 },
  hq: { deadline: 'good', cpu: '2', crf: 24 },
};

const BT709 = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];

function need(ff: FfmpegInfo, enc: string, what: string) {
  if (!ff.encoders.includes(enc)) fail('E_FFMPEG', `this ffmpeg has no ${enc} encoder (needed for ${what}).`, 'run "mgl doctor --fetch" for a full build, or choose another output format.');
}

/** The ffmpeg arguments for an encode (exported for tests and `render --print-cmd`). */
export function encodeArgs(o: EncodeOptions, ff: FfmpegInfo): string[] {
  const a = ['-hide_banner', '-nostdin', '-v', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${o.width}x${o.height}`, '-framerate', rateToString(o.rate), '-i', 'pipe:0'];
  const withAudio = !!o.audio && !['gif', 'png', 'apng'].includes(o.format);
  if (withAudio) a.push('-i', o.audio!);
  a.push('-map', '0:v:0');
  if (withAudio) a.push('-map', '1:a:0');
  const even = 'crop=trunc(iw/2)*2:trunc(ih/2)*2';
  const toYuv = (fmt: string) => `${even},scale=out_color_matrix=bt709:out_range=tv:flags=bicubic+accurate_rnd+full_chroma_int,format=${fmt}`;
  switch (o.format) {
    case 'mp4': {
      need(ff, 'libx264', 'mp4');
      const q = X264[o.quality];
      a.push('-vf', toYuv('yuv420p'), '-c:v', 'libx264', '-preset', q.preset, '-crf', String(q.crf), '-pix_fmt', 'yuv420p', ...BT709, '-movflags', '+faststart');
      if (withAudio) a.push('-c:a', 'aac', '-b:a', q.abr, '-ar', '48000');
      a.push('-f', 'mp4');
      break;
    }
    case 'webm': {
      need(ff, 'libvpx-vp9', 'webm');
      const q = VP9[o.quality];
      const fmt = o.alpha ? 'yuva420p' : 'yuv420p';
      a.push('-vf', toYuv(fmt), '-c:v', 'libvpx-vp9', '-pix_fmt', fmt, '-b:v', '0', '-crf', String(q.crf), '-deadline', q.deadline, '-cpu-used', q.cpu, '-row-mt', '1', ...BT709);
      if (o.alpha) a.push('-auto-alt-ref', '0');
      if (withAudio) { need(ff, 'libopus', 'webm audio'); a.push('-c:a', 'libopus', '-b:a', '128k'); }
      a.push('-f', 'webm');
      break;
    }
    case 'mov': {
      need(ff, 'prores_ks', 'mov');
      if (o.alpha) a.push('-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuva444p10le', '-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16');
      else a.push('-vf', `${even},scale=out_color_matrix=bt709:out_range=tv,format=yuv422p10le`, '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le');
      a.push('-vendor', 'apl0', ...BT709);
      if (withAudio) a.push('-c:a', 'pcm_s16le');
      a.push('-f', 'mov');
      break;
    }
    case 'gif': {
      const g = o.gif ?? { fps: Math.min(15, o.rate.num / o.rate.den), width: Math.min(o.width, 480), loop: true };
      a.push('-filter_complex', `[0:v]fps=${g.fps},scale=${Math.round(g.width)}:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff:reserve_transparent=0[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle[out]`);
      const i = a.indexOf('-map'); a.splice(i, 2, '-map', '[out]');
      a.push('-loop', g.loop ? '0' : '-1', '-f', 'gif');
      break;
    }
    case 'png':
      a.push('-frames:v', '1', '-c:v', 'png', '-f', 'image2', '-update', '1');
      break;
    case 'apng':
      a.push('-c:v', 'apng', '-plays', '0', '-f', 'apng');
      break;
    default:
      fail('E_FORMAT', `output format "${(o as { format: string }).format}" is not supported.`, 'use mp4, webm, mov, gif, png or apng (audio: wav, mp3, m4a, opus, flac).');
  }
  a.push(o.out);
  return a;
}

/** Start an encoder. Write frames in order, then finish(). write() resolves when ffmpeg can take more (backpressure). */
export async function encode(o: EncodeOptions): Promise<FrameSink> {
  const ff = await getFfmpeg();
  if (!(o.width > 0 && o.height > 0)) fail('E_ENCODE', `output size ${o.width}x${o.height} is not valid.`, 'give a positive width and height.');
  const args = encodeArgs(o, ff);
  const p = spawn(ff.ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  let exited: number | null | undefined;
  let spawnError: Error | null = null;
  p.stderr!.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-50_000); });
  const closed = new Promise<number | null>((r) => p.on('close', (c) => { exited = c; r(c); }));
  p.on('error', (e) => { spawnError = e; });
  p.stdin!.on('error', () => {});
  const frameBytes = o.width * o.height * 4;
  let written = 0;
  const dead = () => procError(ff.ffmpeg, args, stderr || spawnError?.message || 'encoder exited', `encoding ${o.out} stopped`);
  return {
    async write(f: RGBAFrame) {
      if (o.format === 'png' && written >= 1) return;
      if (f.width !== o.width || f.height !== o.height || f.data.byteLength !== frameBytes) {
        fail('E_ENCODE', `frame ${written} is ${f.width}x${f.height} (${f.data.byteLength} bytes); the encoder expects ${o.width}x${o.height} RGBA.`, 'render frames at the output size.');
      }
      if (exited !== undefined || spawnError) throw dead();
      written++;
      const buf = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data.buffer, f.data.byteOffset, f.data.byteLength);
      if (!p.stdin!.write(buf)) {
        await Promise.race([new Promise<void>((r) => p.stdin!.once('drain', () => r())), closed]);
        if (exited !== undefined) throw dead();
      }
    },
    async finish() {
      if (written === 0) { p.kill('SIGKILL'); await closed; fail('E_ENCODE', `no frames were written to ${o.out}.`, 'render at least one frame.'); }
      p.stdin!.end();
      const code = await closed;
      if (code !== 0) throw dead();
    },
    async abort() {
      p.kill('SIGKILL');
      await closed;
      await rm(o.out, { force: true });
    },
  };
}

/** Encode a WAV to the format named by `out`'s extension (mp3, m4a/aac, opus/ogg, flac, wav). */
export async function transcodeAudio(wav: string, out: string, opts: { bitrate?: string } = {}): Promise<void> {
  const ff = await getFfmpeg();
  const ext = extname(out).toLowerCase();
  let codec: string[];
  switch (ext) {
    case '.mp3': need(ff, 'libmp3lame', 'mp3'); codec = ['-c:a', 'libmp3lame', '-b:a', opts.bitrate ?? '192k', '-f', 'mp3']; break;
    case '.m4a': codec = ['-c:a', 'aac', '-b:a', opts.bitrate ?? '192k', '-movflags', '+faststart', '-f', 'mp4']; break;
    case '.aac': codec = ['-c:a', 'aac', '-b:a', opts.bitrate ?? '192k', '-f', 'adts']; break;
    case '.opus': case '.ogg': need(ff, 'libopus', 'opus'); codec = ['-c:a', 'libopus', '-b:a', opts.bitrate ?? '128k', '-f', ext === '.opus' ? 'opus' : 'ogg']; break;
    case '.flac': codec = ['-c:a', 'flac', '-f', 'flac']; break;
    case '.wav': codec = ['-c:a', 'pcm_s16le', '-f', 'wav']; break;
    default: fail('E_FORMAT', `audio format "${ext || out}" is not supported.`, 'use .wav, .mp3, .m4a, .aac, .opus, .ogg or .flac.');
  }
  await run(ff.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', wav, '-vn', ...codec, out], { what: `encoding ${out}` });
}

/** Join segment files of identical encoding with the concat demuxer (no re-encode). */
export async function concat(parts: string[], out: string): Promise<void> {
  if (!parts.length) fail('E_ENCODE', 'nothing to concatenate.', 'pass at least one segment file.');
  const ff = await getFfmpeg();
  const dir = await mkdtemp(join(tmpdir(), 'mgl-concat-'));
  try {
    const list = join(dir, 'list.txt');
    await writeFile(list, parts.map((p) => `file '${resolve(p).replace(/'/g, "'\\''")}'`).join('\n') + '\n');
    const ext = extname(out).toLowerCase();
    const extra = ext === '.mp4' || ext === '.mov' || ext === '.m4a' ? ['-movflags', '+faststart'] : [];
    await run(ff.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-map', '0', '-c', 'copy', ...extra, out], { what: `joining ${parts.length} segments into ${out}` });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
