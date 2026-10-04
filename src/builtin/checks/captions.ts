/**
 * Caption timing as people read it (project stage, no pixels): cues on screen too briefly to read, faster than people
 * read, or blinking off for a moment between two cues. The numbers are the caption timing defaults (CUE_TIMING),
 * so cues made by captions.from-speech or captions.from-text voice= pass.
 */
import { CUE_TIMING, defineCheck, type CheckContext, type Finding } from '../../plugin/api.js';

/**
 * Reading speed (characters per second) over which a cue is reported. Far past CUE_TIMING.maxCps on purpose:
 * word-timed captions follow the voice, and fast talk reaches 20–30 characters/s; only a cue faster than any
 * speech (text crammed into a short span) is a problem.
 */
export const FAST_CPS = 35;
/** A cue shown for less than this (s) is a flash. */
export const FLASH_S = 0.3;
/** Gaps (frames) up to this are a deliberate cut between cues (broadcast practice: 2 frames). */
const CUT_GAP = 2;

const fpsOf = (fps: number | string) => {
  if (typeof fps === 'number') return fps;
  const [n, d] = fps.split('/').map(Number);
  return d ? n! / d : n!;
};

export const captionTiming = defineCheck({
  id: 'caption-timing', stage: 'project',
  describe: 'caption cues shown too briefly or too fast to read, or blinking off for a moment between two cues',
  run(ctx: CheckContext): Finding[] {
    const p = ctx.project;
    const comp = p.comps.find((c) => c.id === ctx.compId) ?? p.comps[0];
    if (!comp) return [];
    const fps = fpsOf(comp.fps);
    const tracks = new Set((p.tracks ?? []).filter((t) => t.comp === comp.id && !t.audio && !t.hidden).map((t) => t.id));
    const out: Finding[] = [];
    for (const clip of (p.clips ?? []).filter((c) => c.captions && tracks.has(c.track) && !c.hidden)) {
      const cues = (p.cues ?? []).filter((q) => q.clip === clip.id).sort((a, b) => a.at - b.at);
      cues.forEach((q, i) => {
        const next = cues[i + 1];
        const s = q.len / fps;
        const chars = q.text.replace(/\*/g, '').length;
        const frame = clip.at + q.at;
        // room to stretch: up to the next cue, else the clip end
        const room = (next ? next.at : clip.len) - q.at;
        const want = Math.ceil(Math.max(CUE_TIMING.minLen, chars / CUE_TIMING.maxCps) * fps);
        const stretch = room > q.len ? ` fix: mgl edit <file> cue.set ${q.id} len=${Math.min(room, want)}` : '';
        if (s < FLASH_S) {
          out.push({ rule: 'caption-timing', severity: 'warning', clip: clip.id, frame, message: `cue "${q.id}" ("${q.text.slice(0, 24)}") is on screen for ${s.toFixed(2)} s: a flash, too short to read`, fix: stretch ? stretch.slice(6) : `mgl edit <file> cue.merge ids='["${q.id}","${next?.id ?? cues[i - 1]?.id ?? q.id}"]'` });
        } else if (chars / s > FAST_CPS) {
          out.push({ rule: 'caption-timing', severity: 'warning', clip: clip.id, frame, message: `cue "${q.id}" shows ${chars} characters for ${s.toFixed(2)} s (${Math.round(chars / s)} characters/s; people read about ${CUE_TIMING.maxCps})`, fix: stretch ? stretch.slice(6) : `mgl edit <file> captions.from-speech id=${clip.id} maxWords=3 # shorter cues; or cue.split ${q.id}` });
        }
        if (next) {
          const gap = next.at - (q.at + q.len);
          if (gap > CUT_GAP && gap / fps < CUE_TIMING.bridge) {
            out.push({ rule: 'caption-timing', severity: 'info', clip: clip.id, frame: frame + q.len, message: `captions blink off for ${(gap / fps).toFixed(2)} s between "${q.id}" and "${next.id}"`, fix: `mgl edit <file> cue.set ${q.id} len=${q.len + gap}` });
          }
        }
      });
    }
    return out;
  },
});
