import { join } from 'node:path';
import * as F from '../../lib/fixtures.mjs';
import { ffmpeg } from '../../lib/util.mjs';

export async function setup(dir) {
  F.ensureDir(join(dir, 'media/circle.mp4'));
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x101018:size=1920x1080:rate=30:duration=6', '-f', 'lavfi', '-i', 'color=c=white:size=160x160:rate=30:duration=6',
    '-filter_complex', "[1:v]format=rgba,geq=r=255:g=255:b=255:a='if(lt(hypot(X-79.5,Y-79.5),80),255,0)'[d];[0:v][d]overlay=x='120+t*260':y=460:shortest=1",
    ...F.X264, join(dir, 'media/circle.mp4')]);
  F.writeProject(join(dir, 'wide.mgl.json'), {
    project: { name: 'Orbit', platform: 'youtube' },
    assets: [{ id: 'circle-mp4', src: 'media/circle.mp4' }],
    comps: [{ id: 'main', size: [1920, 1080], fps: 30, length: 180 }],
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'T1', comp: 'main' }],
    clips: [
      { id: 'shot', track: 'V1', at: 0, len: 180, asset: 'circle-mp4' },
      { id: 'title', track: 'T1', at: 0, len: 90, text: 'Orbit', style: { base: 'title', color: '#ffd400', size: 100 }, y: 150 },
    ],
  });
  return F.finish(dir, { title: 'Orbit' });
}
