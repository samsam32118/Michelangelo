// Reference solution with plain ffmpeg (validates the grader only).
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ff } from '../_lib/proc.mjs';
import { font, esc } from '../_lib/fixtures.mjs';

export async function reference(dir) {
  mkdirSync(join(dir, 'out'), { recursive: true });
  const m = (f) => join(dir, 'media', f);
  const title = `drawtext=fontfile='${font()}':text='${esc('Spring Collection')}':fontsize=96:fontcolor=white:borderw=6:bordercolor=black:x=(w-text_w)/2:y=900-text_h/2`;
  const fc = `[0:v]trim=end_frame=100,setpts=PTS-STARTPTS[a];[1:v]trim=end_frame=100,setpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=1:a=0,${title}[v]`;
  const inputs = ['-i', m('bars.mp4'), '-i', m('test.mp4'), '-i', m('tone.wav'), '-filter_complex', fc, '-map', '[v]', '-map', '2:a', '-t', '8'];
  await ff([...inputs, '-c:v', 'prores_ks', '-profile:v', '2', '-pix_fmt', 'yuv422p10le', '-c:a', 'pcm_s16le', join(dir, 'out/master.mov')]);
  await ff(['-i', join(dir, 'out/master.mov'), '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '4M', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-b:a', '128k', join(dir, 'out/web.webm')]);
  await ff(['-ss', '4', '-i', join(dir, 'out/master.mov'), '-frames:v', '1', '-vf', 'scale=1280:720', '-q:v', '3', join(dir, 'out/thumb.jpg')]);
}
