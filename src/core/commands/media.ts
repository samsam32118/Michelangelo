/**
 * Open media (plugin API 1.5): media.search (find openly licensed images, footage, music and sound effects through
 * the project's 'stock' providers), media.fetch (download one into media/stock/, with a licence sidecar, as an asset
 * and optionally a clip; sounds are described as text) and media.credits (attribution lines for what is used, as a
 * file and/or a credits card). Licence rules live in core (src/core/licence.ts) so every source obeys them.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { fail } from '../errors.js';
import { defineCommand, TimeArg, type CommandContext, type SoundFacts, type StockService } from './registry.js';
import { Id, type Asset, type Clip, type Comp } from '../schema/index.js';
import { DEFAULT_ALLOWED, creditLine, licenceClass, licenceName, licenceUrl, refusal, LICENCE_CLASSES } from '../licence.js';
import type { StockItem, StockKind } from '../../plugin/api.js';
import { busTrack, compFor, compLength } from './audio-gen.js';

const KINDS = ['image', 'video', 'music', 'sfx'] as const;
const Allow = z.array(z.enum(LICENCE_CLASSES)).optional();
const PLUGIN_FIX = 'add the open-media plugin: copy examples/plugins/open-media from the Michelangelo repository to plugins/open-media, run "mgl plugin trust plugins/open-media", then "mgl edit <file> project.set plugins=\'{"open-media": "^1.0.0"}\'" (or any plugin with a stock provider: mgl docs plugins)';

function needStock(ctx: CommandContext, op: string, kind?: StockKind): StockService {
  const s = ctx.services.stock;
  if (!s) return fail('E_NO_PROVIDER', `${op} needs an open-media (stock) provider, and this project has none.`, `${PLUGIN_FIX}. Offline alternatives: audio.music and audio.sfx generate sound; generators draw backgrounds.`);
  if (kind && !s.providers.some((p) => p.media.includes(kind))) fail('E_NO_PROVIDER', `no stock provider of this project serves ${kind} (providers: ${s.providers.map((p) => `${p.id}: ${p.media.join('/')}`).join('; ')}).`, `use kind=${s.providers[0]!.media[0]}, or add a plugin that serves ${kind}.`);
  return s;
}

const fmtSecs = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}:${(s % 60).toFixed(0).padStart(2, '0')}` : `${s.toFixed(s < 10 ? 1 : 0)}s`);
const clipText = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + '…' : t);

/** A licence as few tokens as possible for result lists (credits keep the full name). */
const licenceShort = (id: string) => ({ 'pd-us-gov': 'PD (US gov)', pdm: 'PDM', nkr: 'no known restrictions', 'public-domain': 'PD' } as Record<string, string>)[id] ?? licenceName(id);

/** One result line for the agent, led by its short handle (the full id is in search.json). */
function resultLine(it: StockItem, h: string): string {
  const size = it.width && it.height ? `${it.width}x${it.height}` : '';
  const dur = it.seconds !== undefined ? fmtSecs(it.seconds) : '';
  return `${h.padStart(3)} · ${clipText(it.title || 'untitled', 48)} · ${[dur, size].filter(Boolean).join(' ')}${dur || size ? ' · ' : ''}${licenceShort(it.licence.id)}${it.author ? ` · ${clipText(it.author, 28)}` : ''} · ${it.source}`;
}

const orient = (it: StockItem) => (!it.width || !it.height ? undefined : it.width > it.height * 1.1 ? 'landscape' : it.height > it.width * 1.1 ? 'portrait' : 'square');

/** The default comp's long side (for the image / video size floor). */
function longSide(ctx: CommandContext): number | undefined {
  const id = ctx.project.project?.main ?? (ctx.project.comps.find((c) => c.id === 'main') ?? ctx.project.comps[0])?.id;
  const c = ctx.project.comps.find((x) => x.id === id);
  return c ? Math.max(c.size[0], c.size[1]) : undefined;
}

// ------------------------------------------------------------------------------------------- media.search

defineCommand({
  op: 'media.search', group: 'media',
  doc: 'Search openly licensed media through the project\'s stock providers (a plugin, e.g. open-media): kind image|video|music|sfx, query; optional provider, source (one archive of a provider), orientation, minSeconds/maxSeconds, minWidth (default for image/video: half the comp\'s long side), limit (default 8), page. Changes nothing. Only CC0, public domain and CC BY results are shown unless licences=[...] allows share-alike or non-commercial; no-derivatives and unknown licences are never shown. Prints one line per result led by a short handle (s… sfx, m… music, i… image, v… video; stable within the project, a later search continues the numbering; title, length or size, licence, author, source); full ids and URLs go to .mgl/<name>/search.json and, for images and video, a numbered preview sheet to .mgl/<name>/search.png. Then: media.fetch id=i1.',
  schema: z.strictObject({
    kind: z.enum(KINDS), query: z.string().min(1), provider: z.string().min(1).optional(), source: z.string().min(1).optional(),
    orientation: z.enum(['portrait', 'landscape', 'square']).optional(), minSeconds: z.number().min(0).optional(), maxSeconds: z.number().positive().optional(),
    minWidth: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(40).default(8), page: z.number().int().min(1).optional(), licences: Allow,
  }),
  primary: 'query', example: { kind: 'sfx', query: 'whoosh', maxSeconds: 2 },
  async apply(ctx, p) {
    const s = needStock(ctx, 'media.search', p.kind);
    if (p.provider && !s.providers.some((x) => x.id === p.provider)) fail('E_ARG', `no stock provider "${p.provider}".`, `providers: ${s.providers.map((x) => x.id).join(', ')}.`);
    const allowed = [...DEFAULT_ALLOWED, ...(p.licences ?? [])];
    const visual = p.kind === 'image' || p.kind === 'video';
    const long = longSide(ctx);
    const minWidth = p.minWidth ?? (visual && long ? Math.round(long / 2) : undefined);
    // sound effects are short by default: whooshes and hits, not field recordings
    const maxSeconds = p.maxSeconds ?? (p.kind === 'sfx' ? 10 : undefined);
    const q = {
      kind: p.kind, query: p.query, limit: Math.min(40, p.limit * 3), ...(p.page ? { page: p.page } : {}), ...(p.provider ? { provider: p.provider } : {}), ...(p.source ? { source: p.source } : {}),
      ...(p.orientation ? { orientation: p.orientation } : {}), ...(p.minSeconds !== undefined ? { minSeconds: p.minSeconds } : {}),
      ...(maxSeconds !== undefined ? { maxSeconds } : {}), ...(minWidth ? { minWidth } : {}),
    };
    const { items, failed, notes } = await s.search({ ...q, licences: allowed });
    const dropped = new Map<string, number>();
    const drop = (why: string) => dropped.set(why, (dropped.get(why) ?? 0) + 1);
    const kept = items.filter((it) => {
      const why = refusal(licenceClass(it.licence.id), allowed);
      if (why) { drop(licenceClass(it.licence.id)); return false; }
      if (it.kind !== p.kind) { drop('other kind'); return false; }
      if (maxSeconds !== undefined && it.seconds !== undefined && it.seconds > maxSeconds + 0.05) { drop('too long'); return false; }
      if (p.minSeconds !== undefined && it.seconds !== undefined && it.seconds < p.minSeconds - 0.05) { drop('too short'); return false; }
      if (minWidth && it.width && it.height && Math.max(it.width, it.height) < minWidth) { drop('too small'); return false; }
      if (p.orientation && orient(it) && orient(it) !== p.orientation) { drop(`not ${p.orientation}`); return false; }
      return true;
    });
    const shown = kept.slice(0, p.limit);
    const handles = await s.setShown(p.kind, shown.map((it) => it.id));
    const lines = shown.map((it, i) => resultLine(it, handles[i]!));
    let sheet: string | undefined, list: string | undefined;
    if (ctx.services.writeWork) {
      list = await ctx.services.writeWork('search.json', new TextEncoder().encode(JSON.stringify({ query: q, items: shown.map((it, i) => ({ handle: handles[i], ...it })), more: kept.length - shown.length, failed, notes }, null, 1) + '\n'));
      if (visual && s.sheet && shown.length) {
        const png = await s.sheet(shown, handles).catch(() => undefined);
        if (png) sheet = await ctx.services.writeWork('search.png', png);
      }
    }
    ctx.out.items = shown;
    ctx.out.more = kept.length - shown.length;
    if (failed.length) ctx.out.failed = failed;
    if (sheet) ctx.out.sheet = sheet;
    if (list) ctx.out.list = list;
    const head = `${shown.length ? `${p.kind} for "${p.query}": ${shown.length} shown${kept.length > shown.length ? `, ${kept.length - shown.length} more (limit=)` : ''}` : `no usable ${p.kind} for "${p.query}"`} (providers: ${s.providers.filter((x) => x.media.includes(p.kind) && (!p.provider || x.id === p.provider)).map((x) => x.id).join(', ')})`;
    const tail: string[] = [];
    if (dropped.size) tail.push(`hidden: ${[...dropped].map(([k, n]) => `${n} ${k}`).join(', ')}${[...dropped.keys()].some((k) => k === 'share-alike' || k === 'non-commercial') ? ' (allow with licences=["share-alike"] or ["non-commercial"] if the video can carry them)' : ''}`);
    for (const f of failed) tail.push(`provider ${f.provider} failed: ${f.error}`);
    for (const n of notes.slice(0, 6)) tail.push(`note: ${n}`);
    if (notes.length > 6) tail.push(`note: … ${notes.length - 6} more in search.json`);
    if (sheet) tail.push(`previews: ${sheet} (labelled with the handles)`);
    if (shown.length) tail.push(`next: media.fetch id=${handles[0]}${p.kind === 'sfx' || p.kind === 'music' ? ' at=<time>' : ''}`);
    else tail.push(`try other words, a broader query, ${minWidth && visual ? `minWidth=0, ` : ''}or another kind`);
    ctx.summary([head, ...lines, ...tail].join('\n'));
  },
});

// ------------------------------------------------------------------------------------------- media.fetch

const ASSET_KIND: Record<StockKind, 'image' | 'video' | 'audio'> = { image: 'image', video: 'video', music: 'audio', sfx: 'audio' };
const slug = (t: string) => t.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '') || 'media';

function soundLine(s: SoundFacts): string {
  return `${s.duration.toFixed(2)}s, ${Number.isFinite(s.lufs) && s.lufs > -70 ? `${s.lufs.toFixed(1)} LUFS` : 'silent'}, peak ${s.peak.toFixed(1)} dBTP, starts ${s.onset.toFixed(2)}s, loudest ${s.peakAt.toFixed(2)}s, ${s.texture}, ${s.tone}${s.centroidHz ? ` (centroid ${s.centroidHz >= 1000 ? `${(s.centroidHz / 1000).toFixed(1)} kHz` : `${s.centroidHz} Hz`})` : ''}${s.bpm ? `, ~${s.bpm} BPM` : ''}`;
}

defineCommand({
  op: 'media.fetch', group: 'media',
  doc: 'Download one media.search result (its short handle such as i1, stable within the project, or its full id) into media/stock/<kind>/ (reused when already there) with a licence sidecar (<file>.json), add it as an asset with its licence and credit line, and with at= also a clip: music on a music-bus track, sfx on an sfx-bus track, images and video on a new top visual track (len: images 3 s, video up to 10 s, sounds their length). Sounds are described as text (loudness, peak, where it starts and peaks, tonal/noisy, dark/bright, tempo); align=onset starts the clip so the sound\'s first audible moment lands on at=. Refuses licences media.search would hide (licences=[...] allows share-alike or non-commercial). Credit attribution licences with media.credits.',
  schema: z.strictObject({
    id: z.string().min(2), as: Id.optional(), at: TimeArg.optional(), len: TimeArg.optional(), track: Id.optional(), comp: Id.optional(),
    clip: Id.optional(), gain: z.number().min(-60).max(12).optional(), align: z.enum(['start', 'onset']).default('start'), licences: Allow,
  }),
  primary: 'id', example: { id: 's1', at: '2s', align: 'onset' },
  async apply(ctx, p) {
    const s = needStock(ctx, 'media.fetch');
    const item = await s.item(p.id);
    if (!item) return fail('E_ARG', `unknown media id "${p.id}" (not in the last search of its kind, or a full id its provider cannot look up).`, 'run media.search and use a handle from its list (s1, m1, i1, v1).');
    const cls = licenceClass(item.licence.id), why = refusal(cls, [...DEFAULT_ALLOWED, ...(p.licences ?? [])]);
    if (why) fail('E_LICENCE', `${item.id} (${licenceName(item.licence.id)}) is refused: ${why}.`, 'pick another result (media.search shows only usable ones by default).');
    const provider = item.id.split(':')[0]!.replace(/[^A-Za-z0-9-]/g, '');
    const ext = (item.ext || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'bin';
    const rel = `media/stock/${item.kind}/${provider}-${createHash('sha1').update(item.id).digest('hex').slice(0, 10)}.${ext}`;
    let meta = await s.readSidecar(`${rel}.json`);
    const reused = !!meta && (await s.exists(rel));
    const credit = creditLine(item);
    if (!reused) {
      const { bytes, sha256 } = await s.download(item, rel);
      // make sure it is the kind of media it claims to be
      if (ctx.services.probe) {
        let info: Awaited<ReturnType<NonNullable<typeof ctx.services.probe>>> | undefined;
        try { info = await ctx.services.probe(rel); } catch { info = undefined; }
        const want = ASSET_KIND[item.kind];
        const ok = info && (want === 'audio' ? info.hasAudio !== false && (info.kind === 'audio' || info.kind === 'video') : want === 'video' ? info.kind === 'video' : info.kind === 'image' || (info.kind === 'video' && !info.duration));
        if (!ok) {
          await s.remove(rel);
          fail('E_MEDIA_FILE', `${item.id} did not download as ${want}${info ? ` (got ${info.kind})` : ' (ffprobe cannot read it)'}.`, 'pick another result (media.search).');
        }
        if (info?.width && !item.width) { item.width = info.width; item.height = info.height!; }
        if (info?.duration && item.seconds === undefined && want !== 'image') item.seconds = Math.round(info.duration * 100) / 100;
      }
      meta = {
        v: 1, id: item.id, kind: item.kind, title: item.title, ...(item.author ? { author: item.author } : {}), ...(item.authorUrl ? { authorUrl: item.authorUrl } : {}),
        source: item.source, url: item.url, file: item.file, licence: { id: item.licence.id, name: licenceName(item.licence.id), url: item.licence.url ?? licenceUrl(item.licence.id) ?? null, class: cls },
        credit, ...(item.width ? { width: item.width, height: item.height } : {}), ...(item.seconds !== undefined ? { seconds: item.seconds } : {}),
        fetched: new Date().toISOString().slice(0, 10), bytes, sha256,
      };
    }
    // sounds: described as text, kept in the sidecar
    let sound = meta!.sound as SoundFacts | undefined;
    if ((item.kind === 'sfx' || item.kind === 'music') && !sound && ctx.services.describeSound) {
      try {
        sound = await ctx.services.describeSound(rel);
        // a tempo means something for music only (an engine drone or a crowd has "beats" too)
        if (item.kind !== 'music') delete sound.bpm;
        meta!.sound = sound;
      } catch { /* described when possible */ }
    }
    if (!reused || sound) await s.writeSidecar(`${rel}.json`, meta);

    const assets = (ctx.project.assets ??= []);
    let asset: Asset | undefined = assets.find((a) => a.src === rel);
    if (!asset) {
      if (p.as !== undefined && assets.some((a) => a.id === p.as)) fail('E_DUPLICATE_ID', `asset "${p.as}" already exists.`, 'choose another id with as=, or omit it.');
      asset = { id: p.as ?? ctx.newId(slug(item.title)), src: rel, kind: ASSET_KIND[item.kind], licence: item.licence.id, credit, note: `${item.kind} from ${item.source}: ${item.url}` };
      assets.push(asset);
    }
    ctx.out.asset = asset.id; ctx.out.src = rel; ctx.out.licence = item.licence.id; ctx.out.credit = credit; ctx.out.reused = reused;
    if (sound) ctx.out.sound = sound;
    const lines = [`${reused ? 'reused' : 'fetched'} ${rel} as asset "${asset.id}" (${licenceName(item.licence.id)}${cls === 'attribution' ? ', credit required: media.credits' : ''})`];
    if (sound) lines.push(`sound: ${soundLine(sound)}`);

    if (p.at !== undefined || p.clip !== undefined) {
      const comp: Comp = compFor(ctx, p);
      const fps = ctx.rate(comp).num / ctx.rate(comp).den;
      let at = p.at !== undefined ? ctx.time(p.at, comp, 'at') : 0;
      const srcSecs = sound?.duration ?? item.seconds;
      let len = p.len !== undefined ? ctx.time(p.len, comp, 'len')
        : item.kind === 'image' ? Math.round(3 * fps)
          : item.kind === 'video' ? Math.max(1, Math.floor(Math.min(srcSecs ?? 10, 10) * fps))
            : Math.max(1, Math.floor((srcSecs ?? 3) * fps));
      let inF = 0;
      if (p.align === 'onset' && sound) {
        at -= Math.round(sound.onset * fps);
        if (at < 0) { inF = -at; at = 0; }
        if (p.len === undefined) len = Math.max(1, len - inF);
      }
      const end = compLength(ctx, comp);
      if (item.kind === 'music' && p.len === undefined && end !== undefined && at + len > end) len = Math.max(1, end - at);
      const id = p.clip ?? ctx.newId(`${({ image: 'img', video: 'vid', music: 'mus', sfx: 'sfx' } as const)[item.kind]}-${slug(item.title)}`.slice(0, 24).replace(/-+$/, ''));
      if ((ctx.project.clips ?? []).some((c) => c.id === id)) fail('E_DUPLICATE_ID', `clip "${id}" already exists.`, 'choose another id with clip=, or omit it.');
      let track: string;
      if (item.kind === 'music' || item.kind === 'sfx') track = busTrack(ctx, comp, item.kind, at, at + len, item.kind === 'music' ? 'MUS' : 'SFX', p.track);
      else if (p.track) { ctx.track(p.track); track = p.track; }
      else {
        track = ctx.newId('V');
        (ctx.project.tracks ??= []).push({ id: track, comp: comp.id });
        ctx.note(`created visual track ${track} on top of comp "${comp.id}".`);
      }
      const clip: Clip = { id, track, at, len, asset: asset.id, ...(inF ? { in: inF } : {}), ...(p.gain !== undefined ? { gain: p.gain } : {}) };
      (ctx.project.clips ??= []).push(clip);
      if (typeof comp.length === 'number' && at + len > comp.length && item.kind !== 'music') ctx.note(`the clip ends at frame ${at + len}, after the end of comp "${comp.id}" (${comp.length}); extend it with comp.set ${comp.id} length=${at + len} (or length=auto).`);
      ctx.out.clip = id; ctx.out.at = at; ctx.out.len = len;
      lines.push(`added clip "${id}" on ${track} at ${at}–${at + len}${inF ? ` (starts ${inF} frames into the file so the sound lands on the beat)` : ''}`);
    }
    ctx.summary(lines.join('\n'));
  },
});

// ------------------------------------------------------------------------------------------- media.credits

/** Assets that carry a credit line and are used by a clip (any comp), in first-use order. */
export function creditedAssets(project: CommandContext['project']): Asset[] {
  const used = new Set((project.clips ?? []).map((c) => c.asset).filter((a): a is string => !!a));
  return (project.assets ?? []).filter((a) => a.credit && used.has(a.id));
}

defineCommand({
  op: 'media.credits', group: 'media',
  doc: 'Write attribution lines (title, author, source, licence) for every open-media asset in use: to a text file (out=, default credits.txt, e.g. for the video description) and with card=true as a credits card appended after the end of the comp (a dark card with the lines, len default 3 s; the comp is extended when its length is a number). Records what was credited in project.credits, which the stock-credits QA rule reads.',
  schema: z.strictObject({ out: z.string().min(1).optional(), card: z.boolean().optional(), len: TimeArg.optional(), comp: Id.optional() }),
  example: { card: true },
  async apply(ctx, p) {
    const list = creditedAssets(ctx.project);
    if (!list.length) { ctx.summary('no open-media assets in use: nothing to credit.'); ctx.out.lines = []; return; }
    const lines = list.map((a) => a.credit!);
    const out = p.out ?? (p.card ? undefined : 'credits.txt');
    if (out) {
      if (!ctx.services.writeProjectText) fail('E_NO_SERVICE', 'media.credits writes a file, and no file service is available here.', 'run it through the CLI (mgl edit) or the SDK (open(file)).');
      await ctx.services.writeProjectText(out, `Credits\n\n${lines.join('\n')}\n`);
    }
    const proj = { ...(ctx.project.project ?? {}) };
    proj.credits = { ...(out ? { file: out } : proj.credits?.file ? { file: proj.credits.file } : {}), assets: list.map((a) => a.id) };
    ctx.project.project = proj;
    if (p.card) {
      const comp = compFor(ctx, p);
      const fps = ctx.rate(comp).num / ctx.rate(comp).den;
      const len = p.len !== undefined ? ctx.time(p.len, comp, 'len') : Math.round(3 * fps);
      // replace an earlier credits card
      const old = new Set((ctx.project.clips ?? []).filter((c) => c.tags?.includes('credits') && ctx.compOfClip(c).id === comp.id).map((c) => c.id));
      ctx.project.clips = (ctx.project.clips ?? []).filter((c) => !old.has(c.id));
      const usedTracks = new Set((ctx.project.clips ?? []).map((c) => c.track));
      ctx.project.tracks = (ctx.project.tracks ?? []).filter((t) => !(t.comp === comp.id && /^CREDITS\d*$/.test(t.id) && !usedTracks.has(t.id)));
      const start = compLength(ctx, comp) ?? 0;
      const [W, H] = comp.size;
      // the area clear of the TikTok / Reels / Shorts interface on a vertical comp, title-safe 90 % otherwise
      const safe = H > W ? { x0: 0.05 * W, x1: 0.86 * W, y0: 0.1 * H, y1: 0.79 * H } : { x0: 0.05 * W, x1: 0.95 * W, y0: 0.05 * H, y1: 0.95 * H };
      // legible: at least 2.6 % of the frame height (the tiny-text rule is 2.5 %)
      const size = Math.round(Math.max(H, W) * (H > W ? 0.026 : 0.034) * (H > W ? 1 : Math.min(1, H / W) * 1.6));
      const style = { size, color: '#f2f2f2', align: 'center' as const, lineHeight: 1.3, maxWidth: Math.round((safe.x1 - safe.x0) * 0.94) };
      const budget = (safe.y1 - safe.y0) * 0.92;
      const height = (text: string) => ctx.services.measureText?.(text, style).height
        ?? text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil((l.length * size * 0.55) / style.maxWidth)), 0) * size * style.lineHeight;
      // pages of lines that fit; "Credits" heads the first
      const pages: string[][] = [];
      let page: string[] = ['Credits'];
      for (const l of lines) {
        if (page.length > 1 && height([...page, l].join('\n\n')) > budget) { pages.push(page); page = []; }
        page.push(l);
      }
      pages.push(page);
      const bgTrack = ctx.newId('CREDITS');
      (ctx.project.tracks ??= []).push({ id: bgTrack, comp: comp.id });
      const textTrack = ctx.newId('CREDITS');
      ctx.project.tracks.push({ id: textTrack, comp: comp.id });
      // credits hold still on purpose: the static-visuals rule skips them
      const tags = ['credits', 'qa-ignore:static'];
      pages.forEach((pg, i) => {
        const at = start + i * len;
        (ctx.project.clips ??= []).push(
          { id: ctx.newId('credits-bg'), track: bgTrack, at, len, color: '#101014', tags },
          { id: ctx.newId('credits'), track: textTrack, at, len, text: pg.join('\n\n'), style, x: Math.round((safe.x0 + safe.x1) / 2), y: Math.round((safe.y0 + safe.y1) / 2), tags },
        );
      });
      const end = start + pages.length * len;
      if (typeof comp.length === 'number' && comp.length < end) comp.length = end;
      ctx.out.card = { at: start, len: end - start, pages: pages.length };
    }
    ctx.out.lines = lines;
    if (out) ctx.out.file = out;
    ctx.summary([`credited ${lines.length} asset${lines.length > 1 ? 's' : ''}${out ? ` in ${out}` : ''}${p.card ? `${out ? ' and' : ''} on ${(ctx.out.card as { pages: number }).pages > 1 ? `${(ctx.out.card as { pages: number }).pages} credits cards` : 'a credits card'} at the end` : ''}:`, ...lines.slice(0, 8).map((l) => `  ${l}`), ...(lines.length > 8 ? [`  … ${lines.length - 8} more`] : [])].join('\n'));
  },
});
