// Reference solution with plain ffmpeg + Node (no Michelangelo): keep each phrase with 0.15 s of breath (fillers too),
// concatenate, and burn an intro title, a lower third and per-phrase captions with drawtext; chapters from the
// phrase positions after the cut. The same edit is written as a hand-written project.
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { ffmpeg, readSetup, formatProject } from '../../lib/index.mjs';
import { hasDrawtext, font } from '../../lib/fixtures.mjs';

export async function solve(dir) {
  const { info } = readSetup(dir);
  const o = join(dir, 'out');
  mkdirSync(o, { recursive: true });
  const B = 0.15;
  const keep = info.items.map((x) => [Math.max(0, x.start - B), Math.min(info.duration, x.end + B)]);
  let t = 0;
  const placed = info.items.map((x, i) => { const at = t + (x.start - keep[i][0]); t += keep[i][1] - keep[i][0]; return { ...x, at, outEnd: at + (x.end - x.start) }; });
  const D = t;
  const dt = await hasDrawtext();
  const files = [];
  const text = (s, opts, enable) => {
    if (!dt) return `drawbox=x=${opts.bx}:y=${opts.by}:w=${opts.bw}:h=${opts.bh}:color=white:t=fill:enable='${enable}'`;
    const f = join(o, `.t${files.length}.txt`);
    writeFileSync(f, s); files.push(f);
    return `drawtext=fontfile='${font()}':textfile='${f}':fontsize=${opts.size}:fontcolor=white:borderw=3:bordercolor=black:x=${opts.x}:y=${opts.y}:enable='${enable}'`;
  };
  const filters = [
    text('Design Talks', { size: 64, x: '(w-text_w)/2', y: 'h*0.22', bx: 280, by: 110, bw: 400, bh: 60 }, 'between(t,0,3)'),
    `drawbox=x=30:y=330:w=360:h=90:color=black@0.6:t=fill:enable='between(t,0.5,8)'`,
    text(info.speaker.name, { size: 34, x: 48, y: 342, bx: 48, by: 342, bw: 200, bh: 30 }, 'between(t,0.5,8)'),
    text(info.speaker.role, { size: 24, x: 48, y: 384, bx: 48, by: 384, bw: 160, bh: 20 }, 'between(t,0.5,8)'),
    ...placed.filter((x) => !x.filler).map((x) => text(x.text, { size: 26, x: '(w-text_w)/2', y: 'h-60', bx: 200, by: 470, bw: 560, bh: 30 }, `between(t,${x.at.toFixed(3)},${x.outEnd.toFixed(3)})`)),
  ];
  const graph = keep.map(([a, b], i) => `[0:v]trim=${a}:${b},setpts=PTS-STARTPTS[v${i}];[0:a]atrim=${a}:${b},asetpts=PTS-STARTPTS[a${i}]`).join(';')
    + `;${keep.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${keep.length}:v=1:a=1[cv][ca];[cv]${filters.join(',')},format=yuv420p[v]`;
  await ffmpeg(['-i', join(dir, 'interview.mp4'), '-filter_complex', graph, '-map', '[v]', '-map', '[ca]', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '128k', join(o, 'final.mp4')]);
  for (const f of files) rmSync(f, { force: true });
  const mss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const firsts = placed.filter((x) => x.first);
  writeFileSync(join(o, 'chapters.txt'), firsts.map((x, i) => `${mss(i === 0 ? 0 : x.at)} ${x.topic}`).join('\n') + '\n');
  // the same edit as a project
  const fr = (s) => Math.round(s * 30);
  let at = 0;
  const clips = keep.map(([a, b], i) => { const c = { id: `k${i + 1}`, track: 'V1', at, len: fr(b) - fr(a), asset: 'interview-mp4', in: fr(a) }; at += c.len; return c; });
  const real = placed.filter((x) => !x.filler);
  writeFileSync(join(dir, 'final.mgl.json'), formatProject({ michelangelo: 1, project: { platform: 'youtube' }, assets: [{ id: 'interview-mp4', src: 'interview.mp4' }],
    comps: [{ id: 'main', size: [960, 540], fps: 30, length: at }],
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'T1', comp: 'main' }, { id: 'T2', comp: 'main' }, { id: 'C1', comp: 'main' }],
    clips: [...clips, { id: 'intro', track: 'T1', at: 0, len: 90, text: 'Design Talks', style: 'title' }, { id: 'name', track: 'T2', at: 15, len: 225, text: `${info.speaker.name}\n${info.speaker.role}`, style: 'lower-third' },
      { id: 'captions', track: 'C1', at: 0, len: at, captions: true }],
    cues: real.map((x, i) => ({ id: `c${i + 1}`, clip: 'captions', at: fr(x.at), len: Math.max(1, fr(x.outEnd) - fr(x.at)), text: x.text })),
    markers: firsts.map((x, i) => ({ id: `ch${i + 1}`, comp: 'main', at: i === 0 ? 0 : fr(x.at), note: x.topic })) }));
}
