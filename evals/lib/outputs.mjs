// Helpers to locate the clips a task asked for in a raw project, wherever the agent put them.
import { textClips, absoluteSpans, clipsInComp, compOfClip, isKeyframes, easingsOf } from './project.mjs';

/** Text clips whose text matches re, with their absolute spans in the main comp. */
export function textClipsMatching(p, re) {
  return textClips(p).filter((c) => re.test(c.text)).map((c) => ({ clip: c, spans: absoluteSpans(p, c) }));
}

/** The clips that belong with `c`: the same comp's clips sharing its span (template groups), plus c. */
export function groupOf(p, c) {
  const comp = compOfClip(p, c);
  if (!comp) return [c];
  const s = absoluteSpans(p, c)[0];
  return clipsInComp(p, comp.id).filter((x) => {
    const xs = absoluteSpans(p, x)[0];
    return x === c || (xs && s && Math.abs(xs.end - s.end) < 0.6 && xs.start >= s.start - 0.6 && xs.start <= s.start + 1);
  });
}

const ANIM = ['x', 'y', 'scale', 'rotate', 'opacity'];
/** Does a clip animate (keyframes on transform/opacity, an animate preset, a fade or a transition)? */
export function isAnimated(c) {
  return ANIM.some((k) => isKeyframes(c[k])) || !!(c.animate && (c.animate.in || c.animate.out)) || !!c.transition || (Array.isArray(c.fade) && c.fade.some((f) => f !== 0 && f !== '0'));
}

/** Easing names and animate presets used by a clip. */
export function motionOf(c) {
  return { easings: ANIM.flatMap((k) => easingsOf(c[k])), presets: [c.animate?.in, c.animate?.out].filter(Boolean), transitions: [c.transition?.in?.type, c.transition?.out?.type].filter(Boolean) };
}
