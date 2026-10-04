import { join } from 'node:path';
import * as F from '../../lib/fixtures.mjs';

export async function setup(dir) {
  await F.video(join(dir, 'media/shotA.mp4'), { src: 'testsrc2', d: 8, size: '1280x720', audio: 'sine=f=440:sample_rate=48000:duration=8' });
  await F.video(join(dir, 'media/shotB.mp4'), { src: 'smptebars', d: 8, size: '1280x720', audio: 'sine=f=660:sample_rate=48000:duration=8' });
  F.writeProject(join(dir, 'dialog.mgl.json'), {
    project: { name: 'Dialogue' },
    assets: [{ id: 'shot-a', src: 'media/shotA.mp4' }, { id: 'shot-b', src: 'media/shotB.mp4' }],
    comps: [{ id: 'main', size: [1280, 720], fps: 30, length: 240 }],
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'A1', comp: 'main', audio: true, bus: 'dialogue' }],
    clips: [
      { id: 'a', track: 'V1', at: 0, len: 120, asset: 'shot-a', link: 'A', muted: true },
      { id: 'b', track: 'V1', at: 120, len: 120, asset: 'shot-b', in: 60, link: 'B', muted: true },
      { id: 'a-audio', track: 'A1', at: 0, len: 120, asset: 'shot-a', link: 'A' },
      { id: 'b-audio', track: 'A1', at: 120, len: 120, asset: 'shot-b', in: 60, link: 'B' },
    ],
  });
  return F.finish(dir, { cut: 120 });
}
