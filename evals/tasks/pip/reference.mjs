// Reference solution with plain ffmpeg: cam at 480x270 with rounded corners and a soft shadow, bottom right.
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ffmpeg } from '../../lib/index.mjs';

export async function solve(dir) {
  mkdirSync(join(dir, 'out'), { recursive: true });
  const r = 24, rounded = `geq=lum='p(X,Y)':a='if(gt(abs(X-W/2),W/2-${r})*gt(abs(Y-H/2),H/2-${r}),if(lte(hypot(abs(X-W/2)-(W/2-${r}),abs(Y-H/2)-(H/2-${r})),${r}),255,0),255)'`;
  await ffmpeg(['-i', join(dir, 'screen.mp4'), '-i', join(dir, 'cam.mp4'), '-f', 'lavfi', '-i', 'color=black@0.5:size=520x310,format=rgba', '-filter_complex',
    `[1:v]scale=480:270,format=rgba,${rounded.replace("lum='p(X,Y)'", "r='r(X,Y)':g='g(X,Y)':b='b(X,Y)'")}[cam];[2:v]boxblur=12[sh];[0:v][sh]overlay=1380:770:shortest=1[bg];[bg][cam]overlay=1392:782:shortest=1,format=yuv420p[v]`,
    '-map', '[v]', '-t', '5', '-c:v', 'libx264', '-preset', 'ultrafast', join(dir, 'out/pip.mp4')]);
}
