import { swap, editText } from '../_lib/mutate.mjs';
import { ff } from '../_lib/proc.mjs';
import { loudness } from '../_lib/media.mjs';

const norm = (d, extra) => swap(d, 'out/clean.wav', async (_s, dst) => {
  const l = await loudness(`${d}/voice_hum.wav`);
  await ff(['-i', `${d}/voice_hum.wav`, '-af', [extra, `volume=${(-16 - l).toFixed(2)}dB`].filter(Boolean).join(','), '-c:a', 'pcm_s16le', dst]);
});
export const mutants = [
  { name: 'input only normalised', apply: (d) => norm(d) },
  { name: 'hum halved (6 dB notch)', apply: (d) => norm(d, 'equalizer=f=60:t=q:w=5:g=-6,equalizer=f=120:t=q:w=5:g=-6') },
  { name: 'muffled (lowpass 700 Hz + notches)', apply: (d) => swap(d, 'out/clean.wav', (s, dst) => ff(['-i', s, '-af', 'lowpass=f=700,lowpass=f=700,volume=6dB', '-c:a', 'pcm_s16le', dst])) },
  { name: 'project points at a processed copy', apply: (d) => editText(d, 'clean.mgl.json', (t) => t.replace('"src": "voice_hum.wav"', '"src": "out/clean.wav"')) },
];
