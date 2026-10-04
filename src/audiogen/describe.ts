/**
 * "Listen as text": measured features of a generated sound (loudness, true peak, spectrum, onsets, tempo,
 * envelope, stereo width), as numbers and one readable line, so an agent can judge audio without hearing it.
 */
import { SR, gainDb, lufs, truePeakDb } from './dsp.js';

export interface SoundFeatures {
  duration: number;
  lufs: number;
  truePeak: number;
  /** energy-weighted mean spectral centroid (Hz) */
  centroid: number;
  /** centroid over the first and last thirds (Hz): pitch/brightness movement */
  centroidStart: number;
  centroidEnd: number;
  /** share of energy per band (0..1): sub <60, bass 60-250, lowMid 250-1k, mid 1-4k, high >4k */
  bands: { sub: number; bass: number; lowMid: number; mid: number; high: number };
  onsets: number[];
  /** tempo from the onset envelope (BPM), when the sound is long enough */
  bpm?: number;
  /** time from start to the loudest 10 ms (s) and from there until 30 dB down (s) */
  attack: number;
  decay: number;
  /** 0 = mono, 1 = fully decorrelated */
  width: number;
}

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
        re[b] = re[a]! - tr; im[b] = im[a]! - ti; re[a] = re[a]! + tr; im[a] = im[a]! + ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

export function describeSound(chans: Float32Array[], sampleRate = SR): SoundFeatures {
  const n = chans[0]!.length;
  const mono = new Float32Array(n);
  for (const c of chans) for (let i = 0; i < n; i++) mono[i]! += c[i]! / chans.length;
  // spectrum per frame
  const F = 2048, hop = 512;
  const win = Float64Array.from({ length: F }, (_x, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / F));
  const re = new Float64Array(F), im = new Float64Array(F);
  const bands = { sub: 0, bass: 0, lowMid: 0, mid: 0, high: 0 };
  const flux: number[] = [];
  const cents: { e: number; c: number; t: number }[] = [];
  let prev = new Float64Array(F / 2);
  for (let o = 0; o + F <= Math.max(n, F); o += hop) {
    for (let i = 0; i < F; i++) { re[i] = (mono[o + i] ?? 0) * win[i]!; im[i] = 0; }
    fft(re, im);
    let e = 0, ce = 0, fl = 0;
    const mag = new Float64Array(F / 2);
    for (let k = 1; k < F / 2; k++) {
      const p = re[k]! * re[k]! + im[k]! * im[k]!;
      const f = (k * sampleRate) / F;
      e += p; ce += p * f;
      if (f < 60) bands.sub += p; else if (f < 250) bands.bass += p; else if (f < 1000) bands.lowMid += p; else if (f < 4000) bands.mid += p; else bands.high += p;
      mag[k] = Math.log1p(100 * Math.sqrt(p));
      const d = mag[k]! - prev[k]!; if (d > 0) fl += d;
    }
    prev = mag;
    flux.push(o === 0 ? 0 : fl);
    cents.push({ e, c: e > 0 ? ce / e : 0, t: o / sampleRate });
    if (n < F) break;
  }
  const tot = bands.sub + bands.bass + bands.lowMid + bands.mid + bands.high || 1;
  for (const k of Object.keys(bands) as (keyof typeof bands)[]) bands[k] = Math.round((bands[k] / tot) * 1000) / 1000;
  const wavg = (xs: typeof cents) => { const e = xs.reduce((s, x) => s + x.e, 0); return e > 0 ? xs.reduce((s, x) => s + x.e * x.c, 0) / e : 0; };
  const third = Math.max(1, Math.floor(cents.length / 3));
  // onsets: flux peaks above a local mean
  const hopS = hop / sampleRate;
  const maxF = Math.max(0, ...flux);
  const onsets: number[] = [];
  let last = -1;
  for (let i = 1; i < flux.length - 1; i++) {
    const v = flux[i]!;
    if (v < flux[i - 1]! || v < flux[i + 1]!) continue;
    const a = Math.max(0, i - 8), b = Math.min(flux.length, i + 9);
    let mean = 0; for (let j = a; j < b; j++) mean += flux[j]!; mean /= b - a;
    if (v > mean * 1.5 && v > 0.15 * maxF && i * hopS - last >= 0.08) { onsets.push(Math.round(i * hopS * 1000) / 1000); last = i * hopS; }
  }
  // tempo: autocorrelation of the flux, 60..200 BPM, weighted towards 110
  let bpm: number | undefined;
  if (n / sampleRate >= 4) {
    const m = flux.reduce((s, x) => s + x, 0) / flux.length;
    const x = flux.map((v) => v - m);
    let best = -Infinity, lagB = 0;
    for (let lag = Math.floor(60 / 200 / hopS); lag <= Math.ceil(60 / 60 / hopS) && lag < x.length; lag++) {
      let s = 0; for (let i = 0; i + lag < x.length; i++) s += x[i]! * x[i + lag]!;
      s /= x.length - lag;
      const w = Math.exp(-0.5 * Math.pow(Math.log2(60 / (lag * hopS) / 110), 2));
      if (s * w > best) { best = s * w; lagB = lag; }
    }
    if (lagB && best > 0) bpm = Math.round((60 / (lagB * hopS)) * 10) / 10;
  }
  // envelope: 10 ms RMS
  const w10 = Math.max(1, Math.round(0.01 * sampleRate));
  const env: number[] = [];
  for (let o = 0; o < n; o += w10) { let s = 0; const b = Math.min(n, o + w10); for (let i = o; i < b; i++) s += mono[i]! * mono[i]!; env.push(Math.sqrt(s / Math.max(1, b - o))); }
  let pk = 0; env.forEach((v, i) => { if (v > env[pk]!) pk = i; });
  const floor = env[pk]! * Math.pow(10, -30 / 20);
  let end = env.length - 1; for (let i = pk; i < env.length; i++) if (env[i]! < floor) { end = i; break; }
  // stereo width from L/R correlation
  let width = 0;
  if (chans.length > 1) {
    let lr = 0, ll = 0, rr = 0;
    for (let i = 0; i < n; i++) { const l = chans[0]![i]!, r = chans[1]![i]!; lr += l * r; ll += l * l; rr += r * r; }
    width = ll && rr ? Math.round((1 - lr / Math.sqrt(ll * rr)) * 100) / 100 : 0;
  }
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return {
    duration: Math.round((n / sampleRate) * 1000) / 1000,
    lufs: r1(lufs(chans)), truePeak: r1(truePeakDb(chans)),
    centroid: Math.round(wavg(cents)), centroidStart: Math.round(wavg(cents.slice(0, third))), centroidEnd: Math.round(wavg(cents.slice(-third))),
    bands, onsets, ...(bpm !== undefined ? { bpm } : {}),
    attack: Math.round(pk * 0.01 * 1000) / 1000, decay: Math.round((end - pk) * 0.01 * 1000) / 1000, width,
  };
}

const hz = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(1)} kHz` : `${Math.round(x)} Hz`);

/** One line describing the measured sound. */
export function describeText(f: SoundFeatures): string {
  const move = f.centroidEnd > f.centroidStart * 1.3 ? 'rising' : f.centroidEnd < f.centroidStart / 1.3 ? 'falling' : 'steady';
  const b = f.bands;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const parts = [
    `${f.duration.toFixed(2)} s`, `${f.lufs.toFixed(1)} LUFS`, `peak ${f.truePeak.toFixed(1)} dBTP`,
    `brightness ${hz(f.centroid)} (${move})`,
    `bands sub ${pct(b.sub)} / bass ${pct(b.bass)} / low-mid ${pct(b.lowMid)} / mid ${pct(b.mid)} / high ${pct(b.high)}`,
    `${f.onsets.length} onset${f.onsets.length === 1 ? '' : 's'}${f.duration >= 2 ? ` (${(f.onsets.length / f.duration).toFixed(1)}/s)` : ''}`,
    ...(f.bpm ? [`tempo ≈ ${f.bpm} BPM`] : []),
    ...(f.duration <= 5 ? [`attack ${Math.round(f.attack * 1000)} ms, decay ${f.decay.toFixed(2)} s`] : []),
    `stereo width ${f.width.toFixed(2)}`,
  ];
  return parts.join(', ');
}

export { gainDb };
