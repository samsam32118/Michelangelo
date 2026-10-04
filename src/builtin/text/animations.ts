import { defineTextAnimation, type TextAnimationDef } from '../../plugin/api.js';

const c01 = (p: number) => Math.min(1, Math.max(0, p));
function outBounce(t: number): number {
  const n = 7.5625, d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
}

/** Built-in text animation presets: the state of one unit (char / word / line / all) at progress p (1 = at rest). */
export const textAnimations: TextAnimationDef[] = [
  defineTextAnimation({ id: 'none', describe: 'No animation (shown at rest).', state: () => ({}) }),
  defineTextAnimation({ id: 'fade', describe: 'Fade in.', state: (p) => ({ opacity: c01(p) }) }),
  defineTextAnimation({
    id: 'pop', describe: 'Scale 0.6 → 1.08 → 1 with a quick fade: a punchy overshoot.', easing: 'linear',
    state: (p) => {
      const q = c01(p);
      const scale = q < 0.6 ? 0.6 + 0.48 * (1 - (1 - q / 0.6) ** 2) : 1.08 - 0.08 * ((q - 0.6) / 0.4);
      return { scale, opacity: c01(q * 3) };
    },
  }),
  defineTextAnimation({ id: 'slide-up', describe: 'Rise 40 px into place while fading in.', state: (p) => ({ dy: (1 - p) * 40, opacity: c01(p) }) }),
  defineTextAnimation({ id: 'slide-down', describe: 'Drop 40 px into place while fading in.', state: (p) => ({ dy: -(1 - p) * 40, opacity: c01(p) }) }),
  defineTextAnimation({ id: 'slide-left', describe: 'Slide in 60 px from the right while fading in.', state: (p) => ({ dx: (1 - p) * 60, opacity: c01(p) }) }),
  defineTextAnimation({ id: 'typewriter', describe: 'Each unit appears at once (use by: "char").', easing: 'linear', state: (p) => ({ opacity: p > 0 ? 1 : 0 }) }),
  defineTextAnimation({ id: 'blur-in', describe: 'Sharpen from a 12 px blur while fading in.', state: (p) => ({ blur: (1 - c01(p)) * 12, opacity: c01(p) }) }),
  defineTextAnimation({ id: 'bounce', describe: 'Fall 60 px and bounce to rest.', easing: 'linear', state: (p) => ({ dy: -(1 - outBounce(c01(p))) * 60, opacity: c01(p * 4) }) }),
  defineTextAnimation({ id: 'scale-in', describe: 'Grow from 0 to full size while fading in.', state: (p) => ({ scale: Math.max(0, p), opacity: c01(p) }) }),
  defineTextAnimation({ id: 'drop', describe: 'Drop 80 px from above with a slight overshoot.', easing: 'outBack', state: (p) => ({ dy: -(1 - p) * 80, opacity: c01(p * 2) }) }),
  defineTextAnimation({ id: 'wave', describe: 'Each unit hops up 24 px and lands (stagger makes a wave).', easing: 'linear', state: (p) => ({ dy: -Math.sin(c01(p) * Math.PI) * 24, opacity: c01(p * 3) }) }),
];

export const TEXT_ANIMATION_IDS: string[] = textAnimations.map((a) => a.id);
