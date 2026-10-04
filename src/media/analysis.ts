/**
 * Sound as numbers: loudness (EBU R128 integrated, true peak, LRA, momentary per 100 ms), silences,
 * RMS per 100 ms and beats (spectral-flux onsets + autocorrelation tempo), from one ffmpeg pass.
 */
import { fail } from '../core/errors.js';
import { getFfmpeg } from './ffmpeg.js';
import { run } from './proc.js';
import type { AudioAnalysisReport } from './types.js';

export const ANALYSIS_RATE = 11025;

export interface AnalyzeOptions { silenceDb?: number; minSilence?: number; /** skip beat detection */ noBeats?: boolean }

export function parseEbur128(stderr: string): { integrated: number; truePeak: number; lra: number; momentary: number[] } {
  const momentary: number[] = [];
  for (const m of stderr.matchAll(/\bt:\s*[\d.]+\s+TARGET:\S+\s+LUFS\s+M:\s*(-?[\d.]+|-?inf|nan)/g)) momentary.push(Number(m[1]));
  const sum = stderr.slice(stderr.lastIndexOf('Summary:'));
  const g = (re: RegExp) => { const m = re.exec(sum); return m ? Number(m[1]) : NaN; };
  return {
    integrated: g(/I:\s*(-?[\d.]+|-inf)\s*LUFS/),
    lra: g(/LRA:\s*(-?[\d.]+)\s*LU/),
    truePeak: g(/True peak:\s*Peak:\s*(-?[\d.]+|-inf)\s*dBFS/),
    momentary,
  };
}

export function parseSilences(stderr: string, duration: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let open: number | null = null;
  for (const m of stderr.matchAll(/silence_(start|end):\s*(-?[\d.e+-]+)/g)) {
    const t = Math.max(0, Number(m[2]));
    if (m[1] === 'start') open = t;
    else if (open !== null) { out.push({ start: round3(open), end: round3(t) }); open = null; }
  }
  if (open !== null && duration - open > 0) out.push({ start: round3(open), end: round3(duration) });
  return out;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** RMS dBFS per 100 ms window of mono samples. */
export function rmsWindows(pcm: Float32Array, sr: number, windowS = 0.1): number[] {
  const out: number[] = [];
  const n = Math.ceil(pcm.length / (sr * windowS));
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * sr * windowS), b = Math.min(pcm.length, Math.floor((i + 1) * sr * windowS));
    let s = 0;
    for (let j = a; j < b; j++) s += pcm[j]! * pcm[j]!;
    const r = b > a ? Math.sqrt(s / (b - a)) : 0;
    out.push(r > 0 ? Math.round(20 * Math.log10(r) * 10) / 10 : -120);
  }
  return out;
}

/** In-place radix-2 FFT (re, im of length 2^k). */
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

/** Spectral flux onset strength, one value per hop. */
export function spectralFlux(pcm: Float32Array, frame = 1024, hop = 128): Float64Array {
  const n = Math.max(0, Math.floor((pcm.length - frame) / hop) + 1);
  const flux = new Float64Array(n);
  const win = new Float64Array(frame).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frame));
  let prev = new Float64Array(frame / 2);
  const re = new Float64Array(frame), im = new Float64Array(frame);
  for (let f = 0; f < n; f++) {
    const o = f * hop;
    for (let i = 0; i < frame; i++) { re[i] = pcm[o + i]! * win[i]!; im[i] = 0; }
    fft(re, im);
    const mag = new Float64Array(frame / 2);
    let s = 0;
    for (let k = 0; k < frame / 2; k++) {
      mag[k] = Math.log1p(100 * Math.hypot(re[k]!, im[k]!));
      const d = mag[k]! - prev[k]!;
      if (d > 0) s += d;
    }
    flux[f] = f === 0 ? 0 : s;
    prev = mag;
  }
  return flux;
}

/** Onset times (s): peaks of the flux above a moving median + offset, at least `minGap` apart. */
export function pickOnsets(flux: Float64Array, hopS: number, minGap = 0.07): number[] {
  const out: number[] = [];
  const w = Math.max(3, Math.round(0.25 / hopS));
  let maxF = 0;
  for (const v of flux) maxF = Math.max(maxF, v);
  if (maxF <= 0) return out;
  let last = -Infinity;
  for (let i = 1; i < flux.length - 1; i++) {
    const v = flux[i]!;
    if (v < flux[i - 1]! || v < flux[i + 1]!) continue;
    const a = Math.max(0, i - w), b = Math.min(flux.length, i + w + 1);
    const local = Array.from(flux.subarray(a, b)).sort((x, y) => x - y);
    const med = local[local.length >> 1]!;
    let mean = 0; for (const x of local) mean += x; mean /= local.length;
    if (v > med + 0.1 * maxF && v > mean * 1.5) {
      const t = i * hopS;
      if (t - last >= minGap) { out.push(Math.round(t * 1000) / 1000); last = t; }
    }
  }
  return out;
}

/** Tempo (BPM 60–200) from the autocorrelation of the onset envelope, weighted towards 120 BPM (log-Gaussian, 1 octave). */
export function estimateTempo(flux: Float64Array, hopS: number): number | undefined {
  const n = flux.length;
  if (n * hopS < 2) return undefined;
  let mean = 0; for (const v of flux) mean += v; mean /= n;
  const x = Float64Array.from(flux, (v) => v - mean);
  const lo = Math.floor(60 / 200 / hopS), hi = Math.ceil(60 / 60 / hopS);
  let best = -Infinity, bestLag = 0;
  const ac = new Float64Array(hi + 2);
  for (let lag = lo - 1; lag <= hi + 1 && lag < n; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += x[i]! * x[i + lag]!;
    ac[lag] = s / (n - lag);
  }
  for (let lag = lo; lag <= hi && lag < n - 1; lag++) {
    const bpm = 60 / (lag * hopS);
    const wgt = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120), 2));
    const v = ac[lag]! * wgt;
    if (v > best && ac[lag]! >= ac[lag - 1]! && ac[lag]! >= ac[lag + 1]!) { best = v; bestLag = lag; }
  }
  if (!bestLag || best <= 0) return undefined;
  // parabolic interpolation around the peak
  const y0 = ac[bestLag - 1]!, y1 = ac[bestLag]!, y2 = ac[bestLag + 1]!;
  const den = y0 - 2 * y1 + y2;
  const lag = bestLag + (den !== 0 ? (0.5 * (y0 - y2)) / den : 0);
  return Math.round((60 / (lag * hopS)) * 10) / 10;
}

/** Analyse a media file's audio. */
export async function analyzeAudio(file: string, opts: AnalyzeOptions = {}): Promise<AudioAnalysisReport> {
  const ff = await getFfmpeg();
  const db = opts.silenceDb ?? -50, minS = opts.minSilence ?? 0.5;
  const graph = `[0:a:0]asplit=3[a][b][c];[a]ebur128=peak=true,anullsink;[b]silencedetect=n=${db}dB:d=${minS},anullsink;[c]aresample=${ANALYSIS_RATE},aformat=sample_fmts=flt:channel_layouts=mono[pcm]`;
  const r = await run(ff.ffmpeg, ['-hide_banner', '-nostdin', '-nostats', '-v', 'info', '-i', file, '-filter_complex', graph, '-map', '[pcm]', '-f', 'f32le', '-'], {
    what: `analysing the audio of ${file}`, fix: 'check that the file has an audio stream (mgl show <file>).', allowFail: true,
  });
  if (r.code !== 0) {
    if (/matches no streams|Stream specifier ':a:0'/.test(r.stderr)) fail('E_NO_AUDIO', `${file} has no audio stream.`, 'analyse a file with sound, or render the project audio first.');
    fail('E_MEDIA', `analysing ${file} failed: ${r.stderr.trim().split('\n').slice(-1)[0]}`, 'check the file with mgl show <file>.');
  }
  const pcm = new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + (r.stdout.byteLength & ~3)));
  const duration = pcm.length / ANALYSIS_RATE;
  const e = parseEbur128(r.stderr);
  const hop = 128, hopS = hop / ANALYSIS_RATE;
  let beats: number[] = [], bpm: number | undefined;
  if (!opts.noBeats && pcm.length > 2048) {
    // pad one window of silence so an onset at 0 s is seen; a transient is detected at the hop it enters the window
    const padded = new Float32Array(pcm.length + 1024);
    padded.set(pcm, 1024);
    const flux = spectralFlux(padded, 1024, hop);
    beats = pickOnsets(flux, hopS).map((t) => Math.round((t - hopS) * 1000) / 1000).filter((t) => t >= 0);
    bpm = estimateTempo(flux, hopS);
  }
  const report: AudioAnalysisReport = {
    duration: Math.round(duration * 1000) / 1000,
    loudness: { integrated: e.integrated, truePeak: e.truePeak, lra: e.lra, momentary: e.momentary },
    silences: parseSilences(r.stderr, duration),
    beats,
    rms: rmsWindows(pcm, ANALYSIS_RATE),
  };
  if (bpm !== undefined) report.bpm = bpm;
  return report;
}
