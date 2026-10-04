import { join } from 'node:path';
import * as F from '../../lib/fixtures.mjs';

export async function setup(dir) {
  await F.video(join(dir, 'screen.mp4'), { src: 'testsrc2', d: 6 });
  await F.video(join(dir, 'cam.mp4'), { src: 'smptebars', d: 6 });
  return F.finish(dir, {});
}
