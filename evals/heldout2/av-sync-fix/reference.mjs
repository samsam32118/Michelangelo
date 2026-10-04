// Reference with plain ffmpeg + hand-written project JSON (validates the grader only).
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ff, AAC } from '../_lib/h.mjs';
import { writeProject } from '../_lib/fx.mjs';
import { LAG } from './setup.mjs';

export async function reference(dir) {
  mkdirSync(join(dir, 'out'), { recursive: true });
  await ff(['-i', join(dir, 'interview.mp4'), '-filter_complex', `[0:a]atrim=start=${LAG},asetpts=PTS-STARTPTS,apad=whole_dur=12[a]`, '-map', '0:v', '-map', '[a]', '-c:v', 'copy', ...AAC, '-t', '12', join(dir, 'out/synced.mp4')]);
  writeProject(join(dir, 'synced.mgl.json'), {
    assets: [{ id: 'interview', src: 'interview.mp4' }],
    comps: [{ id: 'main', size: [1280, 720], fps: 30 }],
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'A1', comp: 'main', audio: true, bus: 'dialogue' }],
    clips: [
      { id: 'pic', track: 'V1', at: 0, len: 360, asset: 'interview', muted: true },
      { id: 'snd', track: 'A1', at: 0, len: 347, asset: 'interview', in: 13 },
    ],
  });
}
