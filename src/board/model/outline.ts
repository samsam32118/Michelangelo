/** The project as the board sees it: comps, tracks, clips (frames), a content hash; and which clips show at a frame. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseRate, parseTime, rateToNumber } from '../../core/time.js';
import { clipKind, type Clip } from '../../core/schema/index.js';
import type { Outline, TimeLike } from '../shared/types.js';

function clipLabel(c: Clip): string {
  if (c.text !== undefined) return c.text.length > 40 ? c.text.slice(0, 39) + '…' : c.text;
  if (c.asset !== undefined) return c.asset;
  if (c.comp !== undefined) return `comp ${c.comp}`;
  if (c.gen) return `gen ${(c.gen as { type?: string }).type ?? ''}`.trim();
  if (c.shape) return `shape ${(c.shape as { type?: string }).type ?? ''}`.trim();
  if (c.color !== undefined) return `solid ${String(c.color)}`;
  if (c.captions) return 'captions';
  if (c.adjustment) return 'adjustment';
  return c.id;
}

/** Read a project through the SDK (validated, plugins loaded). hash = sha1 of the file bytes. */
export async function projectOutline(projectPath: string): Promise<Outline> {
  const { open } = await import('../../sdk/index.js');
  const bytes = await readFile(projectPath);
  const p = await open(projectPath);
  const d = p.data;
  const tracks = (d.tracks ?? []).map((t) => ({ id: t.id, comp: t.comp, ...(t.audio ? { audio: true } : {}) }));
  const clips = (d.clips ?? []).map((c) => ({ id: c.id, track: c.track, at: c.at, len: c.len, kind: clipKind(c), label: clipLabel(c) }));
  const trackComp = new Map(tracks.map((t) => [t.id, t.comp]));
  const comps = d.comps.map((c) => {
    const length = typeof c.length === 'number' ? c.length : clips.reduce((m, x) => (trackComp.get(x.track) === c.id ? Math.max(m, x.at + x.len) : m), 0);
    return { id: c.id, size: c.size as [number, number], fps: rateToNumber(parseRate(c.fps)), length };
  });
  return { file: projectPath, main: p.mainComp().id, comps, tracks, clips, hash: createHash('sha1').update(bytes).digest('hex') };
}

/** Ids of the visual clips visible at a frame of a comp (audio tracks are left out), in track order. */
export function clipsAt(outline: Outline, comp: string, frame: number): string[] {
  const order = new Map(outline.tracks.filter((t) => t.comp === comp && !t.audio).map((t, i) => [t.id, i]));
  return outline.clips.filter((c) => order.has(c.track) && c.at <= frame && frame < c.at + c.len)
    .sort((a, b) => order.get(a.track)! - order.get(b.track)! || a.at - b.at).map((c) => c.id);
}

/** A board time → frames at a comp's rate. */
export function timeToFrames(t: TimeLike, fps: number): number {
  return parseTime(t, parseRate(fps), 'time');
}

/** Frames → a readable seconds string ("2.5s"). */
export function framesToTime(frames: number, fps: number): string {
  return `${Number((frames / fps).toFixed(3))}s`;
}

export function compOf(outline: Outline, comp?: string) {
  return outline.comps.find((c) => c.id === (comp ?? outline.main)) ?? outline.comps[0];
}
