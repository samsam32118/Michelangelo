import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { grader, readSetup, probe, run, FFPROBE, rmsWindows, bestMatch, silences, frameAt, textBands, round, assertNotEmpty, findProjectUsing, projectCues, textClips } from '../../lib/index.mjs';

const WIN = 0.02;
const env = async (f, opts) => (await rmsWindows(f, { win: WIN, ...opts })).map((d) => Math.max(-60, d));
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Where each (non-filler) phrase of the interview starts in the output: envelope cross-correlation, in order. */
async function locatePhrases(out, src, items) {
  const o = await env(out);
  const res = [];
  let from = 0;
  for (const it of items.filter((x) => !x.filler)) {
    const e = await env(src, { start: it.start, duration: it.end - it.start });
    const m = bestMatch(o, e, from, Math.min(o.length - e.length, from + Math.round(20 / WIN)));
    res.push({ ...it, at: m.offset * WIN, corr: m.corr });
    if (m.corr < 0.6) break;
    from = m.offset + Math.floor(e.length * 0.8);
  }
  return res;
}

/** Chapters from out/chapters.txt ("0:00 Title" lines) and from the video's chapter metadata: [{t, title}]. */
async function chaptersOf(dir, out) {
  const res = [];
  const txt = join(dir, 'out/chapters.txt');
  if (existsSync(txt)) {
    for (const line of readFileSync(txt, 'utf8').split('\n')) {
      const m = /^\s*[-*]?\s*\(?((?:\d+:)?\d{1,2}:\d{2})\)?\s*[-–—:]?\s*(.+?)\s*$/.exec(line);
      if (m) { const parts = m[1].split(':').map(Number); res.push({ t: parts.reduce((a, v) => a * 60 + v, 0), title: m[2], from: 'chapters.txt' }); }
    }
  }
  if (existsSync(out)) {
    const r = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_chapters', out]);
    try { for (const c of JSON.parse(r.stdout.toString()).chapters ?? []) res.push({ t: Number(c.start_time), title: c.tags?.title ?? '', from: 'metadata' }); } catch { /* none */ }
  }
  return res;
}

export async function grade(dir) {
  const g = grader();
  const { info } = readSetup(dir);
  const src = join(dir, 'interview.mp4'), out = join(dir, 'out/final.mp4');
  const p = await probe(out);
  const real = info.items.filter((x) => !x.filler);
  // dead air: what is beyond 0.3 s of every pause of 0.8 s or more
  const pauses = info.items.map((x, i) => (info.items[i + 1]?.start ?? info.duration) - x.end).concat(info.items[0].start);
  const removable = pauses.reduce((s, d) => s + (d >= 0.8 ? d - 0.3 : 0), 0);
  const maxDur = info.duration - removable / 2 + 5;
  await g.checkAsync(`out/final.mp4: H.264 + AAC, 16:9, at most ${round(maxDur, 1)} s (dead air removed; an intro of up to 5 s allowed)`, async () => {
    if (!p) return { pass: false, detail: 'out/final.mp4 missing' };
    const ne = await assertNotEmpty(out, { audio: true });
    return { pass: p.video?.codec === 'h264' && p.audio?.codec === 'aac' && Math.abs(p.displayWidth / p.displayHeight - 16 / 9) < 0.02 && p.displayWidth >= 960 && p.duration <= maxDur && ne.pass,
      detail: `${p.video?.codec}/${p.audio?.codec} ${p.displayWidth}x${p.displayHeight} ${round(p.duration, 2)} s (interview ${info.duration} s, ${round(removable, 1)} s of dead air); ${ne.detail}` };
  });
  const loc = p?.audio ? await locatePhrases(out, src, info.items) : [];
  const found = loc.length === real.length && loc.every((x) => x.corr >= 0.6);
  g.check(`all ${real.length} phrases kept, in order (energy envelope cross-correlation)`, found, loc.length ? `corr ${loc.map((x) => round(x.corr, 2)).join(' ')}` : 'no audio');
  await g.checkAsync('no silence longer than 0.8 s once the speech starts (-40 dB)', async () => {
    if (!p?.audio) return { pass: false, detail: 'no audio' };
    const t0 = found ? loc[0].at : 0;
    const s = (await silences(out, { db: -40, minDuration: 0.8 })).filter((x) => x.end > t0 + 0.1 && x.start < p.duration - 0.3);
    return { pass: s.length === 0, detail: s.map((x) => `${round(x.start, 2)}-${round(x.end, 2)}`).join(', ') || 'none' };
  });
  const W = 480, H = 270;
  const frame = async (t) => (p?.video ? frameAt(out, Math.min(Math.max(0, t), p.duration - 0.05), { width: W, height: H }) : undefined);
  await g.checkAsync('burned captions: text in the bottom third at >= 80 % of the phrase midpoints after 10 s', async () => {
    if (!found) return { pass: false, detail: 'phrases not located in the output' };
    const mids = loc.map((x) => x.at + (x.end - x.start) / 2).filter((t) => t >= 10);
    const hits = [];
    for (const t of mids) { const img = await frame(t); hits.push(!!img && textBands(img, { box: [0, H * 2 / 3, W, H / 3] }).count >= 30); }
    return { pass: mids.length >= 3 && hits.filter(Boolean).length / mids.length >= 0.8, detail: `${hits.filter(Boolean).length}/${mids.length} midpoints at ${mids.map((t) => round(t, 1)).join(', ')} s` };
  });
  await g.checkAsync('lower third: left-aligned text in the lower part of the frame within the first 10 s', async () => {
    if (!p?.video) return { pass: false, detail: 'out/final.mp4 missing' };
    const seen = [];
    for (let t = 0.5; t < Math.min(10, p.duration); t += 0.5) {
      const img = await frame(t);
      const bands = img ? textBands(img, { box: [0, H * 0.5, W, H * 0.45] }).bands : [];
      if (bands.some((b) => b.x0 < W * 0.35 && b.x1 < W * 0.65)) seen.push(t);
    }
    return { pass: seen.length >= 2, detail: seen.length ? `at ${seen.join(', ')} s` : 'no left-aligned text band in the lower half' };
  });
  await g.checkAsync('intro title: text in the upper or middle of the frame within the first 4 s', async () => {
    if (!p?.video) return { pass: false, detail: 'out/final.mp4 missing' };
    const seen = [];
    for (let t = 0.2; t < Math.min(4, p.duration); t += 0.4) {
      const img = await frame(t);
      if (img && textBands(img, { box: [W * 0.05, H * 0.08, W * 0.9, H * 0.55] }).count >= 40) seen.push(round(t, 1));
    }
    return { pass: seen.length >= 2, detail: seen.length ? `at ${seen.join(', ')} s` : 'none' };
  });
  await g.checkAsync('chapters (out/chapters.txt or chapter metadata): each topic of notes.txt within 2 s of where it starts in the output', async () => {
    const ch = await chaptersOf(dir, out);
    if (!ch.length) return { pass: false, detail: 'no out/chapters.txt lines and no chapter metadata' };
    if (!found) return { pass: false, detail: `${ch.length} chapters, but the phrases were not located in the output` };
    const res = info.chapters.map((c, i) => {
      const first = loc.find((x) => x.topic === c.topic && x.first);
      const want = first?.at ?? NaN;
      const ok = ch.some((x) => norm(x.title).includes(norm(c.topic)) && (Math.abs(x.t - want) <= 2 || (i === 0 && x.t === 0)));
      return { topic: c.topic, want, ok };
    });
    return { pass: res.every((r) => r.ok), detail: `${res.map((r) => `${r.topic} @${round(r.want, 1)} s ${r.ok ? 'ok' : 'MISSING'}`).join('; ')}; found ${ch.map((x) => `${round(x.t, 1)} ${x.title}`).join(' | ')}` };
  });
  const proj = findProjectUsing(dir, { inputs: ['interview.mp4'], pred: (pp) => {
    const srcOf = new Map((pp.assets ?? []).map((a) => [a.id, String(a.src ?? '')]));
    const cuts = (pp.clips ?? []).filter((c) => srcOf.get(c.asset)?.endsWith('interview.mp4')).length;
    if (cuts < 5) return `${cuts} clips of interview.mp4 (dead air not cut)`;
    if (projectCues(pp).length < 5) return 'fewer than 5 caption cues';
    if (!textClips(pp).some((c) => /maya\s+chen/i.test(c.text))) return 'no text clip with the speaker name';
    return (pp.markers ?? []).length >= info.chapters.length || `${(pp.markers ?? []).length} markers (want one per chapter)`;
  } });
  g.check('[lib] a valid project cuts interview.mp4 (>= 5 clips), with caption cues, a name text clip and a marker per chapter', !!proj.p, proj.p ? proj.f : proj.why);
  return g.result();
}
