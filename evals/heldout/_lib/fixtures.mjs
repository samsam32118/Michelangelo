// Fixture generation for setup.mjs: lavfi video/audio, flite speech, input hashes in dir/.setup.json.
import { mkdirSync, writeFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ff, sha256, probe } from './proc.mjs';

export const X264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p'];
export const ensureDir = (f) => { mkdirSync(dirname(f), { recursive: true }); return f; };
export const writeText = (f, s) => { writeFileSync(ensureDir(f), s); return f; };

let fontFile;
/** A bold sans TrueType font for drawtext (fixtures and references only). */
export function font() {
  if (fontFile === undefined) { try { fontFile = execFileSync('fc-match', ['-f', '%{file}', 'sans:style=Bold'], { encoding: 'utf8' }).trim(); } catch { fontFile = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'; } }
  return fontFile;
}
export const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/%/g, '\\%').replace(/,/g, '\\,');

/** Video from a lavfi source graph `src` (e.g. "testsrc2=size=1920x1080:rate=30"), d seconds, optional audio graph. */
export async function video(out, { src, d, vf, audio, codec = X264, acodec = ['-c:a', 'aac', '-b:a', '160k'] }) {
  ensureDir(out);
  const args = ['-f', 'lavfi', '-i', src, ...(audio ? ['-f', 'lavfi', '-i', audio] : [])];
  await ff([...args, ...(vf ? ['-vf', vf] : []), ...codec, ...(audio ? [...acodec, '-ar', '48000', '-ac', '1'] : ['-an']), '-t', String(d), out]);
  return out;
}

/** Flite speech as 48 kHz mono float samples written to a WAV; returns its duration in seconds. */
export async function speech(out, text, { voice = 'kal', af } = {}) {
  ensureDir(out);
  const tmp = mkdtempSync(join(tmpdir(), 'mgl-flite-'));
  try {
    const tf = join(tmp, 't.txt');
    writeFileSync(tf, text);
    await ff(['-f', 'lavfi', '-i', `flite=textfile=${tf}:voice=${voice}`, '-af', ['aresample=48000', af].filter(Boolean).join(','), '-ac', '1', '-c:a', 'pcm_s16le', out]);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  return (await probe(out)).duration;
}

/** Audio from a lavfi graph to a 48 kHz mono 16-bit WAV. */
export async function audio(out, graph, { af, d } = {}) {
  ensureDir(out);
  await ff(['-f', 'lavfi', '-i', graph, ...(af ? ['-af', af] : []), ...(d ? ['-t', String(d)] : []), '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', out]);
  return out;
}

function listFiles(dir) {
  const res = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', '.golden', '.setup.json', '.mgl'].includes(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.isFile()) res.push(relative(dir, p));
    }
  };
  walk(dir);
  return res.sort();
}

/** Hash every fixture into dir/.setup.json with grader info (stashed by the runner while the agent works). */
export function finish(dir, info = {}) {
  const hashes = Object.fromEntries(listFiles(dir).map((f) => [f, sha256(join(dir, f))]));
  writeFileSync(join(dir, '.setup.json'), JSON.stringify({ hashes, info }, null, 1));
  return { files: Object.keys(hashes), info };
}

/** Speech fitted into exactly `len` seconds (sped up if needed, then padded with digital silence). */
export async function speechFit(out, text, len, { voice = 'kal', lead = 0 } = {}) {
  const raw = out.replace(/\.wav$/, '.raw.wav');
  const d = await speech(raw, text, { voice });
  const room = len - lead - 0.2, tempo = d > room ? Math.min(2, d / room) : 1;
  const n = Math.round(len * 48000);
  const fc = `anullsrc=r=48000:cl=mono,atrim=end_sample=${Math.max(1, Math.round(lead * 48000))}[z];[0:a]aresample=48000,${tempo > 1 ? `atempo=${tempo.toFixed(4)},` : ''}asetpts=N/SR/TB[s];[z][s]concat=n=2:v=0:a=1,apad,atrim=end_sample=${n},asetpts=N/SR/TB[a]`;
  await ff(['-i', raw, '-filter_complex', fc, '-map', '[a]', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', out]);
  rmSync(raw, { force: true });
  return out;
}

/** Concatenate WAV files (same format) into one. */
export async function concatWav(out, files) {
  ensureDir(out);
  const inputs = files.flatMap((f) => ['-i', f]);
  await ff([...inputs, '-filter_complex', `${files.map((_, i) => `[${i}:a]`).join('')}concat=n=${files.length}:v=0:a=1[a]`, '-map', '[a]', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', out]);
  return out;
}
