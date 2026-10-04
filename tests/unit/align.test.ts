// @vitest-environment node
/** Word alignment (src/core/align.ts) and caption cue timing (src/core/cue-timing.ts): the defaults that make captions read in sync. */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALIGN_DEFAULTS, alignWords, pauseAfter, snapToOnsets, syllables, textWords, voicedRuns } from '../../src/core/align.js';
import { CUE_TIMING, envelopeFromSilences, timeCues } from '../../src/core/cue-timing.js';
import { analyzeAudio } from '../../src/media/analysis.js';
import { REPO } from './plugin-fixtures.js';

/** An envelope with speech (-20 dB, with a small dip every `dip` s like the gap between words) over `spans` (s). */
function env(duration: number, spans: [number, number][], dip = 0): number[] {
  const out = new Array<number>(Math.round(duration / 0.01)).fill(-95);
  for (const [a, b] of spans) for (let i = Math.round(a / 0.01); i < Math.round(b / 0.01); i++) {
    const k = i - Math.round(a / 0.01);
    out[i] = dip && k > 0 && k % Math.round(dip / 0.01) === 0 ? -45 : -20;
  }
  return out;
}

describe('voicedRuns and helpers', () => {
  it('finds the voiced runs between pauses; short dips inside a word do not split it', () => {
    const e = env(4, [[0.5, 1.5], [2.0, 3.2]]);
    e[80] = -95; e[81] = -95; // a 20 ms dip (a stop consonant)
    expect(voicedRuns(e).map(([a, b]) => [Math.round(a * 100) / 100, Math.round(b * 100) / 100])).toEqual([[0.5, 1.5], [2, 3.2]]);
  });
  it('syllables and pause strength', () => {
    expect([syllables('sleep'), syllables('better'), syllables('chocolate'), syllables('1,000')]).toEqual([1, 2, 3, 6]);
    expect([pauseAfter('sleep.'), pauseAfter('First,'), pauseAfter('room')]).toEqual([1, 0.6, 0]);
  });
});

describe('alignWords', () => {
  it('puts each phrase on its own stretch of speech, in order, every word inside the speech', () => {
    // three phrases spoken at 0.3–1.4, 2.0–3.4, 4.0–4.9 s
    const spans: [number, number][] = [[0.3, 1.4], [2.0, 3.4], [4.0, 4.9]];
    const words = textWords('Three tips for sleep. Keep your room cool and dark. Then rest.');
    const r = alignWords(words, env(5.5, spans, 0.25));
    expect(r.map((w) => w.text)).toEqual(words);
    const phraseOf = (t: number) => spans.findIndex(([a, b]) => t >= a - 0.001 && t < b);
    expect(r.map((w) => phraseOf(w.start))).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2]);
    // phrase starts are exact (the sound starts there)
    expect([r[0]!.start, r[4]!.start, r[10]!.start]).toEqual([0.3, 2, 4]);
    for (let i = 1; i < r.length; i++) expect(r[i]!.start).toBeGreaterThan(r[i - 1]!.start);
    for (const w of r) expect(w.end!).toBeGreaterThan(w.start);
  });
  it('without punctuation still follows the pauses; with no speech it spreads the words', () => {
    const r = alignWords(textWords('one two three four'), env(3, [[0.2, 0.9], [1.6, 2.3]]));
    expect(r[2]!.start).toBe(1.6);
    const flat = alignWords(textWords('a b c'), new Array(100).fill(-120));
    expect(flat).toHaveLength(3);
    expect(alignWords([], env(1, [[0, 1]]))).toEqual([]);
  });
  it('stays fast on a long voice-over (600 words, ~4 min)', () => {
    const spans: [number, number][] = [];
    for (let t = 0.2; t < 240; t += 2.4) spans.push([t, t + 1.9]);
    const words = Array.from({ length: 600 }, (_, i) => (i % 6 === 5 ? 'word.' : 'word'));
    const t0 = performance.now();
    const r = alignWords(words, env(242, spans, 0.3));
    expect(r).toHaveLength(600);
    expect(performance.now() - t0).toBeLessThan(5000);
  });
});

describe('snapToOnsets', () => {
  it('moves a phrase-initial word to where the sound starts and ends a word with its sound', () => {
    const e = env(3, [[0.3, 1.0], [1.6, 2.4]]);
    const r = snapToOnsets([{ text: 'Hi', start: 0.38, end: 1.2 }, { text: 'there.', start: 1.7, end: 2.4 }], e);
    expect(r).toEqual([{ text: 'Hi', start: 0.3, end: 1 }, { text: 'there.', start: 1.6, end: 2.4 }]);
    // a word far from any onset is left alone
    expect(snapToOnsets([{ text: 'x', start: 0.7 }], e)).toEqual([{ text: 'x', start: 0.7 }]);
  });
});

describe('timeCues (CUE_TIMING)', () => {
  const W = (text: string, start: number, end: number) => ({ text, start, end });
  it('a cue appears just before its first word; karaoke words light at their onsets', () => {
    const [q] = timeCues([[W('Put', 1, 1.2), W('it', 1.25, 1.4), W('down.', 1.45, 1.9)]], 30, 0, 300);
    expect(q!.at).toBe(Math.floor((1 - CUE_TIMING.lead) * 30));
    expect(q!.words).toEqual([0, Math.floor((1.25 - CUE_TIMING.wordLead) * 30) - q!.at, Math.floor((1.45 - CUE_TIMING.wordLead) * 30) - q!.at]);
    // stays through the last word plus the tail
    expect(q!.at + q!.len).toBe(Math.ceil((1.9 + CUE_TIMING.tail) * 30));
  });
  it('closes short gaps (no flicker), keeps real pauses, never overlaps', () => {
    const cues = timeCues([[W('One', 0, 0.4)], [W('two', 0.9, 1.3)], [W('three', 3, 3.4)]], 30, 0, 300);
    expect(cues[0]!.at + cues[0]!.len).toBe(cues[1]!.at); // 0.5 s apart: bridged
    expect(cues[2]!.at - (cues[1]!.at + cues[1]!.len)).toBeGreaterThan(30); // 1.6 s pause: kept
    for (let i = 1; i < cues.length; i++) expect(cues[i]!.at).toBeGreaterThanOrEqual(cues[i - 1]!.at + cues[i - 1]!.len);
  });
  it('a short cue stays long enough to read when the silence after it allows', () => {
    const [q] = timeCues([[W('Go!', 1, 1.15)]], 30, 0, 300);
    expect(q!.len).toBeGreaterThanOrEqual(Math.round(CUE_TIMING.minLen * 30));
    const [a] = timeCues([[W('Everything', 1, 1.3), W('considered,', 1.3, 1.7)]], 30, 0, 300);
    expect(a!.len / 30).toBeGreaterThanOrEqual('Everything considered,'.length / CUE_TIMING.maxCps - 0.05);
  });
  it('stays inside [lo, hi) and keeps word offsets inside the cue', () => {
    const cues = timeCues([[W('a', 0, 0.1), W('b', 0.1, 0.2)], [W('c', 0.21, 0.3)]], 30, 0, 12);
    for (const q of cues) { expect(q.at).toBeGreaterThanOrEqual(0); expect(q.at + q.len).toBeLessThanOrEqual(12); expect(q.words.every((w) => w >= 0 && w < q.len)).toBe(true); }
  });
  it('envelopeFromSilences marks speech between the silences', () => {
    const e = envelopeFromSilences([{ start: 0, end: 0.5 }, { start: 1.5, end: 2 }], 2);
    expect(voicedRuns(e)).toEqual([[0.5, 1.5]]);
  });
});

describe('the defaults are documented', () => {
  it('every CUE_TIMING and ALIGN_DEFAULTS value appears in docs/reference/text-and-captions.md', () => {
    const doc = readFileSync(join(REPO, 'docs/reference/text-and-captions.md'), 'utf8');
    for (const [k, v] of [...Object.entries(CUE_TIMING), ...Object.entries(ALIGN_DEFAULTS)]) expect(doc, `${k} = ${v}`).toMatch(new RegExp(`\`${k}\`[^\\n]*\\b${String(v).replace('.', '\\.')}\\b`));
  });
});

describe('real speech (ffmpeg flite)', () => {
  it('phrase starts are found within 60 ms; every word lands inside its phrase', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mgl-align-'));
    try {
      const phrases = ['Keep your phone in another room.', 'Dim the lights after sunset.', 'Wake up at the same time every day.'];
      const pauses = [0.4, 0.9, 0.6];
      const inputs: string[] = [], parts: string[] = [];
      phrases.forEach((t, i) => {
        inputs.push('-f', 'lavfi', '-i', `anullsrc=r=16000:cl=mono:d=${pauses[i]}`, '-f', 'lavfi', '-i', `flite=text='${t.replace(/[.,]/g, '')}':voice=slt`);
        parts.push(`[${2 * i}:a]aresample=16000[s${i}]`, `[${2 * i + 1}:a]aresample=16000[p${i}]`);
      });
      const wav = join(dir, 'vo.wav');
      try {
        execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', `${parts.join(';')};${phrases.map((_, i) => `[s${i}][p${i}]`).join('')}concat=n=${2 * phrases.length}:v=0:a=1`, wav]);
      } catch { return; } // no flite in this ffmpeg: the synthetic tests above cover the logic
      const a = await analyzeAudio(wav, { envelope: true, noBeats: true });
      // the true phrase onsets: the first sound after each silence
      const onsets = voicedRuns(a.envelope!, { minPause: 0.3 }).map(([s]) => s);
      expect(onsets).toHaveLength(3);
      const words = textWords(phrases.join(' '));
      const r = alignWords(words, a.envelope!);
      let i = 0;
      phrases.forEach((p, k) => {
        expect(Math.abs(r[i]!.start - onsets[k]!)).toBeLessThanOrEqual(0.06);
        const n = textWords(p).length;
        for (const w of r.slice(i, i + n)) { expect(w.start).toBeGreaterThanOrEqual(onsets[k]! - 0.06); if (k + 1 < onsets.length) expect(w.start).toBeLessThan(onsets[k + 1]!); }
        i += n;
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('caption-timing check', () => {
  const project = (cues: { id: string; at: number; len: number; text: string }[]) => ({
    michelangelo: 1 as const, comps: [{ id: 'main', size: [1080, 1920] as [number, number], fps: 30, length: 300 }],
    tracks: [{ id: 'T1', comp: 'main' }], clips: [{ id: 'subs', track: 'T1', at: 0, len: 300, captions: true }],
    cues: cues.map((q) => ({ ...q, clip: 'subs' })),
  });
  it('reports flashes, unreadably fast cues and blinks, each with a fix; cues made by timeCues pass', async () => {
    const { captionTiming } = await import('../../src/builtin/checks/captions.js');
    const { checkContext } = await import('../../src/plugin/testing.js');
    const bad = project([
      { id: 'c1', at: 0, len: 6, text: 'Go' },
      { id: 'c2', at: 40, len: 30, text: 'An extremely long caption line that nobody can possibly read in one second flat' },
      { id: 'c3', at: 76, len: 30, text: 'then a blink' },
    ]);
    const f = await captionTiming.run(checkContext(bad as never));
    expect(f.map((x) => [x.severity, x.message.split(' ').slice(0, 2).join(' ')])).toEqual([['warning', 'cue "c1"'], ['warning', 'cue "c2"'], ['info', 'captions blink']]);
    expect(f.every((x) => x.fix?.startsWith('mgl edit <file> '))).toBe(true);
    const W = (text: string, start: number, end: number) => ({ text, start, end });
    const good = timeCues([[W('Three', 0.3, 0.55), W('tips', 0.6, 0.85)], [W('for', 0.9, 1), W('better', 1.05, 1.25), W('sleep.', 1.3, 1.55)], [W('First,', 2, 2.48)]], 30, 0, 300);
    const g = project(good.map((q, i) => ({ id: `c${i + 1}`, at: q.at, len: q.len, text: q.text })));
    expect(await captionTiming.run(checkContext(g as never))).toEqual([]);
  });
});

describe('checkSpeakProvider (michelangelo/testing)', () => {
  it('passes a conforming provider and names what a broken one gets wrong', async () => {
    const { checkSpeakProvider } = await import('../../src/plugin/testing.js');
    const { defineProvider } = await import('../../src/plugin/api.js');
    const { writeFileSync } = await import('node:fs');
    const wav = (n: number) => { const b = Buffer.alloc(44 + n * 2); b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8, 'latin1'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(48000, 24); b.writeUInt32LE(96000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36, 'latin1'); b.writeUInt32LE(n * 2, 40); for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 8) * 8000), 44 + i * 2); return b; };
    const good = defineProvider({ kind: 'speak', id: 'ok', describe: '', async voices() { return [{ id: 'a' }]; }, async speak({ text, out }) { writeFileSync(out, wav(48000)); return { words: text.split(' ').map((t, i) => ({ text: t, start: i * 0.1, end: i * 0.1 + 0.08 })) }; } });
    expect((await checkSpeakProvider(good, { text: 'one two three' })).problems).toEqual([]);
    const bad = defineProvider({ kind: 'speak', id: 'bad', describe: '', async voices() { return []; }, async speak({ out }) { writeFileSync(out, wav(4800)); return { words: [{ text: 'one', start: 5 }] }; } });
    const r = await checkSpeakProvider(bad, { text: 'one two' });
    expect(r.problems.join(' | ')).toMatch(/no voice.*1 word timings for 2 words/);
  });
});
