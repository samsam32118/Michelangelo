import { join } from 'node:path';
import { speechTrack, videoWithAudio, finish, ensureDir } from '../_lib/fx.mjs';
import { ffmpeg } from '../../lib/util.mjs';

export const D = 8;
export async function setup(dir) {
  const tmp = join(dir, '.golden', 'vo.wav');
  await speechTrack(tmp, [[0.2, 'Here is the finished grade. The skin tones are warmer now.'], [4.3, 'And the sky finally has some colour in it.']], D);
  await videoWithAudio(join(dir, 'after.mp4'), { src: `testsrc2=s=1920x1080:r=30:d=${D}`, vf: '[0:v]eq=saturation=1.4[v]', audio: tmp, d: D });
  ensureDir(join(dir, 'before.mp4'));
  await ffmpeg(['-f', 'lavfi', '-i', `testsrc2=s=1920x1080:r=30:d=${D}`, '-f', 'lavfi', '-i', `sine=f=440:d=${D},volume=-17dB`,
    '-vf', 'hue=s=0', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '16', '-pix_fmt', 'yuv420p', '-g', '30', '-c:a', 'aac', '-b:a', '160k', '-t', String(D), join(dir, 'before.mp4')]);
  return finish(dir, {});
}
