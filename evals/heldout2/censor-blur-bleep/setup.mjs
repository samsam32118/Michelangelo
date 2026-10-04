import { join } from 'node:path';
import { speechTrack, videoWithAudio, finish, hasDrawtext, drawtext } from '../_lib/fx.mjs';

export const D = 8;
export const TAG = [120, 820, 400, 160];
export async function setup(dir) {
  await hasDrawtext();
  const vo = join(dir, '.golden', 'vo.wav');
  await speechTrack(vo, [[0.3, 'So I walked in there and I told him that is'], [3.0, 'bloody'], [4.0, 'ridiculous, and he just laughed at me.']], D);
  const vf = ['[0:v]drawbox=x=120:y=820:w=400:h=160:color=white:t=fill',
    drawtext('J. RIVERA', { fontsize: 52, fontcolor: 'black', x: 150, y: 840 }),
    drawtext('CALL 555-0142', { fontsize: 44, fontcolor: 'black', x: 150, y: 905 }),
    'drawbox=x=140:y=895:w=360:h=4:color=black:t=fill'].filter(Boolean).join(',') + '[v]';
  await videoWithAudio(join(dir, 'street.mp4'), { src: `testsrc2=s=1920x1080:r=30:d=${D}`, vf, audio: vo, d: D });
  return finish(dir, {});
}
