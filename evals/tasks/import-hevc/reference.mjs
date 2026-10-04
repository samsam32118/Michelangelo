// Reference solution with plain ffmpeg: autorotated source from 2 s, 6 s, with a title, H.264.
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ffmpeg, formatProject } from '../../lib/index.mjs';
import { hasDrawtext, drawtext } from '../../lib/fixtures.mjs';

export async function solve(dir) {
  mkdirSync(join(dir, 'out'), { recursive: true });
  const t = (await hasDrawtext()) ? `,${drawtext('Day 1', { fontsize: 120, fontcolor: 'white', borderw: 6, bordercolor: 'black', y: 1500 })}` : '';
  await ffmpeg(['-ss', '2', '-i', join(dir, 'phone.mov'), '-t', '6', '-vf', `scale=1080:1920${t}`, '-r', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(dir, 'out/day1.mp4')]);
  // the edit as a project too (plain JSON): graders check the library's file carries it
  writeFileSync(join(dir, 'day1.mgl.json'), formatProject({ michelangelo: 1, project: { name: 'Day 1' },
    assets: [{ id: 'phone', src: 'phone.mov' }],
    comps: [{ id: 'main', size: [1080, 1920], fps: 30, length: 180 }],
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'T1', comp: 'main' }],
    clips: [{ id: 'phone-shot', track: 'V1', at: 0, len: 180, asset: 'phone', in: 60, fit: 'cover' }, { id: 'title', track: 'T1', at: 0, len: 180, text: 'Day 1', style: 'title' }] }));
}
