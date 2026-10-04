// Reference solution with plain ffmpeg: 0-1 s at 1x, 1-3 s at 2x, hold source 3 s for 1 s, then 1x to source 8 s.
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ffmpeg, readProject, formatProject } from '../../lib/index.mjs';

export async function solve(dir) {
  mkdirSync(join(dir, 'out'), { recursive: true });
  await ffmpeg(['-i', join(dir, 'media/counter.mp4'), '-filter_complex', [
    '[0:v]split=4[s0][s1][s2][s3]',
    '[s0]trim=start_frame=0:end_frame=30,setpts=PTS-STARTPTS[a]',
    "[s1]trim=start_frame=30:end_frame=90,select='not(mod(n,2))',setpts=N/30/TB[b]",
    '[s2]trim=start_frame=90:end_frame=91,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop=29[c]',
    '[s3]trim=start_frame=91:end_frame=240,setpts=PTS-STARTPTS[d]',
    '[a][b][c][d]concat=n=4:v=1:a=0,fps=30[v]'].join(';'), '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(dir, 'out/run.mp4')]);
  // the edit as a project too (plain JSON): graders check the library's file carries it
  const p = readProject(join(dir, 'run.mgl.json'));
  p.clips = [
    { id: 'run', track: 'V1', at: 0, len: 30, asset: 'counter' },
    { id: 'fast', track: 'V1', at: 30, len: 30, asset: 'counter', in: 30, speed: 2 },
    { id: 'hold', track: 'V1', at: 60, len: 30, asset: 'counter', in: 90, speed: 0 },
    { id: 'rest', track: 'V1', at: 90, len: 150, asset: 'counter', in: 91 },
  ];
  writeFileSync(join(dir, 'run.mgl.json'), formatProject(p));
}
