import { join } from 'node:path';
import { speechTrack, finish, ensureDir, X264 } from '../_lib/fx.mjs';
import { ffmpeg } from '../../lib/util.mjs';

export const D = 10;
export async function setup(dir) {
  const lav = join(dir, '.golden', 'lav.wav');
  await speechTrack(lav, [[0.3, 'Thanks for having me. We started the company four years ago.'], [5.0, 'Since then the team has grown from three people to forty.']], D, { gainDb: -8 });
  ensureDir(join(dir, 'interview.mp4'));
  const fc = `[1:a]asplit[l][c];[c]adelay=15,volume=-20dB[cs];anoisesrc=color=brown:amplitude=0.05:d=${D}:r=48000[n];sine=f=3150:d=${D}:sample_rate=48000,volume=-12dB[w];`
    + `[cs][n][w]amix=inputs=3:normalize=0:duration=first[r];[l][r]join=inputs=2:channel_layout=stereo[a]`;
  await ffmpeg(['-f', 'lavfi', '-i', `testsrc2=s=1280x720:r=30:d=${D}`, '-i', lav, '-filter_complex', fc, '-map', '0:v', '-map', '[a]', ...X264, '-c:a', 'aac', '-b:a', '192k', '-t', String(D), join(dir, 'interview.mp4')]);
  return finish(dir, {});
}
