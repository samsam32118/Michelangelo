// Reference solution with plain ffmpeg: 3 s + 3 s at 30 fps with a 0.5 s crossfade centred on the cut (handles).
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ffmpeg } from '../../lib/index.mjs';

export async function solve(dir) {
  mkdirSync(join(dir, 'out'), { recursive: true });
  await ffmpeg(['-i', join(dir, 'master.mov'), '-i', join(dir, 'film24.mp4'), '-filter_complex',
    '[0:v]fps=30,trim=0:3.25,setpts=PTS-STARTPTS,format=yuv420p[a];[1:v]fps=30,trim=0:3.25,setpts=PTS-STARTPTS,format=yuv420p[b];[a][b]xfade=transition=fade:duration=0.5:offset=2.75,trim=0:6[v]',
    '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(dir, 'out/edit.mp4')]);
}
