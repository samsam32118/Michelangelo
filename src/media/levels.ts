/**
 * Per-frame sound levels for audio-reactive generators: RMS (0..1) and a 16-band log-spaced spectrum (0..1) of an
 * asset's audio, one value set per frame at a given rate. Computed from one ffmpeg decode (mono, 22.05 kHz) and
 * cached by file identity + rate.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fail } from '../core/errors.js';
import type { Rate } from '../core/time.js';
import { cacheRoot, getFfmpeg } from './ffmpeg.js';
import { probe } from './probe.js';
import { run } from './proc.js';

export const LEVELS_RATE = 22050;
export const LEVEL_BANDS = 16;
const FFT_N = 2048;
/** 2: levels start at the mix's zero (the first video frame, or the first audio sample), as the audio mix does */
const LEVELS_VERSION = 2;
/** dB range mapped to 0..1 (RMS: -60 dBFS..0; bands: 60 dB below the loudest band of the file) */
const RANGE_DB = 60;

export interface AudioLevelsData {
  /** frames per second the values are sampled at */
  rate: Rate;
  rms: Float32Array;
  /** frames × bands, row-major */
  spectrum: Float32Array;
  bands: number;
}

export interface LevelsOptions { cacheDir?: string; noCache?: boolean }

/** In-place radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j]!, re[i]!]; [im[i], im[j]] = [im[j]!, im[i]!]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci, ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr; im[b] = im[a]! - ti;
        re[a] = re[a]! + tr; im[a] = im[a]! + ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/** Band edges (FFT bin indices) of `bands` log-spaced bands from 40 Hz to Nyquist. */
export function bandEdges(bands: number, sr: number, n: number): number[] {
  const lo = 40, hi = sr / 2;
  const edges: number[] = [];
  for (let b = 0; b <= bands; b++) edges.push(Math.max(1, Math.min(n / 2, Math.round(((lo * Math.pow(hi / lo, b / bands)) / sr) * n))));
  for (let b = 1; b < edges.length; b++) if (edges[b]! <= edges[b - 1]!) edges[b] = Math.min(n / 2, edges[b - 1]! + 1);
  return edges;
}

/** Levels of mono PCM: one RMS value and one spectrum row per frame of `rate`. */
export function computeLevels(pcm: Float32Array, sr: number, rate: Rate, bands = LEVEL_BANDS): AudioLevelsData {
  const fps = rate.num / rate.den;
  const frames = Math.max(0, Math.ceil((pcm.length / sr) * fps - 1e-9));
  const rms = new Float32Array(frames);
  const spectrum = new Float32Array(frames * bands);
  const edges = bandEdges(bands, sr, FFT_N);
  const win = new Float64Array(FFT_N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_N));
  const re = new Float64Array(FFT_N), im = new Float64Array(FFT_N);
  const bandDb = new Float32Array(frames * bands);
  let maxDb = -Infinity;
  for (let f = 0; f < frames; f++) {
    const a = Math.floor((f * sr) / fps), b = Math.min(pcm.length, Math.floor(((f + 1) * sr) / fps));
    let s = 0;
    for (let j = a; j < b; j++) s += pcm[j]! * pcm[j]!;
    const r = b > a ? Math.sqrt(s / (b - a)) : 0;
    rms[f] = r > 0 ? Math.min(1, Math.max(0, (20 * Math.log10(r) + RANGE_DB) / RANGE_DB)) : 0;
    // spectrum of a window centred on the frame
    const c = Math.floor((a + b) / 2) - FFT_N / 2;
    for (let i = 0; i < FFT_N; i++) { const k = c + i; re[i] = (k >= 0 && k < pcm.length ? pcm[k]! : 0) * win[i]!; im[i] = 0; }
    fft(re, im);
    for (let q = 0; q < bands; q++) {
      let m = 0;
      const e0 = edges[q]!, e1 = Math.max(e0 + 1, edges[q + 1]!);
      for (let k = e0; k < e1; k++) m += Math.hypot(re[k]!, im[k]!);
      m /= e1 - e0;
      const db = m > 0 ? 20 * Math.log10(m) : -200;
      bandDb[f * bands + q] = db;
      if (db > maxDb) maxDb = db;
    }
  }
  for (let i = 0; i < bandDb.length; i++) spectrum[i] = Number.isFinite(maxDb) ? Math.min(1, Math.max(0, (bandDb[i]! - (maxDb - RANGE_DB)) / RANGE_DB)) : 0;
  return { rate, rms, spectrum, bands };
}

async function cacheKey(file: string, rate: Rate, bands: number): Promise<string> {
  const abs = resolve(file);
  let st;
  try { st = await stat(abs); } catch { return fail('E_MEDIA_MISSING', `media file ${file} does not exist.`, 'check the path (relative to the project file) or relink the asset: mgl edit <project> asset.relink <id> src=<path>.'); }
  return createHash('sha1').update(`levels${LEVELS_VERSION}\0${abs}\0${st.size}\0${st.mtimeMs}\0${rate.num}/${rate.den}\0${bands}`).digest('hex');
}

/**
 * The decode filter that puts sample 0 where the audio mix (renderAudio) puts source time 0: audio is laid on the
 * container clock (aresample async, first_pts=0, so a late audio start is padded with silence), then the offset of
 * the first video frame (or, without video, of the first audio sample) from the container start is trimmed off.
 */
export function levelsAlignFilter(info: { hasVideo?: boolean; startTime?: number; audioStart?: number; formatStart?: number }): string {
  const zero = Math.max(0, Math.round(((info.hasVideo ? info.startTime ?? 0 : info.audioStart ?? 0) - (info.formatStart ?? 0)) * LEVELS_RATE));
  return `aresample=${LEVELS_RATE}:async=1:first_pts=0${zero > 0 ? `,atrim=start_sample=${zero},asetpts=PTS-STARTPTS` : ''}`;
}
async function levelsAlign(file: string, opts: LevelsOptions): Promise<string> {
  try { return levelsAlignFilter(await probe(file, opts.cacheDir ? { cacheDir: join(opts.cacheDir, 'probe') } : {})); } catch { return levelsAlignFilter({}); }
}

/** Per-frame RMS and spectrum of a file's audio at `rate` frames/s (cached under the media cache, `levels/`). */
export async function analyzeLevels(file: string, rate: Rate, opts: LevelsOptions = {}): Promise<AudioLevelsData> {
  const dir = join(opts.cacheDir ?? cacheRoot(), 'levels');
  const key = await cacheKey(file, rate, LEVEL_BANDS);
  if (!opts.noCache) {
    try {
      const j = JSON.parse(await readFile(join(dir, key + '.json'), 'utf8')) as { rms: number[]; spectrum: number[]; bands: number };
      return { rate, rms: Float32Array.from(j.rms), spectrum: Float32Array.from(j.spectrum), bands: j.bands };
    } catch { /* not cached */ }
  }
  const ff = await getFfmpeg();
  const r = await run(ff.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-map', '0:a:0', '-af', await levelsAlign(file, opts), '-ac', '1', '-f', 'f32le', '-'], {
    what: `measuring the sound levels of ${file}`, allowFail: true,
  });
  if (r.code !== 0) {
    if (/matches no streams|Stream specifier ':a:0'|does not contain any stream/.test(r.stderr)) fail('E_NO_AUDIO', `${file} has no audio stream, so an audio-reactive generator has nothing to follow.`, 'point the generator at an asset with sound.');
    fail('E_MEDIA', `measuring the sound levels of ${file} failed: ${r.stderr.trim().split('\n').slice(-1)[0]}`, 'check the file with mgl show <file>.');
  }
  const pcm = new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + (r.stdout.byteLength & ~3)));
  const lv = computeLevels(pcm, LEVELS_RATE, rate);
  if (!opts.noCache) {
    try {
      await mkdir(dir, { recursive: true });
      const tmp = join(dir, `${key}.${process.pid}.tmp`);
      const round = (a: Float32Array) => Array.from(a, (v) => Math.round(v * 1000) / 1000);
      await writeFile(tmp, JSON.stringify({ rms: round(lv.rms), spectrum: round(lv.spectrum), bands: lv.bands }));
      await rename(tmp, join(dir, key + '.json'));
    } catch { /* best effort */ }
  }
  return lv;
}
