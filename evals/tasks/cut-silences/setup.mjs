import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as F from '../../lib/fixtures.mjs';
import { ffmpeg } from '../../lib/util.mjs';
import { probe } from '../../lib/probe.mjs';
import { silences } from '../../lib/audio.mjs';

const PHRASES = ['I grew up in a small town by the sea', 'My father fixed boats for a living', 'Every summer we sailed to the islands',
  'I learned to read the wind before I could read books', 'Later I moved to the city to study', 'It was loud and fast and wonderful',
  'But I always missed the sound of the waves', 'So now I build boats of my own'];
const GAPS = [1.0, 0.1, 1.6, 0.2, 2.0, 1.2, 1.8, 0.15, 1.5];

export async function setup(dir) {
  const tmp = mkdtempSync(join(tmpdir(), 'mgl-cut-'));
  try {
    const parts = [];
    for (let i = 0; i <= PHRASES.length; i++) {
      const sil = join(tmp, `s${i}.wav`);
      await F.tone(sil, `anullsrc=r=48000:cl=mono:d=${GAPS[i]}`);
      parts.push(sil);
      if (i < PHRASES.length) {
        const f = join(tmp, `p${i}.wav`);
        await F.speech(f, PHRASES[i]);
        parts.push(f);
      }
    }
    await ffmpeg([...parts.flatMap((f) => ['-i', f]), '-filter_complex', `${parts.map((_, i) => `[${i}:a]`).join('')}concat=n=${parts.length}:v=0:a=1`, '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', join(dir, 'interview.wav')]);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  const dur = (await probe(join(dir, 'interview.wav'))).duration;
  const sil = await silences(join(dir, 'interview.wav'), { db: -40, minDuration: 0.6 });
  const removable = sil.reduce((s, x) => s + Math.max(0, x.duration - 0.3), 0);
  return F.finish(dir, { duration: dur, silences: sil, expected: dur - removable, segments: await segments(dir) });
}

async function segments(dir) {
  // speech segments = complement of silences ≥ 0.25 s at -40 dB
  const sil = await silences(join(dir, 'interview.wav'), { db: -40, minDuration: 0.25 });
  const dur = (await probe(join(dir, 'interview.wav'))).duration;
  const segs = [];
  let t = 0;
  for (const s of sil) { if (s.start - t > 0.2) segs.push({ start: t, end: s.start }); t = s.end; }
  if (dur - t > 0.2) segs.push({ start: t, end: dur });
  return segs;
}
