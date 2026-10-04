import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import * as L from '../_lib/index.mjs';
import { CUES, CLIP_AT } from './setup.mjs';

const FPS = 30, F = 1 / FPS;
const ts = (s) => { const m = /^(?:(\d+):)?(\d+):(\d+)[.,](\d{1,3})$/.exec(s.trim()); return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000 : NaN; };

/** Cues of an SRT or WebVTT file: [{start, end, lines}] or null if unreadable. */
export function parseSubs(file) {
  let text;
  try { text = readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/\r/g, ''); } catch { return null; }
  const cues = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const k = lines.findIndex((l) => l.includes('-->'));
    if (k < 0) continue;
    const [a, b] = lines[k].split('-->');
    const start = ts(a), end = ts(b.trim().split(/\s+/)[0]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    cues.push({ start, end, lines: lines.slice(k + 1).map((l) => l.replace(/<[^>]*>/g, '').trim()) });
  }
  return cues;
}
const norm = (s) => s.toLowerCase().split(/\s+/).map((w) => w.replace(/[^a-z0-9]/g, '')).filter(Boolean);

export async function grade(dir) {
  const g = L.grader();
  const info = L.readSetup(dir).info;
  const orig = (info.cues ?? CUES).map((c) => ({ start: ((info.clipAt ?? CLIP_AT) + c.at) / FPS, end: ((info.clipAt ?? CLIP_AT) + c.at + c.len) / FPS, words: norm(c.text) }));
  const srt = parseSubs(join(dir, 'out/vlog.srt')), vtt = parseSubs(join(dir, 'out/vlog.vtt'));
  const vttHeader = (() => { try { return readFileSync(join(dir, 'out/vlog.vtt'), 'utf8').replace(/^﻿/, '').startsWith('WEBVTT'); } catch { return false; } })();
  g.check('out/vlog.srt and out/vlog.vtt parse; same cue count (>= 14), times within 1 frame', srt && vtt && vttHeader && srt.length >= 14 && srt.length === vtt.length
    && srt.every((c, i) => Math.abs(c.start - vtt[i].start) <= F + 0.001 && Math.abs(c.end - vtt[i].end) <= F + 0.001),
  `srt ${srt ? srt.length : 'missing/unparseable'} cues, vtt ${vtt ? vtt.length : 'missing/unparseable'} cues${vttHeader ? '' : ' (no WEBVTT header)'}`);

  const shape = (cues) => {
    if (!cues?.length) return ['no cues'];
    const bad = [];
    cues.forEach((c, i) => {
      const d = c.end - c.start;
      if (!c.lines.length || c.lines.length > 2) bad.push(`#${i + 1} ${c.lines.length} lines`);
      for (const l of c.lines) if (l.length > 32) bad.push(`#${i + 1} line of ${l.length} chars`);
      if (d < 0.8 - 0.002 || d > 6 + 0.002) bad.push(`#${i + 1} lasts ${L.round(d, 3)} s`);
      if (i && c.start < cues[i - 1].end - 0.002) bad.push(`#${i + 1} overlaps or is out of order`);
    });
    return bad;
  };
  const badS = shape(srt), badV = shape(vtt);
  g.check('every cue: <= 2 lines of <= 32 chars, 0.8-6.0 s, sorted, no overlaps (SRT and VTT)', !badS.length && !badV.length, [...badS, ...badV].slice(0, 6).join('; ') || `${srt.length} cues ok`);

  const want = orig.flatMap((c, k) => c.words.map((w) => ({ w, k })));
  const got = (srt ?? []).flatMap((c, i) => norm(c.lines.join(' ')).map((w) => ({ w, i })));
  const same = got.length === want.length && got.every((x, j) => x.w === want[j].w);
  const vttWords = (vtt ?? []).flatMap((c) => norm(c.lines.join(' ')));
  const firstDiff = got.findIndex((x, j) => x.w !== want[j]?.w);
  g.check('concatenated cue words equal the original words in order (SRT and VTT)', same && vttWords.join(' ') === want.map((x) => x.w).join(' '),
    `${got.length}/${want.length} words${same ? '' : `; first difference at word ${firstDiff < 0 ? got.length : firstDiff}`}`);

  const outside = [];
  if (same) (srt ?? []).forEach((c, i) => {
    const ks = want.filter((_, j) => got[j].i === i).map((x) => x.k);
    if (!ks.length) return;
    const s = orig[Math.min(...ks)].start, e = orig[Math.max(...ks)].end;
    if (c.start < s - 2 * F - 0.001 || c.end > e + 2 * F + 0.001) outside.push(`#${i + 1} ${L.round(c.start, 2)}-${L.round(c.end, 2)} vs ${L.round(s, 2)}-${L.round(e, 2)}`);
  });
  g.check('each new cue lies within the time span of the original cue its words came from (+/- 2 frames)', same && !outside.length, same ? outside.slice(0, 4).join('; ') || 'all inside' : 'words do not match');

  const out = join(dir, 'out/vlog.mp4'), bg = join(dir, 'media/bg.mp4');
  await g.checkAsync('out/vlog.mp4: not black, not static, audio not silent; captions burned into the lower 40 % at 3 cue midpoints', async () => {
    const p = await L.probe(out);
    if (!p) return { pass: false, detail: 'missing' };
    const ne = await L.notEmpty(out, { audio: true });
    const picks = srt?.length >= 3 ? [1, Math.floor(srt.length / 2), srt.length - 2].map((i) => (srt[i].start + srt[i].end) / 2) : [];
    const W = 540, H = 960, band = [0, Math.round(H * 0.6), W, H];
    const dens = await Promise.all(picks.map(async (t) => {
      const [o, b] = await Promise.all([L.frameAt(out, t, { width: W, height: H }), L.frameAt(bg, t, { width: W, height: H })]);
      return o && b ? L.maskCount(L.diffMask(o, b, 80), W, band) / ((band[2] - band[0]) * (band[3] - band[1])) : 0;
    }));
    const ok = ne.pass && Math.abs(p.duration - 40) <= 0.5 && p.video.width === 1080 && p.video.height === 1920 && picks.length === 3 && dens.every((d) => d >= 0.004);
    return { pass: ok, detail: `${p.video.width}x${p.video.height} ${L.round(p.duration, 2)} s; ${ne.detail}; caption-band changed px ${dens.map((d) => L.round(d, 4)).join('/') || 'no cues to sample'}` };
  });
  return g.result();
}
