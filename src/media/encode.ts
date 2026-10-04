/** Encoding: raw RGBA frames piped to one ffmpeg process; audio transcode; concat without re-encoding. */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fail } from '../core/errors.js';
import { rateToString, type Rate } from '../core/time.js';
import type { RGBAFrame } from '../render/types.js';
import { getFfmpeg } from './ffmpeg.js';
import { procError, run } from './proc.js';
import type { DeliveryOptions, EncodeOptions, FfmpegInfo, FrameSink } from './types.js';

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

const bt709 = (range: 'tv' | 'pc') => ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', range];

const PRORES_PROFILE: Record<NonNullable<DeliveryOptions['prores']>, number> = { proxy: 0, lt: 1, '422': 2, hq: 3, '4444': 4, '4444xq': 5 };
const TIMECODE = /^(\d{2}):([0-5]\d):([0-5]\d)([:;])(\d{2})$/;

/** Drop-frame timecode exists only at 29.97 (30000/1001) and 59.94 (60000/1001) fps. */
export function isDropFrameRate(rate: Rate): boolean {
  return rate.den > 0 && (rate.num * 1001 === rate.den * 30000 || rate.num * 1001 === rate.den * 60000);
}

/**
 * Check delivery settings against an output format; throws E_ARG with a fix. Returns notes for settings this
 * format does not use (they are ignored, and the caller reports it rather than dropping them silently).
 */
export function checkDelivery(d: DeliveryOptions | undefined, format: EncodeOptions['format'], rate: Rate, alpha = false): string[] {
  const notes: string[] = [];
  if (!d) return notes;
  if (d.crf !== undefined) {
    const max = format === 'webm' ? 63 : 51;
    if (format !== 'mp4' && format !== 'webm') fail('E_ARG', `crf applies to mp4 (x264) and webm (VP9), not ${format}.`, format === 'mov' ? 'choose a ProRes profile instead (prores=proxy|lt|422|hq|4444).' : 'drop crf.');
    if (!(Number.isFinite(d.crf) && d.crf >= 0 && d.crf <= max)) fail('E_ARG', `crf ${d.crf} is out of range for ${format}.`, `use 0–${max} (lower = better; mp4 default 20, webm 32).`);
  }
  for (const [k, v] of [['bitrate', d.bitrate], ['audioBitrate', d.audioBitrate]] as const) {
    if (v !== undefined && !/^\d+(\.\d+)?[kKmM]?$/.test(v)) fail('E_ARG', `${k} "${v}" is not a bitrate.`, `give a number with k or M, e.g. ${k === 'bitrate' ? '8M' : '320k'}.`);
  }
  if (d.bitrate !== undefined && format !== 'mp4' && format !== 'webm') fail('E_ARG', `bitrate applies to mp4 and webm, not ${format}.`, format === 'mov' ? 'ProRes is set by profile: prores=proxy|lt|422|hq|4444.' : 'drop bitrate.');
  if (d.pcmDepth !== undefined && d.pcmDepth !== 16 && d.pcmDepth !== 24) fail('E_ARG', `pcm depth ${String(d.pcmDepth)} is not supported.`, 'use 16 or 24.');
  if (d.prores !== undefined) {
    if (format !== 'mov') fail('E_ARG', `a ProRes profile applies to .mov outputs, not ${format}.`, 'render to .mov, or drop prores.');
    if (!(d.prores in PRORES_PROFILE)) fail('E_ARG', `ProRes profile "${d.prores}" does not exist.`, 'use proxy, lt, 422, hq, 4444 or 4444xq.');
    if (alpha && PRORES_PROFILE[d.prores] < 4) fail('E_ALPHA', `ProRes ${d.prores} cannot carry an alpha channel.`, 'use prores=4444 (or 4444xq) with alpha, or drop alpha.');
  }
  if (d.timecode !== undefined) {
    if (format !== 'mov' && format !== 'mp4') fail('E_ARG', `a start timecode is written to mov and mp4 only, not ${format}.`, 'render to .mov or .mp4, or drop timecode.');
    const m = TIMECODE.exec(d.timecode);
    const fps = Math.round(rate.num / rate.den);
    if (!m) fail('E_ARG', `timecode "${d.timecode}" is not HH:MM:SS:FF.`, 'write it like 10:00:00:00 (";" before the frames for drop-frame, e.g. 10:00:00;00).');
    if (Number(m[5]) >= fps) fail('E_ARG', `timecode "${d.timecode}" has frame ${m[5]}, but the comp runs at ${fps} fps.`, `use frames 00–${String(fps - 1).padStart(2, '0')}.`);
    if (m[4] === ';' && !isDropFrameRate(rate)) fail('E_ARG', `drop-frame timecode (";") needs a 29.97 or 59.94 fps comp; this one is ${(rate.num / rate.den).toFixed(3)} fps.`, `use ":" before the frames: ${d.timecode.replace(';', ':')}.`);
  }
  if (d.colorRange !== undefined && d.colorRange !== 'tv' && d.colorRange !== 'pc') fail('E_ARG', `colour range "${String(d.colorRange)}" is not valid.`, 'use tv (limited, the default) or pc (full).');
  if (d.pcmDepth !== undefined && format !== 'mov') {
    notes.push(format === 'gif' || format === 'png' || format === 'apng'
      ? `pcmDepth ${d.pcmDepth} ignored: ${format} outputs carry no audio`
      : `pcmDepth ${d.pcmDepth} ignored: ${format} audio is ${format === 'webm' ? 'Opus' : 'AAC'}, not PCM (render to .mov or .wav for ${d.pcmDepth}-bit PCM; audioBitrate sets the ${format} audio quality)`);
  }
  if (d.audioBitrate !== undefined && format !== 'mp4' && format !== 'webm') {
    notes.push(format === 'mov'
      ? `audioBitrate ${d.audioBitrate} ignored: mov audio is uncompressed PCM (pcmDepth sets 16 or 24 bit)`
      : `audioBitrate ${d.audioBitrate} ignored: ${format} outputs carry no audio`);
  }
  return notes;
}

function need(ff: FfmpegInfo, enc: string, what: string) {
  if (!ff.encoders.includes(enc)) fail('E_FFMPEG', `this ffmpeg has no ${enc} encoder (needed for ${what}).`, 'run "mgl doctor --fetch" for a full build, or choose another output format.');
}

/** "8M" → "16M" (the VBV buffer for a capped rate) */
function doubleRate(b: string): string {
  const m = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(b);
  return m ? `${Number(m[1]) * 2}${m[2]}` : b;
}

/** The ffmpeg arguments for an encode (exported for tests and `render --print-cmd`). */
export function encodeArgs(o: EncodeOptions, ff: FfmpegInfo): string[] {
  const a = ['-hide_banner', '-nostdin', '-v', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${o.width}x${o.height}`, '-framerate', rateToString(o.rate), '-i', 'pipe:0'];
  const withAudio = !!o.audio && !['gif', 'png', 'apng'].includes(o.format);
  if (withAudio) a.push('-i', o.audio!);
  a.push('-map', '0:v:0');
  if (withAudio) a.push('-map', '1:a:0');
  const d = o.delivery ?? {};
  const range = d.colorRange ?? 'tv';
  const BT709 = bt709(range);
  const even = 'crop=trunc(iw/2)*2:trunc(ih/2)*2';
  const toYuv = (fmt: string) => `${even},scale=out_color_matrix=bt709:out_range=${range}:flags=bicubic+accurate_rnd+full_chroma_int,format=${fmt}`;
  const tc = d.timecode ? ['-timecode', d.timecode] : [];
  switch (o.format) {
    case 'mp4': {
      need(ff, 'libx264', 'mp4');
      const q = X264[o.quality];
      const rc = d.bitrate && d.crf === undefined
        ? ['-b:v', d.bitrate, '-maxrate', d.bitrate, '-bufsize', doubleRate(d.bitrate)]
        : ['-crf', String(d.crf ?? q.crf), ...(d.bitrate ? ['-maxrate', d.bitrate, '-bufsize', doubleRate(d.bitrate)] : [])];
      a.push('-vf', toYuv('yuv420p'), '-c:v', 'libx264', '-preset', q.preset, ...rc, '-pix_fmt', 'yuv420p', ...BT709, ...tc, '-movflags', '+faststart');
      if (withAudio) a.push('-c:a', 'aac', '-b:a', d.audioBitrate ?? q.abr, '-ar', '48000');
      a.push('-f', 'mp4');
      break;
    }
    case 'webm': {
      need(ff, 'libvpx-vp9', 'webm');
      const q = VP9[o.quality];
      const fmt = o.alpha ? 'yuva420p' : 'yuv420p';
      const rc = d.bitrate && d.crf === undefined ? ['-b:v', d.bitrate] : ['-b:v', d.bitrate ?? '0', '-crf', String(d.crf ?? q.crf)];
      a.push('-vf', toYuv(fmt), '-c:v', 'libvpx-vp9', '-pix_fmt', fmt, ...rc, '-deadline', q.deadline, '-cpu-used', q.cpu, '-row-mt', '1', ...BT709);
      if (o.alpha) a.push('-auto-alt-ref', '0');
      if (withAudio) { need(ff, 'libopus', 'webm audio'); a.push('-c:a', 'libopus', '-b:a', d.audioBitrate ?? '128k'); }
      a.push('-f', 'webm');
      break;
    }
    case 'mov': {
      need(ff, 'prores_ks', 'mov');
      const profile = PRORES_PROFILE[d.prores ?? (o.alpha ? '4444' : 'hq')];
      if (o.alpha) a.push('-vf', `scale=out_color_matrix=bt709:out_range=${range},format=yuva444p10le`, '-c:v', 'prores_ks', '-profile:v', String(profile), '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16');
      else if (profile >= 4) a.push('-vf', `scale=out_color_matrix=bt709:out_range=${range},format=yuv444p10le`, '-c:v', 'prores_ks', '-profile:v', String(profile), '-pix_fmt', 'yuv444p10le');
      else a.push('-vf', `${even},scale=out_color_matrix=bt709:out_range=${range},format=yuv422p10le`, '-c:v', 'prores_ks', '-profile:v', String(profile), '-pix_fmt', 'yuv422p10le');
      a.push('-vendor', 'apl0', ...BT709, ...tc);
      if (withAudio) a.push('-c:a', d.pcmDepth === 24 ? 'pcm_s24le' : 'pcm_s16le');
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
export async function transcodeAudio(wav: string, out: string, opts: { bitrate?: string; pcmDepth?: 16 | 24 } = {}): Promise<void> {
  const ff = await getFfmpeg();
  const ext = extname(out).toLowerCase();
  let codec: string[];
  switch (ext) {
    case '.mp3': need(ff, 'libmp3lame', 'mp3'); codec = ['-c:a', 'libmp3lame', '-b:a', opts.bitrate ?? '192k', '-f', 'mp3']; break;
    case '.m4a': codec = ['-c:a', 'aac', '-b:a', opts.bitrate ?? '192k', '-movflags', '+faststart', '-f', 'mp4']; break;
    case '.aac': codec = ['-c:a', 'aac', '-b:a', opts.bitrate ?? '192k', '-f', 'adts']; break;
    case '.opus': case '.ogg': need(ff, 'libopus', 'opus'); codec = ['-c:a', 'libopus', '-b:a', opts.bitrate ?? '128k', '-f', ext === '.opus' ? 'opus' : 'ogg']; break;
    case '.flac': codec = ['-c:a', 'flac', ...(opts.pcmDepth === 24 ? ['-sample_fmt', 's32'] : []), '-f', 'flac']; break;
    case '.wav': codec = ['-c:a', opts.pcmDepth === 24 ? 'pcm_s24le' : 'pcm_s16le', '-f', 'wav']; break;
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
