import { join } from 'node:path';
import * as F from '../../lib/fixtures.mjs';

export async function setup(dir) {
  await F.video(join(dir, 'media/vlog.mp4'), { src: 'testsrc2', d: 15, size: '1080x1920', vf: 'eq=brightness=-0.25:saturation=0.5' });
  F.writeProject(join(dir, 'vlog.mgl.json'), {
    project: { name: 'Day in the life', platform: 'shorts' },
    assets: [{ id: 'vlog-mp4', src: 'media/vlog.mp4' }],
    comps: [{ id: 'main', size: [1080, 1920], fps: 30, length: 450 }],
    tracks: [{ id: 'V1', comp: 'main' }],
    clips: [{ id: 'vlog', track: 'V1', at: 0, len: 450, asset: 'vlog-mp4' }],
  });
  return F.finish(dir, {});
}
