// Reference solution with plain ffmpeg: autorotated source from 2 s, 6 s, with a title, H.264.
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ffmpeg } from '../../lib/index.mjs';
import { hasDrawtext, drawtext } from '../../lib/fixtures.mjs';

export async function solve(dir) {
  mkdirSync(join(dir, 'out'), { recursive: true });
  const t = (await hasDrawtext()) ? `,${drawtext('Day 1', { fontsize: 120, fontcolor: 'white', borderw: 6, bordercolor: 'black', y: 1500 })}` : '';
  await ffmpeg(['-ss', '2', '-i', join(dir, 'phone.mov'), '-t', '6', '-vf', `scale=1080:1920${t}`, '-r', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(dir, 'out/day1.mp4')]);
}
