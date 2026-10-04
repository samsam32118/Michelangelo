import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { video, speechFit, concatWav, writeText, finish } from '../_lib/fixtures.mjs';

// Segment boundaries (s, on 30 fps frame boundaries) and who speaks.
export const BOUNDS = [0, 3.5, 6.0, 10.5, 13.0, 17.4, 20.0, 24.0];
const LINES = [
  'Welcome back to the show. Today I have a very special guest with me.',
  'Thanks for having me. It is great to be here.',
  'So tell us how you got started building small tools for other people.',
  'Honestly, it began as a weekend hobby.',
  'And when did you realise it could become a real business for you?',
  'When strangers started paying for it.',
  'That is a great answer. Let us talk about what comes next for you and the team.',
];

export async function setup(dir) {
  const A30 = (f) => `aevalsrc=0.0316*sin(2*PI*${f}*t):s=48000:d=24`; // -30 dBFS decoy tones
  await video(join(dir, 'host.mp4'), { src: 'testsrc2=size=1920x1080:rate=30', d: 24, vf: 'hue=h=220:s=1.5,colorchannelmixer=rr=0.05:rg=0.05:rb=0.05:gr=0.1:gg=0.15:gb=0.1:br=0.4:bg=0.4:bb=0.5,format=yuv420p', audio: A30(1000) });
  await video(join(dir, 'guest.mp4'), { src: 'smptebars=size=1920x1080:rate=30', d: 24, audio: A30(440) });
  const tmp = mkdtempSync(join(tmpdir(), 'mglh-pod-'));
  try {
    const segs = [];
    for (let i = 0; i < 7; i++) segs.push(await speechFit(join(tmp, `s${i}.wav`), LINES[i], BOUNDS[i + 1] - BOUNDS[i], { voice: i % 2 ? 'slt' : 'kal', lead: 0.15 }));
    await concatWav(join(dir, 'room.wav'), segs);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  const rows = BOUNDS.slice(0, -1).map((s, i) => `${s.toFixed(1)},${BOUNDS[i + 1].toFixed(1)},${i % 2 ? 'guest' : 'host'}`);
  writeText(join(dir, 'speakers.csv'), `start,end,speaker\n${rows.join('\n')}\n`);
  return finish(dir, { bounds: BOUNDS });
}
