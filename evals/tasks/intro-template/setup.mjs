import { join } from 'node:path';
import * as F from '../../lib/fixtures.mjs';

export async function setup(dir) {
  await F.video(join(dir, 'cook.mp4'), { src: 'testsrc2', d: 8 });
  return F.finish(dir, {});
}
