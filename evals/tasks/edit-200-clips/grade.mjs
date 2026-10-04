import { join } from 'node:path';
import { grader, readSetup, readProject, validateRaw, resolveStyle, toFrames } from '../../lib/index.mjs';

const eq = (a, b) => JSON.stringify(Object.entries(a).filter(([, v]) => v !== undefined).sort()) === JSON.stringify(Object.entries(b).filter(([, v]) => v !== undefined).sort());
const norm = (c) => ({ ...c, at: toFrames(c.at, 30), len: toFrames(c.len, 30), ...(c.in !== undefined ? { in: toFrames(c.in, 30) } : {}) });

export async function grade(dir) {
  const g = grader();
  const { info } = readSetup(dir);
  const p = readProject(join(dir, 'big.mgl.json'));
  const orig = info.clips;
  const now = (p?.clips ?? []).map(norm);
  const byId = new Map(now.map((c) => [c.id, c]));

  // expected V2: the clips of ≥ 10 frames, closed up
  const expV2 = [];
  let t = 0;
  for (const c of orig.filter((c) => c.track === 'V2' && c.len >= 10)) { expV2.push({ ...c, at: t }); t += c.len; }
  const v2 = now.filter((c) => c.track === 'V2').sort((a, b) => a.at - b.at);
  g.check('V2 has no clips < 10 frames and no gaps where they were (later V2 clips shifted)',
    v2.length === expV2.length && expV2.every((e, i) => v2[i].id === e.id && v2[i].at === e.at && v2[i].len === e.len && eq({ ...v2[i], at: 0 }, { ...e, at: 0 })),
    `${v2.length} V2 clips (expected ${expV2.length}); short left: ${v2.filter((c) => c.len < 10).length}; first mismatch: ${expV2.find((e, i) => !v2[i] || v2[i].at !== e.at || v2[i].id !== e.id)?.id ?? 'none'}`);

  const v1 = orig.filter((c) => c.track === 'V1');
  const otherOk = v1.every((c) => byId.get(c.id) && eq(byId.get(c.id), c)) && now.filter((c) => c.track === 'V1').length === v1.length;
  g.check('other tracks unchanged (V1 clips identical; T1 positions identical)', otherOk && orig.filter((c) => c.track === 'T1').every((c) => { const n = byId.get(c.id); return n && n.at === c.at && n.len === c.len && n.text === c.text && n.track === 'T1'; }),
    otherOk ? 'V1 identical' : 'V1 changed');

  const texts = orig.filter((c) => c.track === 'T1');
  const colourOf = (c) => String(resolveStyle(p, c).color ?? '').toLowerCase();
  const chorusOk = texts.filter((c) => c.text === 'CHORUS').every((c) => byId.get(c.id) && colourOf(byId.get(c.id)) === '#ffcc00' && !byId.get(c.id).hidden);
  const othersOk = texts.filter((c) => c.text !== 'CHORUS').every((c) => byId.get(c.id) && colourOf(byId.get(c.id)) === '#ffffff' && eq({ ...byId.get(c.id), style: 0 }, { ...c, style: 0 }) && resolveStyle(p, byId.get(c.id)).size === 110);
  g.check('the 6 CHORUS clips have colour #ffcc00; other text clips unchanged', chorusOk && othersOk && (p?.clips ?? []).filter((c) => c.text !== undefined).length === 25,
    `CHORUS ${texts.filter((c) => c.text === 'CHORUS').map((c) => (byId.get(c.id) ? colourOf(byId.get(c.id)) : 'missing')).join(',')}; others ${othersOk ? 'unchanged' : 'changed'}`);
  const errs = p ? validateRaw(p) : ['big.mgl.json missing or not JSON'];
  g.check('file valid', errs.length === 0 && (p?.clips ?? []).length === 200 - 17, errs[0] ?? `${(p?.clips ?? []).length} clips`);
  return g.result();
}
