/** template.apply, and the track placement shared by commands that add layered clips (captions, templates). */
import { z } from 'zod';
import { fail, suggest } from '../errors.js';
import { defineCommand, TimeArg, type CommandContext, type TemplateOutput } from './registry.js';
import { Id, TABLES, type Clip, type Comp, type Track } from '../schema/index.js';

export function defaultCompId(ctx: CommandContext): string {
  const p = ctx.project;
  return p.project?.main ?? (p.comps.find((c) => c.id === 'main') ?? p.comps[0]!).id;
}

function takenIds(ctx: CommandContext): Set<string> {
  const s = new Set<string>();
  for (const t of TABLES) for (const e of (ctx.project[t] as { id: string }[] | undefined) ?? []) s.add(e.id);
  return s;
}

/** True when no clip on the track intersects any of the ranges. */
export function trackIsFree(ctx: CommandContext, trackId: string, ranges: { at: number; len: number }[]): boolean {
  return !(ctx.project.clips ?? []).some((c) => c.track === trackId && ranges.some((r) => c.at < r.at + r.len && r.at < c.at + c.len));
}

/**
 * Put layers (each a set of time ranges) on visual tracks of a comp, bottom to top: each layer goes on
 * the first free unlocked track above the previous layer, starting above every track that has content
 * during the layers or holds footage (or at `track` when given); new tracks are created where none is free.
 */
export function placeLayers(ctx: CommandContext, compId: string, layers: { at: number; len: number }[][], opts: { track?: string } = {}): string[] {
  const tracks = (ctx.project.tracks ??= []);
  const visual = () => tracks.filter((t) => t.comp === compId && !t.audio);
  const all = layers.flat();
  const out: string[] = [];
  let prev: Track | undefined;
  if (opts.track) {
    const t = ctx.track(opts.track);
    if (t.comp !== compId) fail('E_REF', `track "${t.id}" belongs to comp "${t.comp}", not "${compId}".`, `use a track of comp "${compId}" or omit track.`);
    if (t.audio) fail('E_TRACK_KIND', `track "${t.id}" is an audio track.`, 'use a visual track, or omit track to pick one.');
    if (!trackIsFree(ctx, t.id, layers[0] ?? [])) fail('E_OVERLAP', `track "${t.id}" already has clips in that time range.`, 'use another track, another "at", or omit track to pick a free one.');
    out.push(t.id);
    prev = t;
    layers = layers.slice(1);
  } else {
    // above anything shown during the layers, and above footage tracks (overlays belong over video)
    const clips = ctx.project.clips ?? [];
    const below = visual().filter((t) => !trackIsFree(ctx, t.id, all) || clips.some((c) => c.track === t.id && (c.asset !== undefined || c.comp !== undefined)));
    prev = below[below.length - 1];
  }
  for (const ranges of layers) {
    const vis = visual();
    const from: number = prev ? vis.indexOf(prev) + 1 : 0;
    let t: Track | undefined = vis.slice(from).find((x) => !x.locked && !x.hidden && trackIsFree(ctx, x.id, ranges));
    if (!t) {
      t = { id: newTrackId(ctx, compId), comp: compId };
      const anchor = prev ?? vis[vis.length - 1];
      const idx = anchor ? tracks.indexOf(anchor) + 1 : tracks.length;
      tracks.splice(idx, 0, t);
      ctx.note(`created track ${t.id}.`);
    }
    out.push(t.id);
    prev = t;
  }
  return out;
}

function newTrackId(ctx: CommandContext, compId: string): string {
  const taken = takenIds(ctx);
  const pre = ctx.project.comps[0]!.id === compId ? 'V' : `${compId}-V`;
  for (let n = 1; ; n++) if (!taken.has(`${pre}${n}`)) return `${pre}${n}`;
}

/** Prefix every id of a template's output and rewrite the references between them. */
function prefixOutput(o: TemplateOutput, prefix: string, compId: string): Required<Omit<TemplateOutput, 'summary'>> {
  // references are renamed only within their own table (a clip "title" and the style "title" are unrelated)
  const renamer = (rows: { id: string }[] | undefined) => {
    const own = new Set((rows ?? []).map((e) => e.id));
    return (v: string) => (own.has(v) ? `${prefix}-${v}` : v);
  };
  const rc = renamer(o.comps), rt = renamer(o.tracks), rk = renamer(o.clips), rs = renamer(o.styles), rq = renamer(o.cues);
  const compIds = new Set((o.comps ?? []).map((c) => c.id));
  const comps: Comp[] = (o.comps ?? []).map((c) => ({ ...structuredClone(c), id: rc(c.id) }));
  const tracks: Track[] = (o.tracks ?? []).map((t) => ({ ...structuredClone(t), id: rt(t.id), comp: compIds.has(t.comp) ? rc(t.comp) : compId }));
  const clips: Clip[] = (o.clips ?? []).map((c0) => {
    const c = structuredClone(c0);
    c.id = rk(c.id);
    // a track the template defines is renamed; any other track name is a layer slot, resolved by placement
    c.track = rt(c.track);
    if (c.comp !== undefined) c.comp = rc(c.comp);
    if (c.parent !== undefined) c.parent = rk(c.parent);
    if (c.matte) c.matte.clip = rk(c.matte.clip);
    if (typeof c.style === 'string') c.style = rs(c.style);
    else if (c.style?.base) c.style.base = rs(c.style.base);
    return c;
  });
  const styles = (o.styles ?? []).map((s) => ({ ...structuredClone(s), id: rs(s.id), ...(s.base ? { base: rs(s.base) } : {}) }));
  const cues = (o.cues ?? []).map((q) => ({ ...structuredClone(q), id: rq(q.id), clip: rk(q.clip) }));
  return { comps, tracks, clips, styles, cues };
}

defineCommand({
  op: 'template.apply', group: 'templates',
  doc: 'Insert a template (intro, lower-third, cta, title, end-card, progress-bar, quote, listicle-item, or a plugin\'s) at a time; its layers go on free visual tracks above existing content, ids are prefixed, clips are tagged "template:<id>". Pass template parameters in `params`.',
  schema: z.strictObject({ template: z.string().min(1), at: TimeArg.optional(), len: TimeArg.optional(), track: Id.optional(), comp: Id.optional(), prefix: Id.optional(), params: z.record(z.string(), z.unknown()).optional() }),
  primary: 'template', example: { template: 'lower-third', at: '2s', params: { name: 'Ada Lovelace', role: 'Engineer' } },
  apply(ctx, p) {
    const templates = ctx.services.catalog?.templates;
    if (!templates) fail('E_NO_CATALOG', 'no template catalog is available here.', 'run through the SDK or CLI (they load the built-in plugins), or pass services.catalog.');
    const def = templates.get(p.template);
    if (!def) {
      const dym = suggest(p.template, templates.keys());
      fail('E_UNKNOWN_TEMPLATE', `template "${p.template}" does not exist.`, dym.length ? `did you mean "${dym[0]}"? (templates: ${[...templates.keys()].join(', ')})` : `templates: ${[...templates.keys()].join(', ')}`, { didYouMean: dym });
    }
    const compId = p.comp ?? (p.track ? ctx.track(p.track).comp : defaultCompId(ctx));
    const comp = ctx.comp(compId);
    let params: Record<string, unknown> = p.params ?? {};
    if (def.params) {
      const r = def.params.safeParse(params);
      if (!r.success) {
        const i = r.error.issues[0]!;
        const keys = def.params instanceof z.ZodObject ? Object.keys(def.params.shape).join(', ') : '';
        fail('E_ARG', `template "${def.id}": ${i.path.length ? `param "${i.path.join('.')}" ` : ''}${i.message}.`, keys ? `params: ${keys} (mgl docs template ${def.id})` : `see: mgl docs template ${def.id}`);
      }
      params = r.data as Record<string, unknown>;
    }
    const at = p.at === undefined ? 0 : ctx.time(p.at, comp, 'at');
    const len = p.len === undefined ? undefined : ctx.time(p.len, comp, 'len');
    if (len !== undefined && len < 1) fail('E_RANGE', `len ${len} is too short.`, 'give a positive length, e.g. len="4s".');
    const taken = takenIds(ctx);
    const base = p.prefix ?? def.id;
    let out: ReturnType<typeof prefixOutput> | undefined;
    let summary: string | undefined;
    for (let n = 1; n < 1000 && !out; n++) {
      const prefix = n === 1 ? base : `${base}${n}`;
      const raw = def.build({ params, comp, rate: ctx.rate(comp), at, ...(len !== undefined ? { len } : {}), prefix, project: ctx.project });
      const o = prefixOutput(raw, prefix, compId);
      const clash = [...o.comps, ...o.tracks, ...o.clips, ...o.styles, ...o.cues].find((e) => taken.has(e.id));
      if (!clash) { out = o; summary = raw.summary; }
      else if (p.prefix) fail('E_DUPLICATE_ID', `id "${clash.id}" is already used.`, 'choose another prefix or omit it.');
    }
    if (!out) fail('E_DUPLICATE_ID', `no free id prefix for template "${def.id}".`, 'pass prefix=<unique name>.');
    const pr = ctx.project;
    pr.comps.push(...out.comps);
    (pr.tracks ??= []).push(...out.tracks);
    if (out.styles.length) (pr.styles ??= []).push(...out.styles);
    // layer slots, in order of first appearance (bottom → top)
    const ownTracks = new Set(out.tracks.map((t) => t.id));
    const slots = new Map<string, Clip[]>();
    for (const c of out.clips) if (!ownTracks.has(c.track)) slots.set(c.track, [...(slots.get(c.track) ?? []), c]);
    const placed = placeLayers(ctx, compId, [...slots.values()].map((cs) => cs.map((c) => ({ at: c.at, len: c.len }))), p.track ? { track: p.track } : {});
    [...slots.values()].forEach((cs, i) => { for (const c of cs) c.track = placed[i]!; });
    for (const c of out.clips) c.tags = [...(c.tags ?? []).filter((t) => !t.startsWith('template:')), `template:${def.id}`];
    (pr.clips ??= []).push(...out.clips);
    if (out.cues.length) (pr.cues ??= []).push(...out.cues);
    ctx.out.ids = out.clips.map((c) => c.id);
    ctx.out.tracks = [...new Set(placed)];
    const end = out.clips.reduce((m, c) => Math.max(m, c.at + c.len), at);
    ctx.summary(`applied template "${def.id}"${summary ? ` (${summary})` : ''}: ${out.clips.length} clip(s) at ${at}–${end} on ${[...new Set(placed)].join(', ') || 'its own tracks'}.`);
  },
});
