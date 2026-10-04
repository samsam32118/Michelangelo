import { join } from 'node:path';
import * as F from '../../lib/fixtures.mjs';
import { probe } from '../../lib/probe.mjs';

/** The bed is a chord of high tones (above flite's 4 kHz speech band) so music and voice are measured separately. */
export const TONES = [4800, 6000, 7200];
const VO = 'Welcome to the show. Today we are talking about the history of radio and why it still matters. ' +
  'Radio was the first medium that brought live voices into every home. It shaped music and news for a century. ' +
  'Stay with us after the break for the full story.';

export async function setup(dir) {
  await F.tone(join(dir, 'media/bed.wav'), `aevalsrc='${TONES.map((f) => `0.09*sin(2*PI*${f}*t)`).join('+')}':s=48000:d=30`, { channels: 2 });
  await F.speech(join(dir, 'media/vo.wav'), VO, { gainDb: 6 });
  const vo = await probe(join(dir, 'media/vo.wav'));
  const voLen = Math.min(420, Math.floor(vo.duration * 30));
  F.writeProject(join(dir, 'pod.mgl.json'), {
    project: { name: 'Podcast intro' },
    assets: [{ id: 'vo-wav', src: 'media/vo.wav' }, { id: 'bed-wav', src: 'media/bed.wav' }],
    comps: [{ id: 'main', size: [1280, 720], fps: 30, length: 900 }],
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'A1', comp: 'main', audio: true, bus: 'dialogue' }, { id: 'A2', comp: 'main', audio: true, bus: 'music' }],
    clips: [
      { id: 'bg', track: 'V1', at: 0, len: 900, color: '#202020' },
      { id: 'vo', track: 'A1', at: 180, len: voLen, asset: 'vo-wav' },
      { id: 'bed', track: 'A2', at: 0, len: 900, asset: 'bed-wav' },
    ],
  });
  return F.finish(dir, { tones: TONES, voStart: 6, voEnd: 6 + voLen / 30 });
}
