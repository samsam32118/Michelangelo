// @vitest-environment node
/** Open media in core (plugin API 1.5): licence rules, media.search / media.fetch / media.credits, sound as text, stock QA rules. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { canonicalLicence, creditLine, licenceClass, licenceName, refusal } from '../../src/core/licence.js';
import { definePlugin, defineProvider, type StockItem, type StockProvider } from '../../src/plugin/api.js';
import { PluginRegistry } from '../../src/plugin/registry.js';
import { builtinRegistry } from '../../src/builtin/index.js';
import { checkPluginDef as validatePlugin } from '../../src/plugin/validate.js';
import { makeServices } from '../../src/sdk/services.js';
import { Project, emptyProject } from '../../src/sdk/project.js';
import { MglError } from '../../src/core/errors.js';
import type { ProjectFile } from '../../src/core/schema/index.js';
import { levelFacts } from '../../src/sdk/sound.js';
import { runCheck } from './qa-fixtures.js';
import '../../src/core/commands/index.js';

describe('licence rules', () => {
  it('maps CC URLs and short names to canonical ids', () => {
    expect(canonicalLicence('https://creativecommons.org/publicdomain/zero/1.0/')).toBe('cc0');
    expect(canonicalLicence('http://creativecommons.org/licenses/publicdomain/')).toBe('pdm');
    expect(canonicalLicence('https://creativecommons.org/publicdomain/mark/1.0/')).toBe('pdm');
    expect(canonicalLicence('https://creativecommons.org/licenses/by-sa/3.0/')).toBe('cc-by-sa-3.0');
    expect(canonicalLicence('by', '4.0')).toBe('cc-by-4.0');
    expect(canonicalLicence('by-nc-nd', '2.0')).toBe('cc-by-nc-nd-2.0');
    expect(canonicalLicence('CC BY 4.0')).toBe('cc-by-4.0');
    expect(canonicalLicence('cc0')).toBe('cc0');
    expect(canonicalLicence('All rights reserved')).toBeUndefined();
    expect(canonicalLicence('GFDL')).toBeUndefined();
  });

  it('classes, refusals and names', () => {
    expect(['cc0', 'pdm', 'pd-us-gov', 'pexels'].map(licenceClass)).toEqual(['free', 'free', 'free', 'free']);
    expect(licenceClass('cc-by-4.0')).toBe('attribution');
    expect(licenceClass('cc-by-sa-4.0')).toBe('share-alike');
    expect(licenceClass('cc-by-nc-sa-4.0')).toBe('non-commercial');
    expect(licenceClass('cc-by-nc-nd-4.0')).toBe('no-derivatives');
    expect(licenceClass('gfdl')).toBe('unknown');
    expect(refusal('attribution', ['free', 'attribution'])).toBeUndefined();
    expect(refusal('share-alike', ['free', 'attribution'])).toMatch(/licences=\["share-alike"\]/);
    expect(refusal('share-alike', ['free', 'attribution', 'share-alike'])).toBeUndefined();
    expect(refusal('no-derivatives', ['no-derivatives'])).toMatch(/forbid edits/);
    expect(refusal('unknown', ['unknown'])).toMatch(/could not be identified/);
    expect(licenceName('cc-by-sa-3.0')).toBe('CC BY-SA 3.0');
    expect(creditLine({ title: 'Deep Whoosh #1', author: 'bigdog', source: 'Freesound via Openverse', licence: { id: 'cc-by-4.0' } })).toBe('“Deep Whoosh #1” by bigdog (Freesound via Openverse), CC BY 4.0');
  });
});

describe('sound as text', () => {
  it('a pure tone is tonal and a wideband noise is noisy and bright; onset and peak come from the levels', () => {
    const bands = 16, frames = 100;
    const rms = new Float32Array(frames), tone = new Float32Array(frames * bands), noise = new Float32Array(frames * bands);
    for (let f = 0; f < frames; f++) {
      rms[f] = f < 30 ? 0 : f === 60 ? 0.95 : 0.8;
      for (let b = 0; b < bands; b++) { tone[f * bands + b] = b === 3 ? 1 : 0; noise[f * bands + b] = 0.7 + 0.3 * (b / (bands - 1)); }
    }
    const t = levelFacts(rms, tone, bands), n = levelFacts(rms, noise, bands);
    expect(t).toMatchObject({ onset: 0.3, peakAt: 0.6, texture: 'tonal', tone: 'dark' });
    expect(n).toMatchObject({ texture: 'noisy', tone: 'bright' });
  });
});

describe('sound as text on real audio (ffmpeg)', () => {
  it('a sine is tonal, white noise is noisy and bright, brown noise is dark; a delayed hit reports its onset', async () => {
    const { describeSound } = await import('../../src/sdk/sound.js');
    const { getMediaBackend } = await import('../../src/media/index.js');
    const dir = mkdtempSync(join(tmpdir(), 'mgl-sound-'));
    const make = (name: string, src: string, af?: string) => { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', src, ...(af ? ['-af', af] : []), join(dir, name)]); return join(dir, name); };
    const b = await getMediaBackend({ baseDir: dir });
    const sine = await describeSound(make('sine.wav', 'sine=f=440:d=1'), b);
    const white = await describeSound(make('white.wav', 'anoisesrc=d=1:c=white:a=0.5'), b);
    const brown = await describeSound(make('brown.wav', 'anoisesrc=d=1:c=brown:a=0.5'), b);
    const late = await describeSound(make('late.wav', 'anoisesrc=d=0.5:c=pink:a=0.5', 'adelay=400:all=1'), b);
    expect([sine.texture, white.texture, white.tone, brown.tone]).toEqual(['tonal', 'noisy', 'bright', 'dark']);
    expect(sine.flatness).toBeLessThan(0.02);
    expect(white.centroidHz).toBeGreaterThan(2000);
    expect(late.onset).toBeGreaterThan(0.37);
    expect(late.onset).toBeLessThan(0.43);
  });
});

// ------------------------------------------------------------------------------------------- commands with a fake provider

type Fixture = { bytes: Buffer; type: string };

function fixtures(dir: string): Record<string, Fixture> {
  const ff = (args: string[], out: string) => { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, join(dir, out)]); return readFileSync(join(dir, out)); };
  // a "whoosh": 0.3 s of silence, then 0.6 s of noise
  const whoosh = ff(['-f', 'lavfi', '-i', 'anoisesrc=d=0.6:c=white:a=0.5', '-af', 'adelay=300:all=1,apad=pad_dur=0.1', '-ar', '48000', '-ac', '1'], 'whoosh.wav');
  const tone = ff(['-f', 'lavfi', '-i', 'sine=f=220:d=2', '-ar', '48000'], 'tone.wav');
  const cv = createCanvas(1200, 800), c = cv.getContext('2d');
  c.fillStyle = '#3366cc'; c.fillRect(0, 0, 1200, 800);
  return {
    'whoosh.wav': { bytes: whoosh, type: 'audio/wav' }, 'tone.wav': { bytes: tone, type: 'audio/wav' },
    'pic.png': { bytes: cv.toBuffer('image/png'), type: 'image/png' },
    'gone.wav': { bytes: Buffer.from('<!DOCTYPE html><html><body>moved</body></html>'), type: 'text/html' },
  };
}

const ITEMS: StockItem[] = [
  { id: 'fake:w1', kind: 'sfx', title: 'Deep Whoosh #1', url: 'https://fake.test/w1', file: 'https://fake.test/whoosh.wav', ext: 'wav', licence: { id: 'cc0' }, author: 'bigdog', source: 'Fake Sounds', seconds: 1 },
  { id: 'fake:w2', kind: 'sfx', title: 'Whoosh by', url: 'https://fake.test/w2', file: 'https://fake.test/whoosh.wav', ext: 'wav', licence: { id: 'cc-by-4.0' }, author: 'ana', source: 'Fake Sounds', seconds: 1 },
  { id: 'fake:w3', kind: 'sfx', title: 'Shared whoosh', url: 'https://fake.test/w3', file: 'https://fake.test/whoosh.wav', ext: 'wav', licence: { id: 'cc-by-sa-4.0' }, source: 'Fake Sounds', seconds: 1 },
  { id: 'fake:w4', kind: 'sfx', title: 'Long rain', url: 'https://fake.test/w4', file: 'https://fake.test/whoosh.wav', ext: 'wav', licence: { id: 'cc0' }, source: 'Fake Sounds', seconds: 60 },
  { id: 'fake:w5', kind: 'sfx', title: 'ND whoosh', url: 'https://fake.test/w5', file: 'https://fake.test/whoosh.wav', ext: 'wav', licence: { id: 'cc-by-nd-4.0' }, source: 'Fake Sounds', seconds: 1 },
  { id: 'fake:gone', kind: 'sfx', title: 'Moved file', url: 'https://fake.test/g', file: 'https://fake.test/gone.wav', ext: 'wav', licence: { id: 'cc0' }, source: 'Fake Sounds', seconds: 1 },
  { id: 'fake:t1', kind: 'music', title: 'Tone bed', url: 'https://fake.test/t1', file: 'https://fake.test/tone.wav', ext: 'wav', licence: { id: 'cc-by-4.0' }, author: 'cleo', source: 'Fake Music', seconds: 2 },
  { id: 'fake:p1', kind: 'image', title: 'Blue field', url: 'https://fake.test/p1', file: 'https://fake.test/pic.png', ext: 'png', licence: { id: 'pdm' }, source: 'Fake Archive', width: 1200, height: 800, preview: 'https://fake.test/pic.png' },
  { id: 'fake:p2', kind: 'image', title: 'Tiny thumb', url: 'https://fake.test/p2', file: 'https://fake.test/pic.png', ext: 'png', licence: { id: 'cc0' }, source: 'Fake Archive', width: 300, height: 200 },
];

function setup(o: { failing?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mgl-stock-'));
  const fx = fixtures(mkdtempSync(join(tmpdir(), 'mgl-stock-fx-')));
  const seen: { url: string; ua: string | null }[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    seen.push({ url, ua: new Headers(init?.headers).get('User-Agent') });
    const f = fx[url.split('/').pop()!];
    return f ? new Response(new Uint8Array(f.bytes), { status: 200, headers: { 'content-type': f.type } }) : new Response('nope', { status: 404 });
  };
  const fake: StockProvider = defineProvider({
    kind: 'stock', id: 'fake', describe: 'test archive', media: ['image', 'music', 'sfx'],
    async search(q, ctx) {
      await ctx.fetch('https://fake.test/api?q=' + encodeURIComponent(q.query));
      return ITEMS.filter((i) => i.kind === q.kind);
    },
  });
  const broken: StockProvider = defineProvider({ kind: 'stock', id: 'broken', describe: 'always fails', media: ['sfx'], async search() { throw new Error('HTTP 503 from broken.test'); } });
  const reg = builtinRegistry().add(definePlugin({ name: 'fake-stock', providers: [fake, ...(o.failing ? [broken] : [])] }), 'test');
  const work = join(dir, '.mgl', 'p');
  const services = makeServices(dir, reg, { workDir: work, stock: { fetch, cacheDir: join(dir, 'cache'), env: {} } });
  const data = emptyProject({ size: [1080, 1920], fps: 30, length: 300 });
  const project = Project.create(join(dir, 'p.mgl.json'), data, services);
  const edit = (cmd: { op: string; [k: string]: unknown }) => project.edit(cmd, { save: false });
  return { dir, project, edit, seen, work };
}

async function error(p: Promise<unknown>): Promise<MglError> {
  try { await p; } catch (e) { return e as MglError; }
  throw new Error('expected a failure');
}

describe('media.search', () => {
  it('without a stock provider: E_NO_PROVIDER naming the open-media plugin and offline alternatives', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mgl-stock-none-'));
    const p = Project.create(join(dir, 'p.mgl.json'), emptyProject({ size: [1080, 1920], fps: 30, length: 300 }), makeServices(dir, builtinRegistry()));
    const e = await error(p.edit({ op: 'media.search', kind: 'sfx', query: 'whoosh' }, { save: false }));
    expect(e.code).toBe('E_NO_PROVIDER');
    expect(e.fix).toMatch(/open-media/);
    expect(e.fix).toMatch(/audio\.sfx/);
  });

  it('shows only usable licences and lengths, numbered, with the reasons for what it hid; writes search.json', async () => {
    const { edit, seen, work } = setup({ failing: true });
    const r = await edit({ op: 'media.search', kind: 'sfx', query: 'whoosh' });
    const text = r.summary.join('\n');
    expect(text).toMatch(/^sfx for "whoosh": 3 shown \(providers: fake, broken\)/);
    expect(text).toContain(' s1 · Deep Whoosh #1 · 1.0s · CC0 · bigdog · Fake Sounds');
    expect(text).toContain(' s2 · Whoosh by');
    expect(text).not.toMatch(/Shared whoosh|Long rain|ND whoosh/);
    expect(text).toMatch(/hidden: .*1 share-alike.*1 no-derivatives.*1 too long|hidden: .*1 share-alike/);
    expect(text).toContain('provider broken failed: HTTP 503 from broken.test');
    expect(text).toContain('next: media.fetch id=s1 at=<time>');
    expect(seen[0]!.ua).toMatch(/^michelangelo\//);
    const saved = JSON.parse(readFileSync(join(work, 'search.json'), 'utf8'));
    expect(saved.items.map((i: StockItem & { handle: string }) => [i.handle, i.id])).toEqual([['s1', 'fake:w1'], ['s2', 'fake:w2'], ['s3', 'fake:gone']]);
  });

  it('licences=["share-alike"] shows share-alike; no-derivatives never', async () => {
    const { edit } = setup();
    const r = await edit({ op: 'media.search', kind: 'sfx', query: 'whoosh', licences: ['share-alike', 'no-derivatives'] });
    expect(r.summary.join('\n')).toContain('Shared whoosh');
    expect(r.summary.join('\n')).not.toContain('ND whoosh');
  });

  it('images below half the comp long side are hidden, and a numbered preview sheet is written', async () => {
    const { edit, work } = setup();
    const r = await edit({ op: 'media.search', kind: 'image', query: 'blue' });
    const text = r.summary.join('\n');
    expect(text).toContain(' i1 · Blue field');
    expect(text).not.toContain('Tiny thumb');
    expect(text).toMatch(/1 too small/);
    expect(text).toMatch(/previews: .*search\.png/);
    expect(existsSync(join(work, 'search.png'))).toBe(true);
  });
});

describe('media.fetch', () => {
  it('downloads into media/stock/, writes the sidecar, adds asset + clip on the sfx bus, describes the sound, and lands its onset on at=', async () => {
    const { edit, project, dir } = setup();
    await edit({ op: 'media.search', kind: 'sfx', query: 'whoosh' });
    const r = await edit({ op: 'media.fetch', id: 'fake:w2', at: '2s', align: 'onset' });
    const out = r.out[0] as Record<string, unknown>;
    const src = out.src as string;
    expect(src).toMatch(/^media\/stock\/sfx\/fake-[0-9a-f]{10}\.wav$/);
    expect(existsSync(join(dir, src))).toBe(true);
    const side = JSON.parse(readFileSync(join(dir, `${src}.json`), 'utf8'));
    expect(side).toMatchObject({ id: 'fake:w2', licence: { id: 'cc-by-4.0', class: 'attribution', url: 'https://creativecommons.org/licenses/by/4.0/' }, credit: '“Whoosh by” by ana (Fake Sounds), CC BY 4.0' });
    expect(side.sha256).toMatch(/^[0-9a-f]{64}$/);
    const sound = out.sound as { onset: number; texture: string };
    expect(sound.onset).toBeGreaterThan(0.25);
    expect(sound.onset).toBeLessThan(0.36);
    expect(sound.texture).toBe('noisy');
    const asset = project.data.assets!.find((a) => a.src === src)!;
    expect(asset).toMatchObject({ kind: 'audio', licence: 'cc-by-4.0', credit: '“Whoosh by” by ana (Fake Sounds), CC BY 4.0' });
    const clip = project.data.clips!.find((c) => c.asset === asset.id)!;
    const track = project.data.tracks!.find((t) => t.id === clip.track)!;
    expect(track).toMatchObject({ audio: true, bus: 'sfx' });
    // onset ≈ 0.3 s = 9 frames: the clip starts that much before 2 s
    expect(60 - clip.at).toBeGreaterThanOrEqual(8);
    expect(60 - clip.at).toBeLessThanOrEqual(11);
    expect(r.summary.join('\n')).toMatch(/sound: 1\.00s, -?\d+\.\d LUFS, peak .* starts 0\.\d\ds, .*noisy/);
    // a second fetch reuses the file; the short handle names the same item
    const again = await edit({ op: 'media.fetch', id: 's2' });
    // handles are stable: a second search continues the numbering, a result shown before keeps its handle
    const second = await edit({ op: 'media.search', kind: 'sfx', query: 'whoosh', licences: ['share-alike'] });
    const text2 = second.summary.join('\n');
    expect(text2).toContain(' s1 · Deep Whoosh #1');
    expect(text2).toMatch(/ s4 · Shared whoosh/);
    expect((again.out[0] as Record<string, unknown>).reused).toBe(true);
  });

  it('refuses licences it would hide, unknown ids, and downloads that are web pages', async () => {
    const { edit, dir } = setup();
    await edit({ op: 'media.search', kind: 'sfx', query: 'whoosh', licences: ['share-alike'] });
    expect((await error(edit({ op: 'media.fetch', id: 'fake:w3' }))).code).toBe('E_LICENCE');
    expect((await error(edit({ op: 'media.fetch', id: 'fake:w5' }))).message).toMatch(/no-derivatives/);
    expect((await error(edit({ op: 'media.fetch', id: 'fake:nope' }))).code).toBe('E_ARG');
    const html = await error(edit({ op: 'media.fetch', id: 'fake:gone' }));
    expect(html.message).not.toMatch(/\n/);
    expect(html.code).toBe('E_MEDIA_FILE');
    expect(html.message).toMatch(/web page/);
    expect(existsSync(join(dir, 'media', 'stock', 'sfx'))).toBe(true);
    // share-alike is fetched when allowed
    await edit({ op: 'media.fetch', id: 'fake:w3', licences: ['share-alike'] });
  });

  it('align=peak lands the loudest moment on at=; a short sound reports RMS instead of a missing LUFS', async () => {
    const { edit, project } = setup();
    await edit({ op: 'media.search', kind: 'sfx', query: 'whoosh' });
    const r = await edit({ op: 'media.fetch', id: 's1', at: '2s', align: 'peak', clip: 'hit' });
    const sound = (r.out[0] as { sound: { peakAt: number } }).sound;
    const clip = project.data.clips!.find((c) => c.id === 'hit')!;
    expect(clip.at).toBe(60 - Math.round(sound.peakAt * 30));
    expect(sound.peakAt).toBeGreaterThan(0.25);
  });

  it('titles are capped when results come in, and credit lines cap long titles', async () => {
    const { creditLine } = await import('../../src/core/licence.js');
    const essay = 'Physalis alkekengi L. Rosaceae Chinese lantern, Winter Cherry, Bladder Cherry. Distribution: C & S Europe, W. Asia to Japan; ' + 'more words '.repeat(60);
    const line = creditLine({ title: essay, author: 'A', source: 'S', licence: { id: 'cc-by-4.0' } });
    expect(line.length).toBeLessThan(130);
    expect(line).toMatch(/^“Physalis alkekengi L\. Rosaceae Chinese lantern, Winter Cherry, Bladder Cherry…” by A \(S\), CC BY 4\.0$/);
  });

  it('an image goes on a new top visual track for 3 s; music is cut to the comp', async () => {
    const { edit, project } = setup();
    await edit({ op: 'media.search', kind: 'image', query: 'blue' });
    const r = await edit({ op: 'media.fetch', id: 'fake:p1', as: 'blue', at: 0 });
    expect((r.out[0] as Record<string, unknown>).asset).toBe('blue');
    const clip = project.data.clips!.find((c) => c.asset === 'blue')!;
    expect(clip.len).toBe(90);
    expect(project.data.tracks!.at(-1)!.id).toBe(clip.track);
    await edit({ op: 'media.search', kind: 'music', query: 'bed' });
    await edit({ op: 'media.fetch', id: 'fake:t1', at: '9s' });
    const bed = project.data.clips!.find((c) => c.id.startsWith('mus-tone-bed'))!;
    expect(bed.at + bed.len).toBe(300);
    expect(project.data.tracks!.find((t) => t.id === bed.track)).toMatchObject({ bus: 'music' });
  });
});

describe('media.credits and the stock QA rules', () => {
  it('a CC BY asset in use is flagged until credited; media.credits writes the file and a card that passes QA', async () => {
    const { edit, project, dir } = setup();
    await edit({ op: 'media.search', kind: 'sfx', query: 'whoosh' });
    await edit({ op: 'media.fetch', id: 'fake:w2', at: '1s' });
    await edit({ op: 'media.fetch', id: 'fake:w1', at: '3s' });
    await edit({ op: 'clip.add', color: '#223344', track: 'V1', at: 0, len: 300, id: 'bg' }).catch(async () => {
      await edit({ op: 'track.add', id: 'V1' });
      await edit({ op: 'clip.add', color: '#223344', track: 'V1', at: 0, len: 300, id: 'bg' });
    });
    const before = runCheck('stock-credits', project.data);
    expect(before).toHaveLength(1);
    expect(before[0]!.message).toMatch(/CC BY 4\.0.*not credited/);
    // several uncredited assets: still one finding (they share the fix), naming them
    const many = structuredClone(project.data);
    many.assets!.push({ id: 'x2', src: 'media/stock/image/x2.png', kind: 'image', licence: 'cc-by-2.0', credit: 'c' }, { id: 'x3', src: 'media/stock/image/x3.png', kind: 'image', licence: 'cc-by-4.0', credit: 'c' });
    many.clips!.push({ id: 'u2', track: 'V1', at: 100, len: 10, asset: 'x2' } as never, { id: 'u3', track: 'V1', at: 120, len: 10, asset: 'x3' } as never);
    const all = runCheck('stock-credits', many);
    expect(all).toHaveLength(1);
    expect(all[0]!.message).toMatch(/^3 assets need a credit and have none: .*x2, x3$/);
    expect(before[0]!.fix).toBe('mgl edit <file> media.credits card=true');
    const r = await edit({ op: 'media.credits', out: 'credits.txt', card: true });
    expect(readFileSync(join(dir, 'credits.txt'), 'utf8')).toBe('Credits\n\n“Whoosh by” by ana (Fake Sounds), CC BY 4.0\n“Deep Whoosh #1” by bigdog (Fake Sounds), CC0\n');
    expect(r.summary[0]).toMatch(/^credited 2 assets in credits\.txt and on a credits card at the end:/);
    expect(project.data.project!.credits).toEqual({ file: 'credits.txt', assets: project.data.assets!.filter((a) => a.credit).map((a) => a.id) });
    expect(runCheck('stock-credits', project.data)).toEqual([]);
    expect(project.data.comps[0]!.length).toBe(390);
    const card = project.data.clips!.filter((c) => c.tags?.includes('credits'));
    expect(card).toHaveLength(2);
    expect(card.every((c) => c.at === 300 && c.len === 90 && c.tags!.includes('qa-ignore:static'))).toBe(true);
    // saved and read back: project.credits survives the file format
    await project.save();
    const back = await Project.open(join(dir, 'p.mgl.json'));
    expect(back.data.project!.credits!.assets).toHaveLength(2);
    // re-running replaces the card instead of adding another
    await edit({ op: 'media.credits', card: true });
    expect(project.data.clips!.filter((c) => c.tags?.includes('credits'))).toHaveLength(2);
  });

  it('a long credit list is paged over several cards that fit the safe area', async () => {
    const { edit, project } = setup();
    for (let i = 0; i < 14; i++) {
      (project.data.assets ??= []).push({ id: `a${i}`, src: `media/stock/image/x${i}.png`, kind: 'image', licence: 'cc-by-4.0', credit: `“A rather long title for picture number ${i} of the series” by Somebody Withalongname (Some Archive via Openverse), CC BY 4.0` });
      (project.data.clips ??= []).push({ id: `c${i}`, track: 'V1', at: i * 10, len: 10, asset: `a${i}` } as never);
    }
    if (!project.data.tracks?.some((t) => t.id === 'V1')) (project.data.tracks ??= []).push({ id: 'V1', comp: 'main' });
    const r = await edit({ op: 'media.credits', card: true });
    const card = (r.out[0] as { card: { pages: number; len: number } }).card;
    expect(card.pages).toBeGreaterThan(1);
    expect(card.len).toBe(card.pages * 90);
    const texts = project.data.clips!.filter((c) => c.tags?.includes('credits') && c.text);
    expect(texts.map((c) => c.text!.split('\n\n').length).reduce((a, b) => a + b, 0)).toBe(15);
  });

  it('stock-licence: no-derivatives is an error; non-commercial only in a commercial project; share-alike is a note', () => {
    const p = (licence: string, commercial?: boolean): ProjectFile => ({
      michelangelo: 1, project: { ...(commercial ? { commercial: true } : {}) },
      assets: [{ id: 'a', src: 'media/stock/image/x.png', kind: 'image', licence }],
      comps: [{ id: 'main', size: [1080, 1920], fps: 30, length: 90 }], tracks: [{ id: 'V1', comp: 'main' }],
      clips: [{ id: 'c', track: 'V1', at: 0, len: 90, asset: 'a' }],
    } as ProjectFile);
    expect(runCheck('stock-licence', p('cc-by-nd-4.0'))[0]).toMatchObject({ severity: 'error', clip: 'c' });
    expect(runCheck('stock-licence', p('cc-by-nc-4.0'))).toEqual([]);
    expect(runCheck('stock-licence', p('cc-by-nc-4.0', true))[0]!.message).toMatch(/non-commercial.*commercial/);
    expect(runCheck('stock-licence', p('cc-by-sa-4.0'))[0]).toMatchObject({ severity: 'info' });
    expect(runCheck('stock-licence', p('cc0'))).toEqual([]);
  });
});

describe('provider validation', () => {
  it('a stock provider needs search and a media list', () => {
    const bad = validatePlugin(definePlugin({ name: 'x', providers: [{ kind: 'stock', id: 's', describe: 'd' } as unknown as StockProvider] }));
    expect(bad.join(' ')).toMatch(/no search function/);
    expect(bad.join(' ')).toMatch(/no media list/);
    const ok: StockProvider = { kind: 'stock', id: 's', describe: 'd', media: ['sfx'], search: async () => [] };
    expect(validatePlugin(definePlugin({ name: 'y', providers: [ok] }))).toEqual([]);
    expect(new PluginRegistry().add(definePlugin({ name: 'y', providers: [ok] }), 'test').providers.get('stock')!.size).toBe(1);
  });
});

