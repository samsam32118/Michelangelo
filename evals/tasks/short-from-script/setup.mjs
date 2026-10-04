import { join } from 'node:path';
import * as F from '../../lib/fixtures.mjs';
import { probe } from '../../lib/probe.mjs';

export const LINES = [
  'Want to focus better? Try these three tips.',
  'One. Put your phone in another room.',
  'Two. Work in short sprints with a timer.',
  'Three. Take a real break every hour.',
];

export async function setup(dir) {
  F.writeText(join(dir, 'script.txt'), LINES.join('\n') + '\n');
  await F.speech(join(dir, 'vo.wav'), LINES.join(' . . '), { pad: 0.3 });
  await F.video(join(dir, 'bg.mp4'), { src: 'testsrc2', d: 20 });
  const vo = await probe(join(dir, 'vo.wav'));
  // bg-only references, cover-fitted to 9:16, for the glyph-density comparison
  for (const t of [0.5, 7]) await F.framePng(join(dir, 'bg.mp4'), t, F.golden(dir, `bg_${t}.png`), 'scale=-2:1920,crop=1080:1920');
  return F.finish(dir, { voDuration: vo.duration, lines: LINES });
}
