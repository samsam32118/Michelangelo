// Reference with plain ffmpeg + hand-written project JSON (validates the grader only).
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ff, X264, AAC } from '../_lib/h.mjs';
import { writeProject } from '../_lib/fx.mjs';

export async function reference(dir) {
  mkdirSync(join(dir, 'out'), { recursive: true });
  const fc = '[0:v]split[a][b];[b]crop=420:180:110:810,boxblur=30:3[bl];[a][bl]overlay=110:810[v]'
    + ";[0:a]volume=enable='between(t,3.2,3.8)':volume=0[m];sine=f=1000:d=8,volume=-6dB,volume=enable='not(between(t,3.2,3.8))':volume=0[s];[m][s]amix=inputs=2:normalize=0[a]";
  await ff(['-i', join(dir, 'street.mp4'), '-filter_complex', fc, '-map', '[v]', '-map', '[a]', '-t', '8', ...X264, ...AAC, join(dir, 'out/censored.mp4')]);
  await ff(['-f', 'lavfi', '-i', 'sine=f=1000:d=0.6,volume=-6dB', '-ar', '48000', join(dir, 'bleep.wav')]);
  writeProject(join(dir, 'censored.mgl.json'), {
    assets: [{ id: 'street', src: 'street.mp4' }, { id: 'bleep-wav', src: 'bleep.wav' }],
    comps: [{ id: 'main', size: [1920, 1080], fps: 30 }],
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'V2', comp: 'main' }, { id: 'A1', comp: 'main', audio: true }],
    clips: [
      { id: 'shot', track: 'V1', at: 0, len: 240, asset: 'street' },
      { id: 'redact', track: 'V2', at: 0, len: 240, adjustment: true, masks: [{ shape: 'rect', box: [110, 810, 420, 180] }], fx: [{ type: 'blur', radius: 30 }] },
      { id: 'bleep', track: 'A1', at: 96, len: 18, asset: 'bleep-wav' },
    ],
  });
}
