// Reference solution with plain ffmpeg: the bed at -12 dB while the voice plays (6-20 s), unchanged elsewhere.
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ffmpeg, readSetup } from '../../lib/index.mjs';

export async function solve(dir) {
  const { info } = readSetup(dir);
  mkdirSync(join(dir, 'out'), { recursive: true });
  await ffmpeg(['-i', join(dir, 'media/bed.wav'), '-i', join(dir, 'media/vo.wav'), '-filter_complex',
    `[0:a]volume='if(between(t,${info.voStart - 0.2},${info.voEnd + 0.2}),0.25,1)':eval=frame[m];[1:a]atrim=0:${info.voEnd - info.voStart},adelay=${info.voStart * 1000}:all=1,aformat=channel_layouts=stereo[v];[m][v]amix=inputs=2:normalize=0:duration=first`,
    '-t', '30', '-ar', '48000', '-c:a', 'pcm_s16le', join(dir, 'out/pod.wav')]);
}
