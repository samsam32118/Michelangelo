// Reference solution with plain ffmpeg (validates the grader only).
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ff } from '../_lib/proc.mjs';
import { font, esc } from '../_lib/fixtures.mjs';
import { ROWS } from './setup.mjs';

export async function reference(dir) {
  mkdirSync(join(dir, 'out'), { recursive: true });
  const base = 850, W = 200;
  let fc = 'color=c=white:s=1920x1080:r=30:d=6[c0]';
  ROWS.forEach(([, v, col], i) => {
    const H = Math.round(600 * v / 60), x = 260 + i * 300, t0 = 0.3 + 0.5 * i;
    fc += `;color=c=0x${col.slice(1)}:s=${W}x${H}:r=30:d=6[b${i}];[c${i}][b${i}]overlay=x=${x}:y='${base}-${H}*min(max((t-${t0})/1.2\\,0)\\,1)':eval=frame[c${i + 1}]`;
  });
  const labels = ROWS.map(([l], i) => `drawtext=fontfile='${font()}':text='${esc(l)}':fontsize=44:fontcolor=0x222222:x=${260 + i * 300 + W / 2}-text_w/2:y=${base + 30}`).join(',');
  fc += `;[c${ROWS.length}]drawbox=x=0:y=${base}:w=1920:h=${1080 - base}:t=fill:c=white,${labels},format=yuv420p[v]`;
  await ff(['-filter_complex', fc, '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '16', '-t', '6', join(dir, 'out/chart.mp4')]);
}
