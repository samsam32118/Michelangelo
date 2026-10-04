// Reference solution with plain ffmpeg: cam at 480x270 with rounded corners and a soft shadow, bottom right.
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ffmpeg, formatProject } from '../../lib/index.mjs';

export async function solve(dir) {
  mkdirSync(join(dir, 'out'), { recursive: true });
  const r = 24, rounded = `geq=lum='p(X,Y)':a='if(gt(abs(X-W/2),W/2-${r})*gt(abs(Y-H/2),H/2-${r}),if(lte(hypot(abs(X-W/2)-(W/2-${r}),abs(Y-H/2)-(H/2-${r})),${r}),255,0),255)'`;
  await ffmpeg(['-i', join(dir, 'screen.mp4'), '-i', join(dir, 'cam.mp4'), '-f', 'lavfi', '-i', 'color=black@0.5:size=520x310,format=rgba', '-filter_complex',
    `[1:v]scale=480:270,format=rgba,${rounded.replace("lum='p(X,Y)'", "r='r(X,Y)':g='g(X,Y)':b='b(X,Y)'")}[cam];[2:v]boxblur=12[sh];[0:v][sh]overlay=1380:770:shortest=1[bg];[bg][cam]overlay=1392:782:shortest=1,format=yuv420p[v]`,
    '-map', '[v]', '-t', '5', '-c:v', 'libx264', '-preset', 'ultrafast', join(dir, 'out/pip.mp4')]);
  // the edit as a project too (plain JSON): graders check the library's file carries it
  writeFileSync(join(dir, 'pip.mgl.json'), formatProject({ michelangelo: 1, project: { name: 'PiP' },
    assets: [{ id: 'screen', src: 'screen.mp4' }, { id: 'cam', src: 'cam.mp4' }],
    comps: [{ id: 'main', size: [1920, 1080], fps: 30, length: 150 }],
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'V2', comp: 'main' }],
    clips: [{ id: 'screen-shot', track: 'V1', at: 0, len: 150, asset: 'screen' }, { id: 'cam-shot', track: 'V2', at: 0, len: 150, asset: 'cam', scale: 0.25, x: 1632, y: 917 }] }));
}
