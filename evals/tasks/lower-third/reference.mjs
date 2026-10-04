// Reference solution: a hand-built lower third by JSON edit; the stills drawn with ffmpeg over the plain video.
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ffmpeg, readProject, formatProject } from '../../lib/index.mjs';
import { hasDrawtext, drawtext } from '../../lib/fixtures.mjs';

export async function solve(dir) {
  const p = readProject(join(dir, 'talk.mgl.json'));
  p.tracks.push({ id: 'L3', comp: 'main' });
  p.clips.push({ id: 'l3', track: 'L3', at: 60, len: 150, text: 'Dr. Ada Park — Neuroscientist', style: 'lower-third', anchor: [0, 0.5], x: 120, y: 900, animate: { in: 'slide-left', out: 'fade', by: 'all' } });
  writeFileSync(join(dir, 'talk.mgl.json'), formatProject(p));
  mkdirSync(join(dir, 'out'), { recursive: true });
  const box = 'drawbox=x=100:y=840:w=900:h=120:color=black@0.7:t=fill';
  const vf = (await hasDrawtext()) ? `${box},${drawtext('Dr. Ada Park - Neuroscientist', { fontsize: 52, fontcolor: 'white', x: 130, y: 875 })}` : `${box},drawbox=x=130:y=870:w=700:h=50:color=white:t=fill`;
  await ffmpeg(['-ss', '4', '-i', join(dir, 'media/talk.mp4'), '-frames:v', '1', '-vf', vf, join(dir, 'out/l3.png')]);
  await ffmpeg(['-ss', '1', '-i', join(dir, 'media/talk.mp4'), '-frames:v', '1', join(dir, 'out/before.png')]);
}
