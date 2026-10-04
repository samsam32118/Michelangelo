import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { speechFit, audio, concatWav, finish } from '../_lib/fixtures.mjs';

export async function setup(dir) {
  const tmp = mkdtempSync(join(tmpdir(), 'mglh-ag-'));
  try {
    const parts = [
      await speechFit(join(tmp, 'a.wav'), 'Most people wait for one giant opportunity. I think that is a mistake.', 4, { voice: 'kal', lead: 0.1 }),
      await audio(join(tmp, 'b.wav'), 'anullsrc=r=48000:cl=mono', { d: 2 }),
      await speechFit(join(tmp, 'c.wav'), 'Place many small bets, learn fast, and double down on what works.', 4, { voice: 'kal', lead: 0.1 }),
      await audio(join(tmp, 'd.wav'), 'aevalsrc=0.501*sin(2*PI*300*t):s=48000:d=2'),
    ];
    await concatWav(join(dir, 'clip.wav'), parts);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  return finish(dir, { silence: [4, 6], bg: '#101828' });
}
