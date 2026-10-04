/**
 * Frame-accurate decoding to straight RGBA.
 * Frames come out of ffmpeg as a PAM image stream (self-describing size), in display order with no
 * dropping or duplication; the frame index (probe.ts) says which source frame each one is, so the
 * conform to the comp rate happens here, exactly, instead of in ffmpeg's fps filter.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { extname } from 'node:path';
import { Readable } from 'node:stream';
import { fail } from '../core/errors.js';
import type { Rate } from '../core/time.js';
import type { FilterSpec, RGBAFrame } from '../render/types.js';
import { getFfmpeg } from './ffmpeg.js';
import { filtersToString } from './filters.js';
import { frameIndex, probe, sourceFrameAt, type FrameIndex, type MediaInfoExt, type ProbeOptions } from './probe.js';
import { procError, run } from './proc.js';
import type { FfmpegInfo, OpenVideoOptions, VideoReader } from './types.js';

export interface DecodeOptions extends ProbeOptions {
  maxSize?: { w: number; h: number };
  filters?: FilterSpec[];
  /** directory relative filter files (LUTs) resolve against */
  baseDir?: string;
  /** decoder threads (default: min(4, cores)) */
  threads?: number;
}

/** Reads consecutive PAM images from a stream. */
export class PamReader {
  private chunks: Buffer[] = [];
  private have = 0;
  private ended = false;
  private waiting: (() => void) | null = null;
  private error: Error | null = null;
  constructor(stream: Readable) {
    stream.on('data', (d: Buffer) => {
      this.chunks.push(d);
      this.have += d.length;
      if (this.have > 64 * 1024 * 1024) stream.pause();
      this.wake();
    });
    stream.on('end', () => { this.ended = true; this.wake(); });
    stream.on('error', (e) => { this.error = e; this.ended = true; this.wake(); });
    this.stream = stream;
  }
  private stream: Readable;
  private wake() { const w = this.waiting; this.waiting = null; w?.(); }
  private async need(n: number): Promise<boolean> {
    while (this.have < n) {
      if (this.ended) return false;
      if (this.stream.isPaused()) this.stream.resume();
      await new Promise<void>((r) => (this.waiting = r));
    }
    return true;
  }
  /** The first n bytes (n ≤ have), removed from the queue; touches only the chunks it spans. */
  private take(n: number): Buffer {
    const parts: Buffer[] = [];
    let got = 0;
    while (got < n) {
      const c = this.chunks[0]!;
      const need = n - got;
      if (c.length <= need) { parts.push(c); this.chunks.shift(); got += c.length; }
      else { parts.push(c.subarray(0, need)); this.chunks[0] = c.subarray(need); got += need; }
    }
    this.have -= n;
    if (this.have < 32 * 1024 * 1024 && this.stream.isPaused()) this.stream.resume();
    // always a fresh buffer, so a frame never pins a larger pipe chunk
    return parts.length === 1 ? Buffer.from(parts[0]!) : Buffer.concat(parts, n);
  }
  private peek(n: number): string {
    let s = '';
    for (const c of this.chunks) { s += c.subarray(0, n - s.length).toString('latin1'); if (s.length >= n) break; }
    return s;
  }
  /** The next frame, or null at the end of the stream. */
  async next(): Promise<RGBAFrame | null> {
    // header: P7\nWIDTH w\nHEIGHT h\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n
    let hdrLen = -1;
    for (let want = 64; hdrLen < 0; want += 64) {
      const ok = await this.need(Math.min(want, 256));
      const head = this.peek(256);
      const i = head.indexOf('ENDHDR\n');
      if (i >= 0) hdrLen = i + 7;
      else if (!ok || want >= 256) {
        if (this.error) throw this.error;
        if (this.have === 0) return null;
        fail('E_MEDIA', 'the decoder produced an unreadable frame.', 'report this with the file (mgl show <file>).');
      }
    }
    const head = this.take(hdrLen).toString('latin1');
    const w = Number(/WIDTH (\d+)/.exec(head)?.[1]), h = Number(/HEIGHT (\d+)/.exec(head)?.[1]), depth = Number(/DEPTH (\d+)/.exec(head)?.[1]);
    if (depth !== 4) fail('E_MEDIA', `the decoder produced ${depth}-channel frames.`, 'report this with the file.');
    const n = w * h * 4;
    if (!(await this.need(n))) return null;
    return { width: w, height: h, data: this.take(n) };
  }
}

const threadCap = () => Math.max(1, Math.min(4, availableParallelism()));

function matrixOf(info: MediaInfoExt): string | undefined {
  if (/^(rgb|bgr|gbr|argb|abgr|rgba|bgra|pal8|gray|ya8|monow|monob)/.test(info.pixFmt ?? '')) return undefined;
  switch (info.colorSpace) {
    case 'bt709': return 'bt709';
    case 'bt470bg': case 'smpte170m': return 'bt601';
    case 'bt2020nc': case 'bt2020c': return 'bt2020';
    case 'smpte240m': return 'smpte240m';
    case 'fcc': return 'fcc';
  }
  // untagged: follow ffmpeg's own convention (swscale's default, BT.601), so a file made or checked with ffmpeg
  // round-trips without a colour shift
  return 'bt601';
}

export function isHdr(info: MediaInfoExt): boolean { return info.colorTransfer === 'smpte2084' || info.colorTransfer === 'arib-std-b67'; }

/** The video filter chain: [HDR tone map] → source effects → scale (fit inside maxSize, never up) with the input matrix → rgba. */
export function buildVideoFilter(info: MediaInfoExt, ff: FfmpegInfo, opts: DecodeOptions, notes: string[] = []): string {
  const chain: string[] = [];
  let matrix = matrixOf(info);
  let range = info.colorRange === 'pc' ? 'full' : info.colorRange === 'tv' ? 'tv' : undefined;
  if (isHdr(info)) {
    if (ff.filters.includes('zscale') && ff.filters.includes('tonemap')) {
      const tin = info.colorTransfer === 'arib-std-b67' ? 'arib-std-b67' : 'smpte2084';
      chain.push(`zscale=tin=${tin}:min=bt2020nc:pin=bt2020:t=linear:npl=100`, 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv', 'format=yuv420p');
      matrix = 'bt709'; range = 'tv';
      notes.push('HDR source tone-mapped to SDR (BT.709)');
    } else notes.push(`HDR source (${info.colorTransfer}) shown without tone mapping: this ffmpeg has no zscale (fix: mgl doctor --fetch for a build with zscale)`);
  }
  const user = filtersToString(opts.filters, { baseDir: opts.baseDir });
  if (user) chain.push(user);
  const sc: string[] = [];
  if (opts.maxSize) {
    const W = Math.max(2, Math.round(opts.maxSize.w)), H = Math.max(2, Math.round(opts.maxSize.h));
    sc.push(`w=min(iw\\,${W})`, `h=min(ih\\,${H})`, 'force_original_aspect_ratio=decrease');
  }
  if (matrix) sc.push(`in_color_matrix=${matrix}`);
  if (range) sc.push(`in_range=${range}`);
  sc.push('flags=bicubic');
  chain.push(`scale=${sc.join(':')}`, 'format=rgba');
  return chain.join(',');
}

function inputArgs(info: MediaInfoExt, ff: FfmpegInfo, seek: number | undefined, threads: number): string[] {
  const a = ['-hide_banner', '-nostdin', '-v', 'error', '-threads', String(threads)];
  if (info.alpha && info.videoCodec === 'vp9' && ff.decoders.includes('libvpx-vp9')) a.push('-c:v', 'libvpx-vp9');
  if (info.alpha && info.videoCodec === 'vp8' && ff.decoders.includes('libvpx')) a.push('-c:v', 'libvpx');
  if (seek !== undefined && seek > 0) a.push('-ss', seek.toFixed(6));
  return a;
}

const outputArgs = (vf: string) => ['-map', '0:v:0', '-an', '-sn', '-dn', '-vf', vf, '-fps_mode', 'passthrough', '-f', 'image2pipe', '-c:v', 'pam', '-'];

/** Seek point (container seconds) that makes frame `i` the first decoded frame. */
function seekFor(idx: FrameIndex, i: number): number | undefined {
  if (i <= 0) return undefined;
  const t = idx.pts[i]!, prev = idx.pts[i - 1]!;
  return idx.offset + t - (t - prev) * 0.25;
}

/** Decode one frame-accurate RGBA frame of a video (or an image) at `sourceFrame` frames of `rate`. */
export async function grab(file: string, sourceFrame: number, rate: Rate, opts: DecodeOptions = {}): Promise<RGBAFrame> {
  const info = await probe(file, opts);
  if (info.kind === 'image') return decodeImage(file, opts.maxSize, opts);
  if (!info.hasVideo) fail('E_MEDIA', `${file} has no video to grab a frame from.`, 'use a video or image asset.');
  const ff = await getFfmpeg();
  const idx = await frameIndex(file, opts);
  const { index } = sourceFrameAt(idx, Math.max(0, sourceFrame), rate);
  const vf = buildVideoFilter(info, ff, opts);
  const args = [...inputArgs(info, ff, seekFor(idx, index), opts.threads ?? threadCap()), '-i', file, '-frames:v', '1', ...outputArgs(vf)];
  const r = await run(ff.ffmpeg, args, { what: `decoding ${file} at source frame ${sourceFrame}` });
  const frame = await new PamReader(streamOf(r.stdout)).next();
  if (!frame) fail('E_MEDIA', `${file}: no frame at source frame ${sourceFrame}.`, 'the file may be truncated; check its duration with mgl show <file>.');
  return frame;
}

const streamOf = (buf: Buffer): Readable => Readable.from([buf]);

/** A sequential reader: one ffmpeg process streams frames; backward or far forward requests reopen it. */
export class FfmpegVideoReader implements VideoReader {
  private proc: ChildProcess | null = null;
  private reader: PamReader | null = null;
  private nextIndex = 0;
  private last: { index: number; frame: RGBAFrame } | null = null;
  private stderr = '';
  readonly notes: string[] = [];
  private vf: string;
  /** frames decoded since open (for tests and estimates) */
  decoded = 0;
  opens = 0;

  constructor(private file: string, private info: MediaInfoExt, private idx: FrameIndex, private ff: FfmpegInfo, private opts: DecodeOptions & { rate: Rate }) {
    this.vf = buildVideoFilter(info, ff, opts, this.notes);
  }

  private async open(index: number) {
    await this.kill();
    this.opens++;
    const args = [...inputArgs(this.info, this.ff, seekFor(this.idx, index), this.opts.threads ?? Math.min(2, threadCap())), '-i', this.file, ...outputArgs(this.vf)];
    const p = spawn(this.ff.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.stderr = '';
    p.stderr!.on('data', (d: Buffer) => { this.stderr = (this.stderr + d.toString()).slice(-20_000); });
    p.on('error', () => {});
    this.proc = p;
    this.reader = new PamReader(p.stdout!);
    this.nextIndex = index;
  }

  async frame(sourceFrame: number, rate: Rate = this.opts.rate): Promise<RGBAFrame> {
    const { index } = sourceFrameAt(this.idx, Math.max(0, sourceFrame), rate);
    if (this.last?.index === index) return this.last.frame;
    // far forward: reopening (keyframe seek) beats decoding more than ~2 s of frames
    const far = Math.max(48, Math.round(2 / this.idx.frameDur));
    if (!this.reader || index < this.nextIndex || index - this.nextIndex > far) await this.open(index);
    while (this.nextIndex <= index) {
      const f = await this.reader!.next();
      if (!f) {
        if (this.last) return this.last.frame;
        const err = this.stderr;
        await this.kill();
        if (err.trim()) throw procError(this.ff.ffmpeg, [this.file], err, `decoding ${this.file}`);
        fail('E_MEDIA', `${this.file}: no frame at source frame ${sourceFrame}.`, 'the file may be truncated; check it with mgl show <file>.');
      }
      this.decoded++;
      this.last = { index: this.nextIndex, frame: f };
      this.nextIndex++;
    }
    return this.last!.frame;
  }

  private async kill() {
    const p = this.proc;
    this.proc = null;
    this.reader = null;
    if (p && p.exitCode === null && p.signalCode === null) {
      const done = new Promise<void>((r) => p.once('exit', () => r()));
      p.stdout?.destroy();
      p.kill('SIGKILL');
      await done;
    }
  }

  async close(): Promise<void> { await this.kill(); this.last = null; }
}

/** Open a sequential reader of a video file (images get a reader that always returns the image). */
export async function openVideo(file: string, opts: OpenVideoOptions & DecodeOptions): Promise<VideoReader & { notes: string[] }> {
  const info = await probe(file, opts);
  if (info.kind === 'image') {
    const img = await decodeImage(file, opts.maxSize, opts);
    return { notes: [], frame: async () => img, close: async () => {} };
  }
  if (!info.hasVideo) fail('E_MEDIA', `${file} has no video stream.`, 'put audio files on an audio track.');
  const ff = await getFfmpeg();
  const idx = await frameIndex(file, opts);
  return new FfmpegVideoReader(file, info, idx, ff, opts);
}

const CANVAS_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);

/** Decode a still image to straight RGBA, fitting inside maxSize (never enlarging). */
export async function decodeImage(file: string, maxSize?: { w: number; h: number }, opts: DecodeOptions = {}): Promise<RGBAFrame> {
  if (CANVAS_EXT.has(extname(file).toLowerCase()) && !opts.filters?.length) {
    try {
      const { loadImage, createCanvas } = await import('@napi-rs/canvas');
      const img = await loadImage(file);
      let w = img.width, h = img.height;
      if (maxSize && (w > maxSize.w || h > maxSize.h)) {
        const s = Math.min(maxSize.w / w, maxSize.h / h);
        w = Math.max(1, Math.round(w * s)); h = Math.max(1, Math.round(h * s));
      }
      const c = createCanvas(w, h);
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h);
      return { width: w, height: h, data: Buffer.from(d.data.buffer, d.data.byteOffset, d.data.byteLength) };
    } catch { /* fall through to ffmpeg */ }
  }
  const ff = await getFfmpeg();
  const info = await probe(file, opts);
  const vf = buildVideoFilter(info, ff, { ...opts, maxSize });
  const r = await run(ff.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-frames:v', '1', ...outputArgs(vf)], { what: `decoding image ${file}` });
  const frame = await new PamReader(streamOf(r.stdout)).next();
  if (!frame) fail('E_MEDIA', `${file}: could not decode the image.`, 'convert it to PNG or JPEG.');
  return frame;
}
