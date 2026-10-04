import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as F from '../../lib/fixtures.mjs';
import { ffmpeg } from '../../lib/util.mjs';
import { probe } from '../../lib/probe.mjs';

export const SPEAKER = { name: 'Maya Chen', role: 'Product Designer' };
/** [topic, [phrases]]; "um" / "uh" are fillers. Each item is followed by the pause in GAPS (seconds). */
export const TOPICS = [
  ['Introduction', ['Hi I am Maya Chen and I design tools for makers.', 'um', 'Today I want to talk about how I work.']],
  ['Starting out', ['I started out drawing posters for local bands.', 'uh', 'It taught me to make every pixel count.']],
  ['Design process', ['My process starts with a rough sketch on paper.', 'Then I build a quick prototype and test it with real people.', 'um', 'Most ideas fail and that is fine.']],
  ['Advice', ['My advice is simple.', 'Ship something small every week.', 'And always listen to your users.']],
];
const GAPS = [0.35, 2.4, 2.8, 2.6, 0.3, 3.0, 2.2, 2.5, 0.3, 2.9, 2.7, 2.4, 2.6];
const LEAD = 0.5, DURATION = 60;

export async function setup(dir) {
  const tmp = mkdtempSync(join(tmpdir(), 'mgl-th-'));
  const items = [];
  try {
    const parts = [];
    const lead = join(tmp, 'lead.wav');
    await F.tone(lead, `anullsrc=r=48000:cl=mono:d=${LEAD}`);
    parts.push(lead);
    let t = LEAD, k = 0;
    for (const [topic, phrases] of TOPICS) for (const [j, text] of phrases.entries()) {
      const f = join(tmp, `p${k}.wav`);
      await F.speech(f, text);
      const d = (await probe(f)).duration;
      items.push({ topic, first: j === 0, text, filler: /^(um|uh)$/.test(text), start: t, end: t + d });
      parts.push(f);
      const gap = GAPS[k] ?? 2;
      const s = join(tmp, `g${k}.wav`);
      await F.tone(s, `anullsrc=r=48000:cl=mono:d=${gap}`);
      parts.push(s);
      t += d + gap; k++;
    }
    const audio = join(tmp, 'audio.wav');
    await ffmpeg([...parts.flatMap((f) => ['-i', f]), '-filter_complex', `${parts.map((_, i) => `[${i}:a]`).join('')}concat=n=${parts.length}:v=0:a=1,apad=whole_dur=${DURATION},atrim=0:${DURATION}`, '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', audio]);
    // the "talking head": a soft disc bobbing over a gradient (no hard edges, no text)
    const head = join(tmp, 'head.png'), bg = join(tmp, 'bg.png');
    await ffmpeg(['-f', 'lavfi', '-i', "color=c=black@0:s=270x270:d=1,format=rgba,geq=r='235':g='190':b='160':a='255*clip((128-hypot(X-135\\,Y-135))/22\\,0\\,1)'", '-frames:v', '1', head]);
    await ffmpeg(['-f', 'lavfi', '-i', 'gradients=s=960x540:c0=0x2b3a55:c1=0x6b4f3a:d=1', '-frames:v', '1', bg]);
    const n = DURATION * 30 - 1;
    await ffmpeg(['-i', bg, '-i', head, '-i', audio, '-filter_complex',
      `[0:v]format=yuv420p,loop=loop=${n}:size=1,setpts=N/30/TB[b];[1:v]format=yuva420p,loop=loop=${n}:size=1,setpts=N/30/TB[h];[b][h]overlay=x=345+15*sin(t*0.9):y=105+9*sin(t*1.7):format=yuv420[v]`,
      '-map', '[v]', '-map', '2:a', '-r', '30', ...F.X264, '-c:a', 'aac', '-b:a', '128k', '-t', String(DURATION), join(dir, 'interview.mp4')]);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const chapters = items.filter((x) => x.first).map((x, i) => ({ topic: x.topic, source: i === 0 ? 0 : x.start }));
  F.writeText(join(dir, 'notes.txt'), [`Speaker: ${SPEAKER.name}, ${SPEAKER.role}`, '', 'Topics (times in interview.mp4):', ...chapters.map((c) => `${mmss(c.source)} ${c.topic}`), ''].join('\n'));
  return F.finish(dir, { items, chapters, speaker: SPEAKER, duration: DURATION });
}
