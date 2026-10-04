// @vitest-environment node
/** audio.music, audio.sfx and audio.auto-sfx (src/core/commands/audio-gen.ts) and the generated-file services. */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeProject } from './commands-fixtures.js';
import type { CommandServices } from '../../src/core/commands/index.js';
import type { ProjectFile } from '../../src/core/schema/index.js';
import { decodeWav } from '../../src/audiogen/index.js';
import { generatedFileServices } from '../../src/audiogen/node.js';

/** In-memory file services (writeFile / fileExists / readText) that count writes. */
function memFiles() {
  const files = new Map<string, Uint8Array>();
  const writes: string[] = [];
  const services: CommandServices = {
    async writeFile(p, d) { files.set(p, d); writes.push(p); },
    async fileExists(p) { return files.has(p); },
    async readText(p) { const d = files.get(p); if (!d) throw new Error(`no ${p}`); return new TextDecoder().decode(d); },
  };
  return { files, writes, services };
}

function setup(edit?: (p: ProjectFile) => void) {
  const mem = memFiles();
  return { ...mem, ...makeProject({ services: mem.services, ...(edit ? { edit } : {}) }) };
}

describe('audio.music', () => {
  it('writes a WAV into media/generated, adds an asset and a looping clip on the music bus, and reuses the file', async () => {
    const { edit, project, files, writes } = setup();
    const r = await edit({ op: 'audio.music', mood: 'chill', len: '4s', seed: 2, key: 'Eb' });
    const src = r.out[0]!.src as string;
    expect(src).toMatch(/^media\/generated\/music-[0-9a-f]{10}\.wav$/);
    expect(files.has(src) && files.has(`${src}.json`)).toBe(true);
    const wav = decodeWav(files.get(src)!);
    expect(wav.sampleRate).toBe(48000);
    expect(wav.chans).toHaveLength(2);
    const clip = project.data.clips!.find((c) => c.id === r.out[0]!.id)!;
    expect(clip).toMatchObject({ track: 'A2', at: 0, len: 120, loop: true, fade: [0, 30] });
    expect(project.data.tracks!.find((t) => t.id === 'A2')!.bus).toBe('music');
    const asset = project.data.assets!.find((a) => a.id === clip.asset)!;
    expect(asset.src).toBe(src);
    expect(asset.note).toMatch(/chill, \d+ BPM, Eb major/);
    expect(r.summary.join(' ')).toMatch(/Eb major .*-18(\.\d)? LUFS.*Generated media\/generated\/music-.*Sounds like: .*LUFS/);
    expect(r.out[0]).toMatchObject({ key: 'Eb major', generated: true });
    // same parameters, another clip: no new render, same asset
    const n = writes.length;
    const r2 = await edit({ op: 'audio.music', mood: 'chill', len: '4s', seed: 2, key: 'Eb', at: '10s' });
    expect(writes.length).toBe(n);
    expect(r2.out[0]!.generated).toBe(false);
    expect(r2.summary.join(' ')).toMatch(/Reused/);
    expect(project.data.clips!.find((c) => c.id === r2.out[0]!.id)!.asset).toBe(clip.asset);
    expect(project.data.assets).toHaveLength(1);
  });

  it('fills the comp by default, replaces a bed with the same id, and takes energy or an intensity curve', async () => {
    const { edit, project } = setup((p) => { p.comps[0]!.length = 150; });
    await edit({ op: 'audio.music', id: 'bed', mood: 'corporate', seed: 1 });
    expect(project.data.clips!.find((c) => c.id === 'bed')).toMatchObject({ at: 0, len: 150, track: 'A2' });
    await edit({ op: 'audio.music', id: 'bed', mood: 'cinematic', energy: 0.9, seed: 1 });
    const beds = project.data.clips!.filter((c) => c.id === 'bed');
    expect(beds).toHaveLength(1);
    expect(project.data.assets!.find((a) => a.id === beds[0]!.asset)!.note).toMatch(/epic/); // alias
    await edit({ op: 'audio.music', id: 'bed', mood: 'upbeat', intensity: [['0s', 0.2], ['3s', 1]], seed: 1 });
    await expect(edit({ op: 'audio.music', mood: 'upbeat', energy: 0.5, intensity: [[0, 1]] })).rejects.toMatchObject({ code: 'E_ARG' });
    await expect(edit({ op: 'audio.music', mood: 'upbeat', key: 'H#' })).rejects.toMatchObject({ code: 'E_ARG', fix: expect.stringMatching(/key=Am/) });
    await expect(edit({ op: 'audio.music', mood: 'jazz' })).rejects.toMatchObject({ code: 'E_ARG' });
  });

  it('refuses an id used by a clip that is not a generated bed', async () => {
    const { edit } = setup((p) => { p.clips = [{ id: 'title', track: 'T1', at: 0, len: 30, text: 'Hi' }]; });
    await expect(edit({ op: 'audio.music', id: 'title', len: '2s' })).rejects.toMatchObject({ code: 'E_DUPLICATE_ID' });
  });

  it('adds exact beat or bar markers from its grid', async () => {
    const { edit, project } = setup();
    const r = await edit({ op: 'audio.music', mood: 'upbeat', bpm: 120, len: '4s', markers: 'beats' });
    const m = project.data.markers!;
    expect(m.map((x) => x.at)).toEqual([0, 15, 30, 45, 60, 75, 90, 105]);
    expect(m[0]!.id).toBe('beat1');
    expect(r.summary.join(' ')).toMatch(/Added 8 beat markers/);
    await edit({ op: 'audio.music', mood: 'upbeat', bpm: 120, len: '4s', markers: 'bars', at: '5s' });
    expect(project.data.markers!.filter((x) => x.id.startsWith('bar')).map((x) => x.at)).toEqual([150, 210]);
  });

  it('sits lower and ducks under dialogue', async () => {
    const { edit, project } = setup((p) => { p.assets = [{ id: 'vo', src: 'vo.wav' }]; p.clips = [{ id: 'v', track: 'A1', at: 0, len: 90, asset: 'vo' }]; });
    const r = await edit({ op: 'audio.music', mood: 'lofi', len: '4s' });
    expect(project.data.clips!.find((c) => c.id === r.out[0]!.id)!.gain).toBe(-6);
    expect(project.data.buses).toEqual([{ id: 'music', duck: { by: 'dialogue', db: 9 } }]);
  });

  it('says how to get a file service when there is none', async () => {
    const { edit } = makeProject();
    await expect(edit({ op: 'audio.music', len: '2s' })).rejects.toMatchObject({ code: 'E_NO_SERVICE' });
  });
});

describe('audio.sfx', () => {
  it('lands the peak on at=, puts overlapping sounds on extra sfx tracks', async () => {
    const { edit, project } = setup();
    const a = await edit({ op: 'audio.sfx', type: 'whoosh', at: '2s' });
    const w = project.data.clips!.find((c) => c.id === a.out[0]!.id)!;
    // whoosh peaks ~0.42 s in (12-13 frames): the clip starts that much before the hit
    expect(60 - w.at).toBeGreaterThanOrEqual(11);
    expect(60 - w.at).toBeLessThanOrEqual(14);
    expect(project.data.tracks!.find((t) => t.id === w.track)).toMatchObject({ audio: true, bus: 'sfx' });
    const b = await edit({ op: 'audio.sfx', type: 'riser', at: '2s', gain: -3 });
    const rs = project.data.clips!.find((c) => c.id === b.out[0]!.id)!;
    expect(rs.track).not.toBe(w.track);
    expect(rs.gain).toBe(-3);
    expect(rs.at + rs.len).toBeGreaterThanOrEqual(58); // the riser ends at its climax
    const c = await edit({ op: 'audio.sfx', type: 'pop', at: '5s' });
    expect(project.data.clips!.find((x) => x.id === c.out[0]!.id)!.track).toBe(w.track); // free again
    expect(b.summary.join(' ')).toMatch(/rising .* LUFS/);
  });

  it('trims the head of a sound whose peak would fall before 0', async () => {
    const { edit, project } = setup();
    const r = await edit({ op: 'audio.sfx', type: 'riser', at: '0.5s' });
    const c = project.data.clips!.find((x) => x.id === r.out[0]!.id)!;
    expect(c.at).toBe(0);
    expect(c.in).toBeGreaterThan(30);
  });

  it('refuses a busy or visual track', async () => {
    const { edit } = setup();
    await edit({ op: 'audio.sfx', type: 'hit', at: '1s', track: 'FX1' });
    await expect(edit({ op: 'audio.sfx', type: 'hit', at: '1.1s', track: 'FX1' })).rejects.toMatchObject({ code: 'E_OVERLAP' });
    await expect(edit({ op: 'audio.sfx', type: 'hit', at: '1s', track: 'V1' })).rejects.toMatchObject({ code: 'E_TRACK_KIND' });
  });
});

const scene = (p: ProjectFile) => {
  p.clips = [
    { id: 's1', track: 'V1', at: 0, len: 90, color: '#112233' },
    { id: 's2', track: 'V1', at: 90, len: 90, color: '#223344' },
    { id: 's3', track: 'V1', at: 180, len: 90, color: '#334455', transition: { in: { type: 'crossfade', len: 12 } } },
    { id: 'title', track: 'T1', at: 20, len: 60, text: 'Hello' },
    { id: 'cap', track: 'T1', at: 92, len: 40, text: 'Close to a cut' },
    { id: 'lt-bg', track: 'V2', at: 200, len: 60, color: '#000000', tags: ['template:lower-third'] },
    { id: 'lt-name', track: 'V3', at: 203, len: 57, text: 'Ada', tags: ['template:lower-third'] },
  ];
  p.tracks!.push({ id: 'V2', comp: 'main' }, { id: 'V3', comp: 'main' });
};

describe('audio.auto-sfx', () => {
  it('whooshes transitions, hits hard cuts, swooshes templates, pops text — linked to the source', async () => {
    const { edit, project } = setup(scene);
    const r = await edit({ op: 'audio.auto-sfx' });
    const placed = r.out[0]!.placed as { type: string; cat: string; src: string; frame: number }[];
    expect(placed.map((x) => `${x.type}:${x.src}@${x.frame}`)).toEqual(['pop:title@20', 'hit:s2@90', 'whoosh:s3@180', 'swoosh:lt-bg@200']);
    // the text at 92 is within 0.25 s of the cut at 90: one sound, the cut wins
    for (const x of placed) {
      const sfx = project.data.clips!.find((c) => c.tags?.includes(`sfx-for:${x.src}`))!;
      const src = project.data.clips!.find((c) => c.id === x.src)!;
      expect(sfx.link).toBe(src.link);
      expect(project.data.tracks!.find((t) => t.id === sfx.track)!.bus).toBe('sfx');
    }
    // moving the source moves its sound
    const pop = project.data.clips!.find((c) => c.tags?.includes('sfx-for:title'))!;
    const before = pop.at;
    await edit({ op: 'clip.move', id: 'title', by: -15 });
    expect(project.data.clips!.find((c) => c.id === pop.id)!.at).toBe(before - 15);
    expect(r.summary.join(' ')).toMatch(/placed 4 SFX: 1 whoosh \(transitions\), 1 hit \(cuts\), 1 swoosh \(templates\), 1 pop \(text\)/);
  });

  it('re-running replaces the previous auto SFX and cleans up their assets; on= and map= choose', async () => {
    const { edit, project } = setup(scene);
    await edit({ op: 'audio.auto-sfx' });
    const r = await edit({ op: 'audio.auto-sfx', on: ['text', 'cuts'], map: { text: 'click', cuts: 'none' }, gain: -4 });
    const auto = project.data.clips!.filter((c) => c.tags?.includes('auto-sfx'));
    expect(auto.map((c) => c.tags![1])).toEqual(['sfx-for:title', 'sfx-for:cap']);
    expect(auto.every((c) => c.gain === -4)).toBe(true);
    expect(project.data.assets!.every((a) => /sfx-click/.test(a.src))).toBe(true);
    expect(r.summary.join(' ')).toMatch(/replacing 4/);
    const none = await edit({ op: 'audio.auto-sfx', on: ['transitions'], map: { transitions: 'none' } });
    expect(none.summary.join(' ')).toMatch(/no transitions found .*removed 2/);
    expect(project.data.clips!.some((c) => c.tags?.includes('auto-sfx'))).toBe(false);
    expect(project.data.tracks!.some((t) => t.bus === 'sfx')).toBe(false);
  });

  it('varies repeated sounds with a few seeded variants, not one file per event', async () => {
    const { edit, project } = setup((p) => { p.clips = Array.from({ length: 6 }, (_x, i) => ({ id: `t${i}`, track: 'T1', at: i * 30, len: 25, text: `Line ${i}` })); });
    await edit({ op: 'audio.auto-sfx', on: ['text'] });
    const assets = new Set(project.data.clips!.filter((c) => c.tags?.includes('auto-sfx')).map((c) => c.asset));
    expect(assets.size).toBe(3);
  });
});

describe('generatedFileServices', () => {
  it('writes only directly inside media/generated of the project', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mgl-gen-'));
    const s = generatedFileServices(dir);
    await s.writeFile('media/generated/a.wav', new Uint8Array([1, 2, 3]));
    expect(readFileSync(join(dir, 'media/generated/a.wav'))).toEqual(Buffer.from([1, 2, 3]));
    expect(await s.fileExists('media/generated/a.wav')).toBe(true);
    expect(await s.fileExists('media/generated/b.wav')).toBe(false);
    expect(await s.fileExists('../x')).toBe(false);
    await expect(s.writeFile('../evil.wav', new Uint8Array(1))).rejects.toMatchObject({ code: 'E_PATH' });
    await expect(s.writeFile('media/generated/../../x.wav', new Uint8Array(1))).rejects.toMatchObject({ code: 'E_PATH' });
    await expect(s.writeFile('media/other/x.wav', new Uint8Array(1))).rejects.toMatchObject({ code: 'E_PATH' });
    // a symlinked media/generated that leaves the project is refused
    const out = mkdtempSync(join(tmpdir(), 'mgl-out-'));
    const d2 = mkdtempSync(join(tmpdir(), 'mgl-gen2-'));
    mkdirSync(join(d2, 'media'));
    symlinkSync(out, join(d2, 'media/generated'));
    await expect(generatedFileServices(d2).writeFile('media/generated/x.wav', new Uint8Array(1))).rejects.toMatchObject({ code: 'E_PATH' });
    expect(existsSync(join(out, 'x.wav'))).toBe(false);
  });
});
