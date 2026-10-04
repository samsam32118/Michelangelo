import { join } from 'node:path';
import { grader, readSetup, readProject, validateRaw, toFrames, renderStill, frameAt, readCounter } from '../../lib/index.mjs';

export async function grade(dir) {
  const g = grader();
  const { info } = readSetup(dir);
  const p = readProject(join(dir, 'trim.mgl.json'));
  const get = (id) => { const c = (p?.clips ?? []).find((x) => x.id === id); return c && { at: toFrames(c.at, 30), len: toFrames(c.len, 30), in: toFrames(c.in ?? 0, 30), speed: c.speed }; };
  const [a, b, c] = ['a', 'b', 'c'].map(get);
  const [A, B, C] = info.clips;
  g.check('[lib] a.len +12, b.at +12, b.in +12, b.len -12; c.at and c.len unchanged, c.in +30',
    !!(a && b && c) && a.at === A.at && a.len === A.len + 12 && a.in === A.in && b.at === B.at + 12 && b.in === B.in + 12 && b.len === B.len - 12 && c.at === C.at && c.len === C.len && c.in === C.in + 30
      && [a, b, c].every((x) => x.speed === undefined || x.speed === 1) && !validateRaw(p).length && p.clips.length === 3,
    a && b && c ? `a ${a.at}+${a.len} in ${a.in}; b ${b.at}+${b.len} in ${b.in}; c ${c.at}+${c.len} in ${c.in}` : 'clips missing');
  await g.checkAsync('[lib] rendered counter at c start = old + 30 (and clip a still showing 0.1 s after the old cut)', async () => {
    if (!p) return { pass: false, detail: 'trim.mgl.json missing' };
    const rc = await renderStill(dir, 'trim.mgl.json', 6);
    if (rc.error) return { pass: false, detail: rc.error };
    const rb = await renderStill(dir, 'trim.mgl.json', 3.1);
    const vc = readCounter(await frameAt(rc.file, 0, { width: 640, height: 360 }));
    const vb = rb.file ? readCounter(await frameAt(rb.file, 0, { width: 640, height: 360 })) : -1;
    return { pass: vc === C.in + 30 && vb === 93, detail: `counter at 6 s = ${vc} (want ${C.in + 30}), at 3.1 s = ${vb} (want 93: still clip a after the roll)` };
  });
  return g.result();
}
