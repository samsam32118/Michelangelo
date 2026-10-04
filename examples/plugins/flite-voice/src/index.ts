import { definePlugin, defineProvider, defineCommand, z, type SpeakProvider } from 'michelangelo/plugin';

/**
 * A text-to-speech provider (plugin API 1.3) for `audio.speak`, using the flite engine built into ffmpeg (the
 * `flite` lavfi source): no model downloads, fully offline and deterministic. Robotic but clear; good for drafts,
 * tests and evals. Text is spoken phrase by phrase (split at punctuation) so word timings follow the real
 * phrase lengths; inside a phrase the voiced span is shared out by syllables.
 *
 * ffmpeg: $MGL_FFMPEG, else `ffmpeg` on PATH (it must be built with --enable-libflite; `mgl doctor` says).
 * Node built-ins are imported lazily, so loading the plugin costs nothing until it speaks.
 */

export const VOICES = [
  { id: 'slt', describe: 'US English, female (default)', lang: 'en-US' },
  { id: 'kal', describe: 'US English, male, 8 kHz diphone (thin)', lang: 'en-US' },
  { id: 'rms', describe: 'US English, male', lang: 'en-US' },
  { id: 'awb', describe: 'Scottish English, male', lang: 'en-GB' },
];

const RATE = 48000;
/** silence after a phrase, by its last punctuation (seconds) */
const PAUSE: Record<string, number> = { '.': 0.32, '!': 0.32, '?': 0.32, ';': 0.2, ':': 0.2, ',': 0.12, '': 0.08 };

export interface Phrase { text: string; words: string[]; pause: number }

/** Split text into phrases at punctuation, keeping each word's punctuation. */
export function phrases(text: string): Phrase[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const out: Phrase[] = [];
  let cur: string[] = [];
  words.forEach((w, i) => {
    cur.push(w);
    const m = /([.!?;:,])["')\]]*$/.exec(w);
    if (m || i === words.length - 1) {
      out.push({ text: cur.join(' '), words: cur, pause: PAUSE[m?.[1] ?? ''] ?? 0.08 });
      cur = [];
    }
  });
  return out;
}

/** Rough syllable count (vowel groups), at least 1; digits count as two each (they are read as words). */
export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z0-9]/g, '');
  const digits = (w.match(/[0-9]/g) ?? []).length;
  const groups = (w.replace(/[0-9]/g, '').replace(/e$/, '').match(/[aeiouy]+/g) ?? []).length;
  return Math.max(1, groups + digits * 2);
}

/** First and last sample above a small threshold (the voiced span of a phrase). */
export function voicedSpan(pcm: Int16Array, threshold = 300): [number, number] {
  let a = 0, b = pcm.length - 1;
  while (a < pcm.length && Math.abs(pcm[a]!) < threshold) a++;
  while (b > a && Math.abs(pcm[b]!) < threshold) b--;
  return a >= pcm.length ? [0, pcm.length] : [a, b + 1];
}

/** A 16-bit mono PCM WAV file. */
export function wav(pcm: Int16Array, rate = RATE): Uint8Array {
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

/** Synthesise one phrase to 48 kHz mono PCM with ffmpeg's flite source. */
async function synth(text: string, voice: string, speed: number): Promise<Int16Array> {
  const { spawn } = await import('node:child_process');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'flite-voice-'));
  try {
    // a text file avoids escaping the text for the filter graph; the path itself needs ' and : and \ escaped
    const file = join(dir, 'text.txt');
    await writeFile(file, text);
    const esc = file.replace(/\\/g, '/').replace(/'/g, "\\'").replace(/:/g, '\\:');
    const chain = [`aresample=${RATE}`, 'highpass=f=70', ...(speed !== 1 ? [`atempo=${speed}`] : [])].join(',');
    const ffmpeg = process.env.MGL_FFMPEG || 'ffmpeg';
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', `flite=textfile='${esc}':voice=${voice}`, '-af', chain, '-ac', '1', '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'];
    const bytes = await new Promise<Buffer>((res, rej) => {
      const p = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const out: Buffer[] = [], err: Buffer[] = [];
      p.stdout.on('data', (d: Buffer) => out.push(d));
      p.stderr.on('data', (d: Buffer) => err.push(d));
      p.on('error', (e) => rej(new Error(`cannot run ${ffmpeg}: ${e.message} (install ffmpeg built with libflite, or set MGL_FFMPEG)`)));
      p.on('close', (code) => {
        const msg = Buffer.concat(err).toString().trim();
        if (code !== 0) rej(new Error(/flite/i.test(msg) && /not found|No such filter/i.test(msg) ? `${ffmpeg} has no flite source (needs --enable-libflite; mgl doctor checks it)` : `ffmpeg flite failed: ${msg.split('\n').pop()}`));
        else res(Buffer.concat(out));
      });
    });
    const pcm = new Int16Array(bytes.length >> 1);
    for (let i = 0; i < pcm.length; i++) pcm[i] = bytes.readInt16LE(i * 2);
    return pcm;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const flite: SpeakProvider = defineProvider({
  kind: 'speak',
  id: 'flite',
  describe: 'Offline text to speech with ffmpeg flite (voices slt, kal, rms, awb; English; robotic but clear).',
  async voices() { return VOICES; },
  async speak({ text, voice, speed, out }) {
    const v = voice ?? 'slt';
    if (!VOICES.some((x) => x.id === v)) throw new Error(`flite has no voice "${v}"; use one of ${VOICES.map((x) => x.id).join(', ')}`);
    const sp = Math.min(2, Math.max(0.5, speed ?? 1));
    const parts = phrases(text);
    if (!parts.length) throw new Error('nothing to say: the text has no words');
    const chunks: Int16Array[] = [];
    const words: { text: string; start: number; end: number }[] = [];
    const lead = Math.round(0.08 * RATE);
    chunks.push(new Int16Array(lead));
    let pos = lead;
    for (const ph of parts) {
      const pcm = await synth(ph.text, v, sp);
      const [a, b] = voicedSpan(pcm);
      const voiced = pcm.subarray(a, b);
      // share the voiced span out by syllables; each word ends a little before the next starts
      const syl = ph.words.map(syllables);
      const total = syl.reduce((n, s) => n + s, 0);
      let t = 0;
      ph.words.forEach((w, i) => {
        const d = (syl[i]! / total) * voiced.length;
        words.push({ text: w, start: Math.round(((pos + t) / RATE) * 1000) / 1000, end: Math.round(((pos + t + d * 0.92) / RATE) * 1000) / 1000 });
        t += d;
      });
      chunks.push(voiced);
      pos += voiced.length;
      const gap = new Int16Array(Math.round((ph.pause / sp) * RATE));
      chunks.push(gap);
      pos += gap.length;
    }
    // one level for the whole line: peak at -3 dBFS
    const all = new Int16Array(pos);
    let o = 0;
    for (const c of chunks) { all.set(c, o); o += c.length; }
    let peak = 1;
    for (let i = 0; i < all.length; i++) peak = Math.max(peak, Math.abs(all[i]!));
    const gain = (32767 * 10 ** (-3 / 20)) / peak;
    for (let i = 0; i < all.length; i++) all[i] = Math.round(all[i]! * gain);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(out, wav(all));
    return { words };
  },
});

/** Lists the voices (plugins need a kind the manifest knows; this command also helps an agent pick a voice). */
const voicesCmd = defineCommand({
  op: 'flite-voice.voices', group: 'audio',
  doc: 'List the flite voices for audio.speak voice=... (changes nothing).',
  schema: z.strictObject({}),
  example: {},
  apply(ctx) {
    ctx.out.voices = VOICES;
    ctx.summary(`flite voices: ${VOICES.map((v) => `${v.id} (${v.describe})`).join('; ')}. Use: audio.speak text="..." voice=slt`);
  },
});

export default definePlugin({ name: 'flite-voice', version: '1.0.0', providers: [flite], commands: [voicesCmd] });
