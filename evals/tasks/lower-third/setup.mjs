import { join } from 'node:path';
import * as F from '../../lib/fixtures.mjs';

export async function setup(dir) {
  await F.video(join(dir, 'media/talk.mp4'), { src: 'testsrc2', d: 10, vf: 'eq=brightness=-0.2:saturation=0.6' });
  F.writeProject(join(dir, 'talk.mgl.json'), {
    project: { name: 'Interview', platform: 'youtube' },
    assets: [{ id: 'talk-mp4', src: 'media/talk.mp4' }],
    comps: [{ id: 'main', size: [1920, 1080], fps: 30, length: 300 }],
    tracks: [{ id: 'V1', comp: 'main' }],
    clips: [{ id: 'talk', track: 'V1', at: 0, len: 300, asset: 'talk-mp4' }],
  });
  return F.finish(dir, {});
}
