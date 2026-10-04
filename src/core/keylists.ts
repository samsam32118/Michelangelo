/** Every keyframe list of a clip (animatable props, effect params, shape.trim, generator params), for code that retimes or collapses them. */
import type { Clip } from './schema/index.js';
import { ANIMATABLE_CLIP_KEYS, isKeyframes } from './load.js';

export interface KeyListRef {
  /** label like "x", "fx.0.radius", "shape.trim", "gen.speed" */
  label: string;
  keys: [number, unknown, unknown?][];
  /** replace the value (a constant or a new key list) */
  set(v: unknown): void;
}

export function keyLists(c: Clip): KeyListRef[] {
  const out: KeyListRef[] = [];
  const rec = c as Record<string, unknown>;
  for (const k of ANIMATABLE_CLIP_KEYS) {
    const v = rec[k];
    if (isKeyframes(v)) out.push({ label: k, keys: v as KeyListRef['keys'], set: (n) => { rec[k] = n; } });
  }
  (c.fx ?? []).forEach((fx, i) => {
    for (const [k, v] of Object.entries(fx)) if (k !== 'type' && isKeyframes(v)) out.push({ label: `fx.${i}.${k}`, keys: v as KeyListRef['keys'], set: (n) => { fx[k] = n; } });
  });
  if (c.shape && isKeyframes(c.shape.trim)) { const sh = c.shape; out.push({ label: 'shape.trim', keys: sh.trim as KeyListRef['keys'], set: (n) => { sh.trim = n as never; } }); }
  if (c.gen) {
    const g = c.gen as Record<string, unknown>;
    for (const [k, v] of Object.entries(g)) if (k !== 'type' && isKeyframes(v)) out.push({ label: `gen.${k}`, keys: v as KeyListRef['keys'], set: (n) => { g[k] = n; } });
  }
  return out;
}
