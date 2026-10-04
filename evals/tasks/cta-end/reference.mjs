// Reference solution: a Subscribe clip with an outBack pop by JSON edit; the draft drawn with ffmpeg (half size).
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ffmpeg, readProject, formatProject } from '../../lib/index.mjs';

export async function solve(dir) {
  const p = readProject(join(dir, 'vlog.mgl.json'));
  p.tracks.push({ id: 'CTA', comp: 'main' });
  p.clips.push({ id: 'cta', track: 'CTA', at: 360, len: 90, text: 'Subscribe', style: 'cta', y: 1200, scale: [[0, 0.3, 'outBack'], [12, 1]] });
  writeFileSync(join(dir, 'vlog.mgl.json'), formatProject(p));
  mkdirSync(join(dir, 'out'), { recursive: true });
  await ffmpeg(['-i', join(dir, 'media/vlog.mp4'), '-vf', "scale=540:960,drawbox=x=120:y=560:w=300:h=80:color=red:t=fill:enable='gte(t,12)'", '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(dir, 'out/vlog.mp4')]);
}
