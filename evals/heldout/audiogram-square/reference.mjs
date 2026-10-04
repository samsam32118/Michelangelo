// Reference solution with plain ffmpeg (validates the grader only).
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ff } from '../_lib/proc.mjs';
import { font, esc } from '../_lib/fixtures.mjs';

export async function reference(dir) {
  mkdirSync(join(dir, 'out'), { recursive: true });
  const title = `drawtext=fontfile='${font()}':text='${esc('Small Bets, Big Wins')}':fontsize=72:fontcolor=white:x=(w-text_w)/2:y=120`;
  const fc = `color=c=0x101828:s=1080x1080:r=30:d=12[bg];[0:a]showwaves=s=1000x280:mode=cline:rate=30:colors=0x7dd3fc:scale=sqrt,format=rgba[w];[bg][w]overlay=40:400:shortest=1,${title},format=yuv420p[v]`;
  await ff(['-i', join(dir, 'clip.wav'), '-filter_complex', fc, '-map', '[v]', '-map', '0:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', '-t', '12', join(dir, 'out/audiogram.mp4')]);
}
