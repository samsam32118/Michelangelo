// @vitest-environment node
/**
 * Offline audio generation (src/audiogen): determinism, loudness and true peak, musical structure, beats that
 * the analyser (marker.beats' path) finds, distinct moods and effects. "Listen as text": every generated
 * sound's measured features are printed, so a reader can judge them without hearing them.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MOODS, SFX_TYPES, generateMusic, generateSfx, renderMusic, renderSfx, encodeWav, decodeWav, describeSound, describeText,
  parseKey, musicPath, sfxPath, paramsHash, type Mood, type SoundFeatures,
} from '../../src/audiogen/index.js';
import { lufs, truePeakDb, master, curveAt, SR } from '../../src/audiogen/dsp.js';
import { analyzeAudio } from '../../src/media/analysis.js';
import { tempDir } from './media-fixtures.js';

const t = tempDir();
afterAll(() => t.cleanup());

const LEN = 12;
const music = new Map<Mood, ReturnType<typeof generateMusic>>();
const musicOf = (m: Mood) => { let r = music.get(m); if (!r) { r = generateMusic({ mood: m, len: LEN, seed: 1 }); music.set(m, r); } return r; };
const features = new Map<string, SoundFeatures>();
const feat = (name: string, l: Float32Array, r: Float32Array) => { let f = features.get(name); if (!f) { f = describeSound([l, r]); features.set(name, f); } return f; };

/** cosine similarity of two band-energy vectors plus a centroid term: 1 = same spectrum */
function spectralDistance(a: SoundFeatures, b: SoundFeatures): number {
  const ka = Object.values(a.bands), kb = Object.values(b.bands);
  const dot = ka.reduce((s, x, i) => s + x * kb[i]!, 0), na = Math.hypot(...ka), nb = Math.hypot(...kb);
  return (1 - dot / (na * nb)) + Math.abs(Math.log2(a.centroid / b.centroid)) / 2;
}

describe('dsp', () => {
  it('measures a full-scale 1 kHz sine at about -3 LUFS and 0 dBTP, and masters to a target', () => {
    const n = SR * 3;
    const s = new Float32Array(n).map((_x, i) => Math.sin((2 * Math.PI * 1000 * i) / SR));
    expect(lufs([s, s.slice()])).toBeCloseTo(-0.0, 0); // stereo full-scale sine: -3 per channel, summed = 0
    expect(lufs([s])).toBeCloseTo(-3.0, 0);
    expect(truePeakDb([s])).toBeCloseTo(0, 1);
    const a = s.map((x) => x * 0.9), b = a.slice();
    const m = master([a, b], -18, -6);
    expect(m.lufs).toBeCloseTo(-18, 0);
    expect(m.truePeak).toBeLessThanOrEqual(-6 + 0.05);
  });
  it('true-peak limits inter-sample overs', () => {
    // a quarter-sample-rate sine at 45° phase: samples at 0.707, true peak 1.0
    const s = new Float32Array(SR).map((_x, i) => Math.sin((Math.PI / 2) * i + Math.PI / 4));
    expect(truePeakDb([s])).toBeGreaterThan(-0.5);
    expect(20 * Math.log10(Math.max(...s.map(Math.abs)))).toBeLessThan(-2.9);
  });
  it('interpolates a curve and holds its ends', () => {
    const c: [number, number][] = [[1, 0], [3, 1]];
    expect([curveAt(c, 0), curveAt(c, 2), curveAt(c, 5)]).toEqual([0, 0.5, 1]);
  });
  it('hashes parameters stably regardless of key order, as hex', () => {
    expect(paramsHash({ a: 1, b: [2, 3] })).toBe(paramsHash({ b: [2, 3], a: 1, c: undefined }));
    expect(paramsHash({ a: 1 })).not.toBe(paramsHash({ a: 2 }));
    for (let i = 0; i < 200; i++) expect(paramsHash({ i })).toMatch(/^[0-9a-f]{10}$/);
  });
});

describe('wav', () => {
  it('round-trips 16-bit stereo PCM within one LSB and writes a valid header', () => {
    const l = new Float32Array(1000).map((_x, i) => Math.sin(i / 10) * 0.5), r = l.map((x) => -x);
    const bytes = encodeWav([l, r]);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('RIFF');
    expect(bytes.length).toBe(44 + 1000 * 4);
    const d = decodeWav(bytes);
    expect(d.sampleRate).toBe(48000);
    expect(d.chans).toHaveLength(2);
    for (let i = 0; i < 1000; i++) expect(Math.abs(d.chans[1]![i]! - r[i]!)).toBeLessThan(3 / 32768);
  });
});

describe('music theory', () => {
  it('parses key names', () => {
    expect(parseKey('Am')).toMatchObject({ pc: 9, minor: true, name: 'A minor' });
    expect(parseKey('F# minor')).toMatchObject({ pc: 6, minor: true, name: 'F# minor' });
    expect(parseKey('Bb')).toMatchObject({ pc: 10, minor: false, name: 'Bb major' });
    expect(parseKey('eb major')).toMatchObject({ pc: 3, name: 'Eb major' });
    expect(parseKey('H')).toBeUndefined();
    expect(parseKey('C dorian')).toBeUndefined();
  });
  it('builds a diatonic progression in the asked key and tempo', () => {
    const r = generateMusic({ mood: 'corporate', len: 4, key: 'G', bpm: 110, seed: 2 });
    expect(r.meta).toMatchObject({ key: 'G major', bpm: 110 });
    const diatonic = new Set(['G', 'Am', 'Bm', 'C', 'D', 'Em', 'F#dim']);
    for (const c of r.meta.chords) expect(diatonic.has(c)).toBe(true);
    const m = generateMusic({ mood: 'dramatic', len: 4, key: 'D minor', seed: 2 });
    const dm = new Set(['Dm', 'Edim', 'F', 'Gm', 'Am', 'Bb', 'C']);
    for (const c of m.meta.chords) expect(dm.has(c)).toBe(true);
  });
});

describe('audio.music generator', () => {
  it('is deterministic for the same parameters and differs by seed', () => {
    const a = renderMusic({ mood: 'lofi', len: 4, seed: 7 }).bytes;
    const b = renderMusic({ mood: 'lofi', len: 4, seed: 7 }).bytes;
    const c = renderMusic({ mood: 'lofi', len: 4, seed: 8 }).bytes;
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(Buffer.from(a).equals(Buffer.from(c))).toBe(false);
    expect(musicPath({ mood: 'lofi', len: 4, seed: 7 })).toBe(musicPath({ mood: 'lofi', len: 4, seed: 7 }));
    expect(musicPath({ mood: 'lofi', len: 4, seed: 7 })).not.toBe(musicPath({ mood: 'lofi', len: 4, seed: 8 }));
    expect(musicPath({ mood: 'lofi', len: 4 })).toMatch(/^media\/generated\/music-[0-9a-f]{10}\.wav$/);
  });

  it.each(MOODS)('%s: whole bars, -18 LUFS, true peak ≤ -1 dBTP, broadcast-like crest, loops without a click', (mood) => {
    const r = musicOf(mood);
    const f = feat(`music:${mood}`, r.left, r.right);
    console.log(`listen ${mood.padEnd(9)} ${r.meta.bpm} BPM ${r.meta.key} [${r.meta.chords.join(' ')}] layers ${r.meta.layers.join(',')}\n           ${describeText(f)}`);
    expect(r.meta.duration).toBeGreaterThanOrEqual(LEN);
    expect(r.meta.duration / r.meta.bar).toBeCloseTo(Math.round(r.meta.duration / r.meta.bar), 3);
    expect(r.left.length).toBe(Math.round(r.meta.duration * SR));
    expect(Math.abs(f.lufs + 18)).toBeLessThanOrEqual(0.5);
    expect(f.truePeak).toBeLessThanOrEqual(-1);
    expect(f.truePeak - f.lufs).toBeLessThanOrEqual(12); // peak-to-loudness ratio: a +4 dB master gain needs no limiter
    // the loop seam: the step from the last sample to the first is no bigger than the music's ordinary steps
    let maxStep = 0;
    for (let i = 1; i < r.left.length; i++) maxStep = Math.max(maxStep, Math.abs(r.left[i]! - r.left[i - 1]!));
    expect(Math.abs(r.left[0]! - r.left[r.left.length - 1]!)).toBeLessThanOrEqual(maxStep);
    // drums, bass and harmony are all there
    expect(r.meta.layers).toContain('kick');
    expect(r.meta.layers).toContain('bass');
    expect(r.meta.layers.some((l) => ['pad', 'comp'].includes(l))).toBe(true);
    expect(f.bands.sub + f.bands.bass).toBeGreaterThan(0.3);
    expect(f.bands.mid + f.bands.high).toBeGreaterThan(0.03);
  });

  it.each(MOODS)('%s: marker.beats (the analyser) finds the beats, and the tempo', async (mood) => {
    const r = musicOf(mood);
    const file = join(t.dir, `${mood}.wav`);
    writeFileSync(file, encodeWav([r.left, r.right]));
    const a = await analyzeAudio(file);
    const grid: number[] = [];
    for (let x = 0; x < r.meta.duration - 0.05; x += r.meta.beat) grid.push(x);
    const found = grid.filter((g) => a.beats.some((b) => Math.abs(b - g) <= 1 / 30)).length;
    const octave = Math.abs(Math.log2(a.bpm! / r.meta.bpm));
    console.log(`beats  ${mood.padEnd(9)} ${found}/${grid.length} beats within a frame, tempo ${a.bpm} (true ${r.meta.bpm}), ${a.loudness.integrated} LUFS, ${a.loudness.truePeak} dBTP (ffmpeg)`);
    expect(found / grid.length).toBeGreaterThanOrEqual(0.9);
    expect(Math.min(octave, Math.abs(octave - 1))).toBeLessThan(0.02); // the tempo or its double
    expect(a.loudness.truePeak).toBeLessThanOrEqual(-1);
    expect(Math.abs(a.loudness.integrated + 18)).toBeLessThanOrEqual(0.6);
  });

  it('gives each mood its own sound (tempo, spectrum, density)', () => {
    const fs = MOODS.map((m) => ({ m, f: feat(`music:${m}`, musicOf(m).left, musicOf(m).right), r: musicOf(m) }));
    for (let i = 0; i < fs.length; i++) for (let j = i + 1; j < fs.length; j++) {
      const a = fs[i]!, b = fs[j]!;
      const d = spectralDistance(a.f, b.f) + Math.abs(Math.log2(a.r.meta.bpm / b.r.meta.bpm)) + Math.abs(a.f.onsets.length - b.f.onsets.length) / Math.max(a.f.onsets.length, b.f.onsets.length);
      expect(d, `${a.m} vs ${b.m}`).toBeGreaterThan(0.08);
      expect(a.r.meta.layers.join() === b.r.meta.layers.join() && a.r.meta.bpm === b.r.meta.bpm, `${a.m} vs ${b.m}`).toBe(false);
    }
    // character checks: lofi is the darkest, upbeat and corporate are major and faster than chill and lofi
    const by = Object.fromEntries(fs.map((x) => [x.m, x]));
    expect(by.lofi!.f.centroid).toBeLessThan(Math.min(by.upbeat!.f.centroid, by.epic!.f.centroid, by.dramatic!.f.centroid));
    expect(Math.min(by.upbeat!.r.meta.bpm, by.corporate!.r.meta.bpm)).toBeGreaterThan(Math.max(by.chill!.r.meta.bpm, by.lofi!.r.meta.bpm));
    expect(by.dramatic!.r.meta.key).toMatch(/minor/);
    expect(by.epic!.r.meta.key).toMatch(/minor/);
    expect(by.upbeat!.r.meta.key).toMatch(/major/);
  });

  it('follows the intensity curve: quiet bars drop layers, loud bars add them', () => {
    const lo = generateMusic({ mood: 'upbeat', len: 8, seed: 3, intensity: [[0, 0.1], [8, 0.1]] });
    const hi = generateMusic({ mood: 'upbeat', len: 8, seed: 3, intensity: [[0, 1], [8, 1]] });
    expect(lo.meta.layers).toEqual(['pad']);
    expect(hi.meta.layers).toEqual(expect.arrayContaining(['kick', 'bass', 'clap', 'hat16', 'arp', 'pad', 'shaker']));
    // a build: the second half (all layers) has more onsets than the first (pad only)
    const build = generateMusic({ mood: 'upbeat', len: 16, seed: 3, intensity: [[0, 0.1], [7.9, 0.1], [8, 1], [16, 1]] });
    const f = describeSound([build.left, build.right]);
    const half = build.meta.duration / 2;
    expect(f.onsets.filter((x) => x >= half).length).toBeGreaterThan(3 * f.onsets.filter((x) => x < half - 0.2).length);
  });
});

describe('audio.sfx generator', () => {
  const sfx = new Map(SFX_TYPES.map((ty) => [ty, generateSfx(ty, 0)]));

  it.each(SFX_TYPES)('%s: true peak ≤ -1 dBTP, levelled, ends at zero, described', (ty) => {
    const r = sfx.get(ty)!;
    const f = feat(`sfx:${ty}`, r.left, r.right);
    console.log(`listen ${ty.padEnd(8)} ${describeText(f)}  (peakAt ${r.peakAt}s)`);
    expect(f.truePeak).toBeLessThanOrEqual(-1);
    expect(f.lufs).toBeGreaterThan(-30);
    expect(f.lufs).toBeLessThan(-14);
    expect(r.peakAt).toBeGreaterThanOrEqual(0);
    expect(r.peakAt).toBeLessThan(r.meta.duration);
    expect(Math.abs(r.left[r.left.length - 1]!)).toBe(0);
    expect(r.meta.duration).toBeLessThan(5);
  });

  it('each effect has the character its name promises', () => {
    const f = (ty: (typeof SFX_TYPES)[number]) => features.get(`sfx:${ty}`) ?? feat(`sfx:${ty}`, sfx.get(ty)!.left, sfx.get(ty)!.right);
    expect(f('riser').centroidEnd).toBeGreaterThan(f('riser').centroidStart * 1.5); // rising
    expect(sfx.get('riser')!.peakAt).toBeGreaterThan(1.5); // climaxes at its end
    expect(f('impact').bands.sub + f('impact').bands.bass).toBeGreaterThan(0.8); // deep
    expect(f('impact').decay).toBeGreaterThan(1); // long tail
    expect(f('hit').bands.sub + f('hit').bands.bass).toBeGreaterThan(0.6);
    expect(f('pop').duration).toBeLessThan(0.3);
    expect(f('click').duration).toBeLessThan(0.1);
    expect(f('swipe').centroid).toBeGreaterThan(4000); // airy, bright
    expect(f('swoosh').centroid).toBeGreaterThan(f('whoosh').centroid);
    expect(f('whoosh').attack).toBeGreaterThan(0.2); // swells into its peak
    expect(f('bell').decay).toBeGreaterThan(f('ding').decay); // the bell rings longer
    expect(f('typing').onsets.length).toBeGreaterThanOrEqual(8); // a run of keys
    expect(f('camera').onsets.length).toBeGreaterThanOrEqual(2); // two shutter clicks
  });

  it('all thirteen effects are spectrally distinct from each other', () => {
    for (let i = 0; i < SFX_TYPES.length; i++) for (let j = i + 1; j < SFX_TYPES.length; j++) {
      const a = SFX_TYPES[i]!, b = SFX_TYPES[j]!;
      const fa = features.get(`sfx:${a}`) ?? feat(`sfx:${a}`, sfx.get(a)!.left, sfx.get(a)!.right);
      const fb = features.get(`sfx:${b}`) ?? feat(`sfx:${b}`, sfx.get(b)!.left, sfx.get(b)!.right);
      const d = spectralDistance(fa, fb) + Math.abs(Math.log2(fa.duration / fb.duration)) / 2;
      expect(d, `${a} vs ${b}`).toBeGreaterThan(0.1);
    }
  });

  it('is deterministic per seed, and seeds vary the sound', () => {
    expect(Buffer.from(renderSfx('whoosh', 4).bytes).equals(Buffer.from(renderSfx('whoosh', 4).bytes))).toBe(true);
    expect(Buffer.from(renderSfx('whoosh', 4).bytes).equals(Buffer.from(renderSfx('whoosh', 5).bytes))).toBe(false);
    expect(sfxPath('pop', 1)).toMatch(/^media\/generated\/sfx-pop-[0-9a-f]{10}\.wav$/);
    expect(sfxPath('pop', 1)).not.toBe(sfxPath('pop', 2));
  });
});
