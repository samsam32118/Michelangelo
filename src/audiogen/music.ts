/**
 * Procedural music beds: a mood picks tempo, scale, a 4-bar chord progression, drum patterns, bass line,
 * pad/keys and an arpeggio; an intensity curve (0..1 over time) brings layers in and out bar by bar. The
 * result is a whole number of bars with reverb/delay tails folded back onto the start, so it loops
 * seamlessly, mastered to a loudness target with a true-peak ceiling. Deterministic for (params, seed).
 */
import { SR, Biquad, curveAt, dbGain, gainDb, hash32, master, pingPong, reverb, rng } from './dsp.js';
import { addBass, addClap, addCrash, addHat, addKeys, addKick, addPad, addPluck, addRim, addShaker, addSnare, addSynth, addTom, type BassKind, type KickOpts } from './instruments.js';

export const MOODS = ['upbeat', 'chill', 'dramatic', 'corporate', 'lofi', 'epic'] as const;
export type Mood = (typeof MOODS)[number];

export interface MusicParams {
  /** length in seconds (rounded up to whole bars in the file) */
  len: number;
  mood: Mood;
  bpm?: number;
  /** "A", "Am", "F# minor", "Bb major" ... */
  key?: string;
  seed?: number;
  /** [[seconds, 0..1], ...] */
  intensity?: [number, number][];
  /** loudness target (default -18 LUFS) */
  lufs?: number;
}

export interface MusicMeta {
  mood: Mood;
  bpm: number;
  key: string;
  chords: string[];
  bars: number;
  /** file length in seconds (whole bars; loops seamlessly) */
  duration: number;
  /** seconds per beat / bar */
  beat: number;
  bar: number;
  lufs: number;
  truePeak: number;
  layers: string[];
}

export interface MusicResult { left: Float32Array; right: Float32Array; meta: MusicMeta }

// ----------------------------------------------------------------------------------- theory

const PCS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];

export interface Key { pc: number; minor: boolean; name: string }

/** Parse a key name; undefined when it is not one. */
export function parseKey(s: string): Key | undefined {
  const m = /^\s*([A-Ga-g])\s*([#♯b♭]?)\s*(m|min|minor|maj|major|M)?\s*$/.exec(s);
  if (!m) return undefined;
  let pc = PCS[m[1]!.toUpperCase()]!;
  if (m[2] === '#' || m[2] === '♯') pc = (pc + 1) % 12;
  if (m[2] === 'b' || m[2] === '♭') pc = (pc + 11) % 12;
  const minor = m[3] === 'm' || m[3] === 'min' || m[3] === 'minor';
  const flat = m[2] === 'b' || m[2] === '♭';
  const k = { pc, minor, name: '' };
  k.name = `${(flat || useFlats(k) ? NAMES_FLAT : NAMES_SHARP)[pc]} ${minor ? 'minor' : 'major'}`;
  return k;
}

/** Keys conventionally spelled with flats. */
function useFlats(k: { pc: number; minor: boolean; name?: string }): boolean {
  if (k.name && /^[A-G]b /.test(k.name)) return true;
  return (k.minor ? [2, 7, 0, 5, 10, 3, 8] : [5, 10, 3, 8, 1, 6]).includes(k.pc);
}

interface Chord { root: number; notes: number[]; name: string }

function chordOf(key: Key, degree: number, seventh: boolean): Chord {
  const scale = key.minor ? MINOR : MAJOR;
  const tones = [0, 2, 4, ...(seventh ? [6] : [])].map((k) => {
    const d = degree + k;
    return key.pc + scale[d % 7]! + 12 * Math.floor(d / 7);
  });
  const rootPc = ((tones[0]! % 12) + 12) % 12;
  const iv = tones.map((t) => t - tones[0]!);
  const third = iv[1] === 3 ? 'm' : '';
  const fifth = iv[2] === 6 ? 'dim' : '';
  let q = fifth ? (third ? 'dim' : 'b5') : third;
  if (seventh) {
    const sev = iv[3]!;
    if (fifth && third) q = 'm7b5';
    else if (third) q = 'm7';
    else q = sev === 11 ? 'maj7' : '7';
  }
  const names = useFlats(key) ? NAMES_FLAT : NAMES_SHARP;
  return { root: rootPc, notes: tones.map((t) => ((t % 12) + 12) % 12), name: names[rootPc] + q };
}

/** Pad voicing near the previous one (smooth voice leading), within ~[52, 76]. */
function voice(pcs: number[], prev: number[] | undefined): number[] {
  const cands: number[][] = [];
  for (let base = 50; base <= 62; base++) {
    // the lowest note at or above `base` of each pitch class, ascending
    const v = pcs.map((pc) => { let n = base + ((pc - base) % 12 + 12) % 12; return n; }).sort((a, b) => a - b);
    cands.push(v);
  }
  const target = prev ?? pcs.map((_x, i) => 58 + i * 4);
  let best = cands[0]!, bestD = Infinity;
  for (const c of cands) {
    const d = c.reduce((s, n, i) => s + Math.abs(n - (target[Math.min(i, target.length - 1)] ?? 60)), 0) + (c[c.length - 1]! > 76 ? 20 : 0);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

// ----------------------------------------------------------------------------------- moods

type Arp = { voice: 'synth' | 'pluck' | 'keys'; rate: 8 | 16; mode: 'up' | 'updown' | 'ostinato' | 'random'; low: number; vel: number };
interface MoodDef {
  bpm: [number, number];
  minor: boolean;
  sevenths: boolean;
  keys: string[];
  progs: number[][];
  swing: number;
  kick: KickOpts;
  drums: Partial<Record<'kick' | 'snare' | 'clap' | 'rim' | 'hat' | 'hat16' | 'ohat' | 'shaker' | 'tom', string[]>>;
  bass: { kind: BassKind; pattern: string[] };
  pad?: { bright: number; attack: number; voices: number; vel: number };
  comp?: { pattern: string };
  arp?: Arp;
  melody?: boolean;
  reverb: number;
  delay?: number;
  pump?: number;
  lowpass?: number;
  crackle?: boolean;
  tomFills?: boolean;
  crashEvery?: number;
  /** stem balance: each stem's RMS (dB, relative) over the bars it plays */
  mix: Partial<Record<string, number>>;
}

const MOOD_DEFS: Record<Mood, MoodDef> = {
  upbeat: {
    bpm: [118, 128], minor: false, sevenths: false, keys: ['C', 'D', 'G', 'A', 'F', 'E'],
    progs: [[0, 4, 5, 3], [5, 3, 0, 4], [0, 5, 3, 4]], swing: 0.5,
    kick: { f0: 160, f1: 50, decay: 0.28, drive: 2, click: 0.8 },
    drums: { kick: ['X...X...X...X...'], clap: ['....X.......X...'], ohat: ['..x...x...x...x.'], hat16: ['xoxoxoxoxoxoxoxo', 'xoxoxoxoxoxoxxxo'], shaker: ['oxoxoxoxoxoxoxox'] },
    bass: { kind: 'saw', pattern: ['r.o.r.o.r.o.r.o.', 'r.o.r.o.r.o.f.o.'] },
    pad: { bright: 1.1, attack: 0.08, voices: 3, vel: 0.8 },
    arp: { voice: 'synth', rate: 16, mode: 'up', low: 64, vel: 0.55 },
    reverb: 0.22, delay: 0.75, pump: 0.55, crashEvery: 8,
    mix: { kick: -14, bass: -17, pad: -19, arp: -21, clap: -24, ohat: -28, hat16: -28, shaker: -31 },
  },
  chill: {
    bpm: [84, 96], minor: false, sevenths: true, keys: ['D', 'F', 'Eb', 'G', 'C'],
    progs: [[0, 5, 1, 4], [3, 4, 2, 5], [3, 2, 1, 0]], swing: 0.56,
    kick: { f0: 120, f1: 48, decay: 0.3, drive: 1.2, click: 0.15 },
    drums: { kick: ['X......x..X.....', 'X.........X..x..'], rim: ['....X.......X...'], hat: ['x.x.x.x.x.x.x.x.'], shaker: ['.x.x.x.x.x.x.x.x'] },
    bass: { kind: 'round', pattern: ['r-----.r--f---.-', 'r-------f---o---'] },
    pad: { bright: 0.5, attack: 0.5, voices: 3, vel: 0.7 },
    arp: { voice: 'pluck', rate: 8, mode: 'updown', low: 62, vel: 0.5 },
    reverb: 0.32, delay: 0.5, crashEvery: 0,
    mix: { kick: -17, bass: -16, pad: -17, arp: -20, rim: -24, hat: -29, shaker: -32 },
  },
  dramatic: {
    bpm: [76, 90], minor: true, sevenths: false, keys: ['D', 'C', 'E', 'A', 'F'],
    progs: [[0, 5, 2, 6], [0, 3, 5, 4], [0, 6, 5, 6]], swing: 0.5,
    kick: { f0: 110, f1: 38, decay: 0.55, drive: 1.8, click: 0.2 },
    drums: { kick: ['X.........X.....', 'X.....X...X.....'], snare: ['........X.......'], hat: ['x...x...x...x...'], hat16: ['x.xxx.xxx.xxx.xx'], tom: ['............x.x.'] },
    bass: { kind: 'sub', pattern: ['r---------------', 'r-------r---f---'] },
    pad: { bright: 0.55, attack: 0.9, voices: 3, vel: 0.95 },
    arp: { voice: 'pluck', rate: 8, mode: 'ostinato', low: 57, vel: 0.6 },
    reverb: 0.45, crashEvery: 4, tomFills: true,
    mix: { kick: -16, snare: -19, pad: -16, bass: -17, tom: -19, arp: -21, hat: -29, hat16: -30, crash: -28 },
  },
  corporate: {
    bpm: [104, 116], minor: false, sevenths: false, keys: ['C', 'G', 'D', 'F', 'A'],
    progs: [[0, 4, 5, 3], [3, 0, 4, 5], [0, 3, 5, 4]], swing: 0.5,
    kick: { f0: 140, f1: 52, decay: 0.24, drive: 1.4, click: 0.25 },
    drums: { kick: ['X.......X.......', 'X.......X.x.....'], clap: ['....X.......X...'], hat: ['x.x.x.x.x.x.x.x.'], shaker: ['oxoxoxoxoxoxoxox'] },
    bass: { kind: 'pluck', pattern: ['r.r.r.r.r.r.f.f.', 'r.r.r.r.o.r.r.r.'] },
    pad: { bright: 0.8, attack: 0.25, voices: 2, vel: 0.55 },
    arp: { voice: 'keys', rate: 8, mode: 'up', low: 64, vel: 0.55 },
    reverb: 0.2, delay: 0.5, pump: 0.25, crashEvery: 8,
    mix: { kick: -16, bass: -17, pad: -20, arp: -19, clap: -21, hat: -28, shaker: -30 },
  },
  lofi: {
    bpm: [72, 86], minor: false, sevenths: true, keys: ['F', 'Eb', 'D', 'Bb', 'A'],
    progs: [[1, 4, 0, 5], [3, 2, 1, 0], [5, 1, 4, 0]], swing: 0.6,
    kick: { f0: 105, f1: 46, decay: 0.32, drive: 1.5, click: 0.1 },
    drums: { kick: ['X......X..X.....', 'X.....x...X..x..'], snare: ['....X.......X...'], hat: ['x.x.x.x.x.x.x.x.', 'x.x.x.xxx.x.x.x.'] },
    bass: { kind: 'round', pattern: ['r--.--r.f--.----', 'r-----r---f-o---'] },
    comp: { pattern: 'X-----x-----.---' },
    melody: true,
    reverb: 0.28, lowpass: 5200, crackle: true, crashEvery: 0,
    mix: { kick: -16, snare: -20, comp: -16, bass: -16, melody: -20, hat: -28 },
  },
  epic: {
    bpm: [84, 96], minor: true, sevenths: false, keys: ['D', 'C', 'E', 'F', 'G'],
    progs: [[0, 5, 2, 6], [0, 5, 6, 4], [0, 3, 5, 6]], swing: 0.5,
    kick: { f0: 120, f1: 40, decay: 0.45, drive: 2.2, click: 0.3 },
    drums: { kick: ['X.......X.......', 'X.....X.X.......'], snare: ['........X.......'], tom: ['X..x..X.X..x..x.', 'X..x..X.X.xxX.x.'], hat16: ['xoooxoooxoooxooo'] },
    bass: { kind: 'saw', pattern: ['r.r.r.r.r.r.r.r.', 'r.r.r.r.o.o.r.r.'] },
    pad: { bright: 1.0, attack: 0.4, voices: 4, vel: 1 },
    arp: { voice: 'synth', rate: 16, mode: 'ostinato', low: 57, vel: 0.5 },
    reverb: 0.42, delay: 0.75, crashEvery: 4, tomFills: true, pump: 0.2,
    mix: { kick: -15, tom: -17, pad: -16, snare: -18, bass: -18, arp: -22, hat16: -29, crash: -27 },
  },
};

/** Layer gates: a layer plays in a bar when the intensity there is at least this. */
const GATE: Record<string, number> = { pad: 0, comp: 0, kick: 0.2, bass: 0.3, snare: 0.4, clap: 0.4, rim: 0.4, hat: 0.45, ohat: 0.45, arp: 0.6, melody: 0.6, tom: 0.6, hat16: 0.7, shaker: 0.7, crash: 0.7 };

/** Default intensity: a build into the body, a lift late on, a softer last bar. */
export function defaultIntensity(total: number, bar: number): [number, number][] {
  if (total <= bar * 4) return [[0, 0.75], [total, 0.75]];
  return [[0, 0.45], [Math.min(bar * 2, total * 0.25) - 0.01, 0.5], [Math.min(bar * 2, total * 0.25), 0.78], [total * 0.6, 0.8], [total * 0.6 + 0.01, 0.92], [Math.max(total - bar, total * 0.6 + 0.02), 0.92], [Math.max(total - bar + 0.01, total * 0.6 + 0.03), 0.6], [total, 0.6]];
}

const VEL: Record<string, number> = { X: 1, x: 0.72, o: 0.42 };

// ----------------------------------------------------------------------------------- renderer

/** Tuning aid: set `debug.stems = {}` to receive each stem's RMS level (dB) after a render. */
export const debug: { stems?: Record<string, number> } = {};

export function generateMusic(p: MusicParams): MusicResult {
  const def = MOOD_DEFS[p.mood];
  const seed = (p.seed ?? 0) >>> 0;
  const r = rng(hash32(`music:${p.mood}:${seed}`));
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  const bpm = p.bpm ?? Math.round(def.bpm[0] + r() * (def.bpm[1] - def.bpm[0]));
  const key = (p.key ? parseKey(p.key) : undefined) ?? parseKey(pick(def.keys) + (def.minor ? 'm' : ''))!;
  const prog = pick(def.progs);
  const beat = 60 / bpm, bar = beat * 4;
  const bars = Math.max(2, Math.ceil(p.len / bar - 1e-6));
  const loopLen = Math.round(bars * bar * SR);
  const tail = Math.round(3.5 * SR);
  const N = loopLen + tail;
  const intensity = (p.intensity?.length ? [...p.intensity].sort((a, b) => a[0] - b[0]) : defaultIntensity(bars * bar, bar));
  const chords = prog.map((d) => chordOf(key, d, def.sevenths));
  const variant = Math.floor(r() * 2);

  // stems (mono unless noted)
  const stems = new Map<string, Float32Array>();
  const barUsed = new Set<string>();
  const activeBars = new Map<string, number>();
  const stem = (name: string) => { barUsed.add(name); let b = stems.get(name); if (!b) { b = new Float32Array(N); stems.set(name, b); } return b; };
  const padL = new Float32Array(N), padR = new Float32Array(N);
  // notes and hits are rendered once per distinct sound and mixed in with their velocity (fast, and identical repeats are inaudible here)
  const memo = new Map<string, Float32Array[]>();
  const play = (dst: Float32Array[], key: string, seconds: number, s0: number, g: number, render: (bufs: Float32Array[]) => void) => {
    let src = memo.get(key);
    if (!src) { src = dst.map(() => new Float32Array(Math.round(seconds * SR))); render(src); memo.set(key, src); }
    for (let c = 0; c < dst.length; c++) {
      const d = dst[c]!, sb = src[c]!;
      const a = Math.max(0, -s0), b = Math.min(sb.length, d.length - s0);
      for (let i = a; i < b; i++) d[s0 + i]! += sb[i]! * g;
    }
  };
  const hr = rng(hash32(`hits:${seed}`));
  const vary = (k: number) => Math.floor(r() * k);
  const used = new Set<string>();

  const stepTime = (barIdx: number, step: number) => {
    const s = def.swing;
    const within = [0, s / 2, s, s + (1 - s) / 2][step % 4]!;
    return barIdx * bar + (Math.floor(step / 4) + within) * beat;
  };
  const human = (t: number, amt = 0.003) => Math.max(0, Math.round((t + (r() * 2 - 1) * amt) * SR));
  const hv = (v: number) => v * (0.92 + r() * 0.16);
  const kickTimes: number[] = [];
  let prevVoicing: number[] | undefined;
  const bassRoot = (pc: number) => 33 + ((pc - 9 + 12) % 12); // A1..G#2
  const crashAt = (b: number) => def.crashEvery && b > 0 && b % def.crashEvery === 0;

  for (let b = 0; b < bars; b++) {
    for (const u of barUsed) activeBars.set(u, (activeBars.get(u) ?? 0) + 1);
    barUsed.clear();
    const level = curveAt(intensity, b * bar + 0.01);
    const on = (layer: string) => level >= (GATE[layer] ?? 0);
    const chord = chords[b % chords.length]!;
    const nextChord = chords[(b + 1) % chords.length]!;
    const phraseEnd = b % 4 === 3;
    const fill = phraseEnd && level >= 0.55 && b < bars - 1;
    const lift = 0.75 + 0.35 * level;
    // drums
    for (const [inst, pats] of Object.entries(def.drums) as [string, string[]][]) {
      if (!on(inst)) continue;
      if (inst === 'hat' && def.drums.hat16 && on('hat16')) continue;
      if (inst === 'tom' && !def.tomFills && !on('tom')) continue;
      const pat = pats[(b + variant) % pats.length]!;
      used.add(inst);
      for (let st = 0; st < 16; st++) {
        let ch = pat[st]!;
        if (fill && st >= 12 && (inst === 'snare' || inst === 'clap') && !def.tomFills) ch = st % 2 === 0 || level > 0.8 ? 'x' : ch;
        const v = VEL[ch];
        if (!v) continue;
        const t = stepTime(b, st);
        const s0 = human(t, inst === 'kick' ? 0.001 : 0.004);
        const vel = hv(v) * lift;
        const dst = [stem(inst)];
        switch (inst) {
          case 'kick': play(dst, 'kick', 1.6, s0, vel, ([b]) => addKick(b!, 0, 1, def.kick)); kickTimes.push(t); break;
          case 'snare': play(dst, `snare${vary(3)}`, 1.4, s0, vel, ([b]) => addSnare(b!, 0, 1, hr, p.mood === 'lofi' ? { decay: 0.12, bright: 1800 } : p.mood === 'epic' || p.mood === 'dramatic' ? { decay: 0.26, tone: 170 } : {})); break;
          case 'clap': play(dst, `clap${vary(3)}`, 0.6, s0, vel, ([b]) => addClap(b!, 0, 1, hr)); break;
          case 'rim': play(dst, 'rim', 0.08, s0, vel, ([b]) => addRim(b!, 0, 1)); break;
          case 'hat': case 'hat16': play(dst, `hat${vary(4)}`, 0.2, s0, vel, ([b]) => addHat(b!, 0, 1, hr, false, p.mood === 'lofi' ? 0.7 : 1)); break;
          case 'ohat': play(dst, `ohat${vary(3)}`, 1.4, s0, vel, ([b]) => addHat(b!, 0, 1, hr, true)); break;
          case 'shaker': play(dst, `shaker${vary(4)}`, 0.09, s0, vel, ([b]) => addShaker(b!, 0, 1, hr)); break;
          case 'tom': { const f = 70 + (st % 3) * 18; play(dst, `tom${f}`, 2, s0, vel, ([b]) => addTom(b!, 0, 1, f, 0.4)); break; }
        }
      }
    }
    if (fill && def.tomFills) {
      used.add('tom');
      for (let k = 0; k < 4; k++) { const f = 140 - k * 22; play([stem('tom')], `fill${f}`, 1.5, human(stepTime(b, 12 + k)), hv(0.6 + 0.12 * k), ([x]) => addTom(x!, 0, 1, f, 0.3)); }
    }
    if (crashAt(b) && on('crash')) { used.add('crash'); play([stem('crash')], 'crash', 6.4, human(b * bar), 0.9, ([x]) => addCrash(x!, 0, 1, hr)); }
    // bass
    if (on('bass')) {
      used.add('bass');
      const pat = def.bass.pattern[(b + variant) % def.bass.pattern.length]!;
      const root = bassRoot(chord.root);
      for (let st = 0; st < 16; st++) {
        const ch = pat[st]!;
        if (ch === '.' || ch === '-') continue;
        let len = 1; while (st + len < 16 && pat[st + len] === '-') len++;
        const note = ch === 'o' ? root + 12 : ch === 'f' ? root + 7 : root;
        const durS = len * beat / 4 * (len === 1 ? 0.85 : 0.97);
        // approach the next chord on the last 16th of a phrase-turnaround
        const n2 = st === 15 && len === 1 ? bassRoot(nextChord.root) : note;
        play([stem('bass')], `bass${n2}:${Math.round(durS * 1000)}`, durS + 0.05, human(stepTime(b, st), 0.002), hv(st % 4 === 0 ? 1 : 0.8), ([x]) => addBass(x!, 0, n2, durS, 1, def.bass.kind));
      }
    }
    const voicing = voice(chord.notes, prevVoicing);
    prevVoicing = voicing;
    // pad
    if (def.pad && on('pad')) {
      used.add('pad'); barUsed.add('pad');
      const bright = Math.round(def.pad.bright * (0.7 + 0.5 * level) * 10) / 10, release = Math.min(1.2, bar * 0.4), pd = def.pad;
      play([padL, padR], `pad${voicing.join(',')}:${bright}`, bar * 0.98 + release, Math.round(b * bar * SR), pd.vel * (0.7 + 0.3 * level), ([l, rr]) => addPad(l!, rr!, 0, voicing, bar * 0.98, 1, { bright, attack: pd.attack, voices: pd.voices, release }));
    }
    // keys comping (lofi)
    if (def.comp && on('comp')) {
      used.add('comp');
      const pat = def.comp.pattern;
      for (let st = 0; st < 16; st++) {
        const v = VEL[pat[st]!];
        if (!v) continue;
        let len = 1; while (st + len < 16 && pat[st + len] === '-') len++;
        const dur = len * beat / 4;
        for (const [k, n] of voicing.entries()) play([stem('comp')], `comp${n}:${Math.round(dur * 1000)}`, Math.min(dur + 0.25, 6.4), human(stepTime(b, st) + k * 0.012), hv(v) * 0.6, ([x]) => addKeys(x!, 0, n, dur, 1, { index: 1.1, decay: 1.6 }));
      }
    }
    // arpeggio
    if (def.arp && on('arp')) {
      used.add('arp');
      const a = def.arp;
      const tones = [...voicing.map((n) => n + 12 * Math.ceil((a.low - n) / 12)).sort((x, y) => x - y)];
      const ladder = [...tones, ...tones.map((n) => n + 12)].sort((x, y) => x - y);
      const steps = a.rate;
      for (let k = 0; k < steps; k++) {
        const st = k * (16 / steps);
        let note: number;
        if (a.mode === 'up') note = ladder[k % ladder.length]!;
        else if (a.mode === 'updown') { const cyc = ladder.length * 2 - 2; const i = k % cyc; note = ladder[i < ladder.length ? i : cyc - i]!; }
        else if (a.mode === 'ostinato') note = [ladder[0]!, ladder[2]!, ladder[1]!, ladder[2]!][k % 4]! + (k >= steps / 2 && level > 0.85 ? 12 : 0);
        else note = ladder[Math.floor(r() * ladder.length)]!;
        if (p.mood === 'chill' && r() < 0.25) continue;
        const durS = (beat * 4) / steps * 0.6;
        const s0 = human(stepTime(b, st), 0.002);
        const vel = hv(a.vel) * (k % (steps / 4) === 0 ? 1 : 0.8);
        const lv = Math.round(level * 10) / 10;
        if (a.voice === 'synth') play([stem('arp')], `synth${note}:${lv}`, durS + 0.07, s0, vel, ([x]) => addSynth(x!, 0, note, durS, 1, { cutoff: 1800 + 2600 * lv, decay: 0.12 }));
        else if (a.voice === 'pluck') play([stem('arp')], `pluck${note}:${lv}:${vary(2)}`, 0.9, s0, vel, ([x]) => addPluck(x!, 0, note, 1, hr, { bright: 0.35 + 0.4 * lv, len: 0.9 }));
        else play([stem('arp')], `keys${note}`, durS * 1.6 + 0.26, s0, vel, ([x]) => addKeys(x!, 0, note, durS * 1.6, 1, { index: 0.7, decay: 0.7 }));
      }
    }
    // lofi melody: sparse chord/pentatonic notes
    if (def.melody && on('melody')) {
      used.add('melody');
      const penta = (key.minor ? [0, 3, 5, 7, 10] : [0, 2, 4, 7, 9]).map((x) => key.pc + x);
      for (let st = 0; st < 16; st += 2) {
        if (r() > (st % 4 === 0 ? 0.45 : 0.25)) continue;
        const pool = r() < 0.6 ? chord.notes : penta;
        const pc = pool[Math.floor(r() * pool.length)]!;
        const note = 67 + (((pc - 67) % 12) + 12) % 12;
        const dur = Math.round(beat * (0.5 + r()) * 20) / 20;
        play([stem('melody')], `mel${note}:${dur}`, dur + 0.26, human(stepTime(b, st), 0.008), hv(0.55), ([x]) => addKeys(x!, 0, note, dur, 1, { index: 1.4, decay: 1.2 }));
      }
    }
  }

  for (const u of barUsed) activeBars.set(u, (activeBars.get(u) ?? 0) + 1);
  // ---- mix: each stem is scaled so its RMS over the bars it plays meets the mood's balance table
  const barLen = bar * SR;
  const gains: Record<string, number> = {};
  const level = (name: string, bufs: Float32Array[]) => {
    let e = 0;
    for (const bb of bufs) for (let i = 0; i < N; i++) e += bb[i]! * bb[i]!;
    const active = (activeBars.get(name) ?? 1) * barLen * bufs.length;
    const rms = Math.sqrt(e / Math.max(1, active));
    gains[name] = rms > 0 ? dbGain((def.mix[name] ?? -24) - gainDb(rms)) : 0;
  };
  for (const [name, buf] of stems) level(name, [buf]);
  level('pad', [padL, padR]);
  const mix = gains;
  const L = new Float32Array(N), R = new Float32Array(N);
  const sendL = new Float32Array(N), sendR = new Float32Array(N);
  const SEND: Record<string, number> = { snare: 0.35, clap: 0.3, rim: 0.3, pad: 0.4, arp: 0.35, comp: 0.3, melody: 0.45, tom: 0.3, crash: 0.2, ohat: 0.1 };
  const PAN: Record<string, number> = { hat: 0.62, hat16: 0.62, ohat: 0.4, shaker: 0.3, rim: 0.56, tom: 0.45, comp: 0.5, melody: 0.55 };
  // sidechain pump from the kicks
  const pump = def.pump ? new Float32Array(N).fill(1) : undefined;
  if (pump) for (const t of kickTimes) {
    const s0 = Math.round(t * SR), n = Math.round(beat * 0.9 * SR);
    for (let i = 0; i < n && s0 + i < N; i++) {
      const x = i / SR;
      const g = 1 - def.pump! * (x < 0.004 ? x / 0.004 : Math.exp(-(x - 0.004) / (beat * 0.22)));
      if (g < pump[s0 + i]!) pump[s0 + i] = g;
    }
  }
  const pumped = new Set(['pad', 'arp', 'bass', 'comp']);
  const addStem = (name: string, l: Float32Array, rr: Float32Array | undefined) => {
    const g = mix[name] ?? 0;
    const pan = PAN[name] ?? 0.5;
    const gl = rr ? 1 : Math.cos((pan * Math.PI) / 2) * Math.SQRT2, gr = rr ? 1 : Math.sin((pan * Math.PI) / 2) * Math.SQRT2;
    const send = SEND[name] ?? 0.04;
    const pw = pump && pumped.has(name) ? (name === 'bass' ? 0.5 : 1) : 0;
    const right = rr ?? l;
    for (let i = 0; i < N; i++) {
      const pg = pw ? 1 - pw * (1 - pump![i]!) : 1;
      const a = l[i]! * g * gl * pg, c = right[i]! * g * gr * pg;
      L[i]! += a; R[i]! += c;
      sendL[i]! += a * send; sendR[i]! += c * send;
    }
  };
  if (debug.stems) for (const [name, buf] of stems) { let e = 0; const g = mix[name] ?? 0; for (let i = 0; i < N; i++) e += buf[i]! * buf[i]!; debug.stems[name] = Math.round(10 * Math.log10((e * g * g) / N + 1e-12) * 10) / 10; }
  for (const [name, buf] of stems) addStem(name, buf, undefined);
  if (used.has('pad')) addStem('pad', padL, padR);
  if (def.delay && stems.has('arp')) {
    const a = stems.get('arp')!;
    const [dl, dr] = pingPong(a, a, beat * def.delay, 0.38, 3500);
    const g = (mix.arp ?? 0) * 0.35;
    for (let i = 0; i < N; i++) { L[i]! += dl[i]! * g; R[i]! += dr[i]! * g; }
  }
  const [wl, wr] = reverb(sendL, sendR, { room: 0.82, damp: 0.4 });
  for (let i = 0; i < N; i++) { L[i]! += wl[i]! * def.reverb * 3; R[i]! += wr[i]! * def.reverb * 3; }
  if (def.crackle) {
    const cr = rng(hash32(`crackle:${seed}`));
    const bp = Biquad.highpass(1500);
    for (let i = 0; i < N; i++) {
      let x = (cr() * 2 - 1) * 0.004;
      if (cr() < 0.0004) x += (cr() * 2 - 1) * 0.25;
      x = bp.tick(x);
      L[i]! += x; R[i]! += x * 0.9;
    }
  }
  // master bus: high-pass, optional lo-fi low-pass, fold the tail onto the head (seamless loop)
  for (const ch of [L, R]) {
    Biquad.highpass(32).run(ch);
    if (def.lowpass) Biquad.lowpass(def.lowpass, 0.6).run(ch);
  }
  const outL = L.slice(0, loopLen), outR = R.slice(0, loopLen);
  for (let i = 0; i < tail && i < loopLen; i++) { outL[i]! += L[loopLen + i]!; outR[i]! += R[loopLen + i]!; }
  const target = p.lufs ?? -18;
  const m = master([outL, outR], target, Math.min(-1.5, target + 11));
  return {
    left: outL, right: outR,
    meta: {
      mood: p.mood, bpm, key: key.name, chords: chords.map((c) => c.name), bars, duration: loopLen / SR, beat, bar,
      lufs: Math.round(m.lufs * 10) / 10, truePeak: Math.round(m.truePeak * 10) / 10,
      layers: [...used].sort(),
    },
  };
}
