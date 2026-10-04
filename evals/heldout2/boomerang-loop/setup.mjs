import { join } from 'node:path';
import { finish } from '../_lib/fx.mjs';
import { counterVideo } from '../../lib/counter.mjs';

export async function setup(dir) {
  await counterVideo(join(dir, 'jump.mp4'), { d: 4, fps: 30, w: 1080, h: 1080, bg: '0x3a6ea5' });
  return finish(dir, {});
}
