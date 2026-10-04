/**
 * A sound described as text (plugin API 1.5, `describeSound`): loudness, peak, where it starts and peaks, tonal or
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
  const loudest = Math.max(...a.rms.filter((x) => Number.isFinite(x)));
  if (Number.isFinite(loudest)) facts.rms = round(loudest, 1);
  if (backend.analyzeLevels) {
    const lv = await backend.analyzeLevels(abs, RATE);
    const { bandEdges, LEVELS_RATE } = await import('../media/levels.js');
    Object.assign(facts, levelFacts(lv.rms, lv.spectrum, lv.bands, bandEdges(lv.bands, LEVELS_RATE, 2048)));
  }
  // texture from ffmpeg's per-bin spectral flatness (more faithful than 16 log bands)
  const st = await spectralStats(abs).catch(() => undefined);
  if (st) Object.assign(facts, st);
  return facts;
}

/**
 * Thresholds: spectral flatness (0 pure tone … 1 white noise; per FFT bin, from ffmpeg) and the power-weighted centroid on
 * a log-frequency scale (brown noise ≈ 230 Hz, pink ≈ 580 Hz, white ≈ 3.8 kHz).
 */
export const TEXTURE = { tonal: 0.04, noisy: 0.15 };
export const TONE_HZ = { dark: 300, bright: 2000 };

/** Energy-weighted spectral flatness over the audible windows, from ffmpeg astats + aspectralstats. */
export async function spectralStats(abs: string): Promise<Pick<SoundFacts, 'flatness' | 'texture'> | undefined> {
  const { getFfmpeg } = await import('../media/ffmpeg.js');
  const { run } = await import('../media/proc.js');
  const ff = await getFfmpeg();
  const chain = 'aformat=channel_layouts=mono,asetnsamples=n=2048,astats=metadata=1:reset=1:measure_perchannel=RMS_level:measure_overall=none,aspectralstats=win_size=2048:measure=flatness,ametadata=print:file=-';
  const r = await run(ff.ffmpeg, ['-hide_banner', '-nostats', '-loglevel', 'error', '-i', abs, '-t', '120', '-af', chain, '-f', 'null', '-'], { what: 'spectral analysis', timeoutMs: 120_000 });
  const frames: { rms: number; f: number }[] = [];
  let cur: { rms?: number; f?: number } = {};
  const push = () => { if (cur.rms !== undefined && cur.f !== undefined) frames.push(cur as { rms: number; f: number }); cur = {}; };
  for (const line of r.stdout.toString('utf8').split('\n')) {
    if (line.startsWith('frame:')) { push(); continue; }
    const m = /^lavfi\.(astats\.1\.RMS_level|aspectralstats\.1\.flatness)=(.+)$/.exec(line.trim());
    const v = m ? Number(m[2]) : NaN;
    if (!m || !Number.isFinite(v)) continue;
    if (m[1]!.startsWith('astats')) cur.rms = v; else cur.f = v;
  }
  push();
  if (!frames.length) return undefined;
  const loud = Math.max(...frames.map((x) => x.rms));
  let w = 0, fl = 0;
  for (const x of frames) {
    if (x.rms < loud - 30 || x.rms < -60) continue;
    const k = 10 ** (x.rms / 10);
    w += k; fl += k * x.f;
  }
  if (!w) return undefined;
  const flatness = fl / w;
  return { flatness: round(flatness, 3), texture: flatness < TEXTURE.tonal ? 'tonal' : flatness > TEXTURE.noisy ? 'noisy' : 'mixed' };
}

/**
 * Onset, peak and tone from per-frame RMS (0..1 over 60 dB) and band levels (mean magnitude per FFT bin, 0..1 over 60 dB
 * below the loudest band). Tone is the power-weighted centroid on the log-frequency band scale (`edges`: FFT bin edges of the
 * bands, from bandEdges); without edges the bands count equally. A rough flatness over the bands is the fallback texture.
 */
export function levelFacts(rms: Float32Array, spectrum: Float32Array, bands: number, edges?: number[]): Pick<SoundFacts, 'onset' | 'peakAt' | 'flatness' | 'texture' | 'brightness' | 'tone' | 'centroidHz'> {
  const frames = rms.length;
  let max = 0, maxAt = 0;
  for (let f = 0; f < frames; f++) if (rms[f]! > max) { max = rms[f]!; maxAt = f; }
  // audible: within 30 dB of the loudest moment and above -54 dBFS
  const floor = Math.max(max - 30 / RANGE_DB, 0.1);
  let onset = 0;
  while (onset < frames && rms[onset]! < floor) onset++;
  let flatSum = 0, wSum = 0, eSum = 0, cSum = 0;
  for (let f = 0; f < frames; f++) {
    if (rms[f]! < floor) continue;
    const w = 10 ** (((rms[f]! - 1) * RANGE_DB) / 10);
    let lin = 0, logSum = 0;
    for (let b = 0; b < bands; b++) {
      const p = 10 ** (((spectrum[f * bands + b]! - 1) * RANGE_DB) / 10) + 1e-9;
      lin += p; logSum += Math.log(p);
      const e = p * (edges ? Math.max(1, edges[b + 1]! - edges[b]!) : 1);
      eSum += w * e; cSum += w * e * (b + 0.5);
    }
    flatSum += w * (Math.exp(logSum / bands) / (lin / bands));
    wSum += w;
  }
  const flatness = wSum ? flatSum / wSum : 0, centre = eSum ? cSum / eSum : bands / 2;
  const centroidHz = Math.round(40 * Math.pow(11025 / 40, centre / bands));
  return {
    onset: round(Math.min(onset, frames) / RATE.num, 2), peakAt: round(maxAt / RATE.num, 2),
    flatness: round(flatness, 2), texture: flatness < 0.15 ? 'tonal' : flatness > 0.4 ? 'noisy' : 'mixed',
    brightness: round(centre / bands, 2), centroidHz, tone: centroidHz < TONE_HZ.dark ? 'dark' : centroidHz > TONE_HZ.bright ? 'bright' : 'balanced',
  };
}

function round(v: number, d: number): number {
  if (!Number.isFinite(v)) return v;
  const k = 10 ** d;
  return Math.round(v * k) / k;
}
