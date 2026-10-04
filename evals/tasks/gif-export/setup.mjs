import { join } from 'node:path';
import * as F from '../../lib/fixtures.mjs';

export async function setup(dir) {
  await F.video(join(dir, 'media/bg.mp4'), { src: 'testsrc2', d: 10, size: '1280x720' });
  F.writeProject(join(dir, 'demo.mgl.json'), {
    project: { name: 'Demo' },
    assets: [{ id: 'bg-mp4', src: 'media/bg.mp4' }],
    comps: [{ id: 'main', size: [1280, 720], fps: 30, length: 300 }],
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'T1', comp: 'main' }],
    clips: [
      { id: 'bg', track: 'V1', at: 0, len: 300, asset: 'bg-mp4' },
      { id: 'label', track: 'T1', at: 0, len: 300, text: 'Demo', style: { base: 'title', size: 60 }, y: 80, x: [[0, 200], [299, 1080]] },
    ],
  });
  return F.finish(dir, {});
}
