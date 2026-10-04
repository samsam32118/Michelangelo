import { definePlugin, defineProvider, defineCommand, z, type SpeakProvider } from 'michelangelo/plugin';

/**
 * Natural text to speech for `audio.speak` with Kokoro-82M (https://huggingface.co/hexgrad/Kokoro-82M, Apache-2.0
 * weights), run on the CPU through kokoro-js (ONNX). English voices, US and UK.
 *
 * Word timings come from the model itself: the "timestamped" ONNX export returns how many frames (600 samples at
 * 24 kHz, 25 ms) it spends on each phoneme, so every word's start and end is where the model put it, not a guess.
 * Text words are matched to the phoneme words by `matchWords` ("18°C" becomes three spoken words and still maps to
 * one caption word). When a match is not possible the provider returns no timings and Michelangelo aligns the text
 * to the audio itself (core word alignment), so captions still line up.
 *
 * Needs `npm install` in this folder (kokoro-js). The first `audio.speak` downloads the model (~330 MB, fp32) from
 * Hugging Face into ~/.cache/michelangelo/kokoro; later runs are offline. Settings (environment variables):
 *   MGL_KOKORO_DTYPE  fp32 (default: full quality, ~330 MB), q8 (~90 MB, near the same), fp16, q4, q4f16
 *   MGL_KOKORO_MODEL  a Hugging Face model id (default onnx-community/Kokoro-82M-v1.0-ONNX-timestamped)
 *   MGL_KOKORO_CACHE  the model folder (default ~/.cache/michelangelo/kokoro)
 *   MGL_KOKORO_OFFLINE=1  never download (the model must be in the cache)
 * Node built-ins and kokoro-js are imported lazily: loading the plugin costs nothing until it speaks.
 */

/** English voices (kokoro-js 1.2), best first; grades from the model card. */
export const VOICES = [
  { id: 'af_heart', describe: 'US English, female, warm (grade A; default)', lang: 'en-US' },
  { id: 'af_bella', describe: 'US English, female, bright (A-)', lang: 'en-US' },
  { id: 'af_nicole', describe: 'US English, female, soft/close-mic (B-)', lang: 'en-US' },
  { id: 'bf_emma', describe: 'UK English, female (B-)', lang: 'en-GB' },
  { id: 'am_fenrir', describe: 'US English, male (C+)', lang: 'en-US' },
  { id: 'am_michael', describe: 'US English, male (C+)', lang: 'en-US' },
  { id: 'am_puck', describe: 'US English, male (C+)', lang: 'en-US' },
  { id: 'af_aoede', describe: 'US English, female (C+)', lang: 'en-US' },
  { id: 'af_kore', describe: 'US English, female (C+)', lang: 'en-US' },
  { id: 'af_sarah', describe: 'US English, female (C+)', lang: 'en-US' },
  { id: 'bm_george', describe: 'UK English, male (C)', lang: 'en-GB' },
  { id: 'bm_fable', describe: 'UK English, male (C)', lang: 'en-GB' },
  { id: 'bf_isabella', describe: 'UK English, female (C)', lang: 'en-GB' },
  { id: 'af_alloy', describe: 'US English, female (C)', lang: 'en-US' },
  { id: 'af_nova', describe: 'US English, female (C)', lang: 'en-US' },
  { id: 'af_sky', describe: 'US English, female (C-)', lang: 'en-US' },
  { id: 'bm_lewis', describe: 'UK English, male (D+)', lang: 'en-GB' },
  { id: 'am_echo', describe: 'US English, male (D)', lang: 'en-US' },
  { id: 'am_eric', describe: 'US English, male (D)', lang: 'en-US' },
  { id: 'am_liam', describe: 'US English, male (D)', lang: 'en-US' },
  { id: 'am_onyx', describe: 'US English, male (D)', lang: 'en-US' },
  { id: 'bf_alice', describe: 'UK English, female (D)', lang: 'en-GB' },
  { id: 'bf_lily', describe: 'UK English, female (D)', lang: 'en-GB' },
  { id: 'bm_daniel', describe: 'UK English, male (D)', lang: 'en-GB' },
  { id: 'af_jessica', describe: 'US English, female (D)', lang: 'en-US' },
  { id: 'af_river', describe: 'US English, female (D)', lang: 'en-US' },
  { id: 'am_santa', describe: 'US English, male (D-)', lang: 'en-US' },
  { id: 'am_adam', describe: 'US English, male (F+)', lang: 'en-US' },
];

export const SAMPLE_RATE = 24000;
/** seconds per duration unit of the timestamped model (600 samples at 24 kHz) */
export const FRAME = 600 / SAMPLE_RATE;
/** most characters per synthesis call (the model reads at most 510 phonemes) */
export const MAX_CHARS = 280;

export interface Word { text: string; start: number; end: number }
export interface PhonemeWord { phonemes: string; start: number; end: number }

/** Split text into chunks of at most `max` characters: whole sentences, else clauses, else words. */
export function chunks(text: string, max = MAX_CHARS): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = clean.split(/(?<=[.!?…]["'”’)\]]*)\s+/);
  const out: string[] = [];
  let cur = '';
  const push = (s: string) => {
    if (!cur) cur = s;
    else if (cur.length + 1 + s.length <= max) cur += ' ' + s;
    else { out.push(cur); cur = s; }
  };
  for (const s of sentences) {
    if (s.length <= max) { push(s); continue; }
    // a long sentence: at clause punctuation, then at spaces
    for (const clause of s.split(/(?<=[,;:—–])\s+/)) {
      if (clause.length <= max) { push(clause); continue; }
      let part = '';
      for (const w of clause.split(' ')) {
        if (part && part.length + 1 + w.length > max) { push(part); part = w; } else part = part ? part + ' ' + w : w;
      }
      if (part) push(part);
    }
  }
  if (cur) out.push(cur);
  return out;
}

const PUNCT = /^[\p{P}\p{S}]+$/u;

/**
 * Phoneme words with times (seconds) from the model's tokens and per-token durations (model frames). Tokens are
 * single characters; " " separates words; "$" pads both ends; punctuation tokens carry the pause that follows a
 * word, so a word ends where its last sound ends.
 */
export function phonemeWords(tokens: string[], durations: number[]): PhonemeWord[] {
  const out: PhonemeWord[] = [];
  let t = 0, cur: { phonemes: string; start: number; end: number } | undefined;
  tokens.forEach((tok, i) => {
    const d = Math.max(1, Math.round(durations[i] ?? 0)) * FRAME;
    if (tok === ' ' || tok === '$') { if (cur) { out.push(cur); cur = undefined; } }
    else if (PUNCT.test(tok) && !/^[ˈˌː]$/.test(tok)) {
      // punctuation: closes the current word without extending it; a lone dash or quote is its own (silent) word
      if (!cur) out.push({ phonemes: tok, start: t, end: t });
    } else {
      if (!cur) cur = { phonemes: '', start: t, end: t };
      cur.phonemes += tok;
      cur.end = t + d;
    }
    t += d;
  });
  if (cur) out.push(cur);
  return out;
}

/** Letters and digits of a word (what is spoken). */
const core = (w: string) => w.replace(/[^\p{L}\p{N}]/gu, '');

/** Consonant outline of a written English word: "thought" → "Tt", "cheapest" → "Cpst". */
export function letterOutline(word: string): string {
  let w = word.toLowerCase().replace(/[^a-z]/g, '');
  w = w.replace(/^kn/, 'n').replace(/^wr/, 'r').replace(/^wh/, 'w').replace(/gh/g, '').replace(/ph/g, 'f').replace(/ck/g, 'k')
    .replace(/qu/g, 'kw').replace(/x/g, 'ks').replace(/tch/g, 'C').replace(/ch/g, 'C').replace(/sh/g, 'S').replace(/th/g, 'T')
    .replace(/ng/g, 'N').replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k').replace(/^y/, 'j').replace(/(.)\1+/g, '$1');
  return w.replace(/[aeiouy]/g, '');
}

/** Consonant outline of a phoneme word (espeak IPA): "θˈɔːt" → "Tt". */
export function phonemeOutline(ph: string): string {
  return ph.replace(/tʃ/g, 'C').replace(/dʒ/g, 'J').replace(/[θð]/g, 'T').replace(/ʃ/g, 'S').replace(/ʒ/g, 'Z').replace(/ŋ/g, 'N')
    .replace(/[ɹrɚɝ]/g, 'r').replace(/[ɾʔ]/g, 't').replace(/ɫ/g, 'l').replace(/ɡ/g, 'g').replace(/[^bdfghjklmnprstvwzCJTSZN]/g, '').replace(/(.)\1+/g, '$1');
}

/** Words English speech uses for a whole number ("1999" read as a number: one thousand nine hundred ninety nine). */
function numberWords(n: number): number {
  if (n < 20) return 1;
  if (n < 100) return n % 10 ? 2 : 1;
  if (n < 1000) return 2 + (n % 100 ? numberWords(n % 100) : 0);
  for (const [scale, size] of [[1e9, 1], [1e6, 1], [1e3, 1]] as const) {
    if (n >= scale) return numberWords(Math.floor(n / scale)) + size + (n % scale ? numberWords(n % scale) : 0);
  }
  return 1;
}

/** Rough count of phoneme words for a word with digits, symbols or spelled letters ("$5.99" → 6, "U.S." → 1). */
export function spokenCount(word: string): number {
  const w = word.replace(/^[^\p{L}\p{N}$€£-]+|[^\p{L}\p{N}%°]+$/gu, '');
  // spelled letters ("U.S.", "AI", "GPUs") come out as one phoneme word
  if (/^(\p{L}\.){2,}$/u.test(w + (w.endsWith('.') ? '' : '.')) || /^\p{Lu}{2,}s?$/u.test(w)) return 1;
  let n = 0;
  if (/^-\d/.test(w)) n++;
  const money = /^[$€£]/.test(w);
  const m = /(\d[\d,]*)(?:\.(\d+))?/.exec(w);
  if (m) {
    const int = Number(m[1]!.replace(/,/g, ''));
    const year = /^\d{4}$/.test(m[1]!) && !m[2] && int >= 1100 && int < 2100 && !money;
    n += year && int % 1000 >= 10 ? numberWords(Math.floor(int / 100)) + (int % 100 ? numberWords(int % 100) : 1) : numberWords(int);
    if (m[2]) n += money && m[2].length === 2 ? 2 + numberWords(Number(m[2])) : 1 + m[2].length;
    const rest = w.slice(m.index + m[0].length);
    for (const g of rest.match(/\d+/g) ?? []) n += numberWords(Number(g)) + 1;
  }
  if (money) n++;
  if (/%/.test(w)) n++;
  if (/°/.test(w)) n += /°[CF]/.test(w) ? 2 : 1;
  const letters = w.replace(/\d+(st|nd|rd|th)\b/g, '').replace(/[^\p{L}]/gu, '');
  if (letters && !/°[CF]$/.test(w)) n++;
  return Math.max(1, n);
}

const NEAR = ['sz', 'tdT', 'kg', 'SZCJ', 'fv', 'pb', 'jy'];
/** How alike two consonant outlines are, 0..1 (edit distance; near sounds cost half). */
export function outlineSimilarity(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  const sub = (x: string, y: string) => (x === y ? 0 : NEAR.some((g) => g.includes(x) && g.includes(y)) ? 0.5 : 1);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + sub(a[i - 1]!, b[j - 1]!)));
    prev = cur;
  }
  return 1 - prev[b.length]! / Math.max(a.length, b.length);
}

/**
 * Match the text's words to the phoneme words, in order. A plain word is one phoneme word; a word with digits,
 * symbols or a hyphen may be several ("18°C" → "eighteen degrees C"); a word with nothing to say ("—") may be
 * none. Returns undefined when no match fits, so the caller can fall back to aligning by sound.
 */
export function matchWords(textWords: string[], ph: PhonemeWord[]): Word[] | undefined {
  const n = textWords.length, k = ph.length;
  if (!n) return [];
  const spoken = ph.map((p) => !PUNCT.test(p.phonemes));
  const maxSpan = (w: string) => (/[\p{N}%°$€£&+@#=/-]/u.test(w) || /\p{Lu}{2}|\p{L}\.\p{L}/u.test(w) ? 8 : 2);
  const INF = Number.POSITIVE_INFINITY;
  // dp[i][j]: text words [0, i) matched to phoneme words [0, j)
  const dp = Array.from({ length: n + 1 }, () => new Float64Array(k + 1).fill(INF));
  const from = Array.from({ length: n + 1 }, () => new Int32Array(k + 1).fill(-1));
  dp[0]![0] = 0;
  for (let i = 0; i <= n; i++) for (let j = 0; j <= k; j++) {
    const c = dp[i]![j]!;
    if (c === INF) continue;
    // a silent phoneme word (punctuation) may be skipped
    if (j < k && !spoken[j] && c < dp[i]![j + 1]!) { dp[i]![j + 1] = c; from[i]![j + 1] = -2; }
    if (i === n) continue;
    const w = textWords[i]!, letters = core(w);
    // a word with nothing to say may take no phoneme word
    if (!letters && c + 0.1 < dp[i + 1]![j]!) { dp[i + 1]![j] = c + 0.1; from[i + 1]![j] = j; }
    // a plain word should sound like what it spells; a word with digits or symbols is read out, so anything goes
    // spelled out letter by letter ("e.g.", "AI", "GPUs") is read out too
    const plain = !/[\p{N}%°$€£&+@#=/]/u.test(w) && !/^\W*(\p{L}\.){2,}\W*$/u.test(w) && !/^\W*\p{Lu}{2,}s?\W*$/u.test(w);
    const outline = letterOutline(w);
    const expected = plain ? 1 : spokenCount(w);
    let joined = '';
    for (let s = 1; s <= maxSpan(w) && j + s <= k; s++) {
      joined += ph[j + s - 1]!.phonemes;
      const sound = plain ? 2 * (1 - outlineSimilarity(outline, phonemeOutline(joined))) : 0.5 * Math.abs(s - expected) + 0.05 * s;
      const cost = c + (s - 1) * (plain ? 1.5 : 0) + sound + (!spoken[j] && letters ? 2 : 0);
      if (cost < dp[i + 1]![j + s]!) { dp[i + 1]![j + s] = cost; from[i + 1]![j + s] = j; }
    }
    // espeak fuses short words ("to be" → "təbi"): several plain text words on one phoneme word
    if (j < k && spoken[j]) {
      let joinedText = w;
      for (let t = 2; t <= 3 && i + t <= n; t++) {
        const wt = textWords[i + t - 1]!;
        if (!core(wt) || /[\p{N}%°$€£&+@#=/]/u.test(wt + w)) break;
        joinedText += wt;
        const cost = c + 0.8 * (t - 1) + 2 * (1 - outlineSimilarity(letterOutline(joinedText), phonemeOutline(ph[j]!.phonemes)));
        if (cost < dp[i + t]![j + 1]!) { dp[i + t]![j + 1] = cost; from[i + t]![j + 1] = -(10 + t); }
      }
    }
  }
  if (dp[n]![k] === INF || dp[n]![k]! > n * 0.9) return undefined;
  const out: Word[] = [];
  for (let i = n, j = k; i > 0 || j > 0;) {
    const f = from[i]![j]!;
    if (f === -2) { j--; continue; }
    if (f <= -10) {
      // t text words on phoneme word j-1: its time is shared by their letters
      const t = -f - 10, p = ph[j - 1]!, ws = textWords.slice(i - t, i);
      const L = ws.reduce((a, w) => a + core(w).length, 0) || 1;
      let at = p.start;
      const part = ws.map((w) => { const d = ((p.end - p.start) * core(w).length) / L; const o = { text: w, start: at, end: at + d }; at += d; return o; });
      out.unshift(...part);
      i -= t; j--;
      continue;
    }
    const span = ph.slice(f, j).filter((p, x) => spoken[f + x]);
    const at = span.length ? span[0]!.start : ph[f]?.start ?? ph[Math.max(0, f - 1)]?.end ?? 0;
    const end = span.length ? span[span.length - 1]!.end : at;
    out.unshift({ text: textWords[i - 1]!, start: at, end });
    i--; j = f;
  }
  // a word with nothing to say sits at the start of the next word, shown with it
  for (let i = out.length - 2; i >= 0; i--) if (out[i]!.end <= out[i]!.start && out[i + 1]) { out[i]!.start = out[i + 1]!.start; out[i]!.end = out[i + 1]!.start; }
  return out;
}

/** A 16-bit mono PCM WAV file. */
export function wav(pcm: Int16Array, rate = SAMPLE_RATE): Uint8Array {
  const out = new Uint8Array(44 + pcm.length * 2);
  const v = new DataView(out.buffer);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, pcm[i]!, true);
  return out;
}

/** Float samples → 16-bit with the peak at `peakDb` dBFS. */
export function toPcm16(samples: Float32Array, peakDb = -3): Int16Array {
  let peak = 1e-9;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]!));
  const gain = (32767 * 10 ** (peakDb / 20)) / peak;
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = Math.round(Math.max(-1, Math.min(1, (samples[i]! * gain) / 32767)) * 32767);
  return out;
}

// --------------------------------------------------------------------------------------- the model (lazy)

interface Tensor { data: ArrayLike<number | bigint>; dims: number[] }
interface RawAudio { audio: Float32Array; sampling_rate: number }
interface Kokoro {
  model: (inputs: Record<string, unknown>) => Promise<{ waveform: Tensor; durations?: Tensor }>;
  tokenizer: { decode(ids: number[]): string };
  generate(text: string, o: { voice?: string; speed?: number }): Promise<RawAudio>;
}

let loading: Promise<Kokoro> | undefined;
/** one synthesis at a time: the duration capture below wraps a shared model */
let queue: Promise<unknown> = Promise.resolve();

async function load(): Promise<Kokoro> {
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const spec: string = 'kokoro-js';
  let mod: { KokoroTTS: { from_pretrained(id: string, o: Record<string, unknown>): Promise<Kokoro> } };
  try { mod = await import(spec); } catch {
    throw new Error('kokoro-js is not installed: run "npm install" in the kokoro-voice plugin folder (then mgl plugin trust it again)');
  }
  const tspec: string = '@huggingface/transformers';
  const tf: { env: { cacheDir: string; allowRemoteModels: boolean } } = await import(tspec);
  tf.env.cacheDir = process.env.MGL_KOKORO_CACHE || join(homedir(), '.cache', 'michelangelo', 'kokoro');
  if (process.env.MGL_KOKORO_OFFLINE === '1') tf.env.allowRemoteModels = false;
  const id = process.env.MGL_KOKORO_MODEL || 'onnx-community/Kokoro-82M-v1.0-ONNX-timestamped';
  const dtype = process.env.MGL_KOKORO_DTYPE || 'fp32';
  try {
    return await mod.KokoroTTS.from_pretrained(id, { dtype, device: 'cpu' });
  } catch (e) {
    throw new Error(`cannot load Kokoro model ${id} (${dtype}) into ${tf.env.cacheDir}: ${String((e as Error)?.message ?? e).split('\n')[0]}${process.env.MGL_KOKORO_OFFLINE === '1' ? ' (MGL_KOKORO_OFFLINE=1: the model must already be in the cache)' : ' (the first run downloads it from huggingface.co)'}`);
  }
}

/** Speak one chunk: samples, plus word timings when the model reports durations and the words match. */
async function speakChunk(tts: Kokoro, text: string, voice: string, speed: number): Promise<{ samples: Float32Array; words?: Word[] }> {
  const model = tts.model;
  let captured: { ids: number[]; durations?: number[] } | undefined;
  tts.model = async (inputs) => {
    const r = await model(inputs);
    const ids = Array.from((inputs.input_ids as Tensor).data, Number);
    captured = { ids, ...(r.durations ? { durations: Array.from(r.durations.data, Number) } : {}) };
    return r;
  };
  try {
    const audio = await tts.generate(text, { voice, speed });
    if (audio.sampling_rate !== SAMPLE_RATE) return { samples: audio.audio };
    if (!captured?.durations || captured.durations.length !== captured.ids.length) return { samples: audio.audio };
    const tokens = captured.ids.map((id) => tts.tokenizer.decode([id]));
    const words = matchWords(text.split(' ').filter(Boolean), phonemeWords(tokens, captured.durations));
    return { samples: audio.audio, ...(words ? { words } : {}) };
  } finally {
    tts.model = model;
  }
}

export const kokoro: SpeakProvider = defineProvider({
  kind: 'speak',
  id: 'kokoro',
  describe: 'Natural neural text to speech (Kokoro-82M, English US/UK voices, af_heart default) with word timings from the model.',
  async voices() { return VOICES; },
  async speak({ text, voice, speed, out }) {
    const v = voice ?? 'af_heart';
    if (!VOICES.some((x) => x.id === v)) throw new Error(`kokoro has no voice "${v}"; use one of ${VOICES.slice(0, 6).map((x) => x.id).join(', ')} ... (kokoro-voice.voices lists all)`);
    const sp = Math.min(2, Math.max(0.5, speed ?? 1));
    const parts = chunks(text);
    if (!parts.length) throw new Error('nothing to say: the text has no words');
    const run = queue.then(async () => {
      const tts = await (loading ??= load().catch((e) => { loading = undefined; throw e; }));
      const pieces: Float32Array[] = [];
      const words: Word[] = [];
      let pos = 0, timed = true;
      for (const part of parts) {
        const r = await speakChunk(tts, part, v, sp);
        if (r.words) for (const w of r.words) words.push({ text: w.text, start: Math.round((pos + w.start) * 1000) / 1000, end: Math.round((pos + w.end) * 1000) / 1000 });
        else timed = false;
        pieces.push(r.samples);
        pos += r.samples.length / SAMPLE_RATE;
      }
      const all = new Float32Array(pieces.reduce((n, p) => n + p.length, 0));
      let o = 0;
      for (const p of pieces) { all.set(p, o); o += p.length; }
      const { writeFile } = await import('node:fs/promises');
      await writeFile(out, wav(toPcm16(all)));
      // all or nothing: partial timings would misplace the rest; without them Michelangelo aligns by sound
      return timed ? { words } : {};
    });
    queue = run.catch(() => undefined);
    return run;
  },
});

/** Lists the voices (also helps an agent pick one). */
const voicesCmd = defineCommand({
  op: 'kokoro-voice.voices', group: 'audio',
  doc: 'List the Kokoro voices for audio.speak voice=... (changes nothing).',
  schema: z.strictObject({}),
  example: {},
  apply(ctx) {
    ctx.out.voices = VOICES;
    ctx.summary(`kokoro voices (best first): ${VOICES.slice(0, 8).map((v) => `${v.id} (${v.describe})`).join('; ')}; ${VOICES.length - 8} more in --json. Use: audio.speak text="..." voice=af_heart`);
  },
});

export default definePlugin({ name: 'kokoro-voice', version: '1.0.0', providers: [kokoro], commands: [voicesCmd] });
