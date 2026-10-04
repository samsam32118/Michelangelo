// Fixture generation for setup.mjs: ffmpeg lavfi sources, flite speech, hand-written projects, input hashes.
import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ffmpeg, sha256, run, FFMPEG } from './util.mjs';
import { formatProject } from './project.mjs';

export const X264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p'];

let fontCache;
/** A TrueType font for drawtext (or null): FC font of "sans". */
export function font() {
  if (fontCache !== undefined) return fontCache;
  try { fontCache = execFileSync('fc-match', ['-f', '%{file}', 'sans:style=Bold'], { encoding: 'utf8' }).trim() || null; } catch { fontCache = null; }
  if (fontCache && !existsSync(fontCache)) fontCache = null;
  return fontCache;
}
let dt;
export async function hasDrawtext() {
  if (dt === undefined) { const r = await run(FFMPEG, ['-hide_banner', '-filters']); dt = /\bdrawtext\b/.test(r.stdout.toString()) && !!font(); }
  return dt;
}
/** A drawtext filter (or '' when unavailable); call after `await hasDrawtext()`. */
export function drawtext(text, opts = {}) {
  if (!dt) return '';
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/%/g, '\\%');
  const o = { fontsize: 48, fontcolor: 'white', x: '(w-text_w)/2', y: '(h-text_h)/2', ...opts };
  return `drawtext=fontfile='${font()}':text='${esc(text)}':${Object.entries(o).map(([k, v]) => `${k}=${v}`).join(':')}`;
}

export const ensureDir = (f) => { mkdirSync(dirname(f), { recursive: true }); return f; };

/** Generate a video from a lavfi source graph. */
export async function video(out, { src, d, size = '1920x1080', fps = 30, vf, codec = X264, audio } = {}) {
  ensureDir(out);
  const inputs = ['-f', 'lavfi', '-i', `${src}${src.includes('=') ? ':' : '='}size=${size}:rate=${fps}:duration=${d}`];
  if (audio) inputs.push('-f', 'lavfi', '-i', audio);
  await ffmpeg([...inputs, ...(vf ? ['-vf', vf] : []), ...codec, ...(audio ? ['-c:a', 'aac', '-b:a', '128k', '-shortest'] : ['-an']), '-t', String(d), out]);
  return out;
}

/** Flite speech, resampled to 48 kHz mono WAV, optionally padded with silence. */
export async function speech(out, text, { voice = 'kal', pad = 0, gainDb = 0 } = {}) {
  ensureDir(out);
  const af = [`aresample=48000`, ...(gainDb ? [`volume=${gainDb}dB`] : []), ...(pad ? [`apad=pad_dur=${pad}`] : [])];
  await ffmpeg(['-f', 'lavfi', '-i', `flite=text='${text.replace(/[',:;\\]/g, ' ')}':voice=${voice}`, '-af', af.join(','), '-ac', '1', '-c:a', 'pcm_s16le', out]);
  return out;
}

/** Audio from a lavfi graph (e.g. "sine=f=440:d=5") to WAV 48 kHz. */
export async function tone(out, graph, { channels = 1, af } = {}) {
  ensureDir(out);
  await ffmpeg(['-f', 'lavfi', '-i', graph, ...(af ? ['-af', af] : []), '-ar', '48000', '-ac', String(channels), '-c:a', 'pcm_s16le', out]);
  return out;
}

/** Write a project file in the one-entity-per-line layout. */
export function writeProject(file, p) {
  ensureDir(file);
  writeFileSync(file, formatProject({ michelangelo: 1, ...p }));
  return file;
}

export function writeText(file, text) { ensureDir(file); writeFileSync(file, text); return file; }

/** Every file under dir (relative), excluding node_modules and the golden dir. */
function listAll(dir) {
  const res = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.golden' || e.name === '.setup.json') continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.isFile()) res.push(relative(dir, p));
    }
  };
  walk(dir);
  return res;
}

/** Finish setup: hash every fixture file into dir/.setup.json along with grader info. Goldens live in dir/.golden/. */
export function finish(dir, info = {}) {
  const hashes = Object.fromEntries(listAll(dir).map((f) => [f, sha256(join(dir, f))]));
  writeFileSync(join(dir, '.setup.json'), JSON.stringify({ created: new Date().toISOString(), hashes, info }, null, 1));
  return { hashes, info };
}

export const golden = (dir, name) => ensureDir(join(dir, '.golden', name));

/** Extract a frame of a video to PNG with plain ffmpeg (autorotation on). */
export async function framePng(src, t, out, vf) {
  ensureDir(out);
  await ffmpeg(['-ss', String(t), '-i', src, '-frames:v', '1', ...(vf ? ['-vf', vf] : []), out]);
  return out;
}

export { statSync };
