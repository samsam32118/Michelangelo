/**
 * FrameProvider over the media backend.
 *
 * - sequential mode (render): one VideoReader per media clip, kept open across frames. MediaSource carries no
 *   clip id, so readers are pooled per (file, filters) and a request goes to the reader whose position is just
 *   behind it; two clips of the same asset get two readers.
 * - random mode (stills): frame-accurate grabs, cached and coalesced; `prefetch` warms the cache in parallel.
 * Images are decoded once per (file, filters) and re-decoded only when drawn larger than the cached copy.
 * Every decode is scaled to the layer's drawn size (`maxSize`, from the renderer) so small layers decode small.
 */
import { isAbsolute, resolve } from 'node:path';
import type { MediaBackend, VideoReader } from '../media/types.js';
import type { DisplayNode, FrameProvider, Matrix, MediaSource, RGBAFrame } from './types.js';
import { multiply } from './matrix.js';

type Size = { w: number; h: number };

export interface MediaFramesOptions {
  backend: MediaBackend;
  /** directory relative asset paths resolve against (the project file's directory) */
  baseDir: string;
  mode?: 'sequential' | 'random';
  /** most readers kept open per (file, filters) */
  maxReaders?: number;
}

interface ReaderSlot { reader: Promise<VideoReader>; size: Size; pos: number; used: number; queue: Promise<unknown>; recent: Map<number, { size: Size; frame: Promise<RGBAFrame> }> }
interface Cached { size: Size; frame: Promise<RGBAFrame> }

/** Grow a decode size a little past the request so slow zooms do not reopen the decoder every frame. */
const GROW = 1.25;
/** a reader serves requests up to this many frames ahead before a fresh reader (or a seek) is better */
const AHEAD = 60;
const CLOSE_WAIT_MS = 100;

const fits = (have: Size, want: Size) => have.w >= want.w - 1 && have.h >= want.h - 1;
/** a decoded frame smaller than what was asked for is already the source's full size */
const isFull = (req: Size, f: RGBAFrame) => f.width < req.w - 1 && f.height < req.h - 1;
const evenUp = (v: number) => Math.max(2, Math.ceil(v / 2) * 2);

export class MediaFrames implements FrameProvider {
  readonly backend: MediaBackend;
  readonly baseDir: string;
  readonly mode: 'sequential' | 'random';
  private maxReaders: number;
  private readers = new Map<string, ReaderSlot[]>();
  private images = new Map<string, Cached & { full?: boolean }>();
  private grabs = new Map<string, (Cached & { full?: boolean })[]>();
  private tick = 0;
  /** counters (tests, estimates) */
  stats = { readerOpens: 0, imageDecodes: 0, grabs: 0 };

  constructor(o: MediaFramesOptions) {
    this.backend = o.backend;
    this.baseDir = o.baseDir;
    this.mode = o.mode ?? 'sequential';
    this.maxReaders = o.maxReaders ?? 4;
  }

  path(src: MediaSource): string { return isAbsolute(src.src) ? src.src : resolve(this.baseDir, src.src); }
  private key(src: MediaSource): string { return `${this.path(src)}\u0000${JSON.stringify(src.filters ?? [])}`; }

  get(src: MediaSource, maxSize: Size): Promise<RGBAFrame> {
    const want = { w: Math.max(1, Math.round(maxSize.w)), h: Math.max(1, Math.round(maxSize.h)) };
    if (src.kind === 'image') return this.image(src, want);
    return this.mode === 'random' ? this.grab(src, want) : this.sequential(src, want);
  }

  /** Warm the random-access cache (stills); resolves when decoded. */
  prefetch(src: MediaSource, maxSize: Size): Promise<RGBAFrame> { return this.get(src, maxSize); }

  private image(src: MediaSource, want: Size): Promise<RGBAFrame> {
    const k = this.key(src);
    const c = this.images.get(k);
    if (c && (c.full || fits(c.size, want))) return c.frame;
    const size = { w: evenUp(want.w * (c ? GROW : 1)), h: evenUp(want.h * (c ? GROW : 1)) };
    const file = this.path(src);
    this.stats.imageDecodes++;
    const frame = src.filters?.length
      ? this.backend.grab(file, 0, src.rate, { maxSize: size, filters: src.filters })
      : this.backend.decodeImage(file, size);
    const entry: Cached & { full?: boolean } = { size, frame };
    frame.then((f) => { entry.full = isFull(size, f); }, () => this.images.delete(k));
    this.images.set(k, entry);
    return frame;
  }

  private grab(src: MediaSource, want: Size): Promise<RGBAFrame> {
    const k = `${this.key(src)}\u0000${src.sourceFrame}/${src.rate.num}/${src.rate.den}`;
    const list = this.grabs.get(k) ?? [];
    const hit = list.find((c) => c.full || fits(c.size, want));
    if (hit) return hit.frame;
    const size = { w: evenUp(want.w), h: evenUp(want.h) };
    this.stats.grabs++;
    const frame = this.backend.grab(this.path(src), src.sourceFrame, src.rate, { maxSize: size, ...(src.filters?.length ? { filters: src.filters } : {}) });
    const entry: Cached & { full?: boolean } = { size, frame };
    frame.then((f) => { entry.full = isFull(size, f); }, () => this.grabs.set(k, (this.grabs.get(k) ?? []).filter((e) => e !== entry)));
    list.push(entry);
    this.grabs.set(k, list);
    return frame;
  }

  private sequential(src: MediaSource, want: Size): Promise<RGBAFrame> {
    const k = this.key(src);
    const slots = this.readers.get(k) ?? [];
    this.readers.set(k, slots);
    const sf = src.sourceFrame;
    // already requested (a prefetch, or a second layer showing the same frame)
    for (const s of slots) {
      const r = s.recent.get(sf);
      if (r && fits(r.size, want)) { s.used = ++this.tick; return r.frame; }
    }
    // the reader just behind the request (or exactly at it)
    let slot = slots.filter((s) => s.pos <= sf && sf - s.pos <= AHEAD).sort((a, b) => b.pos - a.pos)[0];
    if (!slot) {
      if (slots.length < this.maxReaders) slot = this.open(src, want, slots);
      else slot = slots.sort((a, b) => a.used - b.used)[0]!; // least recently used seeks
    }
    if (!fits(slot.size, want)) {
      const old = slot;
      slots.splice(slots.indexOf(old), 1);
      void old.queue.then(() => old.reader).then((r) => r.close(), () => {});
      slot = this.open(src, { w: want.w * GROW, h: want.h * GROW }, slots);
    }
    const s = slot;
    s.used = ++this.tick;
    s.pos = sf;
    const p = s.queue.then(() => s.reader).then((r) => r.frame(sf, src.rate));
    s.queue = p.catch(() => {});
    s.recent.set(sf, { size: s.size, frame: p });
    if (s.recent.size > 4) s.recent.delete(s.recent.keys().next().value!);
    return p;
  }

  private open(src: MediaSource, size: Size, slots: ReaderSlot[]): ReaderSlot {
    const sz = { w: evenUp(size.w), h: evenUp(size.h) };
    this.stats.readerOpens++;
    const reader = this.backend.openVideo(this.path(src), { rate: src.rate, maxSize: sz, ...(src.filters?.length ? { filters: src.filters } : {}) });
    reader.catch(() => {});
    const slot: ReaderSlot = { reader, size: sz, pos: src.sourceFrame, used: ++this.tick, queue: Promise.resolve(), recent: new Map() };
    slots.push(slot);
    return slot;
  }

  /** Close every reader and drop caches. */
  async close(): Promise<void> {
    const all = [...this.readers.values()].flat();
    this.readers.clear();
    this.images.clear();
    this.grabs.clear();
    // a reader's close() can wait forever for a paused stdout after the kill; the kill itself is immediate
    const closing = Promise.all(all.map((s) => s.queue.then(() => s.reader).then((r) => r.close(), () => {})));
    await Promise.race([closing, new Promise((r) => setTimeout(r, CLOSE_WAIT_MS))]);
  }
}

export function createFrameProvider(o: MediaFramesOptions): MediaFrames { return new MediaFrames(o); }

/** Run async jobs with at most `n` in flight. */
export async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * The media frames a display list will ask for, with the size the renderer will request
 * (layer box × the scale of layer px → output px), so decodes can start before drawing.
 */
export function mediaRequests(nodes: DisplayNode[], root: Matrix): { src: MediaSource; size: Size }[] {
  const out: { src: MediaSource; size: Size }[] = [];
  const walk = (ns: DisplayNode[], m: Matrix) => {
    for (const n of ns) {
      if (n.type === 'transition') { walk(n.from, m); walk(n.to, m); continue; }
      const t = multiply(m, n.matrix);
      if (n.matte) walk([n.matte.node], m);
      if (n.type !== 'layer') continue;
      if (n.source.type === 'media') {
        const k = Math.min(8, Math.max(0.02, Math.max(Math.hypot(t[0], t[1]), Math.hypot(t[2], t[3]))));
        out.push({ src: n.source, size: { w: Math.max(1, Math.round(n.box.w * k)), h: Math.max(1, Math.round(n.box.h * k)) } });
      } else if (n.source.type === 'comp' && n.source.list) walk(n.source.list.nodes, t);
    }
  };
  walk(nodes, root);
  return out;
}
