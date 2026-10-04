import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProjectFile } from '../../src/core/schema/index.js';
import type { CheckContext, Finding } from '../../src/plugin/api.js';
import { builtinRegistry } from '../../src/builtin/index.js';
import { ignores } from '../../src/builtin/checks/index.js';
import { applyIgnores, checkProject, makeContext, mergePlatforms, runStage, sampleFrames, withFile } from '../../src/qa/check.js';
import { displayName, estimateLook } from '../../src/qa/look.js';
import { layersAt, runCheck, shortsProject } from './qa-fixtures.js';

type B = [number, number, number, number];
const FULL: B = [0, 0, 1080, 1920];
const L = (clipId: string, kind: string, box: B, text?: string) => ({ clipId, kind, box, ...(text ? { text } : {}) });
const extra = (o: Record<string, unknown>) => o as Partial<CheckContext>;

/** A frame image at `scale` of 1080x1920, filled with rgb, with optional rects. */
function img(rgb: [number, number, number], scale = 0.1, rects: { box: B; rgb: [number, number, number] }[] = []) {
  const width = Math.round(1080 * scale), height = Math.round(1920 * scale), data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const r = rects.find(({ box: b }) => x >= b[0] * scale && x < (b[0] + b[2]) * scale && y >= b[1] * scale && y < (b[1] + b[3]) * scale);
    data.set([...(r?.rgb ?? rgb), 255], (y * width + x) * 4);
  }
  return { width, height, data, scale };
}

describe('frozen: visible pixels only, never a ripple trim', () => {
  const p = shortsProject({
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'V2', comp: 'main' }, { id: 'T1', comp: 'main' }],
    assets: [{ id: 'a', src: 'a.mp4' }, { id: 'b', src: 'b.mp4' }],
    clips: [{ id: 'camA', track: 'V1', at: 0, len: 300, asset: 'a' }, { id: 'camB', track: 'V2', at: 0, len: 300, asset: 'b' }],
  } as Partial<ProjectFile>);

  it('a video hidden under an opaque full-frame video above it is not reported', () => {
    const layers = new Map([[30, [L('camA', 'video', FULL), L('camB', 'video', FULL)]], [60, [L('camA', 'video', FULL), L('camB', 'video', FULL)]]]);
    const f = runCheck('frozen', p, { layers, frames: new Map([[30, img([40, 50, 60])], [60, img([40, 50, 60])]]) });
    expect(f.filter((x) => x.clip === 'camA')).toEqual([]);
  });

  it('a screen recording where only a small timestamp changes is not frozen', () => {
    const layers = new Map([[15, [L('camA', 'video', FULL)]], [45, [L('camA', 'video', FULL)]]]);
    const frames = new Map([[15, img([200, 200, 200], 0.1, [{ box: [900, 40, 140, 60], rgb: [0, 0, 0] }])], [45, img([200, 200, 200], 0.1, [{ box: [900, 40, 140, 60], rgb: [255, 0, 0] }])]]);
    expect(runCheck('frozen', p, { layers, frames })).toEqual([]);
  });

  it('a clip running past its source end: warning with a trim to exactly the source end, no ripple', () => {
    const one = { ...p, clips: [{ id: 'camA', track: 'V1', at: 0, len: 300, asset: 'a' }] } as ProjectFile;
    const layers = new Map([[200, [L('camA', 'video', FULL)]], [260, [L('camA', 'video', FULL)]]]);
    const f = runCheck('frozen', one, extra({ layers, frames: new Map([[200, img([9, 9, 9])], [260, img([9, 9, 9])]]), sourceDuration: () => 5 }));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: 'warning', fix: 'mgl edit <file> clip.trim camA end=150' });
    expect(f[0]!.fix).not.toContain('ripple');
    // within the source: only an info, with no fix at all
    const g = runCheck('frozen', one, extra({ layers, frames: new Map([[200, img([9, 9, 9])], [260, img([9, 9, 9])]]), sourceDuration: () => 60 }));
    expect(g[0]).toMatchObject({ severity: 'info' });
    expect(g[0]!.fix).toBeUndefined();
  });
});

describe('overlaps respect stacking', () => {
  const base = shortsProject({
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'T1', comp: 'main' }, { id: 'V2', comp: 'main' }],
    assets: [{ id: 'bgv', src: 'lavfi:testsrc2' }, { id: 'png', src: 'live.png' }],
    clips: [
      { id: 'bg', track: 'V1', at: 0, len: 300, asset: 'bgv' },
      { id: 'crawl', track: 'T1', at: 0, len: 300, text: 'Breaking news crawl' },
      { id: 'live', track: 'V2', at: 0, len: 300, asset: 'png' },
    ],
  } as Partial<ProjectFile>);
  const layers = layersAt(60, [L('bg', 'video', FULL), L('crawl', 'text', [100, 1500, 900, 80], 'Breaking news crawl'), L('live', 'image', [700, 1450, 300, 200])]);

  it('text on a lower track under a higher layer is "hidden under", fixed by moving it up a track', () => {
    const f = runCheck('caption-overlap', base, { layers });
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toMatch(/crawl\) is hidden under image "live"/);
    expect(f[0]!.message).not.toContain('drawn over');
    expect(f[0]!.fix).toBe('mgl edit <file> track.add id=V4 comp=main above=V2 && mgl edit <file> clip.move crawl track=V4');
    const withFree = { ...base, tracks: [...base.tracks!, { id: 'V3', comp: 'main' }] } as ProjectFile;
    expect(runCheck('caption-overlap', withFree, { layers })[0]!.fix).toBe('mgl edit <file> clip.move crawl track=V3');
  });

  it('overlap-alpha (pixels) says "hidden under" too, never "drawn over" for the lower text', () => {
    const frames = new Map([[60, img([0, 0, 0], 0.25, [{ box: [700, 1450, 300, 200], rgb: [255, 0, 0] }])]]);
    const f = runCheck('overlap-alpha', base, { layers, frames });
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toContain('is hidden under image "live"');
  });

  it('split screen: a label is never moved into the other half; no clear spot → info with a qa-ignore tag', () => {
    const p = shortsProject({ clips: [] } as Partial<ProjectFile>);
    const ls = layersAt(30, [L('top', 'comp', [0, 0, 1080, 960]), L('bottom', 'comp', [0, 960, 1080, 960]), L('lblA', 'text', [340, 860, 400, 80], 'BEFORE'), L('lblB', 'text', [340, 1820, 400, 80], 'AFTER')]);
    const f = runCheck('caption-overlap', p, { layers: ls });
    const a = f.find((x) => x.clip === 'lblA')!;
    expect(a.severity).toBe('info');
    expect(a.fix).toBe('mgl edit <file> clip.set lblA \'tags=["qa-ignore:overlap"]\'');
    expect(f.every((x) => !/y=\d/.test(x.fix ?? ''))).toBe(true);
  });

  it('a verified move: the proposed position is clear of the other layers', () => {
    const p = shortsProject({ clips: [{ id: 'logo', track: 'T1', at: 0, len: 300, asset: 'bgv', y: 1300 }] } as Partial<ProjectFile>);
    const cap = L('subs', 'captions', [200, 1250, 680, 120], 'hello');
    const logo = L('logo', 'image', [440, 1200, 200, 200]);
    // a sticker sits right above the logo, so moving the logo up would hit it: the logo goes below instead
    const sticker = L('sticker', 'image', [440, 980, 200, 200]);
    const f = runCheck('caption-overlap', p, { layers: layersAt(60, [logo, sticker, cap]) });
    // moving the logo up (the nearest spot) would hit the sticker, so the caption moves below the logo instead
    expect(f.find((x) => x.clip === 'subs')!.fix).toBe('mgl edit <file> clip.set subs y=1129');
    expect(runCheck('caption-overlap', p, { layers: layersAt(60, [logo, cap]) })[0]!.fix).toBe('mgl edit <file> clip.set logo y=1131');
  });
});

describe('new checks', () => {
  it('layer-hidden: an overlay under an opaque nested comp for its whole duration', () => {
    const p = {
      ...shortsProject(),
      comps: [{ id: 'main', size: [1080, 1920], fps: 30, length: 300 }, { id: 'inner', size: [1080, 1920], fps: 30, bg: '#000000' }],
      tracks: [{ id: 'V1', comp: 'main' }, { id: 'T1', comp: 'main' }, { id: 'V3', comp: 'main' }],
      clips: [{ id: 'bg', track: 'V1', at: 0, len: 300, asset: 'bgv' }, { id: 'wm', track: 'T1', at: 0, len: 300, text: 'DRAFT' }, { id: 'nest', track: 'V3', at: 0, len: 300, comp: 'inner' }],
    } as unknown as ProjectFile;
    const frames = [30, 150, 270];
    const sampled = new Map(frames.map((f) => [f, [L('bg', 'video', FULL), L('wm', 'text', [400, 900, 280, 90], 'DRAFT'), L('nest', 'comp', FULL)]]));
    const f = runCheck('layer-hidden', p, extra({ sampled }));
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toMatch(/text "DRAFT" \(wm\) is hidden under "nest".*whole duration/);
    expect(f[0]!.fix).toBe('mgl edit <file> track.add id=V4 comp=main above=V3 && mgl edit <file> clip.move wm track=V4');
    // the cover plays only half the time: not hidden
    const half = { ...p, clips: p.clips!.map((c) => (c.id === 'nest' ? { ...c, len: 150 } : c)) } as ProjectFile;
    expect(runCheck('layer-hidden', half, extra({ sampled }))).toEqual([]);
    // a nested comp without bg or covering clip is see-through
    const clear = { ...p, comps: [p.comps[0]!, { id: 'inner', size: [1080, 1920], fps: 30 }] } as ProjectFile;
    expect(runCheck('layer-hidden', clear, extra({ sampled }))).toEqual([]);
  });

  it('layer-hidden end to end through checkProject (real layout): text under an opaque solid', async () => {
    const p = shortsProject({
      tracks: [{ id: 'V1', comp: 'main' }, { id: 'T1', comp: 'main' }, { id: 'V2', comp: 'main' }],
      clips: [{ id: 'bg', track: 'V1', at: 0, len: 300, color: '#123456' }, { id: 'title', track: 'T1', at: 0, len: 300, text: 'Hello' }, { id: 'plate', track: 'V2', at: 0, len: 300, color: '#ff0000' }],
    } as Partial<ProjectFile>);
    const f = await checkProject(p, { baseDir: tmpdir(), registry: builtinRegistry() });
    expect(f.find((x) => x.rule === 'layer-hidden')?.clip).toBe('title');
  }, 30_000);

  it('media-off-frame: an image layer mostly outside the frame (both crossed edges named); backgrounds are fine', () => {
    const p = shortsProject({ assets: [{ id: 'bgv', src: 'lavfi:testsrc2' }, { id: 'png', src: 'logo.png' }], clips: [...shortsProject().clips!, { id: 'logo', track: 'T1', at: 0, len: 300, asset: 'png' }] } as Partial<ProjectFile>);
    const sampled = layersAt(150, [L('bg', 'video', FULL), L('logo', 'image', [700, -100, 600, 300])]);
    const f = runCheck('media-off-frame', p, extra({ sampled }));
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toMatch(/image "logo" runs off the top and right of the frame/);
    expect(f[0]!.fix).toBe('mgl edit <file> clip.set logo x=266 y=1156');
    // too big for the frame: scale it down
    const big = runCheck('media-off-frame', p, extra({ sampled: layersAt(150, [L('logo', 'image', [300, 1200, 1800, 1200])]) }));
    expect(big[0]!.fix).toMatch(/^mgl edit <file> clip\.set logo scale=0\.\d+/);
    expect(runCheck('media-off-frame', p, extra({ sampled: layersAt(150, [L('bg', 'video', [-500, 0, 2080, 1920])]) }))).toEqual([]);
  });

  it('trailing-black: only a matte after the last content (comp auto length)', () => {
    const p = shortsProject({
      comps: [{ id: 'main', size: [1080, 1920], fps: 30 }],
      tracks: [{ id: 'V1', comp: 'main' }, { id: 'M', comp: 'main' }],
      clips: [
        { id: 'shot', track: 'V1', at: 0, len: 330, asset: 'bgv' },
        { id: 'matte-top', track: 'M', at: 0, len: 330, shape: { type: 'rect', size: [1080, 200], fill: '#000000' } },
        { id: 'matte-bot', track: 'M', at: 330, len: 330, shape: { type: 'rect', size: [1080, 200], fill: '#000000' } },
      ],
    } as Partial<ProjectFile>);
    const f = runCheck('trailing-black', p);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: 'warning', frame: 330 });
    expect(f[0]!.message).toContain('11.00 s of black');
    expect(f[0]!.fix).toBe('mgl edit <file> track.add id=V3 comp=main above=M && mgl edit <file> clip.move matte-bot track=V3 at=0');
    expect(runCheck('trailing-black', shortsProject())).toEqual([]);
    // audio-only: nothing to say
    expect(runCheck('trailing-black', shortsProject({ tracks: [{ id: 'A1', comp: 'main', audio: true }], clips: [{ id: 'vo', track: 'A1', at: 0, len: 300, asset: 'bgv' }] } as Partial<ProjectFile>))).toEqual([]);
  });

  it('clip-past-source: in check, through a provided probe; trims to the source end without ripple', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mgl-qa-v2-'));
    writeFileSync(join(dir, 'bg.mp4'), 'x');
    const p = shortsProject({ assets: [{ id: 'bgv', src: 'bg.mp4' }], clips: [{ id: 'bg', track: 'V1', at: 30, len: 450, asset: 'bgv' }] } as Partial<ProjectFile>);
    const f = await checkProject(p, { baseDir: dir, registry: builtinRegistry(), probe: async () => ({ duration: 12, width: 1080, height: 1920 }), file: 'clip.mgl.json' });
    const past = f.find((x) => x.rule === 'clip-past-source')!;
    expect(past.message).toContain('runs 3.00 s past the end of its source "bgv" (12.00 s)');
    expect(past.fix).toBe('mgl edit clip.mgl.json clip.trim bg end=390');
    // without a probe the rule stays quiet (no guessing)
    expect((await checkProject(p, { baseDir: dir, registry: builtinRegistry() })).some((x) => x.rule === 'clip-past-source')).toBe(false);
  }, 30_000);

  it('luma-range: info when over 5% of a video layer is outside 16–235; legal pictures pass', () => {
    const p = shortsProject();
    const layers = layersAt(30, [L('bg', 'video', FULL)]);
    const f = runCheck('luma-range', p, { layers, frames: new Map([[30, img([128, 128, 128], 0.1, [{ box: [0, 0, 1080, 400], rgb: [0, 0, 0] }])]]) });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: 'info', clip: 'bg', fix: 'mgl edit <file> fx.add bg type=legalize range=pc' });
    expect(runCheck('luma-range', p, { layers, frames: new Map([[30, img([128, 128, 128])]]) })).toEqual([]);
  });

  it('alpha-with-bg: only for an --alpha render of a comp with an opaque bg', () => {
    const p = shortsProject({ comps: [{ id: 'main', size: [1080, 1920], fps: 30, length: 300, bg: '#101010' }] } as Partial<ProjectFile>);
    expect(runCheck('alpha-with-bg', p, extra({ alpha: true }))[0]).toMatchObject({ severity: 'info', fix: 'mgl edit <file> comp.set main bg=null' });
    expect(runCheck('alpha-with-bg', p)).toEqual([]);
    expect(runCheck('alpha-with-bg', shortsProject(), extra({ alpha: true }))).toEqual([]);
  });
});

describe('check and look agree; fixes and messages', () => {
  it('music-over-voice and text-cut-off are project-stage (run by check, not only look)', () => {
    const reg = builtinRegistry();
    expect(reg.checks.get('music-over-voice')!.stage).toBe('project');
    expect(reg.checks.get('text-cut-off')!.stage).toBe('project');
  });

  it('checkProject reports music under voice and substitutes the real file name in fixes', async () => {
    const p = shortsProject({
      tracks: [{ id: 'V1', comp: 'main' }, { id: 'A1', comp: 'main', audio: true, bus: 'dialogue' }, { id: 'A2', comp: 'main', audio: true, bus: 'music' }],
      assets: [{ id: 'vo', src: 'lavfi:sine' }, { id: 'bed', src: 'lavfi:sine=f=220' }],
      clips: [{ id: 'bg', track: 'V1', at: 0, len: 300, color: '#123' }, { id: 'vo1', track: 'A1', at: 30, len: 200, asset: 'vo' }, { id: 'bed1', track: 'A2', at: 0, len: 300, asset: 'bed' }],
    } as Partial<ProjectFile>);
    const f = await checkProject(p, { baseDir: tmpdir(), registry: builtinRegistry(), file: 'q3.mgl.json' });
    expect(f.find((x) => x.rule === 'music-over-voice')!.fix).toBe('mgl edit q3.mgl.json audio.duck bus=music by=dialogue db=9');
    expect(f.every((x) => !x.fix?.includes('<file>'))).toBe(true);
  }, 30_000);

  it('withFile / displayName', () => {
    expect(withFile([{ rule: 'r', severity: 'info', message: 'm', fix: 'mgl edit <file> x' }], 'my file.json')[0]!.fix).toBe("mgl edit 'my file.json' x");
    expect(displayName('/a/b/c.mgl.json', '/a')).toBe('b/c.mgl.json');
    expect(displayName('/x/c.mgl.json', '/a')).toBe('/x/c.mgl.json');
  });

  it('black-frames: skipped for audio-only comps; transparent comps get the alpha hint, not a bg fix', () => {
    const audioOnly = shortsProject({ tracks: [{ id: 'A1', comp: 'main', audio: true }], clips: [{ id: 'vo', track: 'A1', at: 0, len: 300, asset: 'bgv' }] } as Partial<ProjectFile>);
    expect(runCheck('black-frames', audioOnly, { frames: new Map([[30, img([0, 0, 0])]]), layers: new Map([[30, []]]) })).toEqual([]);
    const gfx = shortsProject({ clips: [{ id: 'dark', track: 'T1', at: 0, len: 300, color: '#000000' }] } as Partial<ProjectFile>);
    const at30 = { frames: new Map([[30, img([0, 0, 0])]]), layers: layersAt(30, [L('dark', 'solid', [0, 0, 1080, 1920])]) };
    // an --alpha render: transparent on purpose, so the hint is an ignore tag
    const f = runCheck('black-frames', gfx, { ...at30, alpha: true });
    expect(f[0]!.message).toContain('--alpha');
    expect(f[0]!.fix).toBe('mgl edit <file> clip.set dark \'tags=["qa-ignore:black-frames"]\'');
    // not an alpha render: a transparent comp renders black, so the fix is a bg (never a tag that hides it)
    expect(runCheck('black-frames', gfx, at30)[0]!.fix).toBe('mgl edit <file> comp.set main bg=#202020');
  });

  it('text-cut-off: text that moves across the edge (a crawl) is info with no fix; static text is an error', () => {
    const crawl = shortsProject({ clips: [{ id: 'crawl', track: 'T1', at: 0, len: 300, text: 'Long crawl text', x: [[0, 2000], [299, -1000]] }] } as unknown as Partial<ProjectFile>);
    const f = runCheck('text-cut-off', crawl, { layers: layersAt(150, [L('crawl', 'text', [-500, 1700, 2000, 80], 'Long crawl text')]) });
    expect(f[0]).toMatchObject({ severity: 'info' });
    expect(f[0]!.fix).toBeUndefined();
    // a credit roll detected from boxes moving between samples (no keys on the clip itself, e.g. parented)
    const roll = shortsProject({ clips: [{ id: 'roll', track: 'T1', at: 0, len: 300, text: 'Credits' }] } as Partial<ProjectFile>);
    const sampled = new Map([[30, [L('roll', 'text', [200, 1500, 680, 900])]], [150, [L('roll', 'text', [200, 600, 680, 900])]]]);
    expect(runCheck('text-cut-off', roll, extra({ layers: layersAt(30, [L('roll', 'text', [200, 1500, 680, 900])]), sampled }))[0]!.severity).toBe('info');
    expect(runCheck('text-outside-safe', roll, extra({ layers: layersAt(30, [L('roll', 'text', [200, 1500, 680, 900])]), sampled }))).toEqual([]);
  });

  it('safe zone: names every crossed edge and the fix moves only the axes that cross', () => {
    // tiktok: safe x 55..929, y 173..1516
    const p = shortsProject({ project: { platform: 'tiktok' }, clips: [{ id: 'h', track: 'T1', at: 0, len: 60, text: '@handle', x: 900, y: 1560 }] } as Partial<ProjectFile>);
    const ctx = makeContext(p, 'main', undefined, { layers: layersAt(30, [L('h', 'text', [745, 1520, 310, 80], '@handle')]) });
    const f = builtinRegistry().checks.get('text-outside-safe')!.run(ctx) as Finding[];
    expect(f[0]!.message).toContain('crosses the bottom and right of the tiktok-safe area');
    expect(f[0]!.fix).toBe('mgl edit <file> clip.set h x=773 y=1476');
    const only = makeContext(p, 'main', undefined, { layers: layersAt(30, [L('h', 'text', [500, 1520, 310, 80], '@handle')]) });
    const g = builtinRegistry().checks.get('text-outside-safe')!.run(only) as Finding[];
    expect(g[0]!.message).toMatch(/crosses the bottom of/);
    expect(g[0]!.fix).toBe('mgl edit <file> clip.set h y=1476');
  });
});

describe('qa-ignore tags', () => {
  it('tags match the rule id, an alias, or all', () => {
    expect(ignores({ tags: ['qa-ignore:frozen'] }, 'frozen')).toBe(true);
    expect(ignores({ tags: ['qa-ignore:safe-zone'] }, 'text-outside-safe')).toBe(true);
    expect(ignores({ tags: ['qa-ignore:all'] }, 'gaps')).toBe(true);
    expect(ignores({ tags: ['qa-ignore:*'] }, 'gaps')).toBe(true);
    expect(ignores({ tags: ['qa-ignore:frozen'] }, 'gaps')).toBe(false);
    expect(ignores(undefined, 'gaps')).toBe(false);
  });

  it('runStage drops findings of tagged clips, and timeline findings while a tagged clip plays', async () => {
    const p = shortsProject({ clips: [
      { id: 'a', track: 'V1', at: 0, len: 60, color: '#f00', tags: ['qa-ignore:gaps'] },
      { id: 'b', track: 'V1', at: 90, len: 60, color: '#0f0', tags: ['qa-ignore:gaps'] },
      { id: 'cap', track: 'T1', at: 0, len: 90, text: 'Subscribe now', y: 1700, tags: ['qa-ignore:all'] },
    ] } as Partial<ProjectFile>);
    const ctx = makeContext(p, 'main', undefined, { layers: layersAt(45, [L('cap', 'text', [300, 1660, 480, 80], 'Subscribe now')]) });
    const f = await runStage(builtinRegistry(), 'project', ctx);
    expect(f.filter((x) => x.clip === 'cap')).toEqual([]);
    expect(f.filter((x) => x.rule === 'gaps')).toEqual([]);
    // a black-frames finding at a frame where a tagged clip plays
    const g = applyIgnores(shortsProject({ clips: [{ id: 'lead', track: 'V1', at: 0, len: 300, color: '#000', tags: ['qa-ignore:black'] }] } as Partial<ProjectFile>), 'main', [{ rule: 'black-frames', severity: 'warning', frame: 10, message: 'black' }, { rule: 'loudness', severity: 'warning', message: 'loud' }]);
    expect(g.map((x) => x.rule)).toEqual(['loudness']);
  });
});

describe('multi-platform', () => {
  it('mergePlatforms keeps shared findings once and labels the rest', () => {
    const shared: Finding = { rule: 'gaps', severity: 'warning', message: 'gap' };
    const m = mergePlatforms([['tiktok', [shared, { rule: 'text-outside-safe', severity: 'warning', message: 'x crosses tiktok' }]], ['youtube', [shared]]]);
    expect(m).toHaveLength(2);
    expect(m[1]).toMatchObject({ platform: 'tiktok', message: '[tiktok] x crosses tiktok' });
  });

  it('checkProject with platforms reports per platform', async () => {
    const p = shortsProject({ clips: [...shortsProject().clips!, { id: 'h', track: 'T1', at: 0, len: 60, text: '@handle', x: 780, y: 1000 }] } as Partial<ProjectFile>);
    const f = await checkProject(p, { baseDir: tmpdir(), registry: builtinRegistry(), platforms: ['tiktok', 'youtube'] });
    const safe = f.filter((x) => x.rule === 'text-outside-safe');
    expect(safe.map((x) => x.platform)).toEqual(['tiktok']);
  }, 30_000);
});

describe('helpers', () => {
  it('sampleFrames spans every visual clip', () => {
    expect(sampleFrames(shortsProject(), 'main')).toEqual([30, 150, 270]);
  });

  it('estimateLook: a typical project is fast and needs no printed estimate', async () => {
    const e = await estimateLook(shortsProject(), { baseDir: tmpdir(), registry: builtinRegistry() });
    expect(e.slow).toBe(false);
    expect(e.frames).toBe(12);
    expect(e.note).toMatch(/^est\. \d+ s \(look: 12 frames \+ sound analysis of 10 s\)$/);
  });
});

describe('look with fakes: file names, platforms, probed durations', () => {
  it('fixes name the real file; frozen past the source end uses the probed duration; per-platform findings', async () => {
    const { look } = await import('../../src/qa/look.js');
    const dir = mkdtempSync(join(tmpdir(), 'mgl-qa-v2-look-'));
    writeFileSync(join(dir, 'shot.mp4'), 'x');
    const p = shortsProject({
      assets: [{ id: 'shot', src: 'shot.mp4' }],
      clips: [{ id: 'bg', track: 'V1', at: 0, len: 300, asset: 'shot' }, { id: 'h', track: 'T1', at: 0, len: 300, text: '@handle', x: 780 }],
    } as Partial<ProjectFile>);
    const r = await look(p, {
      baseDir: dir, file: join(dir, 'video.mgl.json'), displayFile: 'video.mgl.json', registry: builtinRegistry(), audio: false, platforms: ['tiktok', 'youtube'], frames: [200, 260],
      deps: {
        renderStills: async (_p, o) => o.frames.map((frame) => {
          const s = o.scale ?? 1, w = Math.round(1080 * s), h = Math.round(1920 * s);
          return { frame, image: { width: w, height: h, data: new Uint8Array(w * h * 4).fill(120) }, layers: [{ clipId: 'bg', kind: 'video', box: FULL }] };
        }),
        backend: { renderAudio: async () => {}, analyzeAudio: async () => { throw new Error('unused'); }, probe: async () => ({ duration: 5, width: 1080, height: 1920 }) as never },
      },
    });
    const frozen = r.findings.find((f) => f.rule === 'frozen')!;
    expect(frozen.fix).toBe('mgl edit video.mgl.json clip.trim bg end=150');
    expect(r.findings.find((f) => f.rule === 'clip-past-source')!.fix).toBe('mgl edit video.mgl.json clip.trim bg end=150');
    expect(r.findings.every((f) => !f.fix?.includes('<file>'))).toBe(true);
    expect(r.findings.filter((f) => f.rule === 'text-outside-safe').map((f) => f.platform)).toEqual(['tiktok']);
  }, 30_000);
});
