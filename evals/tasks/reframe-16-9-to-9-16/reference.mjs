// Reference solution: tall.mgl.json by JSON edit; the render made with ffmpeg (letterboxed, title in the safe zone).
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ffmpeg, readProject, formatProject } from '../../lib/index.mjs';
import { hasDrawtext, drawtext } from '../../lib/fixtures.mjs';

export async function solve(dir) {
  const p = readProject(join(dir, 'wide.mgl.json'));
  p.comps[0].size = [1080, 1920];
  p.clips.find((c) => c.id === 'title').y = 500;
  writeFileSync(join(dir, 'tall.mgl.json'), formatProject(p));
  mkdirSync(join(dir, 'out'), { recursive: true });
  const t = (await hasDrawtext()) ? `,${drawtext('Orbit', { fontsize: 100, fontcolor: '0xffd400', y: 450, enable: "'lt(t,3)'" })}` : ",drawbox=x=400:y=450:w=280:h=100:color=0xffd400:t=fill:enable='lt(t,3)'";
  await ffmpeg(['-i', join(dir, 'media/circle.mp4'), '-vf', `scale=1080:-2,pad=1080:1920:0:(oh-ih)/2:color=0x101018${t}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(dir, 'out/tall.mp4')]);
}
