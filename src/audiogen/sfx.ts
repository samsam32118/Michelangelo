/**
 * Procedural sound effects: whoosh, swoosh, pop, click, hit, impact, riser, ding, bell, swipe, glitch, typing,
 * camera. Each is a seeded recipe (noise, filters, oscillators, envelopes) rendered in stereo at 48 kHz and
 * levelled to a per-type loudness so they sit under a voice-over without extra gain. `peakAt` is the moment
 * the ear hears as "the hit" (for placing a whoosh on a cut).
 */
import { SR, Svf, clamp, dbGain, hash32, lufs, reverb, rng, truePeakDb } from './dsp.js';
import { addKick } from './instruments.js';

export const SFX_TYPES = ['whoosh', 'swoosh', 'pop', 'click', 'hit', 'impact', 'riser', 'ding', 'bell', 'swipe', 'glitch', 'typing', 'camera'] as const;
export type SfxType = (typeof SFX_TYPES)[number];

export interface SfxResult {
  left: Float32Array;
  right: Float32Array;
  /** seconds from the start to the perceived hit / climax */
  peakAt: number;
  meta: { type: SfxType; seed: number; duration: number; lufs: number; truePeak: number; describe: string };
}

/** Loudness each type is levelled to (LUFS over the sound), before clip gain. */
const TARGET: Record<SfxType, number> = {
  whoosh: -20, swoosh: -21, pop: -19, click: -22, hit: -18, impact: -16, riser: -21, ding: -21, bell: -22, swipe: -23, glitch: -21, typing: -24, camera: -21,
};

const DESCRIBE: Record<SfxType, string> = {
  whoosh: 'airy band-passed noise sweeping up then down, panning left to right (transitions)',
  swoosh: 'short bright sweep (fast transitions, slides)',
  pop: 'round pitch-drop blip (text and sticker entrances)',
  click: 'tiny UI tick (buttons, cursor)',
  hit: 'punchy thump with a snap (hard cuts, beats)',
  impact: 'deep boom with a noisy crash and tail (reveals, title slams)',
  riser: 'rising noise and saw tension build ending at its peak (before a drop or reveal)',
  ding: 'bright single chime (correct, notification)',
  bell: 'inharmonic struck bell with a long ring (moments, chapter starts)',
  swipe: 'soft quick air swipe (cards, carousels)',
  glitch: 'stuttered digital bursts (glitch transitions)',
  typing: 'a run of keyboard clicks (typing text)',
  camera: 'mechanical shutter: two clicks with a burst (photo, freeze frame)',
};
export function sfxDescribe(t: SfxType): string { return DESCRIBE[t]; }

const TAU = Math.PI * 2;

export function generateSfx(type: SfxType, seed = 0): SfxResult {
  const r = rng(hash32(`sfx:${type}:${seed >>> 0}`));
  const vary = (x: number, amt = 0.1) => x * (1 + (r() * 2 - 1) * amt);
  const buf = (s: number) => [new Float32Array(Math.round(s * SR)), new Float32Array(Math.round(s * SR))] as const;
  let L: Float32Array, R: Float32Array, peakAt = 0;
  const noise = () => r() * 2 - 1;

  /** band-passed noise sweep with a bell envelope and a pan sweep */
  const sweep = (dur: number, f0: number, fPeak: number, f1: number, q: number, peakFrac: number, pan: [number, number]) => {
    [L, R] = buf(dur);
    const bp = new Svf(f0, q), bp2 = new Svf(f0 * 1.5, q);
    const pk = dur * peakFrac;
    for (let i = 0; i < L.length; i++) {
      const t = i / SR;
      const f = t < pk ? f0 * Math.pow(fPeak / f0, t / pk) : fPeak * Math.pow(f1 / fPeak, (t - pk) / (dur - pk));
      if ((i & 7) === 0) { bp.set(f, q); bp2.set(f * 1.6, q); }
      const x = noise();
      bp.tick(x); bp2.tick(x);
      const env = t < pk ? Math.pow(t / pk, 2) : Math.pow(1 - (t - pk) / (dur - pk), 1.6);
      const p = pan[0] + (pan[1] - pan[0]) * (t / dur);
      const y = (bp.bp + 0.4 * bp2.bp) * env;
      L[i] = y * Math.cos((p * Math.PI) / 2); R[i] = y * Math.sin((p * Math.PI) / 2);
    }
    peakAt = pk;
  };
  const mono = (dur: number, f: (t: number, i: number) => number) => {
    [L, R] = buf(dur);
    for (let i = 0; i < L.length; i++) { const y = f(i / SR, i); L[i] = y; R[i] = y; }
  };
  const addVerb = (amt: number, room = 0.75) => {
    const pad = Math.round(room * 1.2 * SR);
    const l2 = new Float32Array(L.length + pad), r2 = new Float32Array(L.length + pad);
    l2.set(L); r2.set(R);
    const [wl, wr] = reverb(l2, r2, { room, damp: 0.45 });
    for (let i = 0; i < l2.length; i++) { l2[i]! += wl[i]! * amt; r2[i]! += wr[i]! * amt; }
    L = l2; R = r2;
  };

  switch (type) {
    case 'whoosh': {
      const lr = r() < 0.5;
      sweep(vary(0.75), vary(300), vary(2200), vary(500), 1.6, vary(0.55, 0.08), lr ? [0.2, 0.8] : [0.8, 0.2]);
      addVerb(0.25, 0.6);
      break;
    }
    case 'swoosh': sweep(vary(0.38), vary(900), vary(5200), vary(1800), 1.4, 0.45, r() < 0.5 ? [0.3, 0.7] : [0.7, 0.3]); break;
    case 'swipe': sweep(vary(0.24), vary(1800), vary(6000), vary(3500), 0.9, 0.35, [0.45, 0.55]); break;
    case 'pop': {
      const f0 = vary(1250), f1 = vary(380);
      let ph = 0;
      mono(0.16, (t) => {
        ph += (f1 + (f0 - f1) * Math.exp(-t / 0.018)) / SR;
        const env = Math.min(1, t / 0.0015) * Math.exp(-t / 0.035);
        return Math.sin(TAU * ph) * env + (t < 0.003 ? noise() * 0.3 * (1 - t / 0.003) : 0);
      });
      peakAt = 0.004;
      break;
    }
    case 'click': {
      const bp = new Svf(vary(3200), 2);
      const f = vary(2100);
      mono(0.045, (t) => { bp.tick(noise()); return (bp.bp * 1.5 + Math.sin(TAU * f * t) * 0.6) * Math.exp(-t / 0.004); });
      peakAt = 0.001;
      break;
    }
    case 'hit': {
      [L, R] = buf(0.7);
      addKick(L, 0, 1, { f0: vary(180), f1: vary(52), decay: 0.16, drive: 2.5, click: 0.6, pitchDecay: 0.03 });
      const bp = new Svf(vary(2200), 0.8), body = vary(190);
      for (let i = 0; i < L.length; i++) { const t = i / SR; bp.tick(noise()); L[i]! += bp.bp * 3 * Math.exp(-t / 0.045) + 0.5 * Math.sin(TAU * body * t) * Math.exp(-t / 0.06); }
      R.set(L);
      addVerb(0.12, 0.5);
      peakAt = 0.003;
      break;
    }
    case 'impact': {
      [L, R] = buf(2.4);
      addKick(L, 0, 1, { f0: vary(110), f1: vary(32), decay: 0.55, drive: 3, click: 0.4, pitchDecay: 0.06 });
      const lp = new Svf(vary(2500), 0.7), lp2 = new Svf(2500, 0.7);
      for (let i = 0; i < L.length; i++) {
        const t = i / SR;
        const fc = 900 + 7000 * Math.exp(-t / 0.2);
        if ((i & 15) === 0) { lp.set(fc, 0.7); lp2.set(fc * 1.1, 0.7); }
        const crash = Math.exp(-t / 0.4) * Math.min(1, t / 0.002);
        const thud = 0.6 * Math.sin(TAU * 140 * t) * Math.exp(-t / 0.09);
        const a = lp.tick(noise()) * crash * 2.2, b = lp2.tick(noise()) * crash * 2.2;
        R[i] = L[i]! + b + thud; L[i]! += a + thud;
      }
      addVerb(0.35, 0.85);
      peakAt = 0.005;
      break;
    }
    case 'riser': {
      const dur = vary(2, 0.05);
      [L, R] = buf(dur + 0.05);
      const bpL = new Svf(400, 1.2), bpR = new Svf(400, 1.2), lp = new Svf(500, 1.5);
      let p1 = 0, p2 = 0.3;
      for (let i = 0; i < L.length; i++) {
        const t = i / SR, u = clamp(t / dur, 0, 1);
        const fN = 300 * Math.pow(25, u), fS = 110 * Math.pow(4, u * u);
        if ((i & 7) === 0) { bpL.set(fN, 1.2); bpR.set(fN * 1.07, 1.2); lp.set(400 + 5000 * u * u, 2); }
        p1 = (p1 + fS / SR) % 1; p2 = (p2 + (fS * 1.008) / SR) % 1;
        const tone = lp.tick((2 * p1 - 1) + (2 * p2 - 1)) * 0.35;
        const env = Math.pow(u, 1.8) * (t > dur ? Math.max(0, 1 - (t - dur) / 0.05) : 1);
        const trem = 1 + 0.25 * Math.sin(TAU * (4 + 14 * u) * t);
        bpL.tick(noise()); bpR.tick(noise());
        L[i] = (bpL.bp * 0.9 + tone) * env * trem; R[i] = (bpR.bp * 0.9 + tone) * env * trem;
      }
      peakAt = dur;
      break;
    }
    case 'ding': {
      const f = vary(1320, 0.05);
      mono(1.4, (t) => {
        const env = Math.min(1, t / 0.002) * Math.exp(-t / 0.35);
        return env * (Math.sin(TAU * f * t) + 0.35 * Math.sin(TAU * f * 2.0 * t) * Math.exp(-t / 0.15) + 0.2 * Math.sin(TAU * f * 3.01 * t) * Math.exp(-t / 0.08));
      });
      addVerb(0.2, 0.6);
      peakAt = 0.003;
      break;
    }
    case 'bell': {
      const f = vary(520, 0.06);
      const partials: [number, number, number][] = [[0.56, 1, 2.2], [0.92, 0.67, 1.8], [1.19, 1, 1.2], [1.71, 1.8, 0.9], [2, 2.67, 0.8], [2.74, 1.67, 0.6], [3, 1.46, 0.45], [3.76, 1.33, 0.35], [4.07, 1.33, 0.3]];
      mono(3.2, (t) => {
        let y = 0;
        for (const [m, a, d] of partials) y += a * Math.sin(TAU * f * m * t + m) * Math.exp(-t / d);
        return (y / 6) * Math.min(1, t / 0.001);
      });
      addVerb(0.18, 0.7);
      peakAt = 0.002;
      break;
    }
    case 'glitch': {
      const dur = vary(0.45);
      [L, R] = buf(dur);
      let pos = 0;
      while (pos < L.length) {
        const seg = Math.round(SR * (0.012 + r() * 0.05));
        const kind = Math.floor(r() * 4);
        const f = 80 + r() * 1800, crush = 2 + Math.floor(r() * 12), amp = 0.4 + r() * 0.6, pan = r();
        let hold = 0;
        for (let i = 0; i < seg && pos + i < L.length; i++) {
          const t = i / SR;
          if (i % crush === 0) hold = kind === 0 ? noise() : kind === 1 ? (Math.sin(TAU * f * t) > 0 ? 1 : -1) : kind === 2 ? Math.sin(TAU * f * t * (1 + 4 * t)) : 0;
          const y = hold * amp * (i < 48 ? i / 48 : 1) * (seg - i < 48 ? (seg - i) / 48 : 1);
          L[pos + i] = y * (1 - pan * 0.6); R[pos + i] = y * (0.4 + pan * 0.6);
        }
        pos += seg;
      }
      peakAt = 0.01;
      break;
    }
    case 'typing': {
      const dur = vary(1.3, 0.05);
      [L, R] = buf(dur + 0.05);
      let t = 0.01;
      while (t < dur) {
        const s0 = Math.round(t * SR);
        const f = 1800 + r() * 1600, body = 180 + r() * 80, a = 0.5 + r() * 0.5, pan = 0.35 + r() * 0.3;
        const bp = new Svf(f, 1.8);
        for (let i = 0; i < 0.03 * SR && s0 + i < L.length; i++) {
          const u = i / SR;
          bp.tick(noise());
          const y = a * (bp.bp * Math.exp(-u / 0.004) + 0.35 * Math.sin(TAU * body * u) * Math.exp(-u / 0.01));
          L[s0 + i]! += y * (1 - pan); R[s0 + i]! += y * pan;
        }
        t += r() < 0.12 ? 0.16 + r() * 0.12 : 0.06 + r() * 0.07;
      }
      peakAt = 0.012;
      break;
    }
    case 'camera': {
      [L, R] = buf(0.32);
      const click = (at: number, f: number, a: number) => {
        const bp = new Svf(f, 1.4), s0 = Math.round(at * SR);
        for (let i = 0; i < 0.04 * SR; i++) { const u = i / SR; bp.tick(noise()); L[s0 + i]! += a * (bp.bp * Math.exp(-u / 0.006) + 0.4 * Math.sin(TAU * 420 * u) * Math.exp(-u / 0.01)); }
      };
      click(0, vary(2600), 1);
      const hp = new Svf(3000, 0.7), s1 = Math.round(0.02 * SR);
      for (let i = 0; i < 0.09 * SR; i++) { const u = i / SR; hp.tick(noise()); L[s1 + i]! += hp.hp * 0.25 * Math.sin((Math.PI * u) / 0.09); }
      click(vary(0.14, 0.05), vary(1900), 0.8);
      R.set(L);
      peakAt = 0.002;
      break;
    }
  }
  // level to the type's loudness, never above -1.5 dBTP
  const chans = [L!, R!];
  const l = lufs(chans), tp = truePeakDb(chans);
  const g = Math.min(Number.isFinite(l) ? dbGain(TARGET[type] - l) : 1, dbGain(-1.5 - tp));
  for (const c of chans) for (let i = 0; i < c.length; i++) c[i]! *= g;
  // 3 ms fade-out so every file ends at zero
  const fo = Math.min(chans[0]!.length, Math.round(0.003 * SR));
  for (const c of chans) for (let i = 0; i < fo; i++) c[c.length - 1 - i]! *= i / fo;
  const m = { lufs: Math.round(lufs(chans) * 10) / 10, truePeak: Math.round(truePeakDb(chans) * 10) / 10 };
  return { left: chans[0]!, right: chans[1]!, peakAt: Math.round(peakAt * 1000) / 1000, meta: { type, seed, duration: chans[0]!.length / SR, ...m, describe: DESCRIBE[type] } };
}
