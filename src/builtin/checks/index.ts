/**
 * Built-in QA checks (public plugin API only).
 * project: from the data and evaluated layer boxes (`check`); frame: from rendered stills (`look`);
 * audio: from the mix analysis (`look`). Every finding names the clip, the time, and a ready-to-run fix.
 */
import { definePlugin, defineCheck, type CheckContext, type CheckDef, type Finding } from '../../plugin/api.js';

type Project = CheckContext['project'];
type Clip = NonNullable<Project['clips']>[number];
type Box = [number, number, number, number];
type Layer = NonNullable<CheckContext['layers']> extends Map<number, (infer L)[]> ? L : never;
type Rect = { x: number; y: number; w: number; h: number };

// ------------------------------------------------------------------------------------------- helpers

function fpsOf(fps: number | string): number {
  if (typeof fps === 'number') return fps;
  const [n, d] = fps.split('/').map(Number);
  return d ? n! / d : n!;
}

interface Comp { id: string; W: number; H: number; fps: number; length?: number; bg?: string; tracks: NonNullable<Project['tracks']>; clips: Clip[] }

function compOf(ctx: CheckContext): Comp {
  const c = ctx.project.comps.find((x) => x.id === ctx.compId) ?? ctx.project.comps[0]!;
  const tracks = (ctx.project.tracks ?? []).filter((t) => t.comp === c.id);
  const ids = new Set(tracks.map((t) => t.id));
  const comp: Comp = { id: c.id, W: c.size[0], H: c.size[1], fps: fpsOf(c.fps), tracks, clips: (ctx.project.clips ?? []).filter((x) => ids.has(x.track)) };
  if (typeof c.length === 'number') comp.length = c.length;
  if (c.bg) comp.bg = c.bg;
  return comp;
}

const sec = (frame: number, fps: number) => `${(frame / fps).toFixed(2)}s`;
const quote = (t: string | undefined) => (t === undefined ? '' : `"${t.length > 24 ? t.slice(0, 23) + '…' : t}" `);
const isText = (kind: string) => kind === 'text' || kind === 'captions';
const area = (b: Box) => Math.max(0, b[2]) * Math.max(0, b[3]);
const fullFrame = (b: Box, c: Comp) => area(intersect(b, [0, 0, c.W, c.H])) >= 0.8 * c.W * c.H;
const round = (b: Box): Box => b.map((v) => Math.round(v)) as Box;

function intersect(a: Box, b: Box): Box {
  const x = Math.max(a[0], b[0]), y = Math.max(a[1], b[1]);
  return [x, y, Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - x), Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - y)];
}

const keyed = (v: unknown): v is [number, unknown, unknown?][] => Array.isArray(v) && v.length > 0 && Array.isArray(v[0]);

/** ctx.layers as [frame, layers] sorted by frame. */
function layerFrames(ctx: CheckContext): [number, Layer[]][] {
  return [...(ctx.layers ?? new Map<number, Layer[]>())].sort((a, b) => a[0] - b[0]);
}

/** A fix that moves/narrows a clip so its box fits inside `r`. */
function fitFix(clip: Clip | undefined, id: string, box: Box, r: Rect, c: Comp): string {
  if (box[2] > r.w) return `mgl edit <file> clip.set ${id} style.maxWidth=${Math.floor(r.w)}`;
  if (box[3] > r.h) return `mgl edit <file> clip.set ${id} style.maxLines=2`;
  let dx = 0, dy = 0;
  if (box[0] < r.x) dx = r.x - box[0]; else if (box[0] + box[2] > r.x + r.w) dx = r.x + r.w - (box[0] + box[2]);
  if (box[1] < r.y) dy = r.y - box[1]; else if (box[1] + box[3] > r.y + r.h) dy = r.y + r.h - (box[1] + box[3]);
  return moveFix(clip, id, dx, dy, c, box);
}

function moveFix(clip: Clip | undefined, id: string, dx: number, dy: number, c: Comp, box: Box): string {
  const parts: string[] = [];
  for (const [prop, d, centre, def] of [['x', dx, box[0] + box[2] / 2, c.W / 2], ['y', dy, box[1] + box[3] / 2, c.H / 2]] as const) {
    if (Math.abs(d) < 0.5) continue;
    const v = clip?.[prop];
    if (keyed(v)) return `mgl edit <file> key.clear ${id} prop=${prop} value=${Math.round(centre + d)}`;
    parts.push(`${prop}=${Math.round((typeof v === 'number' ? v : def) + d)}`);
  }
  return `mgl edit <file> clip.set ${id} ${parts.join(' ') || `y=${Math.round(c.H / 2)}`}`;
}

/** Is the clip inside a fade or transition window at comp frame f (intentional dark/held frames)? */
function inFade(clip: Clip, f: number): boolean {
  const s = f - clip.at, e = clip.at + clip.len - f;
  const fi = Math.max(clip.fade?.[0] ?? 0, clip.transition?.in?.len ?? 0), fo = Math.max(clip.fade?.[1] ?? 0, clip.transition?.out?.len ?? 0);
  return s < fi || e <= fo;
}

const clipAt = (c: Comp, f: number, pred: (x: Clip) => boolean = () => true) => c.clips.find((x) => f >= x.at && f < x.at + x.len && pred(x));
const byId = (c: Comp) => new Map(c.clips.map((x) => [x.id, x]));
const mainTrack = (c: Comp) => c.tracks.find((t) => !t.audio && !t.hidden);
const onTrack = (c: Comp, track: string) => c.clips.filter((x) => x.track === track && !x.hidden).sort((a, b) => a.at - b.at);

// ------------------------------------------------------------------------------------------- project stage

const gaps = defineCheck({
  id: 'gaps', stage: 'project', describe: 'black gaps on the main (bottom) visual track',
  run(ctx) {
    const c = compOf(ctx), t = mainTrack(c);
    if (!t) return [];
    const clips = onTrack(c, t.id), out: Finding[] = [];
    let end = 0;
    for (const x of clips) {
      if (x.at > end) out.push({ rule: 'gaps', severity: 'warning', frame: end, clip: x.id,
        message: `gap on main track ${t.id} ${sec(end, c.fps)}–${sec(x.at, c.fps)} shows black before "${x.id}"`,
        fix: `mgl edit <file> clip.move ${x.id} at=${end}` });
      end = Math.max(end, x.at + x.len);
    }
    if (clips.length && c.length !== undefined && end < c.length) {
      const last = clips.at(-1)!;
      out.push({ rule: 'gaps', severity: 'warning', frame: end, clip: last.id,
        message: `main track ${t.id} ends at ${sec(end, c.fps)} ("${last.id}") but comp ${c.id} runs to ${sec(c.length, c.fps)}: black tail`,
        fix: `mgl edit <file> comp.set ${c.id} length=auto` });
    }
    return out;
  },
});

const textOutsideSafe = defineCheck({
  id: 'text-outside-safe', stage: 'project', describe: 'text or captions outside the platform safe zone',
  run(ctx) {
    const c = compOf(ctx), r = ctx.safeArea(ctx.platform), clips = byId(c), seen = new Set<string>(), out: Finding[] = [];
    for (const [f, layers] of layerFrames(ctx)) for (const l of layers) {
      if (!isText(l.kind) || seen.has(l.clipId)) continue;
      const b = l.box;
      if (b[0] >= r.x - 1 && b[1] >= r.y - 1 && b[0] + b[2] <= r.x + r.w + 1 && b[1] + b[3] <= r.y + r.h + 1) continue;
      if (b[0] + b[2] <= 0 || b[1] + b[3] <= 0 || b[0] >= c.W || b[1] >= c.H) continue; // off-screen (animating in)
      seen.add(l.clipId);
      const side = b[1] + b[3] > r.y + r.h ? 'bottom' : b[1] < r.y ? 'top' : b[0] + b[2] > r.x + r.w ? 'right' : 'left';
      out.push({ rule: 'text-outside-safe', severity: 'warning', frame: f, clip: l.clipId, box: round(b),
        message: `${l.kind} ${quote(l.text)}(${l.clipId}) crosses the ${side} of the ${ctx.platform === 'none' ? 'title' : ctx.platform}-safe area at ${sec(f, c.fps)}`,
        fix: fitFix(clips.get(l.clipId), l.clipId, b, r, c) });
    }
    return out;
  },
});

const hasBox = (clip: unknown): boolean => {
  const st = (clip as { style?: unknown } | undefined)?.style;
  return !!st && typeof st === 'object' && 'box' in st && (st as { box?: unknown }).box !== undefined;
};

const tinyText = defineCheck({
  id: 'tiny-text', stage: 'project', describe: 'text smaller than 2.5% of the frame height at rest',
  run(ctx) {
    const c = compOf(ctx), clips = byId(c), min = 0.025 * c.H;
    const best = new Map<string, { f: number; l: Layer }>();
    for (const [f, layers] of layerFrames(ctx)) for (const l of layers) {
      if (!isText(l.kind) || l.fontPx === undefined) continue;
      const b = best.get(l.clipId);
      if (!b || l.fontPx > b.l.fontPx!) best.set(l.clipId, { f, l });
    }
    const out: Finding[] = [];
    for (const [id, { f, l }] of best) {
      if (l.fontPx! >= min) continue;
      const sc = clips.get(id)?.scale, s = typeof sc === 'number' ? sc : Array.isArray(sc) && typeof sc[0] === 'number' ? Math.min(sc[0], sc[1] as number) : 1;
      out.push({ rule: 'tiny-text', severity: 'warning', frame: f, clip: id, box: round(l.box),
        message: `${l.kind} ${quote(l.text)}(${id}) is ${Math.round(l.fontPx!)}px at ${sec(f, c.fps)}, under 2.5% of the ${c.H}px frame height (${Math.ceil(min)}px)`,
        // a fixed text box shrinks text to fit, so a bigger size alone changes nothing: drop the box too
        fix: `mgl edit <file> clip.set ${id} style.size=${Math.ceil((0.03 * c.H) / (s || 1))}${hasBox(clips.get(id)) ? ' style.box=null' : ''}` });
    }
    return out;
  },
});

/** Pairs (text layer, other content layer) whose boxes intersect at a frame. */
function overlaps(c: Comp, layers: Layer[]): { t: Layer; o: Layer; i: Box }[] {
  const out: { t: Layer; o: Layer; i: Box }[] = [];
  for (const t of layers) {
    if (!isText(t.kind)) continue;
    for (const o of layers) {
      if (o === t || o.clipId === t.clipId || !['image', 'video', 'gen', 'comp', 'text', 'captions'].includes(o.kind) || fullFrame(o.box, c)) continue;
      const i = intersect(t.box, o.box);
      if (area(i) > 0.02 * Math.min(area(t.box), area(o.box))) out.push({ t, o, i });
    }
  }
  return out;
}

function awayFix(c: Comp, clips: Map<string, Clip>, t: Layer, o: Layer): string {
  const above = o.box[1] + o.box[3] / 2 < t.box[1] + t.box[3] / 2, gap = Math.round(c.H * 0.01);
  const dy = above ? t.box[1] - gap - (o.box[1] + o.box[3]) : t.box[1] + t.box[3] + gap - o.box[1];
  const ny = o.box[1] + dy;
  if (ny >= 0 && ny + o.box[3] <= c.H) return moveFix(clips.get(o.clipId), o.clipId, 0, dy, c, o.box);
  return moveFix(clips.get(t.clipId), t.clipId, 0, above ? o.box[1] + o.box[3] + gap - t.box[1] : o.box[1] - gap - (t.box[1] + t.box[3]), c, t.box);
}

const captionOverlap = defineCheck({
  id: 'caption-overlap', stage: 'project', describe: 'a caption or text box overlaps another visible element (by layout box)',
  run(ctx) {
    const c = compOf(ctx), clips = byId(c), seen = new Set<string>(), out: Finding[] = [];
    for (const [f, layers] of layerFrames(ctx)) for (const { t, o, i } of overlaps(c, layers)) {
      const key = [t.clipId, o.clipId].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ rule: 'caption-overlap', severity: 'warning', frame: f, clip: t.clipId, box: round(i),
        message: `${t.kind} ${quote(t.text)}(${t.clipId}) overlaps ${o.kind} "${o.clipId}" at ${sec(f, c.fps)}`,
        fix: awayFix(c, clips, t, o) });
    }
    return out;
  },
});

const clipPastEnd = defineCheck({
  id: 'clip-past-end', stage: 'project', describe: 'clips that run past the comp length',
  run(ctx) {
    const c = compOf(ctx);
    if (c.length === undefined) return [];
    const L = c.length;
    return c.clips.filter((x) => x.at + x.len > L).map((x): Finding => x.at >= L
      ? { rule: 'clip-past-end', severity: 'warning', frame: x.at, clip: x.id, message: `clip "${x.id}" starts at ${sec(x.at, c.fps)}, after comp ${c.id} ends (${sec(L, c.fps)}): never seen`, fix: `mgl edit <file> comp.set ${c.id} length=auto` }
      : { rule: 'clip-past-end', severity: 'warning', frame: L, clip: x.id, message: `clip "${x.id}" runs to ${sec(x.at + x.len, c.fps)}, past comp ${c.id}'s end at ${sec(L, c.fps)}: cut off`, fix: `mgl edit <file> clip.trim ${x.id} end=${L}` });
  },
});

const ANIMATABLE = ['x', 'y', 'scale', 'rotate', 'opacity', 'gain', 'remap'] as const;
const keyframesOutside = defineCheck({
  id: 'keyframes-outside', stage: 'project', describe: 'keyframes outside the clip\'s span (never reached)',
  run(ctx) {
    const c = compOf(ctx), out: Finding[] = [];
    for (const x of c.clips) {
      const lo = x.clock ?? 0, hi = lo + x.len;
      const props: [string, unknown][] = ANIMATABLE.map((p) => [p, x[p]]);
      x.fx?.forEach((e, i) => { for (const [k, v] of Object.entries(e)) props.push([`fx.${i}.${k}`, v]); });
      for (const [prop, v] of props) {
        if (!keyed(v)) continue;
        const bad = v.map((k) => k[0]).filter((t) => t < lo || t > hi);
        if (!bad.length) continue;
        out.push({ rule: 'keyframes-outside', severity: 'warning', frame: x.at + Math.min(Math.max(bad[0]! - lo, 0), x.len - 1), clip: x.id,
          message: `clip "${x.id}" ${prop} has ${bad.length} keyframe${bad.length > 1 ? 's' : ''} outside its span 0–${x.len} (at ${bad.join(', ')}); the clip never reaches ${bad.length > 1 ? 'them' : 'it'}`,
          fix: `mgl edit <file> key.remove ${x.id} prop=${prop} at=${bad[0]}` });
      }
    }
    return out;
  },
});

// ------------------------------------------------------------------------------------------- frame stage

type Img = NonNullable<CheckContext['frames']> extends Map<number, infer I> ? I : never;

/** Mean luma (0..1, BT.709) of a region (comp px) of a frame. */
function meanLuma(img: Img, region?: Box, step = 2): number {
  const [x0, y0, x1, y1] = regionPx(img, region);
  let sum = 0, n = 0;
  for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
    const i = (y * img.width + x) * 4;
    sum += (0.2126 * img.data[i]! + 0.7152 * img.data[i + 1]! + 0.0722 * img.data[i + 2]!) * (img.data[i + 3]! / 255);
    n++;
  }
  return n ? sum / n / 255 : 0;
}

function regionPx(img: Img, r?: Box): [number, number, number, number] {
  if (!r) return [0, 0, img.width, img.height];
  const s = img.scale, cl = (v: number, m: number) => Math.min(m, Math.max(0, Math.round(v)));
  return [cl(r[0] * s, img.width), cl(r[1] * s, img.height), cl((r[0] + r[2]) * s, img.width), cl((r[1] + r[3]) * s, img.height)];
}

/** Mean absolute difference (0..1) of two frames on a coarse grid. */
function frameDiff(a: Img, b: Img): number {
  if (a.width !== b.width || a.height !== b.height) return 1;
  let sum = 0, n = 0;
  const step = Math.max(1, Math.floor(Math.min(a.width, a.height) / 90));
  for (let y = 0; y < a.height; y += step) for (let x = 0; x < a.width; x += step) {
    const i = (y * a.width + x) * 4;
    sum += Math.abs(a.data[i]! - b.data[i]!) + Math.abs(a.data[i + 1]! - b.data[i + 1]!) + Math.abs(a.data[i + 2]! - b.data[i + 2]!);
    n += 3;
  }
  return sum / n / 255;
}

function parseColor(s: string | undefined): [number, number, number] {
  const m = /^#([0-9a-f]{3,8})$/i.exec(s ?? '');
  if (!m) return s === 'white' ? [255, 255, 255] : [0, 0, 0];
  const h = m[1]!.length < 6 ? [...m[1]!.slice(0, 3)].map((ch) => ch + ch).join('') : m[1]!;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const sortedFrames = (ctx: CheckContext) => [...(ctx.frames ?? new Map<number, Img>())].sort((a, b) => a[0] - b[0]);

const blackFrames = defineCheck({
  id: 'black-frames', stage: 'frame', describe: 'black stretches (mean luma < 0.03) in the sampled frames',
  run(ctx) {
    const c = compOf(ctx), out: Finding[] = [];
    const frames = sortedFrames(ctx);
    let run: number[] = [];
    const flush = () => {
      if (!run.length) return;
      const f = run[0]!, layers = (ctx.layers?.get(f) ?? []).filter((l) => l.kind !== 'adjustment');
      const media = [...layers].reverse().find((l) => l.kind === 'video' || l.kind === 'image');
      const t = mainTrack(c), next = t ? onTrack(c, t.id).find((x) => x.at > f) : undefined;
      const span = run.length > 1 ? `${sec(f, c.fps)}–${sec(run.at(-1)!, c.fps)} (${run.length} sampled frames)` : `at ${sec(f, c.fps)}`;
      if (media) out.push({ rule: 'black-frames', severity: 'warning', frame: f, clip: media.clipId, message: `black frame ${span} in "${media.clipId}"`, fix: `mgl edit <file> clip.slip ${media.clipId} by=1s` });
      else if (!layers.length && next) out.push({ rule: 'black-frames', severity: 'warning', frame: f, clip: next.id, message: `black frame ${span}: nothing is on screen before "${next.id}"`, fix: `mgl edit <file> clip.move ${next.id} at=${f}` });
      else if (!layers.length) out.push({ rule: 'black-frames', severity: 'warning', frame: f, message: `black frame ${span}: nothing is on screen`, fix: `mgl edit <file> comp.set ${c.id} length=auto` });
      else out.push({ rule: 'black-frames', severity: 'info', frame: f, clip: layers.at(-1)!.clipId, message: `black frame ${span} with "${layers.at(-1)!.clipId}" on top`, fix: `mgl edit <file> comp.set ${c.id} bg=#202020` });
      run = [];
    };
    for (const [f, img] of frames) {
      const dark = meanLuma(img, undefined, Math.max(1, Math.floor(img.width / 120))) < 0.03;
      const intentional = c.clips.some((x) => f >= x.at && f < x.at + x.len && inFade(x, f));
      if (dark && !intentional) run.push(f); else flush();
    }
    flush();
    return out;
  },
});

const frozen = defineCheck({
  id: 'frozen', stage: 'frame', describe: 'a video clip shows the same picture in consecutive sampled frames',
  run(ctx) {
    const c = compOf(ctx), clips = byId(c), out: Finding[] = [], seen = new Set<string>();
    const frames = sortedFrames(ctx);
    for (let i = 1; i < frames.length; i++) {
      const [fa, a] = frames[i - 1]!, [fb, b] = frames[i]!;
      const la = ctx.layers?.get(fa) ?? [], lb = ctx.layers?.get(fb) ?? [];
      const v = lb.find((l) => l.kind === 'video' && area(l.box) >= 0.25 * c.W * c.H && la.some((x) => x.clipId === l.clipId));
      if (!v || seen.has(v.clipId)) continue;
      const clip = clips.get(v.clipId);
      if (clip && (clip.speed === 0 || clip.speed === '0' || clip.remap !== undefined)) continue;
      if (frameDiff(a, b) > 0.002) continue;
      seen.add(v.clipId);
      out.push({ rule: 'frozen', severity: 'warning', frame: fa, clip: v.clipId, box: round(v.box),
        message: `video "${v.clipId}" is frozen ${sec(fa, c.fps)}–${sec(fb, c.fps)} (source ended or a still frame)`,
        fix: `mgl edit <file> clip.trim ${v.clipId} end=${fa + 1} ripple=true` });
    }
    return out;
  },
});

const overlapAlpha = defineCheck({
  id: 'overlap-alpha', stage: 'frame', describe: 'caption or text drawn over another element\'s visible pixels (refines caption-overlap)',
  run(ctx) {
    const c = compOf(ctx), clips = byId(c), bg = parseColor(c.bg), seen = new Set<string>(), out: Finding[] = [];
    for (const [f, img] of sortedFrames(ctx)) {
      const layers = ctx.layers?.get(f);
      if (!layers) continue;
      for (const { t, o, i } of overlaps(c, layers)) {
        const key = [t.clipId, o.clipId].sort().join('|');
        if (seen.has(key)) continue;
        // pixels in the shared box that differ from the background: glyphs alone cover < 35%, glyphs over an opaque element far more
        const [x0, y0, x1, y1] = regionPx(img, i);
        let hit = 0, n = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
          const k = (y * img.width + x) * 4;
          n++;
          if (Math.abs(img.data[k]! - bg[0]) + Math.abs(img.data[k + 1]! - bg[1]) + Math.abs(img.data[k + 2]! - bg[2]) > 48) hit++;
        }
        if (!n || hit / n < 0.35) continue;
        seen.add(key);
        out.push({ rule: 'overlap-alpha', severity: 'warning', frame: f, clip: t.clipId, box: round(i),
          message: `${t.kind} ${quote(t.text)}(${t.clipId}) is drawn over ${o.kind} "${o.clipId}" at ${sec(f, c.fps)} (${Math.round((100 * hit) / n)}% of the shared area covered)`,
          fix: awayFix(c, clips, t, o) });
      }
    }
    return out;
  },
});

const textCutOff = defineCheck({
  id: 'text-cut-off', stage: 'frame', describe: 'text crossing the frame edge',
  run(ctx) {
    const c = compOf(ctx), clips = byId(c), seen = new Set<string>(), out: Finding[] = [];
    const frame: Rect = { x: 0, y: 0, w: c.W, h: c.H };
    for (const [f, layers] of layerFrames(ctx)) for (const l of layers) {
      const b = l.box;
      if (!isText(l.kind) || seen.has(l.clipId)) continue;
      const crosses = (b[0] < -1 || b[1] < -1 || b[0] + b[2] > c.W + 1 || b[1] + b[3] > c.H + 1) && area(intersect(b, [0, 0, c.W, c.H])) > 0;
      if (!crosses) continue;
      seen.add(l.clipId);
      out.push({ rule: 'text-cut-off', severity: 'error', frame: f, clip: l.clipId, box: round(intersect(b, [0, 0, c.W, c.H])),
        message: `${l.kind} ${quote(l.text)}(${l.clipId}) is cut off by the frame edge at ${sec(f, c.fps)}`,
        fix: fitFix(clips.get(l.clipId), l.clipId, b, frame, c) });
    }
    return out;
  },
});

// ------------------------------------------------------------------------------------------- audio stage

const PLATFORM_LUFS: Record<string, number> = { shorts: -14, tiktok: -14, reels: -14, youtube: -14 };
const masterOf = (p: Project) => p.buses?.find((b) => b.id === 'master');

const clipping = defineCheck({
  id: 'clipping', stage: 'audio', describe: 'true peak above -1 dBTP',
  run(ctx) {
    const tp = ctx.audio?.loudness.truePeak;
    if (tp === undefined || !Number.isFinite(tp) || tp <= -1) return [];
    return [{ rule: 'clipping', severity: tp > 0 ? 'error' : 'warning', message: `mix true peak ${tp.toFixed(1)} dBTP is above -1 dBTP (clips on lossy encodes)`, fix: 'mgl edit <file> audio.normalize peak=-1' }];
  },
});

const loudness = defineCheck({
  id: 'loudness', stage: 'audio', describe: 'integrated loudness more than 2 LU from the target',
  run(ctx) {
    const a = ctx.audio, I = a?.loudness.integrated;
    // a silent mix (no audible audio at all; ebur128 floors at -70) has no loudness to fix
    if (!a || I === undefined || !Number.isFinite(I) || I <= -60) return [];
    const target = masterOf(ctx.project)?.loudness?.lufs ?? PLATFORM_LUFS[ctx.platform] ?? -16;
    if (Math.abs(I - target) <= 2) return [];
    return [{ rule: 'loudness', severity: 'warning', message: `mix is ${I.toFixed(1)} LUFS, ${Math.abs(I - target).toFixed(1)} LU ${I > target ? 'over' : 'under'} the ${target} LUFS target`, fix: `mgl edit <file> audio.normalize lufs=${target}` }];
  },
});

/** The named bus, or the first bus it feeds that is one of `names`. */
function busFamily(p: Project, bus: string, names: string[]): string | undefined {
  const defs = new Map((p.buses ?? []).map((b) => [b.id, b]));
  for (let b: string | undefined = bus, i = 0; b && i < 16; b = defs.get(b)?.to, i++) if (names.includes(b)) return bus;
  return undefined;
}

const musicOverVoice = defineCheck({
  id: 'music-over-voice', stage: 'audio', describe: 'music plays under dialogue without ducking',
  run(ctx) {
    const c = compOf(ctx), p = ctx.project, trackBus = new Map(c.tracks.map((t) => [t.id, t.bus ?? 'master']));
    const audible = c.clips.filter((x) => x.asset !== undefined && !x.muted && !c.tracks.find((t) => t.id === x.track)?.muted);
    const music = audible.filter((x) => busFamily(p, trackBus.get(x.track)!, ['music']));
    const voice = audible.filter((x) => busFamily(p, trackBus.get(x.track)!, ['dialogue', 'voice', 'vo']));
    const defs = new Map((p.buses ?? []).map((b) => [b.id, b]));
    for (const m of music) for (const v of voice) {
      const s = Math.max(m.at, v.at), e = Math.min(m.at + m.len, v.at + v.len);
      if (e <= s) continue;
      const mb = trackBus.get(m.track)!, vb = trackBus.get(v.track)!;
      if (defs.get(mb)?.duck || defs.get('music')?.duck) continue;
      return [{ rule: 'music-over-voice', severity: 'warning', frame: s, clip: m.id,
        message: `music "${m.id}" (bus ${mb}) plays under voice "${v.id}" ${sec(s, c.fps)}–${sec(e, c.fps)} without ducking`,
        fix: `mgl edit <file> audio.duck bus=${mb} by=${vb} db=9` }];
    }
    return [];
  },
});

const longSilence = defineCheck({
  id: 'long-silence', stage: 'audio', describe: 'silences longer than 2 s inside the content',
  run(ctx) {
    const a = ctx.audio;
    if (!a) return [];
    const c = compOf(ctx), audio = c.clips.filter((x) => x.asset !== undefined && c.tracks.find((t) => t.id === x.track)?.audio);
    if (!audio.length) return [];
    return a.silences.filter((s) => s.end - s.start > 2 && s.start > 0.05 && s.end < a.duration - 0.05).map((s): Finding => {
      const f = Math.round(s.start * c.fps), cover = clipAt(c, f + 1, (x) => audio.includes(x));
      const next = audio.filter((x) => x.at > f).sort((x, y) => x.at - y.at)[0];
      const msg = `${(s.end - s.start).toFixed(1)} s of silence ${s.start.toFixed(2)}–${s.end.toFixed(2)}s`;
      return cover ? { rule: 'long-silence', severity: 'warning', frame: f, clip: cover.id, message: `${msg} in "${cover.id}"`, fix: `mgl edit <file> audio.cut-silences ${cover.id} min=2s` }
        : { rule: 'long-silence', severity: 'warning', frame: f, ...(next ? { clip: next.id } : {}), message: `${msg}: no audio clip plays`, fix: next ? `mgl edit <file> clip.move ${next.id} at=${f}` : `mgl edit <file> comp.set ${c.id} length=auto` };
    });
  },
});

export const builtinChecks: CheckDef[] = [gaps, textOutsideSafe, tinyText, captionOverlap, clipPastEnd, keyframesOutside,
  blackFrames, frozen, overlapAlpha, textCutOff, clipping, loudness, musicOverVoice, longSilence];

export default definePlugin({ name: 'builtin-checks', version: '1.0.0', checks: builtinChecks });
