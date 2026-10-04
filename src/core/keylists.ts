/** Every keyframe list of a clip (animatable props, effect params, shape trims, mask boxes, generator params), for code that retimes or collapses them. */
import type { Clip } from './schema/index.js';
import { ANIMATABLE_CLIP_KEYS, SHAPE_ANIMATABLE, isKeyframes } from './load.js';

export interface KeyListRef {
  /** label like "x", "fx.0.radius", "shape.trim", "masks.0.box", "gen.speed" */
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
  if (c.shape) {
    const sh = c.shape as Record<string, unknown>;
    for (const f of SHAPE_ANIMATABLE) if (isKeyframes(sh[f])) out.push({ label: `shape.${f}`, keys: sh[f] as KeyListRef['keys'], set: (n) => { sh[f] = n; } });
  }
  (c.masks ?? []).forEach((m, i) => {
    const mr = m as Record<string, unknown>;
    if (isKeyframes(mr.box)) out.push({ label: `masks.${i}.box`, keys: mr.box as KeyListRef['keys'], set: (n) => { mr.box = n; } });
  });
  if (c.gen) {
    const g = c.gen as Record<string, unknown>;
    for (const [k, v] of Object.entries(g)) if (k !== 'type' && isKeyframes(v)) out.push({ label: `gen.${k}`, keys: v as KeyListRef['keys'], set: (n) => { g[k] = n; } });
  }
  return out;
}
