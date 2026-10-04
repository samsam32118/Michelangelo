import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { speechFit, finish } from '../_lib/fixtures.mjs';
import { ff } from '../_lib/proc.mjs';

const TEXT = 'Hi, I am recording this on a new lapel microphone in my home office. The idea for today is simple. '
  + 'I want to walk you through how I plan a week of work, which tools I use, and the one habit that changed everything for me. Let us get started.';
// 60 Hz at -18 dBFS peak plus 120, 180, 240 Hz at -24 dBFS peak.
const HUM = 'aevalsrc=0.1259*sin(2*PI*60*t)+0.0631*sin(2*PI*120*t)+0.0631*sin(2*PI*180*t)+0.0631*sin(2*PI*240*t):s=48000:d=15';

export async function setup(dir) {
  mkdirSync(join(dir, '.golden'), { recursive: true });
  const ref = join(dir, '.golden/voice_ref.wav'); // grader-only: never copied into the agent's sandbox
  const raw = join(dir, '.golden/speech.wav');
  await speechFit(raw, TEXT, 15, { voice: 'kal', lead: 0.5 });
  await ff(['-i', raw, '-af', 'volume=-6dB', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', ref]);
  await ff(['-i', ref, '-f', 'lavfi', '-i', HUM, '-filter_complex', '[0:a][1:a]amix=inputs=2:normalize=0:duration=first[a]', '-map', '[a]', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', join(dir, 'voice_hum.wav')]);
  rmSync(raw);
  return finish(dir, { lead: 0.5, hum: [60, 120, 180, 240] });
}
