import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as F from '../../lib/fixtures.mjs';
import { ffmpeg } from '../../lib/util.mjs';
import { probe } from '../../lib/probe.mjs';

/** Shots (seconds); the cuts land off any 0.5 s beat grid so a beat-heavy bed cannot hit them by chance. */
const SHOTS = [['testsrc2', 4.2], ['smptebars', 4.9], ['rgbtestsrc', 4.6], ['testsrc', 6.3]];
const TITLE = { text: 'Summer Trip', start: 1.3, end: 3.6 };
const VO = { text: 'Every shot tells a story.', start: 10.2 };

export async function setup(dir) {
  const fr = (s) => Math.round(s * 30);
  for (const [i, [src, d]] of SHOTS.entries()) await F.video(join(dir, `media/shot${i + 1}.mp4`), { src, d, size: '1280x720' });
  await F.speech(join(dir, 'media/vo.wav'), VO.text, { gainDb: 4 });
  const voDur = (await probe(join(dir, 'media/vo.wav'))).duration;
  const cuts = [];
  let t = 0;
  for (const [, d] of SHOTS.slice(0, -1)) { t += d; cuts.push(Math.round(t * 1000) / 1000); }
  let at = 0;
  const clips = SHOTS.map(([, d], i) => { const c = { id: `shot${i + 1}`, track: 'V1', at, len: fr(d), asset: `shot${i + 1}-mp4` }; at += c.len; return c; });
  F.writeProject(join(dir, 'edit.mgl.json'), {
    project: { name: 'Summer trip' },
    assets: [...SHOTS.map((_, i) => ({ id: `shot${i + 1}-mp4`, src: `media/shot${i + 1}.mp4` })), { id: 'vo-wav', src: 'media/vo.wav' }],
    comps: [{ id: 'main', size: [1280, 720], fps: 30, length: 600 }],
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'T1', comp: 'main' }, { id: 'A1', comp: 'main', audio: true, bus: 'dialogue' }],
    clips: [...clips, { id: 'title', track: 'T1', at: fr(TITLE.start), len: fr(TITLE.end - TITLE.start), text: TITLE.text, style: 'title' },
      { id: 'vo', track: 'A1', at: fr(VO.start), len: Math.floor(voDur * 30), asset: 'vo-wav' }],
  });
  // its render, made with plain ffmpeg (the shots' own audio is silent; the voice-over is the only sound)
  await F.hasDrawtext();
  const title = F.drawtext(TITLE.text, { fontsize: 80, borderw: 6, bordercolor: 'black', enable: `'between(t,${TITLE.start},${TITLE.end})'` }) || `drawbox=x=440:y=320:w=400:h=80:color=white:t=fill:enable='between(t,${TITLE.start},${TITLE.end})'`;
  const tmp = mkdtempSync(join(tmpdir(), 'mgl-polish-'));
  try {
    await ffmpeg([...SHOTS.flatMap((_, i) => ['-i', join(dir, `media/shot${i + 1}.mp4`)]), '-i', join(dir, 'media/vo.wav'), '-filter_complex',
      `${SHOTS.map((_, i) => `[${i}:v]`).join('')}concat=n=${SHOTS.length}:v=1:a=0,${title},format=yuv420p[v];[${SHOTS.length}:a]adelay=${Math.round(VO.start * 1000)}:all=1,apad,atrim=0:20,aformat=channel_layouts=stereo,aresample=48000[a]`,
      '-map', '[v]', '-map', '[a]', ...F.X264, '-c:a', 'aac', '-b:a', '160k', '-t', '20', join(dir, 'edit.mp4')]);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  return F.finish(dir, { cuts, title: TITLE, vo: { start: VO.start, end: VO.start + voDur }, duration: 20 });
}
