/**
 * Speech alignment, pure: where each word of a known text is spoken in a recording, from its loudness envelope
 * (dBFS per 10 ms; `analyzeAudio(..., { envelope: true })`). No model, no language data beyond a syllable guess,
 * so it works for any voice: a speak provider that returns no timings, a recorded voice-over with its script.
 *
 * How: the envelope is cut into voiced runs at pauses. Words are then matched to runs in order (dynamic
 * programming): a group of words takes a group of runs whose length fits the group's syllables at the speaker's
 * rate, and a pause is preferred where the text has punctuation. Inside a group, words share the voiced time by
 * syllables, and each boundary moves to the quietest point nearby (the dip between two words).
 */
import type { TimedWord } from './commands/registry.js';

export const ALIGN_DEFAULTS = {
  /** seconds per envelope value */
  hop: 0.01,
  /** a quieter stretch at least this long (s) separates two voiced runs */
  minPause: 0.08,
  /** voiced runs shorter than this (s) are clicks or breaths: dropped */
  minRun: 0.03,
  /** a word boundary moves to the quietest point within this distance (s) */
  snap: 0.06,
  /** most words and runs one group may hold (bounds the search) */
  maxGroup: 14,
} as const;

export interface AlignOptions {
  hop?: number;
  /** level (dBFS) under which the envelope counts as a pause; default: from the recording's own floor and peak */
  silenceDb?: number;
  minPause?: number;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** Rough syllable count of a written word (vowel groups), at least 1; numbers count by their digits. */
export function syllables(word: string): number {
  const w = word.toLowerCase();
  const digits = (w.match(/[0-9]/g) ?? []).length;
  const letters = w.replace(/[^\p{L}]/gu, '');
  let groups = (letters.replace(/e$/, '').match(/[aeiouyàâäéèêëïîôöùûüœæ]+/g) ?? []).length;
  if (!groups && letters.length) groups = Math.max(1, Math.round(letters.length / 3));
  const symbols = (w.match(/[%°$€£&+@#=]/g) ?? []).length;
  return Math.max(1, groups + Math.round(digits * 1.6) + symbols * 2);
}

/**
 * Relative spoken length of a word: syllables plus a little per letter (consonant clusters take time), longer
 * before punctuation (speakers slow down at the end of a phrase).
 */
export function spokenWeight(word: string): number {
  const letters = word.replace(/[^\p{L}\p{N}]/gu, '').length;
  return (0.7 * syllables(word) + 0.08 * letters + 0.15) * (1 + 0.45 * pauseAfter(word));
}

/** How strongly the text invites a pause after this word: 1 sentence end, 0.6 clause, 0 none. */
export function pauseAfter(word: string): number {
  if (/[.!?…]["'”’)\]]*$/.test(word)) return 1;
  if (/[,;:—–-]["'”’)\]]*$/.test(word) || /^[—–-]+$/.test(word)) return 0.6;
  return 0;
}

function percentile(xs: number[], p: number): number {
  if (!xs.length) return -120;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))]!;
}

/**
 * The level under which the envelope is a pause: 25 dB under the speech's loud parts (95th percentile), and at
 * least 6 dB over the floor (so a noisy recording's hiss stays a pause). Short pauses between sentences are
 * rarely silent, so a threshold set from the floor up would miss them.
 */
export function pauseThreshold(env: number[], silenceDb?: number): number {
  if (silenceDb !== undefined) return silenceDb;
  const floor = Math.max(-100, percentile(env, 0.1)), peak = percentile(env, 0.95);
  return Math.max(floor + 6, peak - 25);
}

/** Voiced runs [start, end) in seconds. */
export function voicedRuns(env: number[], o: AlignOptions = {}): [number, number][] {
  const hop = o.hop ?? ALIGN_DEFAULTS.hop, minPause = o.minPause ?? ALIGN_DEFAULTS.minPause;
  const thr = pauseThreshold(env, o.silenceDb);
  const runs: [number, number][] = [];
  let a = -1;
  for (let i = 0; i <= env.length; i++) {
    const on = i < env.length && env[i]! > thr;
    if (on && a < 0) a = i;
    else if (!on && a >= 0) { runs.push([a * hop, i * hop]); a = -1; }
  }
  const merged: [number, number][] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] < minPause) last[1] = r[1];
    else merged.push([r[0], r[1]]);
  }
  return merged.filter(([s, e]) => e - s >= ALIGN_DEFAULTS.minRun);
}

/** The quietest envelope point within ±`reach` s of `t`, kept inside (lo, hi). */
function quietest(env: number[], hop: number, t: number, reach: number, lo: number, hi: number): number {
  const a = Math.max(Math.ceil((lo + 0.02) / hop), Math.round((t - reach) / hop));
  const b = Math.min(Math.floor((hi - 0.02) / hop), Math.round((t + reach) / hop));
  let best = t, bestDb = Infinity;
  for (let i = a; i <= b; i++) {
    // ties go to the point nearest the estimate
    const db = (env[i] ?? 0) + Math.abs(i * hop - t) * 2;
    if (db < bestDb) { bestDb = db; best = i * hop; }
  }
  return best;
}

/**
 * Times for `words` (the text split at spaces, punctuation kept) spoken in a recording with this envelope.
 * Returns one TimedWord per word, in order, with start < end; empty when there are no words. With no voiced
 * run at all the words are spread over the whole recording.
 */
export function alignWords(words: string[], env: number[], o: AlignOptions = {}): TimedWord[] {
  const hop = o.hop ?? ALIGN_DEFAULTS.hop;
  const n = words.length;
  if (!n) return [];
  const duration = env.length * hop;
  let runs = voicedRuns(env, o);
  if (!runs.length) runs = [[0, Math.max(duration, 0.1 * n)]];
  const m = runs.length;
  const syl = words.map(spokenWeight);
  const sylPre = [0]; for (const s of syl) sylPre.push(sylPre[sylPre.length - 1]! + s);
  const voiced = runs.reduce((t, [a, b]) => t + b - a, 0);
  const rate = voiced / sylPre[n]!; // seconds per syllable
  const G = ALIGN_DEFAULTS.maxGroup;

  // prefix sums: voiced time of runs [0, j), and the cost of the pauses before runs 1..j-1 if kept inside a group
  const durPre = [0], innerPre = [0, 0];
  for (let j = 0; j < m; j++) durPre.push(durPre[j]! + runs[j]![1] - runs[j]![0]);
  for (let j = 1; j < m; j++) innerPre.push(innerPre[j]! + Math.min(1, (runs[j]![0] - runs[j - 1]![1]) / 0.25) ** 2);
  // cost of words [i0, i1) on runs [j0, j1): length fit, plus the pauses kept inside the group (cheaper where
  // the text has punctuation inside the group: `punct`)
  const blockCost = (i0: number, i1: number, j0: number, j1: number, punct: number): number => {
    const dur = durPre[j1]! - durPre[j0]!, inner = innerPre[j1]! - innerPre[j0 + 1]!;
    const expect = rate * (sylPre[i1]! - sylPre[i0]!);
    const fit = Math.log(Math.max(dur, 0.02) / Math.max(expect, 0.02));
    return 1.5 * fit * fit + inner * (1 - 0.6 * punct);
  };
  // cost of a pause between groups, after word i-1 (gap in seconds)
  const breakCost = (i: number, gap: number): number => {
    const p = pauseAfter(words[i - 1]!);
    return p ? -p * (0.5 + 0.5 * Math.min(1, gap / 0.3)) : 0.15;
  };

  // dp[i][j]: best cost of words [0, i) on runs [0, j), the last group ending exactly there
  const INF = Number.POSITIVE_INFINITY;
  const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(INF));
  const from = Array.from({ length: n + 1 }, () => new Int32Array(m + 1).fill(-1));
  dp[0]![0] = 0;
  // a band around the diagonal (by syllables vs voiced time) keeps long recordings fast
  const runAt = (sylPos: number) => {
    let acc = 0, target = sylPos * rate;
    for (let j = 0; j < m; j++) { acc += runs[j]![1] - runs[j]![0]; if (acc >= target) return j; }
    return m;
  };
  const band = Math.max(40, Math.round(m * 0.1) + 20);
  for (let i = 1; i <= n; i++) {
    const center = runAt(sylPre[i]!);
    const jlo = Math.max(1, center - band), jhi = Math.min(m, center + band);
    for (let j = jlo; j <= jhi; j++) {
      // the last group: words [i0, i), runs [j0, j); every word and every run belongs to exactly one group
      if (i < n && j === m) continue;
      let punct = 0;
      for (let i0 = i - 1; i0 >= Math.max(0, i - G); i0--) {
        if (i0 < i - 1) punct = Math.max(punct, pauseAfter(words[i0]!));
        for (let j0 = Math.max(0, j - G); j0 < j; j0++) {
          const prev = dp[i0]![j0]!;
          if (prev === INF || (i0 === 0) !== (j0 === 0)) continue;
          const c = prev + blockCost(i0, i, j0, j, punct) + (j0 > 0 ? breakCost(i0, runs[j0]![0] - runs[j0 - 1]![1]) : 0);
          if (c < dp[i]![j]!) { dp[i]![j] = c; from[i]![j] = i0 * (m + 1) + j0; }
        }
      }
    }
  }
  if (dp[n]![m] === INF) {
    // no consistent grouping (more words than the search allows per run): spread over the voiced time
    return spread(words, syl, runs, env, hop, 0, n, 0, m);
  }
  const groups: [number, number, number, number][] = [];
  for (let i = n, j = m; i > 0;) {
    const f = from[i]![j]!, i0 = Math.floor(f / (m + 1)), j0 = f % (m + 1);
    groups.unshift([i0, i, j0, j]);
    i = i0; j = j0;
  }
  return groups.flatMap(([i0, i1, j0, j1]) => spread(words, syl, runs, env, hop, i0, i1, j0, j1));
}

/** Words [i0, i1) shared over runs [j0, j1) by syllables; boundaries go to a pause or the quietest point near. */
function spread(words: string[], syl: number[], runs: [number, number][], env: number[], hop: number, i0: number, i1: number, j0: number, j1: number): TimedWord[] {
  const rs = runs.slice(j0, j1);
  const total = rs.reduce((t, [a, b]) => t + b - a, 0);
  const weight = (i: number) => syl[i]!;
  const W = words.slice(i0, i1).reduce((t, _, k) => t + weight(i0 + k), 0);
  // voiced position (s) → real time; at a run edge, `late` picks the start of the next run
  const real = (pos: number, late: boolean): number => {
    let acc = 0;
    for (const [a, b] of rs) {
      const d = b - a;
      if (pos < acc + d || (!late && pos <= acc + d)) return a + Math.max(0, pos - acc);
      acc += d;
    }
    return rs[rs.length - 1]![1];
  };
  const bounds: number[] = [rs[0]![0]];
  let acc = 0;
  for (let i = i0; i < i1 - 1; i++) {
    acc += (weight(i) / W) * total;
    // near a pause inside the group: the boundary is that pause
    let cut: number | undefined;
    let edge = 0;
    for (let k = 0; k < rs.length - 1; k++) {
      edge += rs[k]![1] - rs[k]![0];
      if (Math.abs(edge - acc) <= Math.min(0.25, 0.4 * (weight(i) / W) * total + 0.05)) cut = rs[k + 1]![0];
    }
    const prev = bounds[bounds.length - 1]!;
    if (cut === undefined || cut <= prev) {
      const t = real(acc, true);
      cut = quietest(env, hop, t, ALIGN_DEFAULTS.snap, prev, rs[rs.length - 1]![1]);
    }
    bounds.push(Math.max(prev + 0.02, cut));
  }
  const end = rs[rs.length - 1]![1];
  return words.slice(i0, i1).map((text, k) => {
    const start = bounds[k]!;
    let stop = k + 1 < bounds.length ? bounds[k + 1]! : end;
    // a word that ends at a pause stops where the voice stops, not where the next word starts
    for (const [a, b] of rs) if (start >= a && start < b && stop > b) { stop = b; break; }
    return { text, start: round3(start), end: round3(Math.max(start + 0.02, stop)) };
  });
}

/** Words of a text, split at whitespace (punctuation stays on its word). */
export function textWords(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/**
 * Provider word timings checked against the sound: a word that starts a phrase (sound after a pause) starts where
 * the sound starts, if the provider put it within `reach` s of there (models tend to mark the vowel, not the first
 * consonant), and a word that ends at a pause ends where the sound stops. Other times are kept.
 */
export function snapToOnsets(words: TimedWord[], env: number[], o: AlignOptions & { reach?: number } = {}): TimedWord[] {
  const reach = o.reach ?? 0.15;
  const runs = voicedRuns(env, o);
  const out = words.map((w) => ({ ...w }));
  if (!runs.length || !out.length) return out;
  for (const [a] of runs) {
    let k = -1;
    for (let i = 0; i < out.length; i++) if (Math.abs(out[i]!.start - a) <= reach && (k < 0 || Math.abs(out[i]!.start - a) < Math.abs(out[k]!.start - a))) k = i;
    if (k < 0 || (k > 0 && out[k - 1]!.start >= a)) continue;
    out[k]!.start = round3(a);
    if (out[k]!.end !== undefined && out[k]!.end! <= a) out[k]!.end = round3(a + 0.02);
  }
  for (const w of out) {
    if (w.end === undefined) continue;
    const run = runs.find(([a, b]) => w.start >= a - 0.02 && w.start < b);
    if (run && w.end > run[1] + 0.05) {
      // the word's end lies in the pause after its run: it ended with the sound
      const nextRun = runs.find(([a]) => a > run[1]);
      if (!nextRun || w.end <= nextRun[0] + 0.02) w.end = round3(run[1]);
    }
  }
  return out;
}
