/**
 * Small, deterministic DSP toolkit for the audio generators (pure TS, no I/O): seeded noise, oscillators,
 * a TPT state-variable filter, biquads, a Freeverb-style reverb, BS.1770 loudness, 4x true peak and a
 * look-ahead true-peak limiter. Everything runs at SR (48 kHz) on Float32Array buffers.
 */

export const SR = 48000;
const TAU = Math.PI * 2;

/** mulberry32: a fast seeded PRNG in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit of a string (seed mixing). */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** Stable short hex hash of any JSON-able value (keys sorted). */
export function paramsHash(v: unknown, len = 10): string {
  const stable = JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).filter(([, y]) => y !== undefined).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ stable.length;
  for (let i = 0; i < stable.length; i++) {
    const c = stable.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0; h2 = (h2 ^ (h2 >>> 13)) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, len);
}

export const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
export const dbGain = (db: number) => Math.pow(10, db / 20);
export const gainDb = (g: number) => (g > 0 ? 20 * Math.log10(g) : -Infinity);
export const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);

/** PolyBLEP residual for band-limited saw/square. */
function blep(t: number, dt: number): number {
  if (t < dt) { const x = t / dt; return x + x - x * x - 1; }
  if (t > 1 - dt) { const x = (t - 1) / dt; return x * x + x + x + 1; }
  return 0;
}
/** Band-limited saw at phase p (0..1) with increment dt. */
export function saw(p: number, dt: number): number { return 2 * p - 1 - blep(p, dt); }
/** Band-limited square. */
export function square(p: number, dt: number): number {
  let v = p < 0.5 ? 1 : -1;
  v += blep(p, dt);
  v -= blep((p + 0.5) % 1, dt);
  return v;
}

/** TPT state-variable filter (Zavalishin): lowpass, bandpass and highpass outputs per sample; cutoff can move per sample. */
export class Svf {
  private ic1 = 0; private ic2 = 0;
  private g = 0; private k = 1; private a1 = 0; private a2 = 0; private a3 = 0;
  lp = 0; bp = 0; hp = 0;
  constructor(cutoff = 1000, q = 0.707) { this.set(cutoff, q); }
  set(cutoff: number, q = 0.707) {
    const fc = clamp(cutoff, 10, SR * 0.45);
    this.g = Math.tan((Math.PI * fc) / SR);
    this.k = 1 / q;
    this.a1 = 1 / (1 + this.g * (this.g + this.k));
    this.a2 = this.g * this.a1;
    this.a3 = this.g * this.a2;
  }
  tick(x: number): number {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.lp = v2; this.bp = v1; this.hp = x - this.k * v1 - v2;
    return v2;
  }
}

/** Direct-form-I biquad. */
export class Biquad {
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  constructor(private b0: number, private b1: number, private b2: number, private a1: number, private a2: number) {}
  static highpass(fc: number, q = 0.707): Biquad {
    const w = (TAU * fc) / SR, c = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
    return new Biquad((1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, (-2 * c) / a0, (1 - al) / a0);
  }
  static lowpass(fc: number, q = 0.707): Biquad {
    const w = (TAU * fc) / SR, c = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
    return new Biquad((1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0, (-2 * c) / a0, (1 - al) / a0);
  }
  /** peaking EQ */
  static peak(fc: number, db: number, q = 1): Biquad {
    const A = Math.pow(10, db / 40), w = (TAU * fc) / SR, c = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al / A;
    return new Biquad((1 + al * A) / a0, (-2 * c) / a0, (1 - al * A) / a0, (-2 * c) / a0, (1 - al / A) / a0);
  }
  tick(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
  run(buf: Float32Array): Float32Array { for (let i = 0; i < buf.length; i++) buf[i] = this.tick(buf[i]!); return buf; }
}

/** Freeverb-style stereo reverb (8 combs + 4 allpasses per side), wet only. */
export function reverb(inL: Float32Array, inR: Float32Array, opts: { room?: number; damp?: number } = {}): [Float32Array, Float32Array] {
  const room = opts.room ?? 0.8, damp = opts.damp ?? 0.35;
  const scale = SR / 44100;
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((n) => Math.round(n * scale));
  const aps = [556, 441, 341, 225].map((n) => Math.round(n * scale));
  const side = (input: Float32Array, spread: number): Float32Array => {
    const out = new Float32Array(input.length);
    const cb = combs.map((n) => ({ buf: new Float32Array(n + spread), i: 0, store: 0 }));
    const ab = aps.map((n) => ({ buf: new Float32Array(n + spread), i: 0 }));
    for (let s = 0; s < input.length; s++) {
      const x = input[s]! * 0.015;
      let acc = 0;
      for (const c of cb) {
        const y = c.buf[c.i]!;
        c.store = y * (1 - damp) + c.store * damp;
        c.buf[c.i] = x + c.store * room;
        if (++c.i >= c.buf.length) c.i = 0;
        acc += y;
      }
      for (const a of ab) {
        const b = a.buf[a.i]!;
        a.buf[a.i] = acc + b * 0.5;
        acc = b - acc;
        if (++a.i >= a.buf.length) a.i = 0;
      }
      out[s] = acc;
    }
    return out;
  };
  return [side(inL, 0), side(inR, 23)];
}

/** Stereo ping-pong delay (wet only). */
export function pingPong(inL: Float32Array, inR: Float32Array, delayS: number, feedback = 0.35, lpHz = 4000): [Float32Array, Float32Array] {
  const n = Math.max(1, Math.round(delayS * SR));
  const bl = new Float32Array(n), br = new Float32Array(n);
  const oL = new Float32Array(inL.length), oR = new Float32Array(inL.length);
  const fl = new Svf(lpHz), fr = new Svf(lpHz);
  let i = 0;
  for (let s = 0; s < inL.length; s++) {
    const dl = bl[i]!, dr = br[i]!;
    oL[s] = dl; oR[s] = dr;
    bl[i] = fl.tick((inL[s]! + inR[s]!) * 0.5 + dr * feedback);
    br[i] = fr.tick(dl * feedback);
    if (++i >= n) i = 0;
  }
  return [oL, oR];
}

// ------------------------------------------------------------------ measurement (BS.1770-4 at 48 kHz)

/** Integrated loudness in LUFS (K-weighted, 400 ms blocks, 75 % overlap, absolute and relative gates). */
export function lufs(chans: Float32Array[]): number {
  const n = chans[0]!.length;
  const block = Math.round(0.4 * SR), hop = Math.round(0.1 * SR);
  const weighted = chans.map((c) => {
    const s1 = new Biquad(1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585);
    const s2 = new Biquad(1, -2, 1, -1.99004745483398, 0.99007225036621);
    const o = new Float64Array(n);
    for (let i = 0; i < n; i++) { const y = s2.tick(s1.tick(c[i]!)); o[i] = y * y; }
    return o;
  });
  // prefix sums of the summed channel power
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) { let s = 0; for (const w of weighted) s += w[i]!; pre[i + 1] = pre[i]! + s; }
  const blocks: number[] = [];
  if (n < block) { if (n > 0) blocks.push(pre[n]! / n); }
  else for (let a = 0; a + block <= n; a += hop) blocks.push((pre[a + block]! - pre[a]!) / block);
  const L = (z: number) => -0.691 + 10 * Math.log10(z);
  const abs = blocks.filter((z) => z > 0 && L(z) > -70);
  if (!abs.length) return -Infinity;
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const rel = L(mean(abs)) - 10;
  const gated = abs.filter((z) => L(z) > rel);
  return L(mean(gated.length ? gated : abs));
}

/** 4x oversampling interpolation taps (windowed sinc), phases 1..3. */
const OS_TAPS = 12;
const OS_PHASES: Float64Array[] = [1, 2, 3].map((ph) => {
  const t = ph / 4;
  const k = new Float64Array(OS_TAPS);
  let sum = 0;
  for (let j = 0; j < OS_TAPS; j++) {
    const x = j - OS_TAPS / 2 + 1 - t;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos((TAU * (j + 1 - t)) / OS_TAPS) + 0.08 * Math.cos((2 * TAU * (j + 1 - t)) / OS_TAPS);
    k[j] = sinc * w; sum += k[j]!;
  }
  for (let j = 0; j < OS_TAPS; j++) k[j]! /= sum;
  return k;
});

const OS_SUMABS = Math.max(...OS_PHASES.map((k) => k.reduce((a, x) => a + Math.abs(x), 0)));

/**
 * Per-sample true-peak estimate: max |x| over the sample and the 3 interpolated points before it. Points are
 * interpolated only where they could exceed `thr` (the sum of |taps| bounds them), so quiet passages cost nothing.
 */
function truePeakEnvelope(c: Float32Array, thr: number): Float32Array {
  const out = new Float32Array(c.length);
  const half = OS_TAPS / 2;
  const lim = thr / OS_SUMABS;
  let lastHot = -Infinity;
  for (let i = 0; i < c.length; i++) out[i] = Math.abs(c[i]!);
  // hot[i]: some sample in the tap window of i is above lim
  for (let i = 0; i < c.length; i++) {
    if (i + half - 1 < c.length && Math.abs(c[i + half - 1]!) > lim) lastHot = i + half - 1;
    if (i - lastHot >= OS_TAPS || i < half || i + half >= c.length) continue;
    const base = i - half;
    let m = out[i]!;
    for (const k of OS_PHASES) {
      let s = 0;
      for (let j = 0; j < OS_TAPS; j++) s += k[j]! * c[base + j]!;
      const a = s < 0 ? -s : s;
      if (a > m) m = a;
    }
    out[i] = m;
  }
  return out;
}

const peakOf = (c: Float32Array) => { let m = 0; for (let i = 0; i < c.length; i++) { const a = Math.abs(c[i]!); if (a > m) m = a; } return m; };

/** True peak in dBTP (4x oversampled). */
export function truePeakDb(chans: Float32Array[]): number {
  let m = 0;
  for (const c of chans) m = Math.max(m, peakOf(c));
  const thr = m;
  for (const c of chans) { const e = truePeakEnvelope(c, thr); for (let i = 0; i < e.length; i++) if (e[i]! > m) m = e[i]!; }
  return gainDb(m);
}

/** Look-ahead true-peak limiter (linked stereo), in place: gain never lets the 4x-oversampled peak exceed `ceilingDb`. */
export function limit(chans: Float32Array[], ceilingDb: number, releaseS = 0.12) {
  const n = chans[0]!.length;
  const ceil = dbGain(ceilingDb);
  const env = new Float32Array(n);
  for (const c of chans) { const e = truePeakEnvelope(c, ceil); for (let i = 0; i < n; i++) if (e[i]! > env[i]!) env[i] = e[i]!; }
  // required gain per sample, spread back over a look-ahead window so gain is already down when the peak arrives
  const look = Math.round(0.002 * SR);
  const need = new Float32Array(n).fill(1);
  for (let i = 0; i < n; i++) if (env[i]! > ceil) {
    const g = ceil / env[i]!;
    for (let j = Math.max(0, i - look); j <= i; j++) {
      const r = (i - j) / look; // 0 at the peak, 1 at the start of the ramp
      const gj = g + (1 - g) * r * r;
      if (gj < need[j]!) need[j] = gj;
    }
  }
  const rel = Math.exp(-1 / (releaseS * SR));
  let g = 1;
  for (let i = 0; i < n; i++) {
    const t = need[i]!;
    g = t < g ? t : t + (g - t) * rel;
    if (g > t) g = t;
    for (const c of chans) c[i]! *= g;
  }
}

/**
 * Scale to a loudness target, then limit true peak to `peakDb`; limiting lowers the loudness a little, so gain
 * and limiter alternate (3 rounds) until both hold. A low `peakDb` (target + 11 dB for music beds) keeps the
 * peak-to-loudness ratio broadcast-like, so a later master gain of +4 dB does not need a limiter at all.
 */
export function master(chans: Float32Array[], targetLufs: number, peakDb: number): { lufs: number; truePeak: number } {
  let l = lufs(chans), tp = truePeakDb(chans);
  if (!Number.isFinite(l)) return { lufs: l, truePeak: tp };
  for (let round = 0; round < 3; round++) {
    const g = dbGain(targetLufs - l);
    for (const c of chans) for (let i = 0; i < c.length; i++) c[i]! *= g;
    tp = truePeakDb(chans);
    if (tp <= peakDb) return { lufs: lufs(chans), truePeak: tp };
    for (let pass = 0; pass < 3 && tp > peakDb; pass++) { limit(chans, peakDb - 0.2 * pass); tp = truePeakDb(chans); }
    l = lufs(chans);
    if (Math.abs(l - targetLufs) < 0.15) break;
  }
  return { lufs: l, truePeak: tp };
}

/** Linear interpolation of a [[t, v], ...] curve (sorted by t), held at the ends. */
export function curveAt(curve: [number, number][], t: number): number {
  if (!curve.length) return 1;
  if (t <= curve[0]![0]) return curve[0]![1];
  for (let i = 1; i < curve.length; i++) {
    const [t1, v1] = curve[i]!;
    if (t <= t1) { const [t0, v0] = curve[i - 1]!; return t1 === t0 ? v1 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0); }
  }
  return curve[curve.length - 1]![1];
}
