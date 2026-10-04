import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ff } from '../_lib/proc.mjs';
import { X264, finish } from '../_lib/fixtures.mjs';

// Lissajous path of the box centre (visits all four quadrants); same expressions drive ffmpeg's overlay.
export const PATH = { cx: '960+700*sin(2*PI*0.25*t+0.3)', cy: '540+320*sin(2*PI*0.375*t)' };
export const centre = (t) => [960 + 700 * Math.sin(2 * Math.PI * 0.25 * t + 0.3), 540 + 320 * Math.sin(2 * Math.PI * 0.375 * t)];

export async function setup(dir) {
  const fc = `[0:v]colorchannelmixer=rr=0.4:gg=0.4:bb=0.4[bg];[1:v]format=yuv420p[box];[bg][box]overlay=x='${PATH.cx}-60':y='${PATH.cy}-60':eval=frame,format=yuv420p[v]`;
  await ff(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=8', '-f', 'lavfi', '-i', 'color=c=0xff7a00:s=120x120:r=30:d=8', '-filter_complex', fc, '-map', '[v]', ...X264, '-t', '8', join(dir, 'drone.mp4')]);
  mkdirSync(join(dir, '.golden'), { recursive: true });
  // grader-only ground truth (frame, centre x, centre y)
  writeFileSync(join(dir, '.golden/track.json'), JSON.stringify(Array.from({ length: 240 }, (_, n) => [n, ...centre(n / 30).map((v) => Math.round(v * 10) / 10)])));
  return finish(dir, {});
}
