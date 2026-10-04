import { open } from 'michelangelo';
const p = await open('beat.mgl.json');
// Detected onsets of beat.wav: 0.5s..4.0s every 0.5s (120 BPM) = frames 15..120.
// The timeline starts on the first beat: the 0.5s silent lead-in of the audio is trimmed off.
const lead = 15;
const beats = [15, 30, 45, 60, 75, 90, 105, 120].map((f) => f - lead);
const end = 150 - lead; // rest of the audio
const r = await p.edit([
  { op: 'clip.trim', id: 'music', start: lead },
  { op: 'clip.move', id: 'music', at: 0 },
  ...beats.map((at, i) => ({ op: 'clip.move', id: `photo${i + 1}`, at })),
]);
console.log(r.summary.join('\n'));
