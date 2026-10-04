import { join } from 'node:path';
import * as F from '../../lib/fixtures.mjs';

export async function setup(dir) {
  await F.speech(join(dir, 'media/speech.wav'), 'This is a quiet recording. The levels are far too low for streaming, and we need to fix that before we publish it.', { gainDb: -14, pad: 3 });
  await F.tone(join(dir, 'media/tones.wav'), "aevalsrc='0.03*sin(2*PI*330*t)*(0.6+0.4*sin(2*PI*0.5*t))+0.02*sin(2*PI*495*t)':s=48000:d=12", { channels: 2 });
  F.writeProject(join(dir, 'mix.mgl.json'), {
    project: { name: 'Quiet mix' },
    assets: [{ id: 'speech-wav', src: 'media/speech.wav' }, { id: 'tones-wav', src: 'media/tones.wav' }],
    comps: [{ id: 'main', size: [1280, 720], fps: 30, length: 360 }],
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'A1', comp: 'main', audio: true, bus: 'dialogue' }, { id: 'A2', comp: 'main', audio: true, bus: 'music' }],
    clips: [
      { id: 'bg', track: 'V1', at: 0, len: 360, color: '#000000' },
      { id: 'speech', track: 'A1', at: 15, len: 300, asset: 'speech-wav' },
      { id: 'tones', track: 'A2', at: 0, len: 360, asset: 'tones-wav' },
    ],
  });
  return F.finish(dir, {});
}
