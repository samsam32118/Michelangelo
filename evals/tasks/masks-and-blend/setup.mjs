import { join } from 'node:path';
import * as F from '../../lib/fixtures.mjs';

export async function setup(dir) {
  await F.video(join(dir, 'media/base.mp4'), { src: 'testsrc2', d: 4, size: '1280x720' });
  await F.video(join(dir, 'media/bars.mp4'), { src: 'smptebars', d: 4, size: '1280x720' });
  // light leak: a slowly moving black → orange gradient (screen-blended it brightens, never darkens)
  await F.video(join(dir, 'media/leak.mp4'), { src: 'gradients=c0=0x000000:c1=0xa05000:x0=0:y0=0:x1=1280:y1=720:speed=0.01', d: 4, size: '1280x720' });
  F.writeProject(join(dir, 'layers.mgl.json'), {
    project: { name: 'Layers' },
    assets: [{ id: 'base-mp4', src: 'media/base.mp4' }, { id: 'bars-mp4', src: 'media/bars.mp4' }, { id: 'leak-mp4', src: 'media/leak.mp4' }],
    comps: [{ id: 'main', size: [1280, 720], fps: 30, length: 120 }],
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'V2', comp: 'main' }, { id: 'V3', comp: 'main' }],
    clips: [
      { id: 'base', track: 'V1', at: 0, len: 120, asset: 'base-mp4' },
      { id: 'top', track: 'V2', at: 0, len: 120, asset: 'bars-mp4' },
      { id: 'leak', track: 'V3', at: 0, len: 120, asset: 'leak-mp4', note: 'light leak' },
    ],
  });
  return F.finish(dir, {});
}
