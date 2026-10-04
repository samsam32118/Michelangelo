// Reference solution: a white pill overlaid with the known path expressions (validates the grader only).
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ff } from '../_lib/proc.mjs';
import { font } from '../_lib/fixtures.mjs';
import { PATH } from './setup.mjs';

export async function reference(dir) {
  mkdirSync(join(dir, 'out'), { recursive: true });
  const pill = `color=c=white:s=220x64:r=30:d=8,drawtext=fontfile='${font()}':text=Package:fontsize=36:fontcolor=0x111111:x=(w-text_w)/2:y=(h-text_h)/2,format=yuva420p[p]`;
  const fc = `${pill};[0:v][p]overlay=x='${PATH.cx}-110':y='${PATH.cy}-144':eval=frame,format=yuv420p[v]`;
  await ff(['-i', join(dir, 'drone.mp4'), '-filter_complex', fc, '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-t', '8', join(dir, 'out/tracked.mp4')]);
}
