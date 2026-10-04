// Reference with plain ffmpeg + hand-written project JSON (validates the grader only).
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ff, AAC } from '../_lib/h.mjs';
import { writeProject } from '../_lib/fx.mjs';

export async function reference(dir) {
  mkdirSync(join(dir, 'out'), { recursive: true });
  await ff(['-i', join(dir, 'interview.mp4'), '-af', 'pan=stereo|c0=c0|c1=c0,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000', '-c:v', 'copy', ...AAC, join(dir, 'out/fixed.mp4')]);
  writeProject(join(dir, 'fixed.mgl.json'), {
    assets: [{ id: 'interview', src: 'interview.mp4' }],
    comps: [{ id: 'main', size: [1280, 720], fps: 30 }],
    tracks: [{ id: 'V1', comp: 'main' }],
    clips: [{ id: 'shot', track: 'V1', at: 0, len: 300, asset: 'interview', fx: [{ type: 'channels', map: 'left-to-both' }] }],
    buses: [{ id: 'master', loudness: -16 }],
  });
}
