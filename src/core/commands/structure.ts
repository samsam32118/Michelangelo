/** project, asset, comp, track, marker, id commands. */
import { z } from 'zod';
import { fail } from '../errors.js';
import { defineCommand, TimeArg } from './registry.js';
import { Id, PLATFORMS, TABLES, type Asset, type Comp, type Track } from '../schema/index.js';
import { parseRate } from '../time.js';
import { secondsToNearestFrame } from '../time.js';
import { keyLists } from '../keylists.js';

export const PRESETS: Record<string, { size: [number, number]; platform?: (typeof PLATFORMS)[number] }> = {
  shorts: { size: [1080, 1920], platform: 'shorts' },
  tiktok: { size: [1080, 1920], platform: 'tiktok' },
  reels: { size: [1080, 1920], platform: 'reels' },
  vertical: { size: [1080, 1920] },
  youtube: { size: [1920, 1080], platform: 'youtube' },
  landscape: { size: [1920, 1080] },
  square: { size: [1080, 1080] },
  portrait: { size: [1080, 1350] },
  '4k': { size: [3840, 2160] },
};

defineCommand({
  op: 'project.set', group: 'project', doc: 'Set project settings: name, platform (safe zones, loudness), main comp, plugins, commercial (true: non-commercial media is an error).',
  schema: z.strictObject({ name: z.string().optional(), platform: z.enum(PLATFORMS).optional(), main: Id.optional(), plugins: z.record(z.string(), z.string().nullable()).optional(), commercial: z.boolean().optional() }),
  example: { name: 'Focus tips', platform: 'shorts' },
  apply(ctx, p) {
    const proj = { ...(ctx.project.project ?? {}) };
    if (p.name !== undefined) proj.name = p.name;
    if (p.platform !== undefined) proj.platform = p.platform;
    if (p.main !== undefined) { ctx.comp(p.main); proj.main = p.main; }
    if (p.commercial !== undefined) proj.commercial = p.commercial;
    if (p.plugins) {
      const pl = { ...(proj.plugins ?? {}) };
      for (const [k, v] of Object.entries(p.plugins)) { if (v === null) delete pl[k]; else pl[k] = v; }
      if (Object.keys(pl).length) proj.plugins = pl; else delete proj.plugins;
    }
    ctx.project.project = proj;
    ctx.summary('project settings updated.');
  },
});

const ASSET_KINDS = ['video', 'audio', 'image', 'font', 'lut', 'subtitles', 'data'] as const;
export function kindFromExtension(src: string): Asset['kind'] | undefined {
  const ext = src.toLowerCase().split('?')[0]!.split('.').pop() ?? '';
  if (['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mxf', 'hevc', 'gif'].includes(ext)) return 'video';
  if (['wav', 'mp3', 'aac', 'm4a', 'flac', 'ogg', 'opus', 'aif', 'aiff'].includes(ext)) return 'audio';
  if (['png', 'jpg', 'jpeg', 'webp', 'svg', 'bmp', 'avif'].includes(ext)) return 'image';
  if (['ttf', 'otf', 'woff', 'woff2'].includes(ext)) return 'font';
  if (['cube', '3dl'].includes(ext)) return 'lut';
  if (['srt', 'vtt'].includes(ext)) return 'subtitles';
  if (src.startsWith('lavfi:')) return 'video';
  return undefined;
}

defineCommand({
  op: 'asset.add', group: 'asset', doc: 'Add a media file (video, audio, image, font, LUT, subtitles) by path relative to the project; probes it.',
  schema: z.strictObject({ src: z.string().min(1), id: Id.optional(), kind: z.enum(ASSET_KINDS).optional(), note: z.string().optional() }),
  primary: 'src', example: { src: 'media/beach.mov', id: 'beach' },
  async apply(ctx, p) {
    const assets = (ctx.project.assets ??= []);
    const existing = assets.find((a) => a.src === p.src);
    if (existing && !p.id) { ctx.out.id = existing.id; ctx.summary(`asset "${existing.id}" already points to ${p.src}.`); return; }
    const base = p.id ?? p.src.split('/').pop()!.replace(/\.[^.]+$/, '').toLowerCase();
    const id = p.id ?? ctx.newId(base);
    if (p.id && TABLES.some((t) => ((ctx.project[t] as { id: string }[] | undefined) ?? []).some((e) => e.id === p.id))) fail('E_DUPLICATE_ID', `id "${p.id}" is already used.`, 'choose another id or omit "id".');
    let probed = '';
    if (ctx.services.probe && !p.src.startsWith('lavfi:')) {
      const info = await ctx.services.probe(p.src);
      probed = ` (${info.kind}${info.width ? ` ${info.width}x${info.height}` : ''}${info.duration ? ` ${info.duration.toFixed(2)}s` : ''})`;
      ctx.out.probe = info;
    }
    const a: Asset = { id, src: p.src };
    const inferred = kindFromExtension(p.src);
    if (p.kind && p.kind !== inferred) a.kind = p.kind;
    if (p.note) a.note = p.note;
    assets.push(a);
    ctx.out.id = id;
    ctx.summary(`added asset "${id}" → ${p.src}${probed}.`);
  },
});

defineCommand({
  op: 'asset.remove', group: 'asset', doc: 'Remove an asset; refuses while clips use it unless `clips: true` also removes them.',
  schema: z.strictObject({ id: Id, clips: z.boolean().optional() }), primary: 'id', example: { id: 'beach' },
  apply(ctx, p) {
    const assets = ctx.project.assets ?? [];
    const i = assets.findIndex((a) => a.id === p.id);
    if (i < 0) fail('E_REF', `asset "${p.id}" does not exist.`, 'list assets with: mgl show <file> --assets');
    // media clips of the asset, and generators that visualise its sound (gen.asset)
    const uses = (c: { asset?: string; gen?: Record<string, unknown> }) => c.asset === p.id || c.gen?.asset === p.id;
    const users = (ctx.project.clips ?? []).filter(uses);
    if (users.length && !p.clips) fail('E_IN_USE', `asset "${p.id}" is used by ${users.length} clip(s): ${users.slice(0, 5).map((c) => c.id).join(', ')}.`, 'remove those clips first, or pass clips=true to remove them too.');
    const gone = new Set(users.map((c) => c.id));
    ctx.project.clips = (ctx.project.clips ?? []).filter((c) => !gone.has(c.id));
    assets.splice(i, 1);
    ctx.summary(`removed asset "${p.id}"${users.length ? ` and ${users.length} clip(s)` : ''}.`);
  },
});

defineCommand({
  op: 'asset.relink', group: 'asset', doc: 'Point an asset at another file (e.g. after moving media).',
  schema: z.strictObject({ id: Id, src: z.string().min(1) }), primary: 'id', example: { id: 'beach', src: 'media/beach-v2.mov' },
  apply(ctx, p) {
    const a = (ctx.project.assets ?? []).find((x) => x.id === p.id);
    if (!a) fail('E_REF', `asset "${p.id}" does not exist.`, 'list assets with: mgl show <file> --assets');
    a.src = p.src;
    ctx.summary(`asset "${p.id}" now points to ${p.src}.`);
  },
});

defineCommand({
  op: 'comp.add', group: 'comp', doc: 'Add a composition (a timeline): size or preset, fps, length.',
  schema: z.strictObject({ id: Id.optional(), preset: z.enum(Object.keys(PRESETS) as [string, ...string[]]).optional(), size: z.tuple([z.number().int(), z.number().int()]).optional(), fps: z.union([z.number(), z.string()]).optional(), length: z.union([TimeArg, z.literal('auto')]).optional(), bg: z.string().optional(), tracks: z.boolean().optional() }),
  example: { id: 'badge', size: [1080, 1080], fps: 30, length: '5s' },
  apply(ctx, p) {
    const id = p.id ?? ctx.newId('comp');
    if (p.id && ctx.project.comps.some((c) => c.id === p.id)) fail('E_DUPLICATE_ID', `comp "${p.id}" already exists.`, 'choose another id.');
    const size = p.size ?? PRESETS[p.preset ?? 'shorts']!.size;
    const c: Comp = { id, size: [size[0], size[1]], fps: p.fps ?? 30 };
    if (p.length !== undefined) c.length = p.length as never;
    if (p.bg) c.bg = p.bg;
    parseRate(c.fps);
    ctx.project.comps.push(c);
    if (p.tracks !== false) {
      const tracks = (ctx.project.tracks ??= []);
      for (const [suffix, audio] of [['V1', false], ['A1', true]] as const) {
        const tid = ctx.newId(ctx.project.comps.length === 1 ? suffix : `${id}-${suffix}`);
        const t: Track = { id: tid, comp: id };
        if (audio) t.audio = true;
        tracks.push(t);
      }
    }
    ctx.out.id = id;
    ctx.summary(`added comp "${id}" ${size[0]}x${size[1]}.`);
  },
});

defineCommand({
  op: 'comp.set', group: 'comp', doc: 'Change a comp: size, fps (rescales every time in the comp), length, background.',
  schema: z.strictObject({ id: Id, size: z.tuple([z.number().int(), z.number().int()]).optional(), fps: z.union([z.number(), z.string()]).optional(), length: z.union([TimeArg, z.literal('auto')]).nullable().optional(), bg: z.string().nullable().optional() }),
  primary: 'id', example: { id: 'main', length: '30s' },
  apply(ctx, p) {
    const c = ctx.comp(p.id);
    if (p.size) c.size = [p.size[0], p.size[1]];
    if (p.bg !== undefined) { if (p.bg === null) delete c.bg; else c.bg = p.bg; }
    if (p.length !== undefined) { if (p.length === null) delete c.length; else c.length = p.length as never; }
    if (p.fps !== undefined) {
      const from = parseRate(c.fps), to = parseRate(p.fps);
      const k = (f: number) => Math.round((f * to.num * from.den) / (to.den * from.num));
      /** a span [at, at+len) rescaled by its ends, so adjacent spans stay adjacent */
      const span = (at: number, len: number): [number, number] => [k(at), Math.max(1, k(at + len) - k(at))];
      const trackIds = new Set((ctx.project.tracks ?? []).filter((t) => t.comp === c.id).map((t) => t.id));
      let n = 0;
      for (const cl of ctx.project.clips ?? []) {
        if (cl.comp === c.id && cl.in) cl.in = k(cl.in); // a clip nesting this comp: its in is in this comp's frames
        if (!trackIds.has(cl.track)) continue;
        [cl.at, cl.len] = span(cl.at, cl.len);
        // `in` of a media clip counts frames at this comp's rate; a nested comp's `in` counts the child's frames (unchanged)
        if (cl.in && cl.comp === undefined) cl.in = k(cl.in);
        if (cl.clock) cl.clock = k(cl.clock);
        n++;
        for (const l of keyLists(cl)) {
          l.keys.forEach((kf) => { kf[0] = k(kf[0]); });
          // remap values are source frames at this comp's rate
          if (l.label === 'remap' && cl.asset !== undefined) l.keys.forEach((kf) => { kf[1] = k(kf[1] as number); });
        }
        if (cl.fade) cl.fade = [k(cl.fade[0]), k(cl.fade[1])];
        for (const side of ['in', 'out'] as const) { const t = cl.transition?.[side]; if (t) t.len = Math.max(1, k(t.len)); }
        if (cl.animate) for (const f of ['stagger', 'len'] as const) { const v = cl.animate[f]; if (typeof v === 'number') cl.animate[f] = f === 'len' ? Math.max(1, k(v)) : k(v); }
        for (const q of ctx.project.cues ?? []) if (q.clip === cl.id) { [q.at, q.len] = span(q.at, q.len); if (q.words) q.words = q.words.map(k); }
      }
      for (const m of ctx.project.markers ?? []) if (m.comp === c.id) { if (m.len) [m.at, m.len] = span(m.at, m.len); else m.at = k(m.at); }
      if (typeof c.length === 'number') c.length = k(c.length);
      c.fps = p.fps;
      ctx.note(`rescaled ${n} clip(s) from ${from.num}/${from.den} to ${to.num}/${to.den} fps (rounded to whole frames).`);
    }
    ctx.summary(`comp "${c.id}" updated.`);
  },
});

defineCommand({
  op: 'comp.remove', group: 'comp', doc: 'Remove a comp with its tracks, clips and markers; refuses while another comp nests it.',
  schema: z.strictObject({ id: Id }), primary: 'id', example: { id: 'badge' },
  apply(ctx, p) {
    ctx.comp(p.id);
    const users = (ctx.project.clips ?? []).filter((c) => c.comp === p.id);
    if (users.length) fail('E_IN_USE', `comp "${p.id}" is nested by ${users.map((c) => c.id).join(', ')}.`, 'remove those clips first.');
    if (ctx.project.comps.length === 1) fail('E_LAST_COMP', 'a project needs at least one comp.', 'add another comp first.');
    const tracks = new Set((ctx.project.tracks ?? []).filter((t) => t.comp === p.id).map((t) => t.id));
    const clips = new Set((ctx.project.clips ?? []).filter((c) => tracks.has(c.track)).map((c) => c.id));
    ctx.project.comps = ctx.project.comps.filter((c) => c.id !== p.id);
    ctx.project.tracks = (ctx.project.tracks ?? []).filter((t) => !tracks.has(t.id));
    ctx.project.clips = (ctx.project.clips ?? []).filter((c) => !clips.has(c.id));
    ctx.project.cues = (ctx.project.cues ?? []).filter((q) => !clips.has(q.clip));
    ctx.project.markers = (ctx.project.markers ?? []).filter((m) => m.comp !== p.id);
    ctx.summary(`removed comp "${p.id}" (${tracks.size} tracks, ${clips.size} clips).`);
  },
});

defineCommand({
  op: 'track.add', group: 'track', doc: 'Add a track to a comp; visual tracks stack in order (later = on top), audio tracks mix into a bus.',
  schema: z.strictObject({ id: Id.optional(), comp: Id.optional(), audio: z.boolean().optional(), bus: Id.optional(), below: Id.optional(), above: Id.optional() }),
  primary: 'id', example: { id: 'V2' },
  apply(ctx, p) {
    const comp = p.comp ?? ctx.project.project?.main ?? ctx.project.comps[0]!.id;
    ctx.comp(comp);
    const tracks = (ctx.project.tracks ??= []);
    const prefix = p.audio ? 'A' : 'V';
    let id = p.id;
    if (!id) { for (let n = 1; ; n++) { const cand = ctx.project.comps.length > 1 && comp !== ctx.project.comps[0]!.id ? `${comp}-${prefix}${n}` : `${prefix}${n}`; if (!tracks.some((t) => t.id === cand)) { id = cand; break; } } }
    if (tracks.some((t) => t.id === id)) fail('E_DUPLICATE_ID', `track "${id}" already exists.`, 'choose another id or omit it (or just use that track: track=' + id + ').');
    if (TABLES.some((tb) => ((ctx.project[tb] as { id: string }[] | undefined) ?? []).some((e) => e.id === id))) fail('E_DUPLICATE_ID', `id "${id}" is already used by another entity.`, 'choose another id or omit it.');
    const t: Track = { id: id!, comp };
    if (p.audio) t.audio = true;
    if (p.bus) t.bus = p.bus;
    let idx = tracks.length;
    if (p.below) { idx = tracks.findIndex((x) => x.id === p.below); if (idx < 0) ctx.track(p.below); }
    else if (p.above) { idx = tracks.findIndex((x) => x.id === p.above) + 1; if (idx <= 0) ctx.track(p.above); }
    tracks.splice(idx, 0, t);
    ctx.out.id = t.id;
    ctx.summary(`added ${p.audio ? 'audio' : 'visual'} track "${t.id}" to comp "${comp}".`);
  },
});

defineCommand({
  op: 'track.set', group: 'track', doc: 'Change a track: hidden, muted, locked, bus.',
  schema: z.strictObject({ id: Id, hidden: z.boolean().optional(), muted: z.boolean().optional(), locked: z.boolean().optional(), bus: Id.nullable().optional(), note: z.string().optional() }),
  primary: 'id', example: { id: 'A2', bus: 'music' },
  apply(ctx, p) {
    const t = ctx.track(p.id);
    for (const k of ['hidden', 'muted', 'locked', 'note'] as const) if (p[k] !== undefined) (t as Record<string, unknown>)[k] = p[k];
    if (p.bus !== undefined) { if (p.bus === null) delete t.bus; else t.bus = p.bus; }
    ctx.summary(`track "${t.id}" updated.`);
  },
});

defineCommand({
  op: 'track.remove', group: 'track', doc: 'Remove a track and its clips.',
  schema: z.strictObject({ id: Id }), primary: 'id', example: { id: 'V3' },
  apply(ctx, p) {
    ctx.track(p.id);
    const clips = new Set((ctx.project.clips ?? []).filter((c) => c.track === p.id).map((c) => c.id));
    ctx.project.tracks = (ctx.project.tracks ?? []).filter((t) => t.id !== p.id);
    ctx.project.clips = (ctx.project.clips ?? []).filter((c) => c.track !== p.id);
    ctx.project.cues = (ctx.project.cues ?? []).filter((q) => !clips.has(q.clip));
    ctx.summary(`removed track "${p.id}" and ${clips.size} clip(s).`);
  },
});

defineCommand({
  op: 'track.move', group: 'track', doc: 'Change a track\'s stacking position (below/above another track, or to top/bottom).',
  schema: z.strictObject({ id: Id, below: Id.optional(), above: Id.optional(), to: z.enum(['top', 'bottom']).optional() }),
  primary: 'id', example: { id: 'T1', to: 'top' },
  apply(ctx, p) {
    const tracks = ctx.project.tracks ?? [];
    const t = ctx.track(p.id);
    const rest = tracks.filter((x) => x.id !== p.id);
    let idx = rest.length;
    if (p.to === 'bottom') idx = 0;
    const ref = p.below ?? p.above;
    if (ref !== undefined) {
      if (ref === p.id) fail('E_ARG', `track.move cannot place "${p.id}" ${p.below ? 'below' : 'above'} itself.`, `name another track, e.g. mgl edit <file> track.move ${p.id} to=top`);
      const rc = ctx.compOfTrack(ref).id, tc = ctx.compOfTrack(p.id).id;
      if (rc !== tc) fail('E_ARG', `track "${ref}" is in comp "${rc}", but "${p.id}" is in comp "${tc}".`, 'tracks stack only within their own comp; name a track in the same comp.');
    }
    if (p.below) idx = rest.findIndex((x) => x.id === p.below);
    else if (p.above) idx = rest.findIndex((x) => x.id === p.above) + 1;
    rest.splice(idx, 0, t);
    ctx.project.tracks = rest;
    ctx.summary(`moved track "${p.id}".`);
  },
});

defineCommand({
  op: 'marker.add', group: 'marker', doc: 'Add a marker (a named point or range) to a comp.',
  schema: z.strictObject({ at: TimeArg, id: Id.optional(), comp: Id.optional(), len: TimeArg.optional(), note: z.string().optional() }),
  example: { at: '15s', id: 'drop', note: 'beat drop' },
  apply(ctx, p) {
    const comp = p.comp ?? ctx.project.project?.main ?? ctx.project.comps[0]!.id;
    const id = p.id ?? ctx.newId('m');
    const m: NonNullable<typeof ctx.project.markers>[number] = { id, comp, at: ctx.time(p.at, comp, 'at') };
    if (p.len !== undefined) m.len = ctx.time(p.len, comp, 'len');
    if (p.note) m.note = p.note;
    (ctx.project.markers ??= []).push(m);
    ctx.out.id = id;
    ctx.summary(`added marker "${id}".`);
  },
});

defineCommand({
  op: 'marker.remove', group: 'marker', doc: 'Remove a marker.',
  schema: z.strictObject({ id: Id }), primary: 'id', example: { id: 'drop' },
  apply(ctx, p) {
    const before = (ctx.project.markers ?? []).length;
    ctx.project.markers = (ctx.project.markers ?? []).filter((m) => m.id !== p.id);
    if (ctx.project.markers.length === before) fail('E_REF', `marker "${p.id}" does not exist.`, 'list markers with: mgl show <file>');
    ctx.summary(`removed marker "${p.id}".`);
  },
});

defineCommand({
  op: 'id.rename', group: 'project', doc: 'Rename any entity and update every reference to it (only references to that kind of entity: renaming a clip never touches a bus of the same name).',
  schema: z.strictObject({ id: z.string(), to: Id }), primary: 'id', example: { id: 'clip3', to: 'hook' },
  apply(ctx, p) {
    const pr = ctx.project;
    let found: (typeof TABLES)[number] | '' = '';
    for (const t of TABLES) for (const e of (pr[t] as { id: string }[] | undefined) ?? []) { if (e.id === p.to) fail('E_DUPLICATE_ID', `id "${p.to}" is already used (${t}).`, 'choose another id.'); if (e.id === p.id && !found) found = t; }
    if (!found) fail('E_REF', `nothing has id "${p.id}".`, 'check the id with: mgl show <file>');
    const r = (v: string | undefined) => (v === p.id ? p.to : v);
    for (const e of (pr[found] as { id: string }[] | undefined) ?? []) if (e.id === p.id) e.id = p.to;
    switch (found) {
      case 'assets':
        for (const c of pr.clips ?? []) {
          if (c.asset) c.asset = r(c.asset);
          // audio-reactive generators name the asset they visualise
          const g = c.gen as Record<string, unknown> | undefined;
          if (g && typeof g.asset === 'string') g.asset = r(g.asset);
        }
        break;
      case 'comps':
        for (const t of pr.tracks ?? []) t.comp = r(t.comp)!;
        for (const c of pr.clips ?? []) if (c.comp) c.comp = r(c.comp);
        for (const m of pr.markers ?? []) m.comp = r(m.comp)!;
        if (pr.project?.main) pr.project.main = r(pr.project.main);
        break;
      case 'tracks':
        for (const c of pr.clips ?? []) c.track = r(c.track)!;
        break;
      case 'clips':
        for (const c of pr.clips ?? []) {
          if (c.parent) c.parent = r(c.parent);
          if (c.matte) c.matte.clip = r(c.matte.clip)!;
        }
        for (const q of pr.cues ?? []) q.clip = r(q.clip)!;
        break;
      case 'styles':
        for (const c of pr.clips ?? []) {
          if (typeof c.style === 'string') c.style = r(c.style);
          else if (c.style && typeof c.style === 'object' && c.style.base) c.style.base = r(c.style.base);
        }
        for (const s of pr.styles ?? []) if (s.base) s.base = r(s.base);
        break;
      case 'buses':
        for (const t of pr.tracks ?? []) if (t.bus) t.bus = r(t.bus);
        for (const b of pr.buses ?? []) { if (b.duck) b.duck.by = r(b.duck.by)!; if (b.to) b.to = r(b.to); }
        break;
      default: break; // cues and markers are not referenced
    }
    ctx.summary(`renamed ${found.replace(/s$/, '')} "${p.id}" to "${p.to}".`);
  },
});

void secondsToNearestFrame;
