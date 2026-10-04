import { definePlugin, defineProvider, defineCommand, canonicalLicence, z, type StockContext, type StockItem, type StockKind, type StockProvider, type StockQuery } from 'michelangelo/plugin';

/**
 * open-media: openly licensed images, footage, music and sound effects for media.search / media.fetch (plugin API 1.5).
 *
 * One stock provider, many sources. Each source maps an archive's API to StockItems with canonical licence ids and
 * drops anything it cannot map (fail closed); core applies the licence rules, downloads, sidecars and credits.
 * Nothing is bundled. Keyless by default; sources that need a key switch on when its environment variable is set.
 *
 *   sfx    Openverse → Freesound (or the Freesound API with FREESOUND_API_KEY)
 *   music  Openverse → Jamendo, ccMixter; Wikimedia Commons audio (Musopen recordings and other public-domain music)
 *   image  Openverse (Flickr, museums, ...), Wikimedia Commons, NASA, Smithsonian (SMITHSONIAN_API_KEY, or a local index
 *          built from its open-access dump with open-media.index), Library of Congress, The Met, Cleveland Museum of
 *          Art, Wellcome Collection, SMK; with keys Europeana, Pexels, Pixabay, Unsplash
 *   video  Wikimedia Commons, NASA, Prelinger Archives (Internet Archive); with keys Pexels, Pixabay
 *
 * Node built-ins are imported lazily, so loading the plugin costs nothing until it is used.
 */

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface Source {
  id: string;
  name: string;
  media: StockKind[];
  /** environment variable of a required key (the source is off without it) */
  key?: string;
  /** whether the source can run now (keys, local indexes); a reason when it cannot */
  ready?(ctx: StockContext): Promise<string | undefined>;
  search(q: StockQuery, ctx: StockContext, n: number): Promise<StockItem[]>;
  fetch?(item: StockItem, out: string, ctx: StockContext): Promise<void>;
}

// ------------------------------------------------------------------------------------------- helpers

const PROVIDER = 'open-media';
const idOf = (source: string, raw: string | number) => `${PROVIDER}:${source}:${raw}`;
const sourceOf = (id: string) => id.split(':')[1] ?? '';

/** GET JSON; a non-2xx answer is an error naming the host and status (429 says "rate limited"). */
export async function getJson(ctx: StockContext, url: string, headers?: Record<string, string>): Promise<Json> {
  const r = await ctx.fetch(url, { headers: { Accept: 'application/json', ...(headers ?? {}) } });
  if (!r.ok) throw new Error(`${new URL(url).host} answered HTTP ${r.status}${r.status === 429 ? ' (rate limited; try again in a minute)' : r.status === 401 || r.status === 403 ? ' (key missing or refused)' : ''}`);
  const text = await r.text();
  try { return JSON.parse(text); } catch { throw new Error(`${new URL(url).host} did not answer JSON (${text.slice(0, 60).replace(/\s+/g, ' ')})`); }
}

/** Download `url` to `out` (absolute path). */
export async function download(ctx: StockContext, url: string, out: string, headers?: Record<string, string>): Promise<void> {
  const r = await ctx.fetch(url, headers ? { headers } : undefined);
  if (!r.ok) throw new Error(`download from ${new URL(url).host} failed: HTTP ${r.status}${r.status === 429 ? ' (rate limited; try again in a minute)' : ''}`);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(out, Buffer.from(await r.arrayBuffer()));
}

export const stripHtml = (s: unknown): string => (typeof s === 'string' ? s.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim() : '');
const extOf = (url: string, fallback: string) => (/\.([a-z0-9]{2,4})(?:$|[?#])/i.exec(new URL(url).pathname)?.[1] ?? fallback).toLowerCase();
const https = (u: string) => u.replace(/^http:\/\//, 'https://');
const qs = (o: Record<string, string | number | undefined>) => Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
const ncAllowed = (q: StockQuery) => !!q.licences?.includes('non-commercial');

// ------------------------------------------------------------------------------------------- Openverse

const OV_SOURCES: Record<string, string> = { freesound: 'Freesound', jamendo: 'Jamendo', ccmixter: 'ccMixter', wikimedia: 'Wikimedia Commons', wikimedia_audio: 'Wikimedia Commons', flickr: 'Flickr', met: 'The Met', rijksmuseum: 'Rijksmuseum', smithsonian_national_museum_of_natural_history: 'Smithsonian NMNH', nasa: 'NASA', stocksnap: 'StockSnap', rawpixel: 'rawpixel', europeana: 'Europeana', brooklynmuseum: 'Brooklyn Museum', clevelandmuseum: 'Cleveland Museum of Art', sciencemuseum: 'Science Museum', wellcome_collection: 'Wellcome Collection', bio_diversity: 'Biodiversity Heritage Library' };
const ovSource = (s: string) => `${OV_SOURCES[s] ?? s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())} via Openverse`;

export function openverseItem(r: Json, kind: StockKind): StockItem | undefined {
  const lic = canonicalLicence(r.license_url) ?? canonicalLicence(r.license, r.license_version);
  if (!lic || !r.url || !r.id) return undefined;
  const it: StockItem = {
    id: idOf('openverse', r.id), kind, title: stripHtml(r.title) || 'untitled', url: r.foreign_landing_url ?? r.detail_url ?? r.url, file: r.url, ext: (r.filetype || extOf(r.url, kind === 'image' ? 'jpg' : 'mp3')).toLowerCase(),
    licence: { id: lic, ...(r.license_url ? { url: r.license_url } : {}) }, source: ovSource(r.source ?? r.provider ?? 'openverse'),
  };
  if (r.creator) it.author = stripHtml(r.creator);
  if (r.creator_url) it.authorUrl = r.creator_url;
  if (typeof r.duration === 'number') it.seconds = Math.round(r.duration / 10) / 100;
  if (r.width && r.height) { it.width = r.width; it.height = r.height; }
  if (r.filesize) it.bytes = r.filesize;
  if (r.thumbnail) it.preview = r.thumbnail;
  const tags = (r.tags ?? []).map((t: Json) => t?.name).filter(Boolean);
  if (tags.length) it.tags = tags.slice(0, 12);
  return it;
}

const openverse: Source = {
  id: 'openverse', name: 'Openverse (Freesound, Jamendo, ccMixter, Flickr, museums)', media: ['image', 'music', 'sfx'],
  async search(q, ctx, n) {
    const audio = q.kind !== 'image';
    // anonymous requests may ask for at most 20 results per page (more answers 401)
    const params: Record<string, string | number | undefined> = { q: q.query, page_size: Math.min(20, n), page: q.page, license_type: ncAllowed(q) ? undefined : 'commercial,modification' };
    if (q.kind === 'sfx') params.source = 'freesound';
    if (q.kind === 'music') params.source = 'jamendo,ccmixter';
    if (q.kind === 'image' && q.orientation) params.aspect_ratio = q.orientation === 'portrait' ? 'tall' : q.orientation === 'landscape' ? 'wide' : 'square';
    const d = await getJson(ctx, `https://api.openverse.org/v1/${audio ? 'audio' : 'images'}/?${qs(params)}`);
    return (d.results ?? []).map((r: Json) => openverseItem(r, q.kind)).filter(Boolean) as StockItem[];
  },
};

// ------------------------------------------------------------------------------------------- Wikimedia Commons

const COMMONS_TYPES: Partial<Record<StockKind, string>> = { image: 'bitmap', video: 'video', music: 'audio' };
const AUDIO_MIME = /^(audio\/(ogg|x-flac|flac|wav|x-wav|mpeg|webm)|application\/ogg)$/;

/** Map Commons' licence fields: the URL first, then the short name; "Public domain" without a URL is public domain. */
export function commonsLicence(em: Json): string | undefined {
  const url = em?.LicenseUrl?.value, short = stripHtml(em?.LicenseShortName?.value);
  return canonicalLicence(url) ?? canonicalLicence(short) ?? (/^public domain$|^pd(-|$)/i.test(short) ? 'public-domain' : undefined);
}

/**
 * The best video file: the smallest WebM transcode whose long side reaches `minLong`, else the original when it does
 * (Commons keeps full-size originals; transcodes may stop at 480p), else the largest file there is.
 */
export function pickDerivative(vi: Json, minLong = 1080): { src: string; width?: number; height?: number } | undefined {
  const ds: Json[] = (vi?.derivatives ?? []).filter((d: Json) => d?.src);
  const long = (d: Json) => Math.max(Number(d.width) || 0, Number(d.height) || 0);
  const original = ds.find((d) => !d.transcodekey);
  const webm = ds.filter((d) => d.transcodekey && /webm/.test(d.type ?? '') && long(d)).sort((a, b) => long(a) - long(b));
  const pick = webm.find((d) => long(d) >= minLong) ?? (original && long(original) >= minLong ? original : undefined) ?? [...ds].sort((a, b) => long(b) - long(a))[0];
  return pick ? { src: pick.src, ...(pick.width ? { width: Number(pick.width), height: Number(pick.height) } : {}) } : undefined;
}

export function commonsItem(p: Json, kind: StockKind, minH?: number): StockItem | undefined {
  const ii = p?.imageinfo?.[0];
  if (!ii?.url) return undefined;
  const em = ii.extmetadata ?? {};
  const lic = commonsLicence(em);
  if (!lic) return undefined;
  if (kind === 'music' && !AUDIO_MIME.test(ii.mime ?? '')) return undefined;
  if (kind === 'image' && !/^image\/(jpeg|png|webp|tiff)$/.test(ii.mime ?? '')) return undefined;
  const title = stripHtml(em.ObjectName?.value) || String(p.title ?? '').replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '');
  let file = ii.url as string, width = ii.width as number | undefined, height = ii.height as number | undefined;
  if (kind === 'video') {
    const d = pickDerivative(p.videoinfo?.[0], minH);
    if (d) { file = d.src; if (d.width) { width = d.width; height = d.height; } }
  }
  const it: StockItem = { id: idOf('commons', p.pageid), kind, title, url: ii.descriptionurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(p.title)}`, file, ext: extOf(file, 'bin'), licence: { id: lic, ...(em.LicenseUrl?.value ? { url: em.LicenseUrl.value } : {}) }, source: 'Wikimedia Commons' };
  const author = stripHtml(em.Artist?.value);
  if (author) it.author = author.slice(0, 80);
  if (width && height && kind !== 'music') { it.width = width; it.height = height; }
  if (typeof ii.duration === 'number' && kind !== 'image') it.seconds = Math.round(ii.duration * 100) / 100;
  if (ii.thumburl) it.preview = ii.thumburl;
  if (em.DateTimeOriginal?.value) it.date = stripHtml(em.DateTimeOriginal.value).slice(0, 20);
  return it;
}

const commons: Source = {
  id: 'commons', name: 'Wikimedia Commons', media: ['image', 'video', 'music'],
  async search(q, ctx, n) {
    const params = {
      action: 'query', format: 'json', formatversion: 2, generator: 'search', gsrnamespace: 6, gsrsearch: `${q.query} filetype:${COMMONS_TYPES[q.kind]}`, gsrlimit: Math.min(50, n),
      gsroffset: q.page ? (q.page - 1) * n : undefined, prop: q.kind === 'video' ? 'imageinfo|videoinfo' : 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: 400,
      iiextmetadatafilter: 'LicenseShortName|LicenseUrl|Artist|ObjectName|DateTimeOriginal', ...(q.kind === 'video' ? { viprop: 'derivatives|size|mime' } : {}),
    };
    const d = await getJson(ctx, `https://commons.wikimedia.org/w/api.php?${qs(params)}`);
    const pages: Json[] = [...(d.query?.pages ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return pages.map((p) => commonsItem(p, q.kind, q.minWidth)).filter(Boolean) as StockItem[];
  },
};

// ------------------------------------------------------------------------------------------- NASA

/** NASA media are US-government works unless a third party made them: keep only NASA-credited or uncredited items. */
export function nasaUsable(d: Json): boolean {
  const who = [d.photographer, d.secondary_creator].filter(Boolean).join(' ');
  if (who && !/\bNASA\b/i.test(who)) return false;
  return !/©|copyright/i.test(`${d.description ?? ''} ${d.title ?? ''}`);
}

export function nasaItem(it: Json, kind: StockKind): StockItem | undefined {
  const d = it?.data?.[0];
  if (!d?.nasa_id || !nasaUsable(d)) return undefined;
  const preview = (it.links ?? []).find((l: Json) => l.render === 'image')?.href;
  const out: StockItem = {
    id: idOf('nasa', encodeURIComponent(d.nasa_id)), kind, title: stripHtml(d.title) || d.nasa_id, url: `https://images.nasa.gov/details/${encodeURIComponent(d.nasa_id)}`,
    file: `https://images-api.nasa.gov/asset/${encodeURIComponent(d.nasa_id)}`, ext: kind === 'video' ? 'mp4' : 'jpg',
    licence: { id: 'pd-us-gov', url: 'https://www.nasa.gov/nasa-brand-center/images-and-media/' }, author: d.photographer ? stripHtml(d.photographer) : 'NASA',
    source: `NASA${d.center ? ` (${d.center})` : ''}`,
  };
  if (preview) out.preview = https(preview);
  if (d.date_created) out.date = String(d.date_created).slice(0, 10);
  if (d.keywords?.length) out.tags = d.keywords.slice(0, 12);
  return out;
}

/** From NASA's asset list: the original JPEG / PNG for images, ~large (else ~orig, ~medium) MP4 for video. */
export function nasaFile(assets: Json, kind: StockKind): string | undefined {
  const hrefs: string[] = (assets?.collection?.items ?? []).map((x: Json) => https(String(x.href)));
  const pick = (re: RegExp) => hrefs.find((h) => re.test(h));
  return kind === 'video' ? pick(/~large\.mp4$/i) ?? pick(/~orig\.mp4$/i) ?? pick(/~medium\.mp4$/i) ?? pick(/\.mp4$/i)
    : pick(/~orig\.(jpe?g|png)$/i) ?? pick(/~large\.jpe?g$/i) ?? pick(/\.(jpe?g|png)$/i);
}

const nasa: Source = {
  id: 'nasa', name: 'NASA Image and Video Library', media: ['image', 'video'],
  async search(q, ctx, n) {
    const d = await getJson(ctx, `https://images-api.nasa.gov/search?${qs({ q: q.query, media_type: q.kind, page_size: Math.min(100, n * 2), page: q.page })}`);
    return (d.collection?.items ?? []).map((it: Json) => nasaItem(it, q.kind)).filter(Boolean).slice(0, n) as StockItem[];
  },
  async fetch(item, out, ctx) {
    const file = nasaFile(await getJson(ctx, item.file), item.kind);
    if (!file) throw new Error(`NASA lists no ${item.kind} file for ${item.id}`);
    await download(ctx, file, out);
  },
};

// ------------------------------------------------------------------------------------------- Smithsonian

const SI_AUTHOR = /^(artist|creator|created by|maker|photographer|designer|manufacturer|author|engraver|printmaker|illustrator|lithographer|painter|sculptor|architect)$/i;
export const SI_DEFAULT_UNITS = ['chndm', 'npg', 'saam', 'fsg', 'nmaahc'];
const SI_DUMP = 'https://smithsonian-open-access.s3-us-west-2.amazonaws.com/metadata/edan';

/** A Smithsonian EDAN record (API row or dump line) with a CC0 image → compact fields, or undefined. */
export function siRecord(r: Json): SiEntry | undefined {
  const c = r?.content ?? {}, dn = c.descriptiveNonRepeating ?? {};
  const media: Json[] = dn.online_media?.media ?? [];
  const img = media.find((m) => m?.type === 'Images' && m?.usage?.access === 'CC0' && m?.idsId);
  if (!img) return undefined;
  const ix = c.indexedStructured ?? {};
  const names: Json[] = c.freetext?.name ?? [];
  const author = names.find((x) => SI_AUTHOR.test(String(x?.label ?? '').trim()))?.content;
  const e: SiEntry = { i: img.idsId, t: stripHtml(dn.title?.content ?? r.title ?? '').slice(0, 160), u: String(r.unitCode ?? dn.unit_code ?? ''), s: String(dn.data_source ?? '') };
  if (author) e.a = stripHtml(author).replace(/,\s*(\d{1,2} \w{3} )?\d{4}\s*-.*$/, '').slice(0, 80);
  const link = dn.record_link ?? dn.guid;
  if (link) e.l = link;
  if (ix.date?.[0]) e.d = String(ix.date[0]);
  const words = [...(ix.topic ?? []), ...(ix.object_type ?? []), ...(ix.place ?? []), ...(ix.name ?? [])].map(String);
  if (words.length) e.k = words.slice(0, 24);
  return e;
}

export interface SiEntry { i: string; t: string; u: string; s: string; a?: string; l?: string; d?: string; k?: string[] }

export function siItem(e: SiEntry): StockItem {
  const src = e.s ? (/^smithsonian/i.test(e.s) ? e.s : `Smithsonian ${e.s}`) : 'Smithsonian Institution';
  const it: StockItem = {
    id: idOf('smithsonian', e.i), kind: 'image', title: e.t || 'untitled', url: e.l ?? `https://www.si.edu/search/collection-images?edan_q=${encodeURIComponent(e.i)}`,
    file: `https://ids.si.edu/ids/deliveryService?id=${encodeURIComponent(e.i)}&max=4000`, ext: 'jpg', licence: { id: 'cc0', url: 'https://creativecommons.org/publicdomain/zero/1.0/' },
    source: src, preview: `https://ids.si.edu/ids/deliveryService?id=${encodeURIComponent(e.i)}&max=300`,
  };
  if (e.a) it.author = e.a;
  if (e.d) it.date = e.d;
  if (e.k?.length) it.tags = e.k.slice(0, 12);
  return it;
}

const words = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length > 1);

/** Rank index entries: every query word must appear; title hits count most. */
export function siSearch(entries: SiEntry[], query: string, n: number): SiEntry[] {
  const want = words(query);
  if (!want.length) return [];
  const scored: [number, SiEntry][] = [];
  for (const e of entries) {
    const title = new Set(words(e.t)), rest = new Set(words(`${(e.k ?? []).join(' ')} ${e.a ?? ''}`));
    let score = 0, ok = true;
    for (const w of want) {
      const t = title.has(w) || [...title].some((x) => x.startsWith(w) && w.length >= 4);
      const r = rest.has(w) || [...rest].some((x) => x.startsWith(w) && w.length >= 4);
      if (!t && !r) { ok = false; break; }
      score += t ? 3 : 1;
    }
    if (ok) scored.push([score, e]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, n).map(([, e]) => e);
}

/** The folder of this provider's caches (the same path core gives StockContext.cacheDir). */
export async function cacheDir(): Promise<string> {
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const root = process.env.MGL_CACHE_DIR || join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'michelangelo');
  return join(root, 'stock', PROVIDER);
}

async function siIndexFiles(dir: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  try { return (await readdir(join(dir, 'smithsonian'))).filter((f) => f.endsWith('.jsonl.gz')).map((f) => join(dir, 'smithsonian', f)); } catch { return []; }
}

let siCache: { key: string; entries: SiEntry[] } | undefined;
async function siLoad(dir: string): Promise<SiEntry[]> {
  const files = await siIndexFiles(dir);
  const { stat, readFile } = await import('node:fs/promises');
  const { gunzipSync } = await import('node:zlib');
  const key = (await Promise.all(files.map(async (f) => `${f}:${(await stat(f)).mtimeMs}`))).join('|');
  if (siCache?.key === key) return siCache.entries;
  const entries: SiEntry[] = [];
  for (const f of files) for (const line of gunzipSync(await readFile(f)).toString('utf8').split('\n')) if (line) entries.push(JSON.parse(line) as SiEntry);
  siCache = { key, entries };
  return entries;
}

const smithsonian: Source = {
  id: 'smithsonian', name: 'Smithsonian Open Access (CC0)', media: ['image'],
  async ready(ctx) {
    if (ctx.env('SMITHSONIAN_API_KEY')) return undefined;
    if ((await siIndexFiles(ctx.cacheDir)).length) return undefined;
    return 'skipped: set SMITHSONIAN_API_KEY (free: https://api.data.gov/signup/) or build the keyless index once with open-media.index (about 0.5 GB streamed, under a minute)';
  },
  async search(q, ctx, n) {
    const key = ctx.env('SMITHSONIAN_API_KEY');
    if (key) {
      // natural-history specimens (herbarium sheets, specimen photos) swamp ordinary words and are rarely footage material
      const terms = q.query.replace(/[():"]/g, ' ').trim();
      const d = await getJson(ctx, `https://api.si.edu/openaccess/api/v1.0/search?${qs({ q: `${terms} AND media_usage:CC0 AND online_media_type:Images AND NOT unit_code:NMNH*`, rows: Math.min(100, n), start: q.page ? (q.page - 1) * n : undefined, api_key: key })}`);
      return (d.response?.rows ?? []).map(siRecord).filter(Boolean).map((e: SiEntry) => siItem(e));
    }
    return siSearch(await siLoad(ctx.cacheDir), q.query, n).map(siItem);
  },
};

/**
 * Build the keyless Smithsonian index: stream every shard of the chosen units from the open-access dump and keep only
 * records with a CC0 image, as <cache>/smithsonian/<unit>.jsonl.gz. `get` fetches a URL (injected in tests).
 */
export async function buildSiIndex(o: { units: string[]; dir: string; get: (url: string) => Promise<Response>; concurrency?: number; onProgress?: (done: number, total: number) => void }): Promise<{ unit: string; records: number; images: number; bytes: number }[]> {
  const { mkdir, writeFile, rename } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { gzipSync } = await import('node:zlib');
  await mkdir(join(o.dir, 'smithsonian'), { recursive: true });
  const out: { unit: string; records: number; images: number; bytes: number }[] = [];
  for (const unit of o.units) {
    const list = await o.get(`${SI_DUMP}/${unit}/index.txt`);
    if (!list.ok) throw new Error(`the Smithsonian dump has no unit "${unit}" (HTTP ${list.status})`);
    const shards = (await list.text()).split('\n').map((s) => s.trim()).filter(Boolean);
    const lines: string[] = [];
    let records = 0, bytes = 0, done = 0, next = 0;
    const worker = async () => {
      while (next < shards.length) {
        const url = shards[next++]!;
        const r = await o.get(url);
        if (!r.ok) throw new Error(`shard ${url} answered HTTP ${r.status}`);
        const text = await r.text();
        bytes += text.length;
        for (const line of text.split('\n')) {
          if (!line) continue;
          records++;
          let e: SiEntry | undefined;
          try { e = siRecord(JSON.parse(line)); } catch { e = undefined; }
          if (e) lines.push(JSON.stringify(e));
        }
        o.onProgress?.(++done, shards.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(o.concurrency ?? 16, shards.length) }, worker));
    const file = join(o.dir, 'smithsonian', `${unit}.jsonl.gz`), tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, gzipSync(lines.join('\n') + '\n'));
    await rename(tmp, file);
    out.push({ unit, records, images: lines.length, bytes });
  }
  return out;
}

// ------------------------------------------------------------------------------------------- Library of Congress

/** The full-size IIIF URL of a P&P image from its service JPEG ("…/service/pnp/cph/…/3a30132r.jpg" → master TIFF via IIIF). */
export function locMaster(service: string): string | undefined {
  const m = /storage-services\/service\/(pnp\/.+?)[a-z]?\.jpg/i.exec(service);
  return m ? `https://tile.loc.gov/image-services/iiif/master:${m[1]!.replace(/\//g, ':')}u/full/pct:100/0/default.jpg` : undefined;
}

export function locItem(r: Json): StockItem | undefined {
  const it = r?.item ?? {};
  const rights = String(it.rights_advisory ?? r.rights_advisory ?? '');
  if (!/no known restrictions/i.test(rights)) return undefined;
  const medium = it.service_medium ?? (r.image_url ?? []).find((u: string) => /r\.jpg/.test(u)) ?? (r.image_url ?? []).at(-1);
  if (!medium) return undefined;
  const service = String(medium).split('#')[0]!;
  const out: StockItem = {
    id: idOf('loc', String(r.id ?? r.url).replace(/^https?:\/\/www\.loc\.gov\/item\//, '').replace(/\/$/, '')), kind: 'image', title: stripHtml(r.title ?? it.title).slice(0, 160) || 'untitled',
    url: https(String(r.url ?? r.id)), file: locMaster(service) ?? service, ext: 'jpg', licence: { id: 'nkr', url: 'https://www.loc.gov/legal/understanding-copyright/' }, source: 'Library of Congress',
  };
  const thumb = (r.image_url ?? [])[0];
  if (thumb) out.preview = String(thumb).split('#')[0];
  const who = it.creator ?? it.contributor_names?.[0] ?? r.contributor?.[0];
  if (who) out.author = stripHtml(Array.isArray(who) ? who[0] : who).slice(0, 80);
  if (r.date) out.date = String(r.date).slice(0, 10);
  if (it.subjects?.length) out.tags = it.subjects.slice(0, 10);
  return out;
}

const loc: Source = {
  id: 'loc', name: 'Library of Congress (photos, prints, posters)', media: ['image'],
  async search(q, ctx, n) {
    const d = await getJson(ctx, `https://www.loc.gov/photos/?${qs({ q: q.query, fo: 'json', c: Math.min(100, n * 2), sp: q.page, fa: 'online-format:image', at: 'results' })}`);
    return (d.results ?? []).map(locItem).filter(Boolean).slice(0, n) as StockItem[];
  },
  async fetch(item, out, ctx) {
    // the master via IIIF when there is one, else the service JPEG
    const fallback = item.preview?.replace(/_150px\.jpg$/, 'r.jpg');
    try { await download(ctx, item.file, out); } catch (e) { if (!fallback || fallback === item.file) throw e; await download(ctx, fallback, out); }
  },
};

// ------------------------------------------------------------------------------------------- museums

export function metItem(o: Json): StockItem | undefined {
  if (!o?.isPublicDomain || !o.primaryImage) return undefined;
  const it: StockItem = {
    id: idOf('met', o.objectID), kind: 'image', title: stripHtml(o.title) || 'untitled', url: o.objectURL ?? `https://www.metmuseum.org/art/collection/search/${o.objectID}`, file: o.primaryImage, ext: extOf(o.primaryImage, 'jpg'),
    licence: { id: 'cc0', url: 'https://creativecommons.org/publicdomain/zero/1.0/' }, source: 'The Metropolitan Museum of Art',
  };
  if (o.artistDisplayName) it.author = stripHtml(o.artistDisplayName);
  if (o.primaryImageSmall) it.preview = o.primaryImageSmall;
  if (o.objectDate) it.date = String(o.objectDate);
  const tags = (o.tags ?? []).map((t: Json) => t?.term).filter(Boolean);
  if (tags.length) it.tags = tags.slice(0, 10);
  return it;
}

const met: Source = {
  id: 'met', name: 'The Metropolitan Museum of Art (open access)', media: ['image'],
  async search(q, ctx, n) {
    const d = await getJson(ctx, `https://collectionapi.metmuseum.org/public/collection/v1.1/search?${qs({ q: q.query, hasImages: 'true', isPublicDomain: 'true', limit: n, offset: q.page ? (q.page - 1) * n : undefined })}`);
    const ids: number[] = (d.objectIDs ?? []).slice(0, n);
    const objs = await Promise.all(ids.map((id) => getJson(ctx, `https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`).catch(() => undefined)));
    return objs.map(metItem).filter(Boolean) as StockItem[];
  },
};

export function clevelandItem(x: Json): StockItem | undefined {
  if (x?.share_license_status !== 'CC0') return undefined;
  const img = x.images?.print ?? x.images?.web;
  if (!img?.url) return undefined;
  const it: StockItem = {
    id: idOf('cleveland', x.id), kind: 'image', title: stripHtml(x.title) || 'untitled', url: x.url ?? `https://clevelandart.org/art/${x.accession_number}`, file: img.url, ext: extOf(img.url, 'jpg'),
    licence: { id: 'cc0', url: 'https://creativecommons.org/publicdomain/zero/1.0/' }, source: 'Cleveland Museum of Art',
  };
  if (img.width && img.height) { it.width = Number(img.width); it.height = Number(img.height); }
  if (x.images?.web?.url) it.preview = x.images.web.url;
  const who = x.creators?.[0]?.description;
  if (who) it.author = stripHtml(who).slice(0, 80);
  if (x.creation_date) it.date = String(x.creation_date);
  return it;
}

const cleveland: Source = {
  id: 'cleveland', name: 'Cleveland Museum of Art (CC0)', media: ['image'],
  async search(q, ctx, n) {
    const d = await getJson(ctx, `https://openaccess-api.clevelandart.org/api/artworks/?${qs({ q: q.query, cc0: 1, has_image: 1, limit: n, skip: q.page ? (q.page - 1) * n : undefined })}`);
    return (d.data ?? []).map(clevelandItem).filter(Boolean) as StockItem[];
  },
};

const WELLCOME_LICENCES: Record<string, string> = { pdm: 'pdm', 'cc-0': 'cc0', 'cc-by': 'cc-by-4.0', 'cc-by-nc': 'cc-by-nc-4.0' };

export function wellcomeItem(r: Json): StockItem | undefined {
  const loc0 = (r?.locations ?? []).find((l: Json) => /info\.json$/.test(l?.url ?? ''));
  const lic = WELLCOME_LICENCES[loc0?.license?.id];
  if (!loc0 || !lic) return undefined;
  const base = String(loc0.url).replace(/\/info\.json$/, '');
  const it: StockItem = {
    id: idOf('wellcome', r.id), kind: 'image', title: stripHtml(r.source?.title) || 'untitled', url: `https://wellcomecollection.org/works/${r.source?.id ?? ''}`, file: `${base}/full/max/0/default.jpg`, ext: 'jpg',
    licence: { id: lic, ...(loc0.license?.url ? { url: loc0.license.url } : {}) }, source: 'Wellcome Collection', preview: `${base}/full/400,/0/default.jpg`,
  };
  const who = r.source?.contributors?.[0]?.agent?.label;
  if (who) it.author = stripHtml(who).slice(0, 80);
  return it;
}

const wellcome: Source = {
  id: 'wellcome', name: 'Wellcome Collection (medicine and science history)', media: ['image'],
  async search(q, ctx, n) {
    const d = await getJson(ctx, `https://api.wellcomecollection.org/catalogue/v2/images?${qs({ query: q.query, pageSize: Math.min(100, n), page: q.page, 'locations.license': ncAllowed(q) ? 'pdm,cc-0,cc-by,cc-by-nc' : 'pdm,cc-0,cc-by', include: 'source.contributors' })}`);
    return (d.results ?? []).map(wellcomeItem).filter(Boolean) as StockItem[];
  },
};

export function smkItem(x: Json): StockItem | undefined {
  const lic = canonicalLicence(x?.rights);
  if (!lic || !x.public_domain || !(x.image_iiif_id || x.image_native)) return undefined;
  const titles: Json[] = x.titles ?? [];
  const title = titles.find((t) => !t.language || /engelsk|english/i.test(t.language))?.title ?? titles[0]?.title ?? 'untitled';
  const big = x.image_iiif_id ? `${x.image_iiif_id}/full/!3000,3000/0/default.jpg` : x.image_native;
  const it: StockItem = { id: idOf('smk', x.object_number ?? x.id), kind: 'image', title: stripHtml(title), url: x.frontend_url ?? `https://open.smk.dk/artwork/image/${x.object_number}`, file: big, ext: 'jpg', licence: { id: lic, url: x.rights }, source: 'SMK – National Gallery of Denmark' };
  if (x.image_width && x.image_height) { const k = Math.min(1, 3000 / Math.max(x.image_width, x.image_height)); it.width = Math.round(x.image_width * k); it.height = Math.round(x.image_height * k); }
  if (x.image_thumbnail) it.preview = x.image_thumbnail;
  if (x.production?.[0]?.creator) it.author = stripHtml(x.production[0].creator);
  if (x.production_date?.[0]?.period) it.date = String(x.production_date[0].period);
  return it;
}

const smk: Source = {
  id: 'smk', name: 'SMK – National Gallery of Denmark', media: ['image'],
  async search(q, ctx, n) {
    const d = await getJson(ctx, `https://api.smk.dk/api/v1/art/search/?${qs({ keys: q.query, offset: q.page ? (q.page - 1) * n : 0, rows: n, filters: '[public_domain:true],[has_image:true]' })}`);
    return (d.items ?? []).map(smkItem).filter(Boolean) as StockItem[];
  },
};

// ------------------------------------------------------------------------------------------- Internet Archive (Prelinger)

/** The video file of an archive.org item: the tallest h.264 / MPEG4 derivative. */
export function iaVideo(meta: Json): { name: string; width?: number; height?: number; seconds?: number } | undefined {
  const files: Json[] = (meta?.files ?? []).filter((f: Json) => /\.mp4$/i.test(f?.name ?? '') && /h\.264|mpeg4/i.test(f?.format ?? ''));
  const best = files.sort((a, b) => Number(b.height ?? 0) - Number(a.height ?? 0) || (/^h\.264$/i.test(b.format) ? 1 : 0) - (/^h\.264$/i.test(a.format) ? 1 : 0))[0];
  if (!best) return undefined;
  return { name: best.name, ...(best.width ? { width: Number(best.width), height: Number(best.height) } : {}), ...(best.length ? { seconds: Math.round(Number(best.length) * 100) / 100 } : {}) };
}

const prelinger: Source = {
  id: 'prelinger', name: 'Prelinger Archives (Internet Archive)', media: ['video'],
  async search(q, ctx, n) {
    const query = `(${q.query.replace(/[()]/g, ' ')}) AND collection:prelinger AND mediatype:movies AND licenseurl:[* TO *]`;
    const d = await getJson(ctx, `https://archive.org/advancedsearch.php?${qs({ q: query, 'fl[]': 'identifier', rows: n, page: q.page ?? 1, output: 'json' })}&fl%5B%5D=title&fl%5B%5D=creator&fl%5B%5D=year&fl%5B%5D=licenseurl`);
    const docs: Json[] = d.response?.docs ?? [];
    const items = await Promise.all(docs.map(async (doc) => {
      const lic = canonicalLicence(doc.licenseurl);
      if (!lic) return undefined;
      const meta = await getJson(ctx, `https://archive.org/metadata/${encodeURIComponent(doc.identifier)}`).catch(() => undefined);
      const v = meta && iaVideo(meta);
      if (!v) return undefined;
      const it: StockItem = {
        id: idOf('prelinger', doc.identifier), kind: 'video', title: stripHtml(doc.title) || doc.identifier, url: `https://archive.org/details/${doc.identifier}`,
        file: `https://archive.org/download/${doc.identifier}/${encodeURIComponent(v.name)}`, ext: 'mp4', licence: { id: lic, url: doc.licenseurl }, source: 'Prelinger Archives (Internet Archive)',
        preview: `https://archive.org/services/img/${doc.identifier}`,
      };
      if (v.width) { it.width = v.width; it.height = v.height!; }
      if (v.seconds) it.seconds = v.seconds;
      const who = Array.isArray(doc.creator) ? doc.creator[0] : doc.creator;
      if (who) it.author = stripHtml(who);
      if (doc.year) it.date = String(doc.year);
      return it;
    }));
    return items.filter(Boolean) as StockItem[];
  },
};

// ------------------------------------------------------------------------------------------- keyed sources

const europeana: Source = {
  id: 'europeana', name: 'Europeana (European libraries and museums)', media: ['image'], key: 'EUROPEANA_API_KEY',
  async search(q, ctx, n) {
    const d = await getJson(ctx, `https://api.europeana.eu/record/v2/search.json?${qs({ wskey: ctx.env('EUROPEANA_API_KEY'), query: q.query, rows: n, start: q.page ? (q.page - 1) * n + 1 : undefined, reusability: ncAllowed(q) ? 'open,restricted' : 'open', media: 'true', qf: 'TYPE:IMAGE' })}`);
    return (d.items ?? []).map((x: Json): StockItem | undefined => {
      const lic = canonicalLicence(x.rights?.[0]);
      const file = x.edmIsShownBy?.[0];
      if (!lic || !file) return undefined;
      const it: StockItem = { id: idOf('europeana', String(x.id).replace(/^\//, '')), kind: 'image', title: stripHtml(x.title?.[0]) || 'untitled', url: x.guid ?? `https://www.europeana.eu/item${x.id}`, file, ext: extOf(file, 'jpg'), licence: { id: lic, url: x.rights[0] }, source: `${x.dataProvider?.[0] ?? 'a European archive'} via Europeana` };
      if (x.edmPreview?.[0]) it.preview = x.edmPreview[0];
      if (x.dcCreator?.[0]) it.author = stripHtml(x.dcCreator[0]).slice(0, 80);
      if (x.year?.[0]) it.date = String(x.year[0]);
      return it;
    }).filter(Boolean) as StockItem[];
  },
};

const pexels: Source = {
  id: 'pexels', name: 'Pexels (photos and video)', media: ['image', 'video'], key: 'PEXELS_API_KEY',
  async search(q, ctx, n) {
    const headers = { Authorization: ctx.env('PEXELS_API_KEY')! };
    const licence = { id: 'pexels', url: 'https://www.pexels.com/license/' };
    if (q.kind === 'image') {
      const d = await getJson(ctx, `https://api.pexels.com/v1/search?${qs({ query: q.query, per_page: Math.min(80, n), page: q.page, orientation: q.orientation })}`, headers);
      return (d.photos ?? []).map((p: Json): StockItem => ({ id: idOf('pexels', `photo-${p.id}`), kind: 'image', title: stripHtml(p.alt) || `Pexels photo ${p.id}`, url: p.url, file: p.src?.original, ext: extOf(p.src?.original ?? 'x.jpg', 'jpg'), licence, source: 'Pexels', author: p.photographer, authorUrl: p.photographer_url, width: p.width, height: p.height, preview: p.src?.medium })).filter((i: StockItem) => i.file);
    }
    const d = await getJson(ctx, `https://api.pexels.com/videos/search?${qs({ query: q.query, per_page: Math.min(80, n), page: q.page, orientation: q.orientation })}`, headers);
    return (d.videos ?? []).map((v: Json): StockItem | undefined => {
      const files: Json[] = (v.video_files ?? []).filter((f: Json) => f.file_type === 'video/mp4' && f.height);
      const f = files.sort((a, b) => a.height - b.height).find((x) => Math.max(x.width, x.height) >= (q.minWidth ?? 1080)) ?? files.at(-1);
      if (!f) return undefined;
      return { id: idOf('pexels', `video-${v.id}`), kind: 'video', title: `Pexels video ${v.id}`, url: v.url, file: f.link, ext: 'mp4', licence, source: 'Pexels', author: v.user?.name, authorUrl: v.user?.url, width: f.width, height: f.height, seconds: v.duration, preview: v.image };
    }).filter(Boolean) as StockItem[];
  },
};

const pixabay: Source = {
  id: 'pixabay', name: 'Pixabay (photos and video)', media: ['image', 'video'], key: 'PIXABAY_API_KEY',
  async search(q, ctx, n) {
    const licence = { id: 'pixabay', url: 'https://pixabay.com/service/license-summary/' };
    const common = { key: ctx.env('PIXABAY_API_KEY'), q: q.query.slice(0, 100), per_page: Math.max(3, Math.min(200, n)), page: q.page, safesearch: 'true' };
    if (q.kind === 'image') {
      const d = await getJson(ctx, `https://pixabay.com/api/?${qs({ ...common, image_type: 'photo', orientation: q.orientation === 'portrait' ? 'vertical' : q.orientation === 'landscape' ? 'horizontal' : undefined })}`);
      return (d.hits ?? []).map((h: Json): StockItem => ({ id: idOf('pixabay', `photo-${h.id}`), kind: 'image', title: stripHtml(h.tags) || `Pixabay ${h.id}`, url: h.pageURL, file: h.largeImageURL, ext: extOf(h.largeImageURL ?? 'x.jpg', 'jpg'), licence, source: 'Pixabay', author: h.user, width: h.imageWidth, height: h.imageHeight, preview: h.previewURL ?? h.webformatURL, tags: String(h.tags ?? '').split(/,\s*/).filter(Boolean) })).filter((i: StockItem) => i.file);
    }
    const d = await getJson(ctx, `https://pixabay.com/api/videos/?${qs(common)}`);
    return (d.hits ?? []).map((h: Json): StockItem | undefined => {
      const f = h.videos?.large?.url ? h.videos.large : h.videos?.medium?.url ? h.videos.medium : undefined;
      if (!f) return undefined;
      return { id: idOf('pixabay', `video-${h.id}`), kind: 'video', title: stripHtml(h.tags) || `Pixabay video ${h.id}`, url: h.pageURL, file: f.url, ext: 'mp4', licence, source: 'Pixabay', author: h.user, width: f.width, height: f.height, seconds: h.duration, ...(h.videos?.tiny?.thumbnail ? { preview: h.videos.tiny.thumbnail } : {}) };
    }).filter(Boolean) as StockItem[];
  },
};

const unsplash: Source = {
  id: 'unsplash', name: 'Unsplash (photos)', media: ['image'], key: 'UNSPLASH_ACCESS_KEY',
  async search(q, ctx, n) {
    const d = await getJson(ctx, `https://api.unsplash.com/search/photos?${qs({ query: q.query, per_page: Math.min(30, n), page: q.page, orientation: q.orientation === 'portrait' ? 'portrait' : q.orientation === 'landscape' ? 'landscape' : q.orientation === 'square' ? 'squarish' : undefined })}`, { Authorization: `Client-ID ${ctx.env('UNSPLASH_ACCESS_KEY')}`, 'Accept-Version': 'v1' });
    return (d.results ?? []).map((p: Json): StockItem => ({
      id: idOf('unsplash', p.id), kind: 'image', title: stripHtml(p.description ?? p.alt_description) || `Unsplash photo ${p.id}`, url: p.links?.html, file: `${p.urls?.raw}&w=3000&fm=jpg&q=85`, ext: 'jpg',
      licence: { id: 'unsplash', url: 'https://unsplash.com/license' }, source: 'Unsplash', author: p.user?.name, authorUrl: p.user?.links?.html, width: Math.min(3000, p.width), height: Math.round(p.height * Math.min(1, 3000 / p.width)), preview: p.urls?.small,
      tags: [p.links?.download_location].filter(Boolean),
    })).filter((i: StockItem) => i.url && i.file);
  },
  async fetch(item, out, ctx) {
    // Unsplash's API guidelines: report each download to its download_location endpoint
    const loc = item.tags?.find((t) => t.startsWith('https://api.unsplash.com/'));
    if (loc) await ctx.fetch(loc, { headers: { Authorization: `Client-ID ${ctx.env('UNSPLASH_ACCESS_KEY')}` } }).catch(() => undefined);
    await download(ctx, item.file, out);
  },
};

const freesound: Source = {
  id: 'freesound', name: 'Freesound API (sound effects)', media: ['sfx'], key: 'FREESOUND_API_KEY',
  async search(q, ctx, n) {
    const filter = `duration:[${q.minSeconds ?? 0} TO ${q.maxSeconds ?? 10}]`;
    const d = await getJson(ctx, `https://freesound.org/apiv2/search/text/?${qs({ query: q.query, filter, page_size: Math.min(150, n), page: q.page, fields: 'id,name,username,license,duration,previews,url,tags', token: ctx.env('FREESOUND_API_KEY') })}`);
    return (d.results ?? []).map((s: Json): StockItem | undefined => {
      const lic = canonicalLicence(s.license);
      const file = s.previews?.['preview-hq-mp3'];
      if (!lic || !file) return undefined;
      return { id: idOf('freesound', s.id), kind: 'sfx', title: stripHtml(s.name), url: s.url, file, ext: 'mp3', licence: { id: lic, url: s.license }, source: 'Freesound', author: s.username, seconds: Math.round(s.duration * 100) / 100, tags: (s.tags ?? []).slice(0, 12) };
    }).filter(Boolean) as StockItem[];
  },
};

export const SOURCES: Source[] = [openverse, commons, nasa, smithsonian, loc, met, cleveland, wellcome, smk, prelinger, europeana, pexels, pixabay, unsplash, freesound];

// ------------------------------------------------------------------------------------------- the provider

/** Sources serving `kind`, the reasons others are off, honouring q.source. */
export async function activeSources(q: Pick<StockQuery, 'kind' | 'source'>, ctx: StockContext): Promise<{ on: Source[]; notes: string[] }> {
  const notes: string[] = [];
  let list = SOURCES.filter((s) => s.media.includes(q.kind));
  if (q.source) {
    list = list.filter((s) => s.id === q.source);
    if (!list.length) throw new Error(`open-media has no ${q.kind} source "${q.source}" (sources: ${SOURCES.filter((s) => s.media.includes(q.kind)).map((s) => s.id).join(', ')})`);
  }
  const on: Source[] = [];
  for (const s of list) {
    if (s.key && !ctx.env(s.key)) { if (q.source) notes.push(`${s.id} skipped: set ${s.key} to use it`); continue; }
    const why = await s.ready?.(ctx);
    if (why) { notes.push(`${s.id} ${why}`); continue; }
    on.push(s);
  }
  // the Freesound API, when keyed, replaces the keyless Freesound previews from Openverse
  if (q.kind === 'sfx' && on.some((s) => s.id === 'freesound') && !q.source) return { on: on.filter((s) => s.id !== 'openverse'), notes };
  return { on, notes };
}

export const openMedia: StockProvider = defineProvider({
  kind: 'stock', id: PROVIDER,
  describe: 'Openly licensed media from public archives: sound effects (Freesound), music (Jamendo, ccMixter, Commons), images (Openverse, Commons, NASA, Smithsonian, Library of Congress, The Met, Cleveland, Wellcome, SMK) and video (Commons, NASA, Prelinger); Pexels, Pixabay, Unsplash, Freesound and Europeana with keys.',
  media: ['image', 'video', 'music', 'sfx'],
  sources: SOURCES.map((s) => s.id),
  async search(q, ctx) {
    const { on, notes } = await activeSources(q, ctx);
    const per = Math.max(3, Math.ceil(q.limit / Math.max(1, on.length)));
    const results = await Promise.all(on.map(async (s) => {
      try { return await s.search(q, ctx, per); } catch (e) { notes.push(`${s.id} failed: ${(e as Error).message.split('\n')[0]}`); return []; }
    }));
    // interleave sources so one archive does not fill the page
    const items: StockItem[] = [];
    for (let i = 0; results.some((r) => i < r.length); i++) for (const r of results) if (i < r.length) items.push(r[i]!);
    return { items, notes };
  },
  async fetch({ item, out }, ctx) {
    const s = SOURCES.find((x) => x.id === sourceOf(item.id));
    if (s?.fetch) return s.fetch(item, out, ctx);
    await download(ctx, item.file, out);
  },
});

// ------------------------------------------------------------------------------------------- commands

const sourcesCmd = defineCommand({
  op: 'open-media.sources', group: 'media',
  doc: 'List open-media sources: the kinds each serves, and whether it is on (keys from the environment, the Smithsonian index). Changes nothing.',
  schema: z.strictObject({}), example: {},
  async apply(ctx) {
    const dir = await cacheDir();
    const indexed = (await siIndexFiles(dir)).map((f) => f.split('/').pop()!.replace(/\.jsonl\.gz$/, ''));
    const rows = SOURCES.map((s) => {
      const state = s.key ? (process.env[s.key] ? 'on (key set)' : `off: set ${s.key}`)
        : s.id === 'smithsonian' ? (process.env.SMITHSONIAN_API_KEY ? 'on (API key)' : indexed.length ? `on (local index: ${indexed.join(', ')})` : 'off: set SMITHSONIAN_API_KEY or run open-media.index')
          : 'on';
      return { id: s.id, name: s.name, media: s.media, state };
    });
    ctx.out.sources = rows;
    ctx.summary(['open-media sources:', ...rows.map((r) => `  ${r.id.padEnd(12)} ${r.media.join('/').padEnd(17)} ${r.state} · ${r.name}`), 'narrow a search to one: media.search kind=image query="..." source=<id>'].join('\n'));
  },
});

const indexCmd = defineCommand({
  op: 'open-media.index', group: 'media',
  doc: `Build the keyless Smithsonian search index from its open-access dump (CC0 images only): streams each chosen unit once (default ${SI_DEFAULT_UNITS.join(', ')}: about 0.5 GB, about 15 s on a cloud container) into the user cache. Units: chndm (Cooper Hewitt design), npg (Portrait Gallery), saam (American Art), fsg (Asian Art), nmaahc (African American History), nasm (Air and Space), hmsg (Hirshhorn), nmah (American History, 2.5 GB), sia (Archives, 2 GB), nmnhbirds and other nature units (large). Changes nothing in the project. With SMITHSONIAN_API_KEY set the live API is used instead and no index is needed.`,
  schema: z.strictObject({ units: z.array(z.string().regex(/^[a-z0-9]+$/)).min(1).optional(), refresh: z.boolean().optional() }),
  example: { units: ['npg', 'saam'] },
  async apply(ctx, p) {
    const units = p.units ?? SI_DEFAULT_UNITS;
    const dir = await cacheDir();
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const todo = p.refresh ? units : units.filter((u) => !existsSync(join(dir, 'smithsonian', `${u}.jsonl.gz`)));
    if (!todo.length) { ctx.summary(`Smithsonian index is up to date for ${units.join(', ')} (refresh=true rebuilds it).`); ctx.out.units = []; return; }
    const t0 = Date.now();
    const get = (url: string) => fetch(url, { headers: { 'User-Agent': 'michelangelo open-media (+https://github.com/samsam32118/Michelangelo)' }, signal: AbortSignal.timeout(120_000) });
    const r = await buildSiIndex({ units: todo, dir, get });
    ctx.out.units = r;
    ctx.summary([`indexed ${r.reduce((n, x) => n + x.images, 0)} CC0 images from ${r.reduce((n, x) => n + x.records, 0)} Smithsonian records in ${Math.round((Date.now() - t0) / 1000)} s:`, ...r.map((x) => `  ${x.unit}: ${x.images} images (${Math.round(x.bytes / 1e6)} MB read)`), 'search it: media.search kind=image query="..." source=smithsonian'].join('\n'));
  },
});

export default definePlugin({ name: 'open-media', version: '1.0.0', providers: [openMedia], commands: [sourcesCmd, indexCmd] });
