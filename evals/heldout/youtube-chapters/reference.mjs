// Reference solution with plain ffmpeg + JSON edits (validates the grader only).
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ff } from '../_lib/proc.mjs';
import { font, esc } from '../_lib/fixtures.mjs';
import { readProject, writeProject } from '../_lib/project.mjs';
import { CHAPTERS } from './setup.mjs';

export async function reference(dir) {
  mkdirSync(join(dir, 'out'), { recursive: true });
  const pad = (n) => String(n).padStart(2, '0');
  writeFileSync(join(dir, 'out/chapters.txt'), CHAPTERS.map(([t, n]) => `${pad(Math.floor(t / 60))}:${pad(t % 60)} ${n}`).join('\n') + '\n');
  const p = readProject(join(dir, 'lesson.mgl.json'));
  p.markers = CHAPTERS.map(([t], i) => ({ id: `ch${i + 1}`, comp: 'main', at: t * 30 }));
  writeProject(join(dir, 'lesson.mgl.json'), p);
  const vf = CHAPTERS.map(([t, n]) => `drawbox=x=0:y=0:w=iw:h=ih:t=fill:c=black@0.6:enable='between(t,${t},${t + 2})',drawtext=fontfile='${font()}':text='${esc(n)}':fontsize=110:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:enable='between(t,${t},${t + 2})'`).join(',');
  await ff(['-i', join(dir, 'lesson.mp4'), '-vf', vf, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(dir, 'out/lesson.mp4')]);
}
