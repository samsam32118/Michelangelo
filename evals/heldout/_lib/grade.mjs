// Grader scaffolding and the shared "not empty" assertion (not black, not static, not silent).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { probe, round } from './proc.mjs';
import { frameAt, loudness } from './media.mjs';
import { luma, meanStd, meanAbsDiff } from './image.mjs';

export function grader() {
  const checks = [];
  const add = (name, pass, detail = '') => { checks.push({ name, pass: !!pass, detail: String(detail).slice(0, 600) }); return !!pass; };
  return {
    check: add,
    /** fn returns {pass, detail}; a throw fails the check with the error. */
    async checkAsync(name, fn) {
      try { const r = await fn(); return add(name, r.pass, r.detail); } catch (e) { return add(name, false, `error: ${e?.message ?? e}`); }
    },
    result() {
      const n = checks.filter((c) => c.pass).length;
      return { pass: checks.length > 0 && n === checks.length, score: checks.length ? round(n / checks.length, 3) : 0, checks };
    },
  };
}

export function readSetup(dir) {
  try { return JSON.parse(readFileSync(join(dir, '.setup.json'), 'utf8')); } catch { return { hashes: {}, info: {} }; }
}

/**
 * The output is a real picture (not black, not one flat colour), changes over time, and (with audio: true)
 * is not silent. Samples 8 frames across the duration.
 */
export async function notEmpty(file, { audio = false, minLufs = -45 } = {}) {
  const p = await probe(file);
  if (!p?.video) return { pass: false, detail: 'no video stream' };
  const d = p.duration > 0 ? p.duration : 1;
  const frames = await Promise.all(Array.from({ length: 8 }, (_, i) => frameAt(file, d * (i + 0.5) / 8, { width: 160, height: 90 })));
  if (frames.some((f) => !f)) return { pass: false, detail: 'frames could not be decoded' };
  const stats = frames.map((f) => meanStd(luma(f)));
  const nonBlack = stats.some((s) => s.mean > 16 || s.std > 6);
  const flat = stats.every((s) => s.std < 2);
  let maxDiff = 0;
  for (let i = 1; i < frames.length; i++) maxDiff = Math.max(maxDiff, meanAbsDiff(frames[i - 1], frames[i]));
  const nonStatic = maxDiff > 1.0;
  let lufs = null, loud = true;
  if (audio) { lufs = p.audio ? await loudness(file) : null; loud = lufs !== null && lufs > minLufs; }
  const pass = nonBlack && !flat && nonStatic && loud;
  return { pass, detail: `${nonBlack ? 'not black' : 'BLACK'}, ${flat ? 'FLAT' : 'textured'}, ${nonStatic ? 'moving' : 'STATIC'} (max diff ${round(maxDiff, 1)})${audio ? `, ${loud ? 'audible' : 'SILENT'} (${lufs === null ? 'no audio' : `${round(lufs, 1)} LUFS`})` : ''}` };
}
