import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { grader, readSetup, parseLoose, validateRaw } from '../../lib/index.mjs';

export async function grade(dir) {
  const g = grader();
  const { info } = readSetup(dir);
  let p, err;
  try { p = parseLoose(readFileSync(join(dir, 'broken.mgl.json'), 'utf8')); } catch (e) { err = String(e.message ?? e); }
  const errs = p ? validateRaw(p) : [err ?? 'missing'];
  g.check('[lib] file loads and check passes with no errors (keys, references, overlaps)', errs.length === 0, errs.slice(0, 3).join('; ') || 'valid');
  const ids = (p?.clips ?? []).map((c) => c.id).sort();
  const ov = (p?.clips ?? []).find((c) => c.id === 'overlay');
  const credit = (p?.clips ?? []).find((c) => c.id === 'credit');
  g.check('[lib] clip count unchanged (same ids, credit kept); the opacity value preserved as "opacity"',
    JSON.stringify(ids) === JSON.stringify([...info.ids].sort()) && ov?.opacity === 0.8 && !('opactiy' in (ov ?? {})) && !!credit && !credit.hidden && credit.text === 'Shot on location' && !ov.hidden,
    `ids ${ids.join(',')}; overlay opacity ${ov?.opacity}`);
  return g.result();
}
