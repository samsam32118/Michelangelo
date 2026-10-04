import { join } from 'node:path';
import * as F from '../../lib/fixtures.mjs';
import { ffmpeg } from '../../lib/util.mjs';

export const COLORS = ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#46f0f0', '#f032e6'];

export async function setup(dir) {
  await F.hasDrawtext();
  for (let i = 0; i < 8; i++) {
    const out = F.ensureDir(join(dir, `photos/photo${i + 1}.png`));
    const txt = F.drawtext(String(i + 1), { fontsize: 200, fontcolor: 'white', borderw: 6, bordercolor: 'black' });
    await ffmpeg(['-f', 'lavfi', '-i', `color=c=0x${COLORS[i].slice(1)}:size=1080x1080`, '-frames:v', '1', ...(txt ? ['-vf', txt] : []), out]);
  }
  // 120 BPM click track: 8 beats from 0.5 s to 4.0 s (short 1 kHz clicks), 5 s long
  const clicks = Array.from({ length: 8 }, (_, i) => `between(t,${0.5 + i * 0.5},${0.5 + i * 0.5 + 0.03})`).join('+');
  await F.tone(join(dir, 'beat.wav'), `aevalsrc='0.8*sin(2*PI*1000*t)*(${clicks})':s=48000:d=5`);
  return F.finish(dir, { colors: COLORS, beats: Array.from({ length: 8 }, (_, i) => 0.5 + i * 0.5) });
}
