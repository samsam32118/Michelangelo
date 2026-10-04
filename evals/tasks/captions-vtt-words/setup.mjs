import { join } from 'node:path';
import * as F from '../../lib/fixtures.mjs';

export const CUES = [
  { start: 0.5, end: 3.0, words: [['Every', 0.5], ['word', 1.1], ['lights', 1.6], ['up', 2.2]] },
  { start: 3.4, end: 6.0, words: [['as', 3.4], ['soon', 3.8], ['as', 4.1], ['it', 4.6], ['is', 4.9], ['spoken', 5.3]] },
  { start: 6.4, end: 9.0, words: [['then', 6.4], ['the', 6.9], ['next', 7.3], ['one', 7.9], ['follows', 8.3]] },
];
const ts = (s) => { const ms = Math.round(s * 1000); const p = (n, w = 2) => String(n).padStart(w, '0'); return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)}.${p(ms % 1000, 3)}`; };

export async function setup(dir) {
  const vtt = ['WEBVTT', '', ...CUES.flatMap((c) => [`${ts(c.start)} --> ${ts(c.end)}`, c.words.map(([w, t], i) => (i ? `<${ts(t)}>${w}` : w)).join(' '), ''])].join('\n');
  F.writeText(join(dir, 'words.vtt'), vtt);
  await F.speech(join(dir, 'media/vo.wav'), CUES.map((c) => c.words.map((w) => w[0]).join(' ')).join(' . '), { pad: 10 });
  F.writeProject(join(dir, 'clip.mgl.json'), {
    project: { name: 'Karaoke', platform: 'shorts' },
    assets: [{ id: 'vo-wav', src: 'media/vo.wav' }],
    comps: [{ id: 'main', size: [1080, 1920], fps: 30, length: 300 }],
    tracks: [{ id: 'BG', comp: 'main' }, { id: 'A1', comp: 'main', audio: true, bus: 'dialogue' }],
    clips: [{ id: 'bg', track: 'BG', at: 0, len: 300, color: '#1e2a4a' }, { id: 'vo', track: 'A1', at: 0, len: 300, asset: 'vo-wav' }],
  });
  return F.finish(dir, { cues: CUES.map((c) => ({ start: c.start, end: c.end, text: c.words.map((w) => w[0]).join(' '), words: c.words.map((w) => w[1]) })), bg: '#1e2a4a' });
}
