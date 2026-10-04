/**
 * ffprobe → MediaInfo, and a per-asset video frame index (sorted PTS) for frame-accurate mapping.
 * Both are cached as JSON keyed by path + size + mtime.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile, rename } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { fail } from '../core/errors.js';
import type { Rate } from '../core/time.js';
import { cacheRoot, getFfmpeg } from './ffmpeg.js';
import { run } from './proc.js';
import type { MediaInfo } from './types.js';

export interface ProbeOptions { cacheDir?: string; noCache?: boolean }

/** Extra probe facts the decoders need (additive to MediaInfo). */
export interface MediaInfoExt extends MediaInfo {
  /** container start (s): -ss is relative to this */
  formatStart?: number;
  colorRange?: string;
  /** VP8/VP9 with an alpha channel (needs the libvpx decoder) */
  alpha?: boolean;
  /** number of video frames when the container says */
  frames?: number;
  /** first audio sample time (s, container clock) */
  audioStart?: number;
}

const IMAGE_FORMATS = /(^|,)(image2|png_pipe|jpeg_pipe|webp_pipe|bmp_pipe|tiff_pipe|gif_pipe|svg_pipe|qoi_pipe|jpegxl_pipe|pam_pipe|ppm_pipe|psd_pipe)(,|$)/;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.avif', '.jxl']);

function ratio(s: string | undefined): Rate | undefined {
  const m = /^(\d+)\/(\d+)$/.exec(s ?? '');
  if (!m || Number(m[2]) === 0 || Number(m[1]) === 0) return undefined;
  const num = Number(m[1]), den = Number(m[2]);
  let a = num, b = den;
  while (b) [a, b] = [b, a % b];
  return { num: num / a, den: den / a };
}

const num = (v: unknown): number | undefined => (v === undefined || v === 'N/A' || v === null || Number.isNaN(Number(v)) ? undefined : Number(v));

async function cacheKey(file: string): Promise<{ key: string; size: number }> {
  const abs = resolve(file);
  let st;
  try { st = await stat(abs); } catch { fail('E_MEDIA_MISSING', `media file ${file} does not exist.`, 'check the path (relative to the project file) or relink the asset: mgl edit <project> asset.relink <id> src=<path>.'); }
  if (!st.isFile()) fail('E_MEDIA_MISSING', `${file} is not a file.`, 'point the asset at a media file.');
  return { key: createHash('sha1').update(`${abs}\0${st.size}\0${st.mtimeMs}`).digest('hex'), size: st.size };
}

async function readCache<T>(dir: string, key: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(join(dir, key + '.json'), 'utf8')) as T; } catch { return undefined; }
}

async function writeCache(dir: string, key: string, v: unknown): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `${key}.${process.pid}.tmp`);
    await writeFile(tmp, JSON.stringify(v));
    await rename(tmp, join(dir, key + '.json'));
  } catch { /* caches are best effort */ }
}

const probeMemo = new Map<string, Promise<MediaInfoExt>>();

/** Probe a media file (cached). Width/height are after display rotation. */
export async function probe(file: string, opts: ProbeOptions = {}): Promise<MediaInfoExt> {
  const { key, size } = await cacheKey(file);
  const dir = opts.cacheDir ?? join(cacheRoot(), 'probe');
  const memoKey = dir + key;
  if (!opts.noCache && probeMemo.has(memoKey)) return probeMemo.get(memoKey)!;
  const p = (async () => {
    if (!opts.noCache) {
      const hit = await readCache<MediaInfoExt>(dir, 'p-' + key);
      if (hit) return hit;
    }
    const info = await probeUncached(file, size);
    if (!opts.noCache) await writeCache(dir, 'p-' + key, info);
    return info;
  })();
  if (!opts.noCache) { probeMemo.set(memoKey, p); p.catch(() => probeMemo.delete(memoKey)); }
  return p;
}

interface FfStream {
  codec_type?: string; codec_name?: string; width?: number; height?: number; r_frame_rate?: string; avg_frame_rate?: string;
  start_time?: string; duration?: string; nb_frames?: string; pix_fmt?: string; color_transfer?: string; color_primaries?: string;
  color_space?: string; color_range?: string; sample_rate?: string; channels?: number; tags?: Record<string, string>;
  side_data_list?: { rotation?: number }[]; disposition?: { attached_pic?: number };
}

export async function probeUncached(file: string, size?: number): Promise<MediaInfoExt> {
  const ff = await getFfmpeg();
  const r = await run(ff.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], {
    allowFail: true,
  });
  if (r.code !== 0) fail('E_MEDIA', `${file} is not a readable media file: ${r.stderr.trim().split('\n').pop() ?? ''}`, 'check the file (is it complete? a supported format?) or replace the asset.');
  const j = JSON.parse(r.stdout.toString() || '{}') as { streams?: FfStream[]; format?: { format_name?: string; duration?: string; start_time?: string; size?: string } };
  const streams = j.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === 'audio');
  const fmt = j.format ?? {};
  const isImage = !!v && (IMAGE_FORMATS.test(fmt.format_name ?? '') || (IMAGE_EXT.has(extname(file).toLowerCase()) && !a));
  if (!v && !a) fail('E_MEDIA', `${file} has no audio or video stream.`, 'use a video, audio or image file.');
  const info: MediaInfoExt = {
    kind: isImage ? 'image' : v ? 'video' : 'audio',
    duration: num(fmt.duration) ?? num(v?.duration) ?? num(a?.duration) ?? 0,
    hasAudio: !!a,
    hasVideo: !!v && !isImage,
    size: size ?? Number(fmt.size ?? 0),
  };
  const fs = num(fmt.start_time);
  if (fs !== undefined) info.formatStart = fs;
  if (v) {
    let rot = Number(v.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0);
    if (!rot && v.tags?.rotate) rot = -Number(v.tags.rotate);
    rot = ((Math.round(rot) % 360) + 360) % 360;
    const swap = rot === 90 || rot === 270;
    info.width = swap ? v.height : v.width;
    info.height = swap ? v.width : v.height;
    if (rot) info.rotation = rot;
    info.videoCodec = v.codec_name;
    if (v.pix_fmt) info.pixFmt = v.pix_fmt;
    if (v.color_transfer && v.color_transfer !== 'unknown') info.colorTransfer = v.color_transfer;
    if (v.color_primaries && v.color_primaries !== 'unknown') info.colorPrimaries = v.color_primaries;
    if (v.color_space && v.color_space !== 'unknown') info.colorSpace = v.color_space;
    if (v.color_range && v.color_range !== 'unknown') info.colorRange = v.color_range;
    if (v.tags?.alpha_mode === '1' || v.tags?.ALPHA_MODE === '1') info.alpha = true;
    if (!isImage) {
      const rf = ratio(v.r_frame_rate), af = ratio(v.avg_frame_rate);
      const fps = af && af.num / af.den < 1000 ? af : rf;
      if (fps) info.fps = fps;
      if (rf && af && Math.abs(rf.num / rf.den - af.num / af.den) / (rf.num / rf.den) > 0.01) info.vfr = true;
      const st = num(v.start_time);
      if (st !== undefined) info.startTime = st;
      const nf = num(v.nb_frames);
      if (nf !== undefined) info.frames = nf;
    }
  }
  if (a) {
    info.audioCodec = a.codec_name;
    const sr = num(a.sample_rate);
    if (sr) info.sampleRate = sr;
    if (a.channels) info.channels = a.channels;
    const as = num(a.start_time);
    if (as !== undefined) info.audioStart = as;
    if (!v && info.startTime === undefined) { const st = num(a.start_time); if (st !== undefined) info.startTime = st; }
  }
  return info;
}

/** Display order PTS of every video frame, seconds from the first frame. */
export interface FrameIndex {
  /** seconds from the first video frame, ascending */
  pts: number[];
  /** first video frame time relative to the container start (what -ss counts from) */
  offset: number;
  vfr: boolean;
  /** median frame duration (s) */
  frameDur: number;
  /** the stream's time base (s per tick); WebM/MKV use 1 ms, so their PTS are rounded to the millisecond */
  tb?: number;
}

const indexMemo = new Map<string, Promise<FrameIndex>>();

/** Build (or load) the frame index of a video file. */
export async function frameIndex(file: string, opts: ProbeOptions = {}): Promise<FrameIndex> {
  const { key } = await cacheKey(file);
  const dir = opts.cacheDir ?? join(cacheRoot(), 'probe');
  const memoKey = dir + key;
  if (!opts.noCache && indexMemo.has(memoKey)) return indexMemo.get(memoKey)!;
  const p = (async () => {
    if (!opts.noCache) {
      const hit = await readCache<FrameIndex>(dir, 'i2-' + key);
      if (hit) return hit;
    }
    const idx = await buildIndex(file, opts);
    if (!opts.noCache) await writeCache(dir, 'i2-' + key, idx);
    return idx;
  })();
  if (!opts.noCache) { indexMemo.set(memoKey, p); p.catch(() => indexMemo.delete(memoKey)); }
  return p;
}

async function buildIndex(file: string, opts: ProbeOptions): Promise<FrameIndex> {
  const ff = await getFfmpeg();
  const info = await probe(file, opts);
  if (!info.hasVideo) fail('E_MEDIA', `${file} has no video stream to index.`, 'use a video file for a video clip.');
  const r = await run(ff.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=time_base:packet=pts,flags', '-of', 'csv=p=0', file]);
  const lines = r.stdout.toString().split('\n');
  let tb = 0;
  const raw: number[] = [];
  for (const line of lines) {
    const parts = line.trim().split(',');
    if (parts.length === 1 && /^\d+\/\d+$/.test(parts[0]!)) { const [n, d] = parts[0]!.split('/').map(Number); tb = n! / d!; continue; }
    if (parts.length >= 2 && parts[0] !== 'N/A' && parts[0] !== '' && !parts[1]!.includes('D')) raw.push(Number(parts[0]));
  }
  // the time_base line can come after the packets
  if (!tb) { const m = /(\d+)\/(\d+)/.exec(r.stdout.toString()); tb = m ? Number(m[1]) / Number(m[2]) : 1 / 90000; }
  raw.sort((x, y) => x - y);
  const uniq = raw.filter((x, i) => i === 0 || x !== raw[i - 1]);
  if (!uniq.length) fail('E_MEDIA', `${file}: no video frames found.`, 'the file may be truncated; re-export it.');
  const first = uniq[0]!;
  const pts = uniq.map((x) => (x - first) * tb);
  const d: number[] = [];
  for (let i = 1; i < pts.length; i++) d.push(pts[i]! - pts[i - 1]!);
  const sorted = [...d].sort((x, y) => x - y);
  const frameDur = sorted.length ? sorted[sorted.length >> 1]! : info.fps ? info.fps.den / info.fps.num : 1 / 30;
  const vfr = d.some((x) => Math.abs(x - frameDur) > frameDur * 0.25);
  const offset = Math.max(0, first * tb - (info.formatStart ?? 0));
  return { pts, offset, vfr, frameDur, tb };
}

/**
 * Tolerance when comparing a time with frame PTS: PTS are rounded to the stream's time base (1 ms for WebM/MKV,
 * so frame 2 of a 30 fps file is stored as 0.067 s, after the exact 0.0667 s), so allow one tick, but never more
 * than a quarter frame.
 */
export function frameEpsilon(idx: Pick<FrameIndex, 'frameDur' | 'tb'>): number {
  const fd = idx.frameDur > 0 ? idx.frameDur : 1 / 30;
  return Math.min(fd * 0.25, Math.max(Math.min(1e-4, fd * 0.01), idx.tb ?? 0));
}

/** Index (into `idx.pts`) of the source frame on screen at `t` seconds from the first frame (the last frame starting at or before t). */
export function frameAtTime(idx: FrameIndex, t: number): number {
  const eps = frameEpsilon(idx);
  const pts = idx.pts;
  let lo = 0, hi = pts.length - 1;
  if (t <= pts[0]! + eps) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pts[mid]! <= t + eps) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Source frame shown at `sourceFrame` frames of `rate` (exact rational time → nearest earlier source frame). */
export function sourceFrameAt(idx: FrameIndex, sourceFrame: number, rate: Rate): { index: number; time: number } {
  const t = (sourceFrame * rate.den) / rate.num;
  const index = frameAtTime(idx, t);
  return { index, time: idx.pts[index]! };
}
