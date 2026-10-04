/**
 * When caption cues appear and leave, pure. Words come in with their spoken times (timeline seconds); cues go out
 * in comp frames. The rules follow how people read captions against speech:
 *
 * - A cue appears a hair before its first word (`lead`): text that lags the voice reads as late, text that leads
 *   it by a frame or two reads as in sync (people tolerate sound after picture far better than before it).
 * - A karaoke highlight moves onto each word at its onset, minus the same small lead.
 * - A cue stays up through its last word plus `tail`, and long enough to read (`minLen`, `maxCps`), but it never
 *   overlaps the next cue and never hangs over silence much longer than that.
 * - A short gap between two cues (`bridge`) is closed: a cue that blinks off and on again in a fraction of a
 *   second reads as flicker.
 */
import type { TimedWord } from './commands/registry.js';

export const CUE_TIMING = {
  /** seconds a cue appears before its first word is heard */
  lead: 0.05,
  /** seconds each karaoke word lights before it is heard */
  wordLead: 0.05,
  /** seconds a cue stays after its last word ends */
  tail: 0.3,
  /** gaps between cues shorter than this (s) are closed: the earlier cue stays until the next appears */
  bridge: 0.5,
  /** the shortest time (s) a cue is shown, when the silence after it allows */
  minLen: 0.7,
  /** reading speed (characters per second) a cue's length is stretched towards, when the silence allows */
  maxCps: 17,
} as const;

export type CueTiming = { [K in keyof typeof CUE_TIMING]: number };

export interface TimedCue {
  /** comp frames */
  at: number;
  len: number;
  text: string;
  /** frame offsets of each word from the cue start */
  words: number[];
}

/**
 * Cues for groups of timed words (each group = one cue), inside [lo, hi) comp frames. Cues are in order and never
 * overlap; each has len ≥ 1 and its word offsets are non-decreasing and inside it.
 */
export function timeCues(groups: TimedWord[][], fps: number, lo: number, hi: number, o: Partial<CueTiming> = {}): TimedCue[] {
  const t = { ...CUE_TIMING, ...o };
  const f = (s: number) => s * fps;
  const live = groups.filter((g) => g.length);
  // the frame each cue appears: a little before its first word, never before the previous cue's first frame
  const starts = live.map((g) => Math.max(lo, Math.floor(f(g[0]!.start - t.lead))));
  for (let i = 1; i < starts.length; i++) starts[i] = Math.max(starts[i]!, starts[i - 1]! + 1);
  const out: TimedCue[] = [];
  live.forEach((g, i) => {
    const at = starts[i]!;
    const next = i + 1 < live.length ? starts[i + 1]! : hi;
    const last = g[g.length - 1]!;
    const spoken = Math.ceil(f((last.end ?? last.start) + t.tail));
    const text = g.map((w) => w.text).join(' ');
    const readable = at + Math.ceil(f(Math.max(t.minLen, text.length / t.maxCps)));
    let end = Math.max(spoken, Math.min(readable, Math.ceil(f((last.end ?? last.start) + Math.max(t.tail, 1)))));
    if (next - end <= Math.round(f(t.bridge))) end = next;
    end = Math.max(at + 1, Math.min(end, next, Math.max(hi, at + 1)));
    let prev = 0;
    const words = g.map((w) => (prev = Math.min(end - at - 1, Math.max(prev, Math.floor(f(w.start - t.wordLead)) - at))));
    out.push({ at, len: end - at, text, words });
  });
  return out;
}

/**
 * A stand-in loudness envelope (dBFS per `hop` s) from silence ranges, for when only silences are known: speech
 * at -20 dB, silence at -90 dB. Word alignment can then still place words in the speech between the pauses.
 */
export function envelopeFromSilences(silences: { start: number; end: number }[], duration: number, hop = 0.01): number[] {
  const env = new Array<number>(Math.max(1, Math.round(duration / hop))).fill(-20);
  for (const s of silences) for (let i = Math.max(0, Math.floor(s.start / hop)); i < Math.min(env.length, Math.ceil(s.end / hop)); i++) env[i] = -90;
  return env;
}
