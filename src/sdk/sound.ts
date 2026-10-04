/**
 * A sound described as text (plugin API 1.4, `describeSound`): loudness, peak, where it starts and peaks, tonal or
 * noisy, dark or bright, tempo. From the existing analysis (ebur128 loudness, onsets/tempo) and the 16-band levels at
 * 100 values per second. Labels are coarse on purpose; the numbers are in the result.
 */
import type { SoundFacts } from '../core/commands/registry.js';
import type { MediaBackend } from '../media/types.js';

const RATE = { num: 100, den: 1 };
/** levels map 60 dB to 0..1 */
const RANGE_DB = 60;

export async function describeSound(abs: string, backend: MediaBackend): Promise<SoundFacts> {
  const a = await backend.analyzeAudio(abs);
  const facts: SoundFacts = {
    duration: round(a.duration, 3), lufs: round(a.loudness.integrated, 1), peak: round(a.loudness.truePeak, 1),
    onset: 0, peakAt: 0, flatness: 0, texture: 'mixed', brightness: 0.5, tone: 'balanced',
    silences: a.silences.map((s) => ({ start: round(s.start, 2), end: round(s.end, 2) })),
  };
  if (a.bpm !== undefined && a.duration >= 8) facts.bpm = Math.round(a.bpm);
  if (!backend.analyzeLevels) return facts;
  const lv = await backend.analyzeLevels(abs, RATE);
  Object.assign(facts, levelFacts(lv.rms, lv.spectrum, lv.bands));
  return facts;
}

/** Onset, peak, flatness and brightness from per-frame RMS (0..1 over 60 dB) and band levels (0..1 over 60 dB below the loudest band). */
export function levelFacts(rms: Float32Array, spectrum: Float32Array, bands: number): Pick<SoundFacts, 'onset' | 'peakAt' | 'flatness' | 'texture' | 'brightness' | 'tone'> {
  const frames = rms.length;
  let max = 0, maxAt = 0;
  for (let f = 0; f < frames; f++) if (rms[f]! > max) { max = rms[f]!; maxAt = f; }
  // audible: within 30 dB of the loudest moment and above -54 dBFS
  const floor = Math.max(max - 30 / RANGE_DB, 0.1);
  let onset = 0;
  while (onset < frames && rms[onset]! < floor) onset++;
  let flatSum = 0, centSum = 0, wSum = 0;
  for (let f = 0; f < frames; f++) {
    if (rms[f]! < floor) continue;
    const w = 10 ** (((rms[f]! - 1) * RANGE_DB) / 10);
    let lin = 0, logSum = 0, cent = 0;
    for (let b = 0; b < bands; b++) {
      const p = 10 ** (((spectrum[f * bands + b]! - 1) * RANGE_DB) / 10) + 1e-9;
      lin += p; logSum += Math.log(p); cent += p * b;
    }
    flatSum += w * (Math.exp(logSum / bands) / (lin / bands));
    centSum += w * (cent / lin / Math.max(1, bands - 1));
    wSum += w;
  }
  const flatness = wSum ? flatSum / wSum : 0, brightness = wSum ? centSum / wSum : 0.5;
  return {
    onset: round(Math.min(onset, frames) / RATE.num, 2), peakAt: round(maxAt / RATE.num, 2),
    flatness: round(flatness, 2), texture: flatness < 0.15 ? 'tonal' : flatness > 0.4 ? 'noisy' : 'mixed',
    brightness: round(brightness, 2), tone: brightness < 0.45 ? 'dark' : brightness > 0.65 ? 'bright' : 'balanced',
  };
}

/** One line: "1.42s, -18.3 LUFS, peak -1.2 dBTP, starts 0.04s, loudest 0.31s, noisy, bright". */
export function soundLine(s: SoundFacts): string {
  return `${s.duration.toFixed(2)}s, ${Number.isFinite(s.lufs) && s.lufs > -70 ? `${s.lufs.toFixed(1)} LUFS` : 'silent'}, peak ${s.peak.toFixed(1)} dBTP, starts ${s.onset.toFixed(2)}s, loudest ${s.peakAt.toFixed(2)}s, ${s.texture}, ${s.tone}${s.bpm ? `, ~${s.bpm} BPM` : ''}`;
}

function round(v: number, d: number): number {
  if (!Number.isFinite(v)) return v;
  const k = 10 ** d;
  return Math.round(v * k) / k;
}
