import { join } from 'node:path';
import * as F from '../../lib/fixtures.mjs';
import { ffmpeg } from '../../lib/util.mjs';

export const DISC = { r: 120, x0: 200, vx: 300, y: 360 };

export async function setup(dir) {
  const d = 2 * DISC.r;
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x00ff00:size=1280x720:rate=30:duration=4', '-f', 'lavfi', '-i', `color=c=0xff00ff:size=${d}x${d}:rate=30:duration=4`,
    '-filter_complex', `[1:v]format=rgba,geq=r=255:g=0:b=255:a='if(lt(hypot(X-${DISC.r - 0.5},Y-${DISC.r - 0.5}),${DISC.r}),255,0)'[d];[0:v][d]overlay=x='${DISC.x0 - DISC.r}+t*${DISC.vx}':y=${DISC.y - DISC.r}:shortest=1`,
    ...F.X264, join(dir, 'presenter.mp4')]);
  // the "city": testsrc2 without any green-dominant pixels (desaturated, cool tint) so leftover green is detectable
  await F.video(join(dir, 'city.mp4'), { src: 'testsrc2', d: 4, size: '1280x720', vf: 'hue=s=0,colorchannelmixer=rr=0.9:gg=0.9:bb=1.0' });
  return F.finish(dir, { disc: DISC });
}
