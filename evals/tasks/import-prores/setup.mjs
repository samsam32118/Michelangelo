import { join } from 'node:path';
import * as F from '../../lib/fixtures.mjs';

export async function setup(dir) {
  await F.video(join(dir, 'master.mov'), { src: 'testsrc', d: 5, codec: ['-c:v', 'prores_ks', '-profile:v', '2', '-pix_fmt', 'yuv422p10le'] });
  await F.video(join(dir, 'film24.mp4'), { src: 'smptebars', d: 5, fps: 24 });
  return F.finish(dir, {});
}
