// Reference solution: re-split in plain JS, write SRT/VTT, burn in with ffmpeg/libass (validates the grader only).
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ff } from '../_lib/proc.mjs';
import { CUES, CLIP_AT } from './setup.mjs';

export function resplit(cues, clipAt, fps = 30) {
  const res = [];
  for (const c of cues) {
    const words = c.text.split(' '), t = (k) => (clipAt + c.at + (k < words.length ? c.words[k] : c.len)) / fps;
    const chunks = [];
    let lines = [''], first = 0;
    words.forEach((w, k) => {
      const cur = lines[lines.length - 1], cand = cur ? `${cur} ${w}` : w;
      if (cand.length <= 32) { lines[lines.length - 1] = cand; return; }
      if (lines.length < 2) { lines.push(w); return; }
      chunks.push({ lines, a: first, b: k }); lines = [w]; first = k;
    });
    chunks.push({ lines, a: first, b: words.length });
    for (const ch of chunks) res.push({ start: t(ch.a), end: t(ch.b), lines: ch.lines });
  }
  return res;
}

const stamp = (s, sep) => { const ms = Math.round(s * 1000), p = (n, w = 2) => String(n).padStart(w, '0'); return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)}${sep}${p(ms % 1000, 3)}`; };

export async function reference(dir) {
  mkdirSync(join(dir, 'out'), { recursive: true });
  const cues = resplit(CUES, CLIP_AT);
  writeFileSync(join(dir, 'out/vlog.srt'), cues.map((c, i) => `${i + 1}\n${stamp(c.start, ',')} --> ${stamp(c.end, ',')}\n${c.lines.join('\n')}\n`).join('\n'));
  writeFileSync(join(dir, 'out/vlog.vtt'), `WEBVTT\n\n${cues.map((c) => `${stamp(c.start, '.')} --> ${stamp(c.end, '.')}\n${c.lines.join('\n')}\n`).join('\n')}`);
  await ff(['-i', 'media/bg.mp4', '-i', 'vlog.wav', '-vf', "subtitles=out/vlog.srt:force_style='Fontsize=14,Outline=2,MarginV=60'", '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', 'out/vlog.mp4'], { cwd: dir });
}
