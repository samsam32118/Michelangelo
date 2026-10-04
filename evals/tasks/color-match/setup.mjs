import { join } from 'node:path';
import * as F from '../../lib/fixtures.mjs';

export async function setup(dir) {
  await F.video(join(dir, 'media/a.mp4'), { src: 'testsrc2', d: 4, size: '1280x720' });
  // shot B: the same footage, mirrored (so the two shots are told apart) and graded warm
  await F.video(join(dir, 'media/b.mp4'), { src: 'testsrc2', d: 4, size: '1280x720', vf: 'hflip,colorbalance=rs=0.25:rm=0.2:rh=0.1:bs=-0.25:bm=-0.2:bh=-0.1' });
  await F.framePng(join(dir, 'media/a.mp4'), 1, F.golden(dir, 'a.png'));
  await F.framePng(join(dir, 'media/a.mp4'), 1, F.golden(dir, 'b_neutral.png'), 'hflip');
  F.writeProject(join(dir, 'match.mgl.json'), {
    project: { name: 'Colour match' },
    assets: [{ id: 'shot-a', src: 'media/a.mp4' }, { id: 'shot-b', src: 'media/b.mp4' }],
    comps: [{ id: 'main', size: [1280, 720], fps: 30, length: 240 }],
    tracks: [{ id: 'V1', comp: 'main' }],
    clips: [{ id: 'a', track: 'V1', at: 0, len: 120, asset: 'shot-a' }, { id: 'b', track: 'V1', at: 120, len: 120, asset: 'shot-b' }],
  });
  return F.finish(dir, {});
}
