import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { video, audio, speechFit, concatWav, finish } from '../_lib/fixtures.mjs';
import { writeProject } from '../_lib/project.mjs';

export const CLIP_AT = 30; // captions clip starts at 1 s; cue times are local to it
const TEXTS = [
  'Good morning everyone, it is day three of the trip and we are finally heading up into the mountains, the weather looks perfect for a long hike today.',
  'First stop is a tiny bakery the locals told us about, apparently they sell out of cinnamon rolls before nine, so we had to leave the hotel super early.',
  'Okay so the trail starts right behind the village church, it is about eight kilometres to the lake and the guide says the last part is really steep, wish us luck.',
  'We made it halfway and honestly my legs are already complaining, but look at this view over the valley, totally worth every single step.',
  'Lunch at the top, sandwiches and the cinnamon rolls we saved, the lake is freezing but a few brave people are swimming anyway, not me though.',
  'That is it for today, thanks for watching, let me know in the comments where we should go next and I will see you tomorrow.',
];
const SPANS = [[15, 186], [210, 180], [400, 210], [620, 165], [795, 195], [1000, 165]];

/** Word start offsets (frames from the cue start) proportional to character position. */
const wordsOf = (text, len) => {
  const out = [];
  let pos = 0;
  for (const w of text.split(' ')) { out.push(Math.round(pos / text.length * (len - 12))); pos += w.length + 1; }
  for (let i = 1; i < out.length; i++) if (out[i] <= out[i - 1]) out[i] = out[i - 1] + 1;
  return out;
};
export const CUES = TEXTS.map((text, i) => ({ id: `cue${i + 1}`, clip: 'subs', at: SPANS[i][0], len: SPANS[i][1], text, words: wordsOf(text, SPANS[i][1]) }));

export async function setup(dir) {
  await video(join(dir, 'media/bg.mp4'), { src: 'testsrc2=size=1080x1920:rate=30', d: 40, codec: ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p'] });
  const tmp = mkdtempSync(join(tmpdir(), 'mglh-cap-'));
  try {
    const parts = [];
    let t = 0;
    for (const [i, c] of CUES.entries()) {
      const s = (CLIP_AT + c.at) / 30, e = (CLIP_AT + c.at + c.len) / 30;
      if (s > t) parts.push(await audio(join(tmp, `g${i}.wav`), 'anullsrc=r=48000:cl=mono', { d: (s - t).toFixed(4) }));
      parts.push(await speechFit(join(tmp, `s${i}.wav`), c.text, e - s, { voice: 'slt', lead: 0.1 }));
      t = e;
    }
    parts.push(await audio(join(tmp, 'end.wav'), 'anullsrc=r=48000:cl=mono', { d: (40 - t).toFixed(4) }));
    await concatWav(join(dir, 'vlog.wav'), parts);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  writeProject(join(dir, 'vlog.mgl.json'), {
    project: { name: 'Vlog day 3' },
    assets: [{ id: 'bg-mp4', src: 'media/bg.mp4' }, { id: 'vlog-wav', src: 'vlog.wav' }],
    comps: [{ id: 'main', size: [1080, 1920], fps: 30, length: 1200 }],
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'T1', comp: 'main' }, { id: 'A1', comp: 'main', audio: true }],
    clips: [
      { id: 'bg', track: 'V1', at: 0, len: 1200, asset: 'bg-mp4' },
      { id: 'subs', track: 'T1', at: CLIP_AT, len: 1170, captions: true, style: 'caption' },
      { id: 'vo', track: 'A1', at: 0, len: 1200, asset: 'vlog-wav' },
    ],
    cues: CUES,
  });
  return finish(dir, { clipAt: CLIP_AT, cues: CUES });
}
