import { join } from 'node:path';
import { video, audio, finish } from '../_lib/fixtures.mjs';
import { writeProject } from '../_lib/project.mjs';

export async function setup(dir) {
  await video(join(dir, 'media/bars.mp4'), { src: 'smptebars=size=1920x1080:rate=25', d: 5 });
  await video(join(dir, 'media/test.mp4'), { src: 'testsrc2=size=1920x1080:rate=25', d: 5 });
  await audio(join(dir, 'media/tone.wav'), 'sine=f=660:r=48000:d=8', { af: 'volume=-6dB' });
  writeProject(join(dir, 'spot.mgl.json'), {
    project: { name: 'Spot' },
    assets: [{ id: 'bars-mp4', src: 'media/bars.mp4' }, { id: 'test-mp4', src: 'media/test.mp4' }, { id: 'tone-wav', src: 'media/tone.wav' }],
    comps: [{ id: 'main', size: [1920, 1080], fps: 25, length: 200 }],
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'T1', comp: 'main' }, { id: 'A1', comp: 'main', audio: true }],
    clips: [
      { id: 'bars', track: 'V1', at: 0, len: 100, asset: 'bars-mp4' },
      { id: 'test', track: 'V1', at: 100, len: 100, asset: 'test-mp4' },
      { id: 'title', track: 'T1', at: 0, len: 200, text: 'Spring Collection', style: { size: 96, color: '#ffffff', stroke: '#000000', strokeWidth: 6 }, y: 900 },
      { id: 'tone', track: 'A1', at: 0, len: 200, asset: 'tone-wav' },
    ],
  });
  return finish(dir, {});
}
