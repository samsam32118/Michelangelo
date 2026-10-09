/** Outline helpers that the page and the snapshot share (pure): the visible clips at a frame, a still's frame, ladder names. */
import type { Outline, StillShape } from './types.js';
import { tryTime } from './time.js';

export const LEVEL_NAMES = ['sketch', 'frames', 'sheet', 'draft', 'final'] as const;
/** typical cost of a rung (BOARD.md §4, 1080×1920 on 4 vCPU) */
export const LEVEL_COST = ['free', '0.05–0.5 s per still', '2–10 s', '≈0.3–2.5× real time', '≈1–3× real time'] as const;

export function compOf(o: Outline | null | undefined, comp?: string): Outline['comps'][number] | undefined {
  return o ? o.comps.find((c) => c.id === (comp ?? o.main)) ?? o.comps[0] : undefined;
}

/** ids of the visual clips visible at a frame (audio tracks left out), in track order */
export function clipsAt(o: Outline, comp: string, frame: number): string[] {
  const order = new Map(o.tracks.filter((t) => t.comp === comp && !t.audio).map((t, i) => [t.id, i] as const));
  return o.clips.filter((c) => order.has(c.track) && c.at <= frame && frame < c.at + c.len)
    .sort((a, b) => order.get(a.track)! - order.get(b.track)! || a.at - b.at).map((c) => c.id);
}

/** a still's comp and frame in the outline, or undefined */
export function stillAt(o: Outline | null | undefined, s: Pick<StillShape, 't' | 'comp'>): { comp: string; frame: number; fps: number } | undefined {
  const c = compOf(o, s.comp);
  const f = c ? tryTime(s.t, c.fps) : undefined;
  return c && f !== undefined ? { comp: c.id, frame: f, fps: c.fps } : undefined;
}
