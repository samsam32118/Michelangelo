// Reference solution: notch filters + gain with plain ffmpeg, hand-written project (validates the grader only).
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { ff } from '../_lib/proc.mjs';
import { loudness } from '../_lib/media.mjs';
import { writeProject } from '../_lib/project.mjs';

export async function reference(dir) {
  mkdirSync(join(dir, 'out'), { recursive: true });
  const notch = [60, 120, 180, 240].flatMap((f) => [`bandreject=f=${f}:width_type=q:w=8`, `bandreject=f=${f}:width_type=q:w=8`]).join(',');
  const tmp = join(dir, 'out/.notched.wav');
  await ff(['-i', join(dir, 'voice_hum.wav'), '-af', notch, '-ar', '48000', '-ac', '1', '-c:a', 'pcm_f32le', tmp]);
  let gain = -16 - await loudness(tmp);
  for (let pass = 0; pass < 3; pass++) { // gain, peak limiter, then correct the gain for what the limiter took
    await ff(['-i', tmp, '-af', `volume=${gain.toFixed(2)}dB,alimiter=limit=0.9:level=false:latency=1`, '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', join(dir, 'out/clean.wav')]);
    gain += -16 - await loudness(join(dir, 'out/clean.wav'));
  }
  rmSync(tmp);
  writeProject(join(dir, 'clean.mgl.json'), {
    assets: [{ id: 'voice-hum', src: 'voice_hum.wav' }],
    comps: [{ id: 'main', size: [1920, 1080], fps: 30, length: 450 }],
    tracks: [{ id: 'A1', comp: 'main', audio: true }],
    clips: [{ id: 'voice', track: 'A1', at: 0, len: 450, asset: 'voice-hum', fx: [{ type: 'hum-notch', freqs: [60, 120, 180, 240] }] }],
  });
}
