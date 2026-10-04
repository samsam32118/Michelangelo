// The check recorder every grader uses, and assertNotEmpty (not black, not static, not silent).
import { probe } from './probe.mjs';
import { frameAt, lumaStats, frameDiff } from './frames.mjs';
import { loudness } from './audio.mjs';
import { round } from './util.mjs';

/**
 * Library-only checks (DESIGN §17.2): a check that needs a Michelangelo project file or another library artefact is
 * named with this prefix; the "without" arm is graded on the other (deliverable) checks only.
 */
export const LIB_PREFIX = '[lib] ';
export const isLibCheck = (name) => String(name).startsWith(LIB_PREFIX);
/** Deliverable-only view of a result: {pass, score, checks} over the checks not marked library-only. */
export function deliverableResult(checks) {
  const own = checks.filter((c) => !isLibCheck(c.name));
  const passed = own.filter((c) => c.pass).length;
  return { pass: own.length > 0 && passed === own.length, score: own.length ? round(passed / own.length, 4) : 0, checks: own.length };
}

/**
 * A recorder: check(name, pass, detail) and await checkAsync(name, fn → {pass, detail} | boolean). result() adds
 * `deliverable` ({pass, score, checks}: the same over the checks without the "[lib] " prefix).
 */
export function grader() {
  const checks = [];
  const check = (name, pass, detail = '') => { checks.push({ name, pass: !!pass, detail: String(detail) }); return !!pass; };
  return {
    checks,
    check,
    async checkAsync(name, fn) {
      try {
        const r = await fn();
        return typeof r === 'boolean' ? check(name, r) : check(name, r.pass, r.detail);
      } catch (e) { return check(name, false, `grader error: ${e?.message ?? e}`); }
    },
    result() {
      const passed = checks.filter((c) => c.pass).length;
      return { pass: checks.length > 0 && passed === checks.length, score: checks.length ? round(passed / checks.length, 4) : 0, checks, deliverable: deliverableResult(checks) };
    },
  };
}

/**
 * The output is not empty: video not black (mean luma > 0.04 in ≥ 1 of 5 sampled frames), not static
 * (some pair of samples differs, unless `still`), audio not silent (integrated > -60 LUFS) when `audio`.
 * Returns {pass, detail}.
 */
export async function assertNotEmpty(file, { video = true, audio = false, still = false, staticThresh = 0.5 } = {}) {
  const info = await probe(file);
  if (!info) return { pass: false, detail: `${file} is missing or not media` };
  const notes = [];
  let ok = true;
  if (video) {
    if (!info.video) return { pass: false, detail: 'no video stream' };
    const d = info.duration > 0.1 && !still ? info.duration : 0;
    const times = d ? [0.1, 0.3, 0.5, 0.7, 0.9].map((f) => f * d) : [0];
    const frames = (await Promise.all(times.map((t) => frameAt(file, t, { width: 160, height: -1 })))).filter(Boolean);
    const lumas = frames.map((f) => lumaStats(f).mean);
    const bright = lumas.some((l) => l > 0.04);
    if (!bright) ok = false;
    notes.push(`luma ${lumas.map((l) => round(l, 3)).join('/')}`);
    if (!still && d) {
      let maxDiff = 0;
      for (let i = 1; i < frames.length; i++) maxDiff = Math.max(maxDiff, frameDiff(frames[i - 1], frames[i]).mean);
      if (maxDiff <= staticThresh) ok = false;
      notes.push(`max frame diff ${round(maxDiff, 2)}`);
    }
  }
  if (audio) {
    if (!info.audio) return { pass: false, detail: 'no audio stream' };
    const l = await loudness(file);
    if (!(l.integrated > -60)) ok = false;
    notes.push(`loudness ${l.integrated} LUFS`);
  }
  return { pass: ok, detail: notes.join(', ') };
}
