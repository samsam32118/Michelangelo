import { join } from 'node:path';
import { grader, assertNotEmpty, probe, loudness, silences, allFrames, frameDiff, textBands, maskXor, dilate, readSetup, findProjectUsing, projectCues, textClips, mainComp, compRate, toFrames, round } from '../../lib/index.mjs';

const W = 360, H = 640, FPS = 4;
const words = (s) => String(s).toLowerCase().match(/[a-z]+/g) ?? [];

/**
 * Stable on-screen text states: runs of >= 2 samples whose text masks agree (xor/union < 0.35), each different from
 * the previous stable state. A caption or title change is one new state; animation in between is not counted.
 */
export function textStates(masks, counts, { minCount = 40, same = 0.35 } = {}) {
  const states = [];
  let ref = -1, run = 0;
  const close = () => {
    if (ref < 0 || run < 2 || counts[ref] < minCount) return;
    const prev = states[states.length - 1];
    if (prev !== undefined && maskXor(masks[prev], masks[ref]) < same) return;
    states.push(ref);
  };
  for (let i = 0; i < masks.length; i++) {
    if (ref >= 0 && maskXor(masks[i], masks[ref]) < same) { run++; continue; }
    close();
    ref = i; run = 1;
  }
  close();
  return states;
}

export async function grade(dir) {
  const g = grader();
  const { info } = readSetup(dir);
  const sentences = info.sentences ?? [];
  const out = join(dir, 'out/short.mp4');
  const p = await probe(out);
  g.check('out/short.mp4: 1080x1920, H.264 + AAC, 20-30 s', !!p && p.displayWidth === 1080 && p.displayHeight === 1920 && p.video?.codec === 'h264' && p.audio?.codec === 'aac' && p.duration >= 20 && p.duration <= 30.05,
    p ? `${p.displayWidth}x${p.displayHeight} ${p.video?.codec}/${p.audio?.codec} ${round(p.duration, 2)} s` : 'out/short.mp4 missing');
  const frames = p?.video ? await allFrames(out, { width: W, height: H, fps: FPS }) : [];
  await g.checkAsync('motion throughout: the picture changes within every 2 s window; not black', async () => {
    if (!frames.length) return { pass: false, detail: 'no frames' };
    const ne = await assertNotEmpty(out);
    const windows = Math.max(1, Math.floor(frames.length / (2 * FPS)));
    const still = [];
    for (let w = 0; w < windows; w++) {
      let best = 0;
      for (let i = w * 2 * FPS + 1; i < Math.min(frames.length, (w + 1) * 2 * FPS); i++) best = Math.max(best, frameDiff(frames[i - 1], frames[i], { thresh: 20 }).changed);
      if (best < 0.002) still.push(`${w * 2}-${w * 2 + 2} s`);
    }
    return { pass: !still.length && ne.pass, detail: `${windows} windows; static: ${still.join(', ') || 'none'}; ${ne.detail}` };
  });
  await g.checkAsync('sound: not silent, integrated loudness -16..-12 LUFS', async () => {
    if (!p?.audio) return { pass: false, detail: p ? 'no audio stream' : 'missing' };
    const l = await loudness(out);
    return { pass: l.integrated >= -16 && l.integrated <= -12, detail: `${l.integrated} LUFS, true peak ${l.truePeak} dBTP` };
  });
  await g.checkAsync('music throughout: no silence longer than 1.5 s (-45 dB)', async () => {
    if (!p?.audio) return { pass: false, detail: 'no audio' };
    const s = await silences(out, { db: -45, minDuration: 1.5 });
    return { pass: s.length === 0, detail: s.map((x) => `${round(x.start, 2)}-${round(x.end, 2)}`).join(', ') || 'none' };
  });
  const tb = frames.map((f) => textBands(f));
  const masks = tb.map((t) => dilate(t.mask, W, H, 1)), counts = tb.map((t) => t.count);
  const withText = counts.map((c) => c >= 40);
  g.check('on-screen text in >= 80 % of sampled frames (4 fps), and in the hook (0.5 s and 1.0 s)',
    frames.length > 0 && withText.filter(Boolean).length / frames.length >= 0.8 && withText[2] && withText[4],
    frames.length ? `${withText.filter(Boolean).length}/${frames.length} frames with text; at 0.5 s ${withText[2] ? 'yes' : 'no'}, 1.0 s ${withText[4] ? 'yes' : 'no'}` : 'no frames');
  const states = textStates(masks, counts);
  g.check(`the text follows the script: >= ${sentences.length} distinct on-screen text states (one per sentence; OCR-free)`, frames.length > 0 && states.length >= sentences.length,
    `${states.length} stable text states, first seen at ${states.map((i) => round(i / FPS, 2)).join(', ') || '-'} s`);
  const scriptWords = sentences.flatMap(words);
  const proj = findProjectUsing(dir, { size: [1080, 1920], pred: (pp) => {
    const shown = new Set([...textClips(pp).map((c) => c.text), ...projectCues(pp).map((c) => c.text)].flatMap(words));
    const cover = scriptWords.filter((w) => shown.has(w)).length / Math.max(1, scriptWords.length);
    const m = mainComp(pp), rate = compRate(m), len = m?.length !== undefined ? toFrames(m.length, rate) / rate : undefined;
    if (cover < 0.8) return `text clips and cues cover ${Math.round(cover * 100)} % of the script words`;
    return len === undefined || (len >= 20 && len <= 30.05) || `main comp is ${round(len, 2)} s`;
  } });
  g.check('[lib] a valid 1080x1920 project whose text clips or cues cover >= 80 % of the script words', !!proj.p, proj.p ? proj.f : proj.why);
  return g.result();
}
