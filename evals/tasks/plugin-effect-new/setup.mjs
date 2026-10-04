import { join } from 'node:path';
import * as F from '../../lib/fixtures.mjs';

export async function setup(dir) {
  await F.video(join(dir, 'media/src.mp4'), { src: 'testsrc2', d: 3, size: '1280x720' });
  F.writeProject(join(dir, 'demo.mgl.json'), {
    project: { name: 'Posterize demo' },
    assets: [{ id: 'src-mp4', src: 'media/src.mp4' }],
    comps: [{ id: 'main', size: [1280, 720], fps: 30, length: 90 }],
    tracks: [{ id: 'V1', comp: 'main' }],
    clips: [{ id: 'shot', track: 'V1', at: 0, len: 90, asset: 'src-mp4' }],
  });
  return F.finish(dir, {});
}
