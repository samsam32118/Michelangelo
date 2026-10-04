import { join } from 'node:path';
import * as F from '../../lib/fixtures.mjs';

const TEXTS = ['Welcome back to the channel', 'Today we talk about sleep', 'Most adults need seven hours', 'But few of us get them',
  'Light in the evening is the enemy', 'Dim your screens after sunset', 'Now for the second part', 'Caffeine stays in your body',
  'for up to ten hours', 'So stop coffee at noon', 'Keep the bedroom cool', 'Thanks for watching'];
const STARTS = [1.0, 3.5, 6.0, 8.4, 10.6, 12.2, 16.1, 18.5, 20.9, 23.0, 25.3, 27.4];

const ts = (s) => { const ms = Math.round(s * 1000); const p = (n, w = 2) => String(n).padStart(w, '0'); return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`; };

export async function setup(dir) {
  await F.video(join(dir, 'media/talk.mp4'), { src: 'testsrc2', d: 30, vf: 'eq=brightness=-0.15' });
  const cues = STARTS.map((s, i) => ({ start: s, end: Math.round((s + (i === 5 ? 1.8 : 2.1)) * 1000) / 1000, text: TEXTS[i] }));
  F.writeText(join(dir, 'talk.srt'), cues.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text}\n`).join('\n'));
  F.writeProject(join(dir, 'talk.mgl.json'), {
    project: { name: 'Sleep talk' },
    assets: [{ id: 'talk-mp4', src: 'media/talk.mp4' }],
    comps: [{ id: 'main', size: [1920, 1080], fps: 30, length: 900 }],
    tracks: [{ id: 'V1', comp: 'main' }],
    clips: [{ id: 'talk', track: 'V1', at: 0, len: 900, asset: 'talk-mp4' }],
  });
  return F.finish(dir, { cues, gap: 15.0 });
}
