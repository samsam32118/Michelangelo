/**
 * Audio effects (plugin API 1.1 audio stage): ffmpeg audio filters on a clip's sound or, on a bus (`Bus.fx`), on the
 * bus mix. They have no picture stage, so adding one to a clip without sound is an error. Names never clash with the
 * video effects (the video `denoise` stays; the audio one is `denoise-audio`).
 */
import { defineEffect, z, type FilterSpec } from '../../../plugin/api.js';
import { dbToLin } from '../util.js';

const hz = (def: number, desc: string) => z.number().min(10).max(22000).default(def).describe(desc);
const db = (def: number, lo: number, hi: number, desc: string) => z.number().min(lo).max(hi).default(def).describe(desc);
const ms = (def: number, hi: number, desc: string) => z.number().min(0.01).max(hi).default(def).describe(desc);
const r3 = (n: number) => Math.round(n * 1000) / 1000;
/** linear amplitude as a short string ffmpeg reads (6 significant digits) */
const lin = (dB: number) => Number(dbToLin(dB).toPrecision(6));

export const highpassFilter = (freq: number, poles = 2): FilterSpec => ({ filter: 'highpass', args: { f: freq, p: poles } });

export const highpass = defineEffect({
  type: 'highpass',
  describe: 'Audio: cuts rumble and low-frequency noise below `freq` Hz (ffmpeg highpass; 80–100 for voice).',
  params: z.object({ freq: hz(80, 'cutoff in Hz'), poles: z.union([z.literal(1), z.literal(2)]).default(2).describe('1 = gentle 6 dB/oct, 2 = 12 dB/oct') }),
  audio: (p) => [highpassFilter(p.freq, p.poles)],
});

export const lowpass = defineEffect({
  type: 'lowpass',
  describe: 'Audio: cuts hiss and highs above `freq` Hz (ffmpeg lowpass; 3000 sounds like a phone, 800 like through a wall).',
  params: z.object({ freq: hz(12000, 'cutoff in Hz'), poles: z.union([z.literal(1), z.literal(2)]).default(2).describe('1 = gentle 6 dB/oct, 2 = 12 dB/oct') }),
  audio: (p) => [{ filter: 'lowpass', args: { f: p.freq, p: p.poles } }],
});

const Band = z.object({
  freq: z.number().min(10).max(22000).describe('centre frequency in Hz'),
  gain: z.number().min(-30).max(30).describe('boost (+) or cut (-) in dB'),
  q: z.number().min(0.05).max(100).default(1).describe('bandwidth as Q (higher = narrower)'),
});

export const eq = defineEffect({
  type: 'eq',
  describe: 'Audio: equaliser with low/high shelves and a mid band in dB (low=-3 mid=2 high=3) plus any number of peaking `bands` [{freq, gain, q}] (0 dB bands are skipped).',
  params: z.object({
    low: db(0, -30, 30, 'low shelf gain in dB'),
    lowFreq: hz(120, 'low shelf corner in Hz'),
    mid: db(0, -30, 30, 'mid band gain in dB'),
    midFreq: hz(1000, 'mid band centre in Hz'),
    midQ: z.number().min(0.05).max(100).default(1).describe('mid band Q'),
    high: db(0, -30, 30, 'high shelf gain in dB'),
    highFreq: hz(8000, 'high shelf corner in Hz'),
    bands: z.array(Band).max(32).default([]).describe('extra peaking bands: [{"freq": 3000, "gain": 2, "q": 1.5}]'),
  }),
  audio(p) {
    const out: FilterSpec[] = [];
    if (p.low) out.push({ filter: 'lowshelf', args: { f: p.lowFreq, g: p.low } });
    if (p.mid) out.push({ filter: 'equalizer', args: { f: p.midFreq, t: 'q', w: p.midQ, g: p.mid } });
    for (const b of p.bands) if (b.gain) out.push({ filter: 'equalizer', args: { f: b.freq, t: 'q', w: b.q, g: b.gain } });
    if (p.high) out.push({ filter: 'highshelf', args: { f: p.highFreq, g: p.high } });
    return out;
  },
});

export const dehum = defineEffect({
  type: 'dehum',
  describe: 'Audio: removes mains hum with narrow notches at `freq` (50 Hz Europe/Asia, 60 Hz Americas) and its harmonics.',
  params: z.object({
    freq: z.union([z.literal(50), z.literal(60)]).default(50).describe('mains frequency: 50 or 60'),
    harmonics: z.number().int().min(1).max(10).default(4).describe('how many notches (freq, 2×freq, ...)'),
    q: z.number().min(1).max(200).default(10).describe('notch Q (higher = narrower, removes less of the voice)'),
  }),
  audio: (p) => Array.from({ length: p.harmonics }, (_, i): FilterSpec => ({ filter: 'bandreject', args: { f: p.freq * (i + 1), t: 'q', w: p.q } })),
});

export const denoiseAudio = defineEffect({
  type: 'denoise-audio',
  describe: 'Audio: broadband noise reduction (hiss, air conditioning, room tone) with ffmpeg afftdn, which tracks the noise floor (for video noise use `denoise`).',
  params: z.object({
    amount: z.number().min(0).max(1).default(0.5).describe('0 = off, 0.5 ≈ 18 dB reduction, 1 = 30 dB (may sound watery)'),
    floor: db(-50, -80, -20, 'starting noise floor estimate in dBFS'),
  }),
  audio: (p) => (p.amount > 0 ? [{ filter: 'afftdn', args: { nr: r3(6 + 24 * p.amount), nf: p.floor, tn: true } }] : []),
});

export const compressorFilter = (p: { threshold: number; ratio: number; attack: number; release: number; makeup: number; knee: number }): FilterSpec => ({
  filter: 'acompressor',
  args: { threshold: lin(p.threshold), ratio: p.ratio, attack: p.attack, release: p.release, makeup: lin(p.makeup), knee: p.knee },
});

export const compressor = defineEffect({
  type: 'compressor',
  describe: 'Audio: evens out loud and quiet passages (ffmpeg acompressor; levels in dB, times in ms, `makeup` adds gain after compression).',
  params: z.object({
    threshold: db(-18, -60, 0, 'level in dBFS above which the sound is compressed'),
    ratio: z.number().min(1).max(20).default(3).describe('compression ratio (3 = 3:1)'),
    attack: ms(20, 2000, 'attack in ms'),
    release: ms(250, 9000, 'release in ms'),
    makeup: db(0, 0, 36, 'gain after compression in dB'),
    knee: z.number().min(1).max(8).default(2.8).describe('knee width (1 = hard, 8 = soft)'),
  }),
  audio: (p) => [compressorFilter(p)],
});

export const limiter = defineEffect({
  type: 'limiter',
  describe: 'Audio: brickwall limiter that keeps peaks under `ceiling` dBFS (ffmpeg alimiter; the level is not raised), best put last.',
  params: z.object({
    ceiling: db(-1, -24, 0, 'maximum peak level in dBFS'),
    attack: ms(5, 80, 'attack in ms'),
    release: ms(50, 8000, 'release in ms'),
  }),
  audio: (p) => [{ filter: 'alimiter', args: { limit: lin(p.ceiling), attack: p.attack, release: p.release, level: false, latency: true } }],
});

export const gate = defineEffect({
  type: 'gate',
  describe: 'Audio: noise gate that turns the sound down while it is under `threshold` dBFS (between phrases), by `range` dB.',
  params: z.object({
    threshold: db(-40, -80, 0, 'level in dBFS under which the gate closes'),
    range: db(-24, -80, 0, 'how far the closed gate turns the sound down, in dB'),
    ratio: z.number().min(1).max(9000).default(4).describe('expansion ratio'),
    attack: ms(10, 9000, 'attack in ms'),
    release: ms(250, 9000, 'release in ms'),
  }),
  audio: (p) => [{ filter: 'agate', args: { threshold: lin(p.threshold), range: lin(p.range), ratio: p.ratio, attack: p.attack, release: p.release } }],
});

export const deesserFilter = (amount: number, freq = 0.5): FilterSpec => ({ filter: 'deesser', args: { i: r3(amount), m: 0.5, f: r3(freq) } });

export const deesser = defineEffect({
  type: 'deesser',
  describe: 'Audio: softens harsh "s" and "sh" sounds in speech (ffmpeg deesser).',
  params: z.object({
    amount: z.number().min(0).max(1).default(0.5).describe('intensity 0..1'),
    freq: z.number().min(0).max(1).default(0.5).describe('which highs to treat, 0 = lower, 1 = only the very top'),
  }),
  audio: (p) => (p.amount > 0 ? [deesserFilter(p.amount, p.freq)] : []),
});

export const voice = defineEffect({
  type: 'voice',
  describe: 'Audio: one-step dialogue clean-up preset: high-pass (rumble), gentle compression and de-essing (add dehum / denoise-audio before it when needed).',
  params: z.object({
    highpass: hz(80, 'high-pass cutoff in Hz'),
    compress: z.number().min(0).max(1).default(0.5).describe('0 = no compression, 1 = strong (ratio 4:1, threshold -26 dB)'),
    deess: z.number().min(0).max(1).default(0.4).describe('de-esser intensity 0..1'),
  }),
  audio(p) {
    const out: FilterSpec[] = [highpassFilter(p.highpass)];
    if (p.compress > 0) out.push(compressorFilter({ threshold: r3(-14 - 12 * p.compress), ratio: r3(1.5 + 2.5 * p.compress), attack: 15, release: 200, makeup: r3(4 * p.compress), knee: 4 }));
    if (p.deess > 0) out.push(deesserFilter(p.deess));
    return out;
  },
});

export const reverb = defineEffect({
  type: 'reverb',
  describe: 'Audio: a simple room ambience from early reflections (ffmpeg aecho): `room` sets the size, `mix` how much is heard.',
  params: z.object({
    room: z.number().min(0).max(1).default(0.4).describe('0 = small room, 1 = hall'),
    mix: z.number().min(0).max(1).default(0.25).describe('wet level 0..1'),
  }),
  audio(p) {
    if (p.mix <= 0) return [];
    const base = 15 + 70 * p.room;
    const delays = [base, base * 1.7, base * 2.6, base * 3.9].map((d) => Math.round(d));
    const decays = [0.5, 0.36, 0.25, 0.16].map((d) => r3(d * p.mix * (0.6 + 0.4 * p.room)));
    const sum = decays.reduce((a, b) => a + b, 0);
    return [{ filter: 'aecho', args: { in_gain: 1, out_gain: r3(1 / (1 + sum)), delays: delays.join('|'), decays: decays.join('|') } }];
  },
});

export const audioEffects = [highpass, lowpass, eq, dehum, denoiseAudio, compressor, limiter, gate, deesser, voice, reverb];
