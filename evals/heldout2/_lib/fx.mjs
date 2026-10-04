// Fixture helpers for setup.mjs (ffmpeg lavfi + flite only).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ffmpeg } from '../../lib/util.mjs';
export { finish, golden, writeProject, writeText, hasDrawtext, drawtext, font } from '../../lib/fixtures.mjs';

export const X264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '16', '-pix_fmt', 'yuv420p', '-g', '30'];
export const ensureDir = (f) => { mkdirSync(dirname(f), { recursive: true }); return f; };
const clean = (t) => t.replace(/[',:;\\%"]/g, ' ');

/**
 * Speech WAV (48 kHz mono) of `dur` seconds: each line [startSeconds, text, voice?] is spoken from its start time.
 * Lines must not overlap (they are mixed, so overlap just sums).
 */
export async function speechTrack(out, lines, dur, { gainDb = 0 } = {}) {
  ensureDir(out);
  const ins = lines.flatMap(([, text, voice]) => ['-f', 'lavfi', '-i', `flite=text='${clean(text)}':voice=${voice ?? 'kal'}`]);
  const fc = lines.map(([s], i) => `[${i}:a]aresample=48000,adelay=${Math.round(s * 1000)}:all=1[a${i}]`).join(';')
    + `;${lines.map((_, i) => `[a${i}]`).join('')}amix=inputs=${lines.length}:normalize=0:duration=longest,apad=whole_dur=${dur},atrim=0:${dur}${gainDb ? `,volume=${gainDb}dB` : ''}[o]`;
  await ffmpeg([...ins, '-filter_complex', fc, '-map', '[o]', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', out]);
  return out;
}

/** Mux a lavfi video graph (string for -f lavfi -i, plus optional -vf) with an audio file into an MP4. */
export async function videoWithAudio(out, { src, vf, audio, d, extraIn = [] }) {
  ensureDir(out);
  const args = ['-f', 'lavfi', '-i', src, ...extraIn];
  if (audio) args.push('-i', audio);
  const ai = 1 + extraIn.filter((x) => x === '-i').length;
  args.push(...(vf ? ['-filter_complex', vf, '-map', '[v]'] : ['-map', '0:v']));
  if (audio) args.push('-map', `${ai}:a`, '-c:a', 'aac', '-b:a', '192k');
  args.push(...X264, '-t', String(d), out);
  await ffmpeg(args);
  return out;
}

export function writeJson(file, obj) { ensureDir(file); writeFileSync(file, JSON.stringify(obj, null, 1)); return file; }
export { join };
