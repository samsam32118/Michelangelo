import { open } from 'michelangelo';
const fps = 30;
// speech segments measured with ffmpeg silencedetect (-38 dB), mapped to script phrases
const segs = [
  [0.22, 1.62, ['Want to focus better?']],
  [1.91, 3.77, ['Try these three tips.']],
  [4.06, 5.41, ['One.', 'Put your phone in another room.']],
  [5.72, 7.97, ['Two.', 'Work in short sprints with a timer.']],
  [8.26, 8.62, ['Three.']],
  [8.91, 10.52, ['Take a real break every hour.']],
];
const p = await open('short.mgl.json');
const edits = p.data.cues.filter((c) => c.clip === 'subs').map((c) => ({ op: 'cue.remove', id: c.id }));
let n = 0;
for (const [s, e, phrases] of segs) {
  const words = phrases.map((ph) => ph.split(' '));
  const all = words.flat();
  const w = all.map((x) => x.length + 1), tot = w.reduce((a, b) => a + b, 0);
  const starts = []; let acc = 0;
  for (const x of w) { starts.push(s + (e - s) * acc / tot); acc += x; }
  let i = 0;
  for (const ph of words) {
    // balanced chunks of at most 3 words
    const nc = Math.ceil(ph.length / 3), size = Math.ceil(ph.length / nc);
    for (let k = 0; k < ph.length; k += size) {
      const chunk = ph.slice(k, k + size), i0 = i + k, i1 = i0 + chunk.length;
      const t0 = Math.round(starts[i0] * fps);
      const t1 = Math.round((i1 < starts.length ? starts[i1] : e) * fps);
      edits.push({ op: 'cue.add', clip: 'subs', id: `c${++n}`, at: t0, len: Math.max(t1 - t0, 4), text: chunk.join(' '),
        words: chunk.map((_, j) => Math.round(starts[i0 + j] * fps) - t0) });
    }
    i += ph.length;
  }
}
edits.push({ op: 'clip.set', id: 'subs', len: 328 });
await p.edit(edits);
console.log(p.data.cues.map((c) => `${c.id} ${c.at}+${c.len} ${c.text} ${JSON.stringify(c.words)}`).join('\n'));
