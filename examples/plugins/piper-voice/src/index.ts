import { definePlugin, defineProvider, defineCommand, z, type SpeakProvider } from 'michelangelo/plugin';

/**
 * A text-to-speech provider (plugin API 1.3) for `audio.speak`, using the Piper neural engine: offline, natural
 * voices, a few times faster than real time on a CPU. Piper and its voice models are NOT bundled or downloaded by
 * this plugin (the core never downloads models): put them in a folder yourself (README) and point $PIPER_HOME at it.
 *
 *   $PIPER_HOME/piper/piper            the binary from a Piper release (or set $PIPER_BIN, or have `piper` on PATH)
 *   $PIPER_HOME/<voice>.onnx           a voice model, with <voice>.onnx.json next to it
 *
 * $PIPER_HOME defaults to ./piper under the folder mgl runs in. A voice is the model's file name without `.onnx`
 * (e.g. en_US-ryan-high); the default is $PIPER_VOICE, else the first one by name.
 * Piper gives no word timings, so they are estimated: the voiced span is shared out by syllables, with extra time
 * after punctuation. ffmpeg ($MGL_FFMPEG, else `ffmpeg` on PATH) resamples to 48 kHz.
 * Node built-ins are loaded lazily, so loading the plugin costs nothing until it speaks.
 */

const RATE = 48000;
/** extra weight (in syllables) for the pause after a word, by its last punctuation */
const PAUSE: Record<string, number> = { '.': 1.6, '!': 1.6, '?': 1.6, ';': 0.8, ':': 0.8, ',': 0.8 };

export interface Voice { id: string; describe?: string; lang?: string }

/** Rough syllable count (vowel groups), at least 1; digits count as two each (they are read as words). */
export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z0-9]/g, '');
  const digits = (w.match(/[0-9]/g) ?? []).length;
  const groups = (w.replace(/[0-9]/g, '').replace(/e$/, '').match(/[aeiouy]+/g) ?? []).length;
  return Math.max(1, groups + digits * 2);
}

/** Word timings (seconds) for `text` spoken from `start` to `end`: by syllables, with pauses after punctuation. */
export function estimateWords(text: string, start: number, end: number): { text: string; start: number; end: number }[] {
  const list = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const voiced = list.map(syllables);
  const weight = list.map((w, i) => voiced[i]! + (PAUSE[/([.!?;:,])["')\]]*$/.exec(w)?.[1] ?? ''] ?? 0));
  // the pause after the last word is not part of the speech
  if (weight.length) weight[weight.length - 1] = voiced[voiced.length - 1]!;
  const total = weight.reduce((a, b) => a + b, 0) || 1;
  const ms = (t: number) => Math.round(t * 1000) / 1000;
  let t = start;
  return list.map((w, i) => {
    const d = (weight[i]! / total) * (end - start);
    const o = { text: w, start: ms(t), end: ms(t + d * (voiced[i]! / weight[i]!)) };
    t += d;
    return o;
  });
}

/** First and last sample above a small threshold (the voiced span). */
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

/** The folder holding piper/ and the voice models. */
export function piperHome(): string {
  const { resolve } = process.getBuiltinModule('node:path');
  return resolve(process.env.PIPER_HOME || 'piper');
}

/** The voices in $PIPER_HOME: every <name>.onnx, described from its <name>.onnx.json when that is readable. */
export function listVoices(home = piperHome()): Voice[] {
  const { readdirSync, readFileSync } = process.getBuiltinModule('node:fs');
  const { join } = process.getBuiltinModule('node:path');
  let files: string[];
  try { files = readdirSync(home); } catch { return []; }
  return files.filter((f) => f.endsWith('.onnx')).sort().map((f) => {
    const id = f.slice(0, -'.onnx'.length);
    try {
      const c = JSON.parse(readFileSync(join(home, `${f}.json`), 'utf8')) as { language?: { code?: string; name_english?: string }; dataset?: string; audio?: { quality?: string } };
      const lang = c.language?.code?.replace('_', '-');
      const describe = [c.language?.name_english, c.dataset, c.audio?.quality].filter(Boolean).join(', ');
      return { id, ...(describe ? { describe } : {}), ...(lang ? { lang } : {}) };
    } catch { return { id }; }
  });
}

async function run(cmd: string, args: string[], input: string | undefined, hint: string): Promise<Buffer> {
  const { spawn } = await import('node:child_process');
  return new Promise<Buffer>((res, rej) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [], err: Buffer[] = [];
    p.stdout.on('data', (d: Buffer) => out.push(d));
    p.stderr.on('data', (d: Buffer) => err.push(d));
    p.stdin.on('error', () => { /* the process ended before reading its input: `close` reports it */ });
    p.on('error', (e) => rej(new Error(`cannot run ${cmd}: ${e.message} (${hint})`)));
    p.on('close', (code) => (code === 0 ? res(Buffer.concat(out)) : rej(new Error(`${cmd} failed: ${Buffer.concat(err).toString().trim().split('\n').pop() ?? `exit ${code}`}`))));
    p.stdin.end(input ?? '');
  });
}

export const piper: SpeakProvider = defineProvider({
  kind: 'speak',
  id: 'piper',
  describe: 'Offline neural text to speech with Piper (natural voices; the binary and models live in $PIPER_HOME).',
  async voices() { return listVoices(); },
  async speak({ text, voice, speed, out }) {
    const { join } = await import('node:path');
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const home = piperHome();
    const known = listVoices(home);
    if (!known.length) throw new Error(`piper has no voices in ${home} (put <voice>.onnx and <voice>.onnx.json there, or set PIPER_HOME; see the plugin README)`);
    const v = voice ?? process.env.PIPER_VOICE ?? known[0]!.id;
    if (!known.some((k) => k.id === v)) throw new Error(`piper has no voice "${v}" in ${home} (voices: ${known.map((k) => k.id).join(', ')})`);
    const bundled = join(home, 'piper', 'piper');
    const bin = process.env.PIPER_BIN || (existsSync(bundled) ? bundled : 'piper');
    const sp = Math.min(2, Math.max(0.5, speed ?? 1));
    const line = text.replace(/\s+/g, ' ').trim();
    const dir = await mkdtemp(join(tmpdir(), 'piper-voice-'));
    try {
      const raw = join(dir, 'raw.wav');
      // length_scale stretches the speech: 1 / speed; one line of text on stdin is one utterance
      await run(bin, ['--model', join(home, `${v}.onnx`), '--length_scale', String(Math.round((1 / sp) * 1000) / 1000), '--sentence_silence', '0.2', '--output_file', raw], line + '\n', 'put the Piper release in $PIPER_HOME/piper/, or set PIPER_BIN');
      const ffmpeg = process.env.MGL_FFMPEG || 'ffmpeg';
      const bytes = await run(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', raw, '-af', `aresample=${RATE},highpass=f=70`, '-ac', '1', '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'], undefined, 'install ffmpeg, or set MGL_FFMPEG');
      const all = new Int16Array(bytes.length >> 1);
      for (let i = 0; i < all.length; i++) all[i] = bytes.readInt16LE(i * 2);
      // trim the silence around the speech, keeping 40 ms each side so nothing clicks
      const [a, b] = voicedSpan(all), pad = Math.round(0.04 * RATE);
      const pcm = all.subarray(Math.max(0, a - pad), Math.min(all.length, b + pad));
      await writeFile(out, wav(pcm));
      const lead = Math.min(a, pad) / RATE;
      return { words: estimateWords(line, lead, lead + (b - a) / RATE) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
});

const voicesCmd = defineCommand({
  op: 'piper-voice.voices', group: 'audio',
  doc: 'List the Piper voices found in $PIPER_HOME for audio.speak voice=... (changes nothing).',
  schema: z.strictObject({}),
  example: {},
  apply(ctx) {
    const home = piperHome(), voices = listVoices(home);
    ctx.out.voices = voices;
    ctx.out.home = home;
    ctx.summary(voices.length
      ? `piper voices in ${home}: ${voices.map((v) => v.id + (v.describe ? ` (${v.describe})` : '')).join('; ')}. Use: audio.speak text="..." voice=${voices[0]!.id}`
      : `no piper voices in ${home}: put <voice>.onnx and <voice>.onnx.json there, or set PIPER_HOME (see the plugin README).`);
  },
});

export default definePlugin({ name: 'piper-voice', version: '1.0.0', providers: [piper], commands: [voicesCmd] });
