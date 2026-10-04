/**
 * Offline, deterministic audio generation: music beds and sound effects as 48 kHz stereo WAV bytes, cached by
 * a hash of their parameters. Pure TS (no I/O): callers write the bytes (the audio.music / audio.sfx commands
 * do it through the project's services).
 */
import { paramsHash } from './dsp.js';
import { generateMusic, type MusicMeta, type MusicParams } from './music.js';
import { generateSfx, type SfxResult, type SfxType } from './sfx.js';
import { encodeWav } from './wav.js';
import { describeSound, describeText } from './describe.js';

export { MOODS, parseKey, generateMusic, defaultIntensity, type Mood, type MusicParams, type MusicMeta } from './music.js';
export { SFX_TYPES, generateSfx, sfxDescribe, type SfxType, type SfxResult } from './sfx.js';
export { encodeWav, decodeWav } from './wav.js';
export { describeSound, describeText, type SoundFeatures } from './describe.js';
export { paramsHash } from './dsp.js';

/** Bumped when the synthesis changes, so cached files are regenerated. */
export const AUDIOGEN_VERSION = 2;
export const GENERATED_DIR = 'media/generated';

/** The normalised parameters that identify a music file (the cache key). */
export function musicKey(p: MusicParams): Record<string, unknown> {
  return { v: AUDIOGEN_VERSION, kind: 'music', mood: p.mood, len: Math.round(p.len * 1000) / 1000, bpm: p.bpm, key: p.key, seed: p.seed ?? 0, intensity: p.intensity, lufs: p.lufs };
}

export function musicPath(p: MusicParams): string {
  return `${GENERATED_DIR}/music-${paramsHash(musicKey(p))}.wav`;
}

export function sfxPath(type: SfxType, seed: number): string {
  return `${GENERATED_DIR}/sfx-${type}-${paramsHash({ v: AUDIOGEN_VERSION, kind: 'sfx', type, seed })}.wav`;
}

/** Render a music bed to WAV bytes with its metadata and a measured description. */
export function renderMusic(p: MusicParams): { bytes: Uint8Array; meta: MusicMeta & { describe: string } } {
  const r = generateMusic(p);
  return { bytes: encodeWav([r.left, r.right], 48000, 7), meta: { ...r.meta, describe: describeText(describeSound([r.left, r.right])) } };
}

/** Render a sound effect to WAV bytes. */
export function renderSfx(type: SfxType, seed: number): { bytes: Uint8Array; meta: SfxResult['meta'] & { peakAt: number; measured: string } } {
  const r = generateSfx(type, seed);
  return { bytes: encodeWav([r.left, r.right], 48000, 11), meta: { ...r.meta, peakAt: r.peakAt, measured: describeText(describeSound([r.left, r.right])) } };
}
