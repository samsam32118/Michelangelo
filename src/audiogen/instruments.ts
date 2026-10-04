/**
 * Synth voices for the music and SFX generators. Each `add*` renders one note or hit into a mono buffer
 * (additive), starting at sample `s0`. Pure functions of their arguments and the given PRNG.
 */
import { SR, Svf, clamp, midiHz, saw, square } from './dsp.js';

const TAU = Math.PI * 2;

export type Buf = Float32Array;

/** Write `n` samples of `f(i, t)` into buf from s0 (bounds-checked). */
function each(buf: Buf, s0: number, n: number, f: (i: number, t: number) => number) {
  const a = Math.max(0, s0), b = Math.min(buf.length, s0 + n);
  for (let s = a; s < b; s++) { const i = s - s0; buf[s]! += f(i, i / SR); }
}

// ------------------------------------------------------------------------------------------- drums

export interface KickOpts { f0?: number; f1?: number; decay?: number; click?: number; drive?: number; pitchDecay?: number }
export function addKick(buf: Buf, s0: number, vel: number, o: KickOpts = {}) {
  const f0 = o.f0 ?? 150, f1 = o.f1 ?? 48, decay = o.decay ?? 0.32, click = o.click ?? 0.35, drive = o.drive ?? 1.6, pd = o.pitchDecay ?? 0.035;
  let ph = 0;
  const n = Math.round(decay * 5 * SR);
  const norm = Math.tanh(drive);
  each(buf, s0, n, (i, t) => {
    const f = f1 + (f0 - f1) * Math.exp(-t / pd);
    ph += f / SR;
    const amp = Math.exp(-t / decay) * Math.min(1, i / 24);
    const body = Math.tanh(drive * Math.sin(TAU * ph) * amp) / norm;
    const cl = t < 0.004 ? click * Math.sin(TAU * 3200 * t) * (1 - t / 0.004) : 0;
    return vel * (body + cl);
  });
}

export function addSnare(buf: Buf, s0: number, vel: number, r: () => number, o: { tone?: number; decay?: number; bright?: number } = {}) {
  const tone = o.tone ?? 190, decay = o.decay ?? 0.17, bright = o.bright ?? 2400;
  const bp = new Svf(bright, 0.8), hp = new Svf(900, 0.7);
  const n = Math.round(decay * 5 * SR);
  each(buf, s0, n, (_i, t) => {
    const nz = r() * 2 - 1;
    bp.tick(nz); hp.tick(nz);
    const noise = (bp.bp * 1.2 + hp.hp * 0.5) * Math.exp(-t / decay);
    const body = (Math.sin(TAU * tone * t) * 0.8 + Math.sin(TAU * tone * 1.78 * t) * 0.3) * Math.exp(-t / 0.06);
    return vel * 0.75 * (noise + body * 0.7);
  });
}

export function addClap(buf: Buf, s0: number, vel: number, r: () => number) {
  const bp = new Svf(1300, 1.1);
  const n = Math.round(0.6 * SR);
  each(buf, s0, n, (_i, t) => {
    bp.tick(r() * 2 - 1);
    let env = 0;
    for (const d of [0, 0.011, 0.022]) if (t >= d) env = Math.max(env, Math.exp(-(t - d) / 0.006));
    if (t >= 0.03) env = Math.max(env, 0.6 * Math.exp(-(t - 0.03) / 0.12));
    return vel * 1.6 * bp.bp * env;
  });
}

const HAT_FREQS = [205.3, 304.4, 369.6, 522.7, 540, 800];
export function addHat(buf: Buf, s0: number, vel: number, r: () => number, open = false, tone = 1) {
  const decay = open ? 0.28 : 0.035;
  const hp = new Svf(5200 * tone, 0.7), pk = new Svf(9000 * tone, 1.5);
  const n = Math.round(decay * 5 * SR);
  const ph = HAT_FREQS.map(() => r());
  each(buf, s0, n, (_i, t) => {
    let m = 0;
    for (let k = 0; k < 6; k++) { const p = (ph[k]! + HAT_FREQS[k]! * 4.1 * t) % 1; m += p < 0.5 ? 1 : -1; }
    const x = m / 6 * 0.6 + (r() * 2 - 1) * 0.5;
    hp.tick(x); pk.tick(hp.hp);
    return vel * 0.55 * (hp.hp * 0.6 + pk.bp * 0.8) * Math.exp(-t / decay);
  });
}

export function addShaker(buf: Buf, s0: number, vel: number, r: () => number) {
  const bp = new Svf(6500, 1.2);
  const n = Math.round(0.09 * SR);
  each(buf, s0, n, (_i, t) => { bp.tick(r() * 2 - 1); const env = t < 0.012 ? t / 0.012 : Math.exp(-(t - 0.012) / 0.025); return vel * 0.5 * bp.bp * env; });
}

export function addRim(buf: Buf, s0: number, vel: number) {
  const n = Math.round(0.08 * SR);
  each(buf, s0, n, (_i, t) => vel * 0.5 * (Math.sin(TAU * 1700 * t) + 0.6 * Math.sin(TAU * 820 * t)) * Math.exp(-t / 0.012));
}

export function addTom(buf: Buf, s0: number, vel: number, f = 110, decay = 0.35) {
  let ph = 0;
  const n = Math.round(decay * 5 * SR);
  each(buf, s0, n, (_i, t) => { ph += (f * (1 + 0.6 * Math.exp(-t / 0.05))) / SR; return vel * Math.tanh(1.4 * Math.sin(TAU * ph)) * Math.exp(-t / decay); });
}

export function addCrash(buf: Buf, s0: number, vel: number, r: () => number, decay = 1.6) {
  const hp = new Svf(4200, 0.6);
  const n = Math.round(decay * 4 * SR);
  each(buf, s0, n, (_i, t) => {
    let m = 0;
    for (let k = 0; k < 6; k++) m += Math.sin(TAU * HAT_FREQS[k]! * 6.3 * t + k);
    hp.tick((r() * 2 - 1) * 0.8 + m * 0.05);
    return vel * 0.4 * hp.hp * Math.exp(-t / decay) * Math.min(1, t / 0.002);
  });
}

// ------------------------------------------------------------------------------------------- tonal voices

export type BassKind = 'saw' | 'round' | 'sub' | 'pluck';
export function addBass(buf: Buf, s0: number, midi: number, durS: number, vel: number, kind: BassKind) {
  const f = midiHz(midi), dt = f / SR;
  const rel = 0.04;
  const n = Math.round((durS + rel) * SR);
  const lp = new Svf(400, kind === 'saw' ? 1.4 : 0.8);
  let p = 0, ps = 0;
  each(buf, s0, n, (i, t) => {
    p += dt; if (p >= 1) p -= 1;
    ps += dt * 0.5; if (ps >= 1) ps -= 1;
    const att = Math.min(1, i / (kind === 'sub' ? 480 : 96));
    const amp = (t < durS ? 1 : Math.max(0, 1 - (t - durS) / rel)) * att;
    let y: number;
    if (kind === 'saw') {
      lp.set(180 + 1600 * Math.exp(-t / 0.09) * vel + f * 2, 1.3);
      y = lp.tick(saw(p, dt)) * 0.9 + Math.sin(TAU * p) * 0.5;
    } else if (kind === 'pluck') {
      lp.set(150 + 2400 * Math.exp(-t / 0.05), 1.0);
      y = lp.tick(square(p, dt)) * 0.7 * Math.exp(-t / 0.5) + Math.sin(TAU * p) * 0.55;
    } else if (kind === 'round') {
      y = Math.sin(TAU * p) + 0.18 * Math.sin(2 * TAU * p) * Math.exp(-t / 0.2);
      y = Math.tanh(1.3 * y) * 0.8;
    } else {
      y = Math.sin(TAU * p) * 0.9 + (Math.abs(4 * p - 2) - 1) * 0.2;
    }
    return vel * amp * y;
  });
}

/** A detuned-saw pad chord into a stereo pair, filtered; `bright` scales the cutoff. */
export function addPad(L: Buf, R: Buf, s0: number, notes: number[], durS: number, vel: number, o: { attack?: number; release?: number; bright?: number; detune?: number; voices?: number } = {}) {
  const attack = o.attack ?? 0.35, release = o.release ?? 0.9, bright = o.bright ?? 1, detune = o.detune ?? 0.12, voices = o.voices ?? 3;
  const n = Math.round((durS + release) * SR);
  const fl = new Svf(1000, 0.6), fr = new Svf(1000, 0.6);
  const osc = notes.flatMap((m) => Array.from({ length: voices }, (_x, v) => {
    // detune is in semitones at the outer voices (0.12 = ±12 cents)
    const off = voices === 1 ? 0 : ((v - (voices - 1) / 2) / ((voices - 1) / 2)) * detune;
    return { dt: midiHz(m + off) / SR, p: (m * 0.137 + v * 0.31) % 1, pan: voices === 1 ? 0.5 : 0.15 + 0.7 * (v / (voices - 1)) };
  }));
  const g = vel / Math.sqrt(osc.length) * 0.55;
  const a0 = Math.max(0, s0), b0 = Math.min(L.length, s0 + n);
  for (let s = a0; s < b0; s++) {
    const t = (s - s0) / SR;
    const env = (t < attack ? t / attack : 1) * (t < durS ? 1 : Math.max(0, 1 - (t - durS) / release));
    if ((s & 31) === 0) {
      const cut = (700 + 1500 * bright) * (0.75 + 0.25 * Math.sin(TAU * 0.15 * t));
      fl.set(cut, 0.6); fr.set(cut * 1.04, 0.6);
    }
    let l = 0, r = 0;
    for (const o2 of osc) {
      o2.p += o2.dt; if (o2.p >= 1) o2.p -= 1;
      const v = saw(o2.p, o2.dt);
      l += v * (1 - o2.pan); r += v * o2.pan;
    }
    L[s]! += fl.tick(l) * g * env;
    R[s]! += fr.tick(r) * g * env;
  }
}

/** An electric-piano (2-op FM) note: bell attack, warm body. */
export function addKeys(buf: Buf, s0: number, midi: number, durS: number, vel: number, o: { index?: number; decay?: number } = {}) {
  const f = midiHz(midi), idx = o.index ?? 1.6, decay = o.decay ?? 1.4;
  const rel = 0.25;
  const n = Math.round(Math.min(durS + rel, decay * 4) * SR);
  each(buf, s0, n, (i, t) => {
    const I = idx * Math.exp(-t / 0.25) * (0.6 + 0.4 * vel) + 0.15;
    const env = Math.exp(-t / decay) * Math.min(1, i / 48) * (t < durS ? 1 : Math.max(0, 1 - (t - durS) / rel));
    return vel * 0.5 * env * (Math.sin(TAU * f * t + I * Math.sin(TAU * f * t)) + 0.15 * Math.sin(TAU * 2 * f * t) * Math.exp(-t / 0.3));
  });
}

/** Karplus-Strong plucked string. */
export function addPluck(buf: Buf, s0: number, midi: number, vel: number, r: () => number, o: { damp?: number; bright?: number; len?: number } = {}) {
  const f = midiHz(midi);
  const N = Math.max(2, Math.round(SR / f));
  const line = new Float32Array(N);
  const lp = new Svf(2000 + 6000 * (o.bright ?? 0.5), 0.7);
  for (let i = 0; i < N; i++) line[i] = lp.tick(r() * 2 - 1);
  const damp = o.damp ?? 0.996;
  const n = Math.round((o.len ?? 0.9) * SR);
  let idx = 0, prev = 0;
  each(buf, s0, n, (i) => {
    const y = line[idx]!;
    const nv = damp * 0.5 * (y + prev);
    prev = y; line[idx] = nv;
    if (++idx >= N) idx = 0;
    const fade = i > n - 480 ? (n - i) / 480 : 1;
    return vel * 0.7 * y * fade;
  });
}

/** A bright saw lead/arp note through a decaying filter. */
export function addSynth(buf: Buf, s0: number, midi: number, durS: number, vel: number, o: { cutoff?: number; decay?: number; square?: boolean } = {}) {
  const f = midiHz(midi), dt = f / SR;
  const rel = 0.06, decay = o.decay ?? 0.18, cut = o.cutoff ?? 3000;
  const lp = new Svf(cut, 1.2);
  let p = 0, p2 = 0.3;
  const n = Math.round((durS + rel) * SR);
  each(buf, s0, n, (i, t) => {
    p += dt; if (p >= 1) p -= 1;
    p2 += dt * 1.004; if (p2 >= 1) p2 -= 1;
    if ((i & 15) === 0) lp.set(clamp(400 + cut * Math.exp(-t / decay), 200, 16000), 1.2);
    const osc = o.square ? square(p, dt) * 0.6 + square(p2, dt) * 0.4 : saw(p, dt) * 0.6 + saw(p2, dt) * 0.4;
    const env = Math.min(1, i / 48) * (t < durS ? 0.6 + 0.4 * Math.exp(-t / decay) : Math.max(0, 1 - (t - durS) / rel) * (0.6 + 0.4 * Math.exp(-durS / decay)));
    return vel * 0.45 * lp.tick(osc) * env;
  });
}
