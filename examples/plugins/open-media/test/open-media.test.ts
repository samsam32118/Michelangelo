import { test, assert, loadPlugin, testStockContext } from 'michelangelo/testing';

const plugin = await loadPlugin(import.meta.url);
const provider = plugin.providers!.find((p) => p.id === 'open-media')!;
const { readFileSync } = await import('node:fs');
const { gzipSync } = await import('node:zlib');
const { activeSources, buildSiIndex, commonsItem, iaVideo, locMaster, nasaFile, siSearch, SOURCES } = await import('../src/index.js');

/** A recorded API answer (metadata only, trimmed; no media). */
const rec = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

/** Recorded answers for every keyless source, routed by URL. */
const ROUTES: [RegExp, unknown][] = [
  [/api\.openverse\.org\/v1\/audio\/.*source=freesound/, rec('openverse-audio-sfx.json')],
  [/api\.openverse\.org\/v1\/audio\//, rec('openverse-audio-music.json')],
  [/api\.openverse\.org\/v1\/images\//, rec('openverse-images.json')],
  [/commons\.wikimedia\.org.*filetype%3Abitmap/, rec('commons-image.json')],
  [/commons\.wikimedia\.org.*filetype%3Avideo/, rec('commons-video.json')],
  [/commons\.wikimedia\.org.*filetype%3Aaudio/, rec('commons-audio.json')],
  [/images-api\.nasa\.gov\/search.*media_type=image/, rec('nasa-image.json')],
  [/images-api\.nasa\.gov\/search.*media_type=video/, rec('nasa-video.json')],
  [/images-api\.nasa\.gov\/asset\/KSC/, rec('nasa-video-asset.json')],
  [/images-api\.nasa\.gov\/asset\//, rec('nasa-image-asset.json')],
  [/www\.loc\.gov\/photos\//, rec('loc.json')],
  [/metmuseum\.org\/.*\/v1\.1\/search/, rec('met-search.json')],
  [/metmuseum\.org\/.*\/v1\/objects\//, rec('met-object.json')],
  [/openaccess-api\.clevelandart\.org/, rec('cma.json')],
  [/api\.wellcomecollection\.org/, rec('wellcome.json')],
  [/api\.smk\.dk/, rec('smk.json')],
  [/api\.si\.edu\/openaccess/, rec('si-api.json')],
  [/archive\.org\/advancedsearch/, rec('ia-prelinger.json')],
  [/archive\.org\/metadata\//, rec('ia-metadata.json')],
];

const search = async (kind: 'image' | 'video' | 'music' | 'sfx', query: string, o: { env?: Record<string, string>; routes?: [RegExp, unknown][]; source?: string; licences?: string[]; cacheDir?: string } = {}) => {
  const ctx = testStockContext({ routes: [...(o.routes ?? []), ...ROUTES], ...(o.env ? { env: o.env } : {}), ...(o.cacheDir ? { cacheDir: o.cacheDir } : {}) });
  if (provider.kind !== 'stock') throw new Error('not a stock provider');
  const r = await provider.search({ kind, query, limit: 24, ...(o.source ? { source: o.source } : {}), ...(o.licences ? { licences: o.licences } : {}) }, ctx);
  const res = Array.isArray(r) ? { items: r, notes: [] as string[] } : { items: r.items, notes: r.notes ?? [] };
  return { ...res, ctx };
};
const from = <T extends { id: string }>(items: T[], source: string): T[] => items.filter((i) => i.id.startsWith(`open-media:${source}:`));

test('one stock provider for all four kinds; keyed sources name their environment variable', () => {
  assert.equal(provider.kind, 'stock');
  if (provider.kind !== 'stock') return;
  assert.deepEqual(provider.media, ['image', 'video', 'music', 'sfx']);
  assert.ok(provider.sources!.includes('smithsonian') && provider.sources!.includes('prelinger'));
  assert.deepEqual(SOURCES.filter((s) => s.key).map((s) => s.key), ['EUROPEANA_API_KEY', 'PEXELS_API_KEY', 'PIXABAY_API_KEY', 'UNSPLASH_ACCESS_KEY', 'FREESOUND_API_KEY']);
});

test('sfx: Freesound effects through Openverse, commercial-use licences asked for, durations in seconds', async () => {
  const { items, ctx } = await search('sfx', 'whoosh');
  assert.ok(items.length >= 3);
  const first = items[0]!;
  assert.match(first.id, /^open-media:openverse:[0-9a-f-]{36}$/);
  assert.equal(first.title, 'Deep Whoosh #1');
  assert.equal(first.licence.id, 'cc0');
  assert.equal(first.source, 'Freesound via Openverse');
  assert.equal(first.seconds, 3.16);
  assert.match(first.file, /^https:\/\/cdn\.freesound\.org\/previews\/.+-hq\.mp3$/);
  assert.ok(first.tags!.includes('swish'));
  const url = ctx.calls[0]!.url;
  assert.match(url, /source=freesound/);
  assert.match(url, /license_type=commercial%2Cmodification/);
  // a non-commercial video may ask for NC too
  const nc = await search('sfx', 'whoosh', { licences: ['free', 'attribution', 'non-commercial'] });
  assert.doesNotMatch(nc.ctx.calls[0]!.url, /license_type/);
});

test('music: Jamendo / ccMixter through Openverse and Commons audio; MIDI files are not music files', async () => {
  const { items } = await search('music', 'mozart');
  assert.ok(from(items, 'openverse').every((i) => i.ext === 'mp3'), 'Jamendo "mp32" files are named .mp3');
  assert.ok(from(items, 'openverse').every((i) => /Jamendo|ccMixter/.test(i.source)));
  const commons = from(items, 'commons');
  assert.ok(commons.length >= 1);
  assert.ok(commons.every((i) => !/\.midi?$/.test(i.file)));
  assert.ok(commons.some((i) => i.licence.id === 'public-domain'));
});

test('images: every keyless archive answers and maps its licence; uncertain rights are dropped', async () => {
  const { items, notes } = await search('image', 'steam engine');
  const by = (s: string) => from(items, s);
  for (const s of ['openverse', 'commons', 'nasa', 'loc', 'met', 'cleveland', 'wellcome', 'smk']) assert.ok(by(s).length > 0, `no results from ${s}`);
  assert.ok(items.every((i) => i.licence.id && i.file && i.url && i.title));
  // the Smithsonian is off without a key or an index, and says how to turn it on
  assert.ok(notes.some((n) => /^smithsonian skipped: set SMITHSONIAN_API_KEY .*open-media\.index/.test(n)), notes.join('\n'));
  // NASA: only NASA-credited media
  assert.ok(by('nasa').every((i) => i.licence.id === 'pd-us-gov' && /NASA/.test(i.author ?? 'NASA')));
  // Library of Congress: "no known restrictions" only, with the full-size master through IIIF
  assert.ok(by('loc').every((i) => i.licence.id === 'nkr'));
  assert.match(by('loc')[0]!.file, /^https:\/\/tile\.loc\.gov\/image-services\/iiif\/master:pnp:.+u\/full\/pct:100\/0\/default\.jpg$/);
  // museums
  assert.deepEqual([by('met')[0]!.licence.id, by('met')[0]!.author, by('met')[0]!.title], ['cc0', 'Vincent van Gogh', 'Sunflowers']);
  assert.ok(by('cleveland').every((i) => i.licence.id === 'cc0' && i.width! >= 1000));
  assert.ok(by('wellcome').every((i) => ['pdm', 'cc0', 'cc-by-4.0'].includes(i.licence.id) && /\/full\/max\/0\/default\.jpg$/.test(i.file)));
  assert.equal(by('smk')[0]!.licence.id, 'pdm');
  assert.equal(by('smk')[0]!.title, 'Ships in quiet weather');
  // results are interleaved across archives, not grouped
  assert.notEqual(items[0]!.id.split(':')[1], items[1]!.id.split(':')[1]);
});

test('Commons: licences from URL or short name; unmappable licences are dropped', () => {
  const page = (em: Record<string, unknown>) => ({ pageid: 1, title: 'File:X.jpg', imageinfo: [{ url: 'https://upload.wikimedia.org/x.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:X.jpg', mime: 'image/jpeg', width: 2000, height: 1000, extmetadata: em }] });
  assert.equal(commonsItem(page({ LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0' } }), 'image')!.licence.id, 'cc-by-sa-4.0');
  assert.equal(commonsItem(page({ LicenseShortName: { value: 'CC BY 2.0' } }), 'image')!.licence.id, 'cc-by-2.0');
  assert.equal(commonsItem(page({ LicenseShortName: { value: 'Public domain' } }), 'image')!.licence.id, 'public-domain');
  assert.equal(commonsItem(page({ LicenseShortName: { value: 'GFDL' } }), 'image'), undefined);
  assert.equal(commonsItem(page({ LicenseShortName: { value: 'Copyrighted free use' } }), 'image'), undefined);
});

test('video: Commons picks a WebM transcode at least comp-tall; Prelinger keeps licensed films only; NASA drops third-party footage', async () => {
  const { items, ctx } = await search('video', 'ocean waves');
  const commons = from(items, 'commons');
  assert.ok(commons.length >= 1 && commons.every((i) => i.licence.id));
  const pre = from(items, 'prelinger');
  assert.ok(pre.length >= 1);
  assert.equal(pre[0]!.file, 'https://archive.org/download/AlaskaAM1948/AlaskaAM1948.mp4');
  assert.deepEqual([pre[0]!.width, pre[0]!.height, pre[0]!.licence.id], [640, 480, 'pdm']);
  assert.ok(ctx.calls.some((c) => /licenseurl%3A%5B\*%20TO%20\*%5D/.test(c.url)), 'Prelinger search asks for licensed items only');
  assert.ok(from(items, 'nasa').length >= 1);
  const third = await search('video', 'rocket', { source: 'nasa', routes: [[/images-api\.nasa\.gov\/search/, rec('nasa-video-thirdparty.json')]] });
  assert.equal(third.items.length, 0, 'Rocket Lab footage is not a NASA work');
});

test('NASA fetch resolves the asset list: the ~large MP4 for video, the original JPEG for images', () => {
  const v = nasaFile(rec('nasa-video-asset.json'), 'video')!;
  assert.match(v, /^https:\/\/images-assets\.nasa\.gov\/video\/.+~large\.mp4$/);
  assert.match(nasaFile(rec('nasa-image-asset.json'), 'image')!, /~orig\.JPG$/);
  assert.equal(iaVideo({ files: [{ name: 'a_512kb.mp4', format: '512Kb MPEG4', height: '240', width: '320' }, { name: 'a.mp4', format: 'h.264', height: '480', width: '640', length: '12.5' }] })!.name, 'a.mp4');
  assert.equal(locMaster('https://tile.loc.gov/storage-services/service/pnp/fsa/8b20000/8b29000/8b29500/8b29516v.jpg'), 'https://tile.loc.gov/image-services/iiif/master:pnp:fsa:8b20000:8b29000:8b29500:8b29516u/full/pct:100/0/default.jpg');
});

test('Smithsonian with a key: the live API, CC0 images only, author from the record', async () => {
  const { items, ctx } = await search('image', 'jazz', { source: 'smithsonian', env: { SMITHSONIAN_API_KEY: 'test-key' } });
  assert.ok(items.length >= 2);
  assert.match(ctx.calls[0]!.url, /q=jazz%20AND%20media_usage%3ACC0%20AND%20online_media_type%3AImages%20AND%20NOT%20unit_code%3ANMNH\*/);
  const it = items[0]!;
  assert.equal(it.licence.id, 'cc0');
  assert.equal(it.source, 'Smithsonian National Museum of African American History and Culture');
  assert.match(it.file, /^https:\/\/ids\.si\.edu\/ids\/deliveryService\?id=NMAAHC-.+&max=4000$/);
  assert.equal(it.author, 'Jack Kleinsinger, American');
});

test('Smithsonian without a key: open-media.index builds a local index from the dump, and search uses it offline', async () => {
  const shard = readFileSync(new URL('./fixtures/si-shard.txt', import.meta.url), 'utf8');
  const base = 'https://smithsonian-open-access.s3-us-west-2.amazonaws.com/metadata/edan/npg';
  const get = async (url: string) => url.endsWith('/index.txt') ? new Response(`${base}/00.txt\n${base}/01.txt\n`) : url.endsWith('00.txt') ? new Response(shard) : new Response('');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'open-media-si-'));
  const r = await buildSiIndex({ units: ['npg'], dir, get });
  assert.equal(r[0]!.unit, 'npg');
  assert.ok(r[0]!.images >= 3 && r[0]!.images < r[0]!.records + 1);
  const gz = readFileSync(join(dir, 'smithsonian', 'npg.jsonl.gz'));
  assert.ok(gzipSync(Buffer.from('x')).length > 0 && gz.length > 50);
  const res = await search('image', 'portrait woman', { source: 'smithsonian', cacheDir: dir });
  assert.equal(res.ctx.calls.length, 0, 'no network: the index is local');
  assert.ok(res.items.length >= 1);
  assert.match(res.items[0]!.title, /Woman/);
  assert.equal(res.items[0]!.author, 'Charles Balthazar Julien Févret de Saint-Mémin');
  assert.deepEqual(siSearch([{ i: 'a', t: 'Sun Bird', u: 'NPG', s: 'x', k: ['Animals'] }, { i: 'b', t: 'Bird', u: 'NPG', s: 'x' }], 'bird animals', 5).map((e) => e.i), ['a']);
});

test('keyed sources are off without their key, and parse their documented answers with it', async () => {
  const on = async (kind: 'image' | 'video' | 'sfx', env: Record<string, string> = {}) => (await activeSources({ kind }, testStockContext({ env }))).on.map((s) => s.id);
  assert.ok(!(await on('image')).includes('pexels'));
  assert.ok((await on('image', { PEXELS_API_KEY: 'k' })).includes('pexels'));
  // with a Freesound key the API replaces the keyless previews from Openverse
  assert.deepEqual(await on('sfx', { FREESOUND_API_KEY: 'k' }), ['freesound']);
  const pexels = { photos: [{ id: 7, width: 4000, height: 6000, url: 'https://www.pexels.com/photo/7/', photographer: 'Ana', photographer_url: 'https://www.pexels.com/@ana', alt: 'A red tram', src: { original: 'https://images.pexels.com/photos/7/a.jpeg', medium: 'https://images.pexels.com/photos/7/a.jpeg?h=350' } }] };
  const { items, ctx } = await search('image', 'tram', { source: 'pexels', env: { PEXELS_API_KEY: 'secret' }, routes: [[/api\.pexels\.com\/v1\/search/, pexels]] });
  assert.deepEqual(items.map((i) => [i.id, i.licence.id, i.author, i.width]), [['open-media:pexels:photo-7', 'pexels', 'Ana', 4000]]);
  assert.equal(ctx.calls[0]!.headers.Authorization, 'secret');
  const fs = { results: [{ id: 9, name: 'Door slam', username: 'bo', license: 'http://creativecommons.org/licenses/by/4.0/', duration: 1.2, url: 'https://freesound.org/s/9/', tags: ['door'], previews: { 'preview-hq-mp3': 'https://cdn.freesound.org/previews/0/9-hq.mp3' } }] };
  const snd = await search('sfx', 'door', { env: { FREESOUND_API_KEY: 'k' }, routes: [[/freesound\.org\/apiv2/, fs]] });
  assert.deepEqual(snd.items.map((i) => [i.id, i.licence.id, i.seconds]), [['open-media:freesound:9', 'cc-by-4.0', 1.2]]);
});

test('a failing archive is a note, never the end of the search', async () => {
  const { items, notes } = await search('image', 'ship', { routes: [[/api\.smk\.dk/, 503], [/commons\.wikimedia\.org/, 429]] });
  assert.ok(items.length > 5);
  assert.ok(notes.some((n) => /^smk failed: api\.smk\.dk answered HTTP 503/.test(n)), notes.join('\n'));
  assert.ok(notes.some((n) => /^commons failed: .*HTTP 429 \(rate limited/.test(n)), notes.join('\n'));
  await assert.rejects(search('image', 'x', { source: 'nope' }), /no image source "nope"/);
});
