// @vitest-environment node
/** Regression tests for the third QA review: checks that misfired on layouts, alpha media, slates, dark footage and credits. */
import { describe, expect, it } from 'vitest';
import type { ProjectFile } from '../../src/core/schema/index.js';
import type { CheckContext, Finding } from '../../src/plugin/api.js';
import { applyIgnores, qaExtras } from '../../src/qa/check.js';
import { layersAt, runCheck, shortsProject } from './qa-fixtures.js';

type B = [number, number, number, number];
const L = (clipId: string, kind: string, box: B, text?: string) => ({ clipId, kind, box, ...(text ? { text } : {}) });
const extra = (o: Record<string, unknown>) => o as Partial<CheckContext>;

/** A W×H frame at `scale`, filled with rgb, with optional rects (comp px). */
function img(rgb: [number, number, number], rects: { box: B; rgb: [number, number, number] }[] = [], W = 1080, H = 1920, scale = 0.1) {
  const width = Math.round(W * scale), height = Math.round(H * scale), data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const r = rects.find(({ box: b }) => x >= b[0] * scale && x < (b[0] + b[2]) * scale && y >= b[1] * scale && y < (b[1] + b[3]) * scale);
    data.set([...(r?.rgb ?? rgb), 255], (y * width + x) * 4);
  }
  return { width, height, data, scale };
}

/** The recipes' 640x360 landscape project. */
function landscape(clips: unknown[], extraP: Record<string, unknown> = {}): ProjectFile {
  return {
    michelangelo: 1, project: { platform: 'youtube' },
    assets: [{ id: 'cama', src: 'media/camA.mp4' }, { id: 'camb', src: 'media/camB.mp4' }, { id: 'ovl', src: 'media/ovl.mov' }, { id: 'wbm', src: 'media/a.webm' }],
    comps: [{ id: 'main', size: [640, 360], fps: 30, bg: '#000000' }],
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'T1', comp: 'main' }, { id: 'V2', comp: 'main' }, { id: 'V3', comp: 'main' }, { id: 'WM', comp: 'main' }],
    clips, ...extraP,
  } as unknown as ProjectFile;
}

describe('media-off-frame: masked layers (layout.grid split screens)', () => {
  const mask = [{ shape: 'rect', box: [0.25313, 0, 0.49375, 1], space: 'clip' }];
  const split = landscape([
    { id: 'left', track: 'V1', at: 0, len: 180, asset: 'cama', x: 158, y: 180, masks: mask },
    { id: 'right', track: 'V2', at: 0, len: 180, asset: 'camb', x: 482, y: 180, masks: mask },
  ]);
  // each 640x360 source sits centred in its 316 px cell, so its box runs 25% off one side; the mask crops it to the cell
  const at90 = new Map([[90, [L('left', 'video', [-162, 0, 640, 360]), L('right', 'video', [162, 0, 640, 360])]]]);

  it('a layout.grid split screen is not off the frame: the crop mask is what shows', () => {
    expect(runCheck('media-off-frame', split, extra({ sampled: at90 }))).toEqual([]);
  });

  it('a masked layer whose visible area does run off: reported with no move/scale fix (it would undo the layout)', () => {
    const off = landscape([{ id: 'left', track: 'V1', at: 0, len: 180, asset: 'cama', x: -100, y: 180, masks: [{ shape: 'rect', box: [0, 0, 1, 1], space: 'clip' }] }]);
    const f = runCheck('media-off-frame', off, extra({ sampled: new Map([[90, [L('left', 'video', [-420, 0, 640, 360])]]]) }));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: 'warning', clip: 'left' });
    expect(f[0]!.fix).toBeUndefined();
    // a path mask (region unknown): info, no fix
    const path = landscape([{ id: 'left', track: 'V1', at: 0, len: 180, asset: 'cama', x: -100, y: 180, masks: [{ shape: 'path', d: 'M0 0 L10 10 Z' }] }]);
    const g = runCheck('media-off-frame', path, extra({ sampled: new Map([[90, [L('left', 'video', [-420, 0, 640, 360])]]]) }));
    expect(g[0]).toMatchObject({ severity: 'info' });
    expect(g[0]!.fix).toBeUndefined();
  });

  it('an unmasked layer off the frame still gets the move fix', () => {
    const p = landscape([{ id: 'left', track: 'V1', at: 0, len: 180, asset: 'cama', x: -100, y: 180, scale: 0.5 }]);
    const f = runCheck('media-off-frame', p, extra({ sampled: new Map([[90, [L('left', 'video', [-260, 90, 320, 180])]]]) }));
    expect(f[0]!.fix).toMatch(/clip\.set left x=/);
  });
});

describe('trailing-black: shapes, text and gens are content', () => {
  it('a coloured logo shape after the text ends is content, not black', () => {
    const p = shortsProject({
      comps: [{ id: 'main', size: [320, 320], fps: 30, bg: '#203040' }],
      tracks: [{ id: 'V1', comp: 'main' }, { id: 'T1', comp: 'main' }],
      clips: [
        { id: 'logo', track: 'V1', at: 0, len: 120, shape: { type: 'ellipse', size: [100, 100], fill: '#ffd400' } },
        { id: 't', track: 'T1', at: 0, len: 60, text: 'Brand' },
      ],
    } as Partial<ProjectFile>);
    expect(runCheck('trailing-black', p)).toEqual([]);
  });

  it('a gen after the last shot is content; a black matte bar is not', () => {
    const p = shortsProject({
      comps: [{ id: 'main', size: [1080, 1920], fps: 30 }],
      tracks: [{ id: 'V1', comp: 'main' }, { id: 'M', comp: 'main' }],
      clips: [
        { id: 'shot', track: 'V1', at: 0, len: 90, asset: 'bgv' },
        { id: 'tc', track: 'M', at: 0, len: 180, gen: { type: 'timecode' } },
      ],
    } as Partial<ProjectFile>);
    expect(runCheck('trailing-black', p)).toEqual([]);
    const matte = shortsProject({
      comps: [{ id: 'main', size: [1080, 1920], fps: 30 }],
      tracks: [{ id: 'V1', comp: 'main' }, { id: 'M', comp: 'main' }],
      clips: [
        { id: 'shot', track: 'V1', at: 0, len: 90, asset: 'bgv' },
        { id: 'bar', track: 'M', at: 0, len: 180, shape: { type: 'rect', size: [1080, 200], fill: '#000000' } },
      ],
    } as Partial<ProjectFile>);
    expect(runCheck('trailing-black', matte)).toHaveLength(1);
  });
});

describe('alpha video overlays are not opaque', () => {
  const text = { id: 't', track: 'V1', at: 0, len: 90, text: 'Hello there' };
  const layers = new Map([[45, [L('t', 'text', [200, 150, 240, 60], 'Hello there'), L('o', 'video', [0, 0, 640, 360])]]]);

  it('a ProRes 4444 .mov (alpha unknown without a probe, or probed yuva444p12le) does not hide the text under it', () => {
    const p = landscape([text, { id: 'o', track: 'T1', at: 0, len: 90, asset: 'ovl' }]);
    expect(runCheck('layer-hidden', p, extra({ sampled: layers }))).toEqual([]);
    expect(runCheck('caption-overlap', p, { layers }).filter((f) => f.message.includes('hidden under'))).toEqual([]);
    const facts = new Map([['ovl', { alpha: true }]]);
    expect(runCheck('layer-hidden', p, extra({ sampled: layers, ...qaExtras(facts, false, undefined, true) }))).toEqual([]);
  });

  it('a VP9 alpha .webm and a .png overlay too; an .mp4 (or a .mov probed without alpha) still hides it', () => {
    expect(runCheck('layer-hidden', landscape([text, { id: 'o', track: 'T1', at: 0, len: 90, asset: 'wbm' }]), extra({ sampled: layers }))).toEqual([]);
    const mp4 = landscape([text, { id: 'o', track: 'T1', at: 0, len: 90, asset: 'cama' }]);
    expect(runCheck('layer-hidden', mp4, extra({ sampled: layers }))).toHaveLength(1);
    const mov = landscape([text, { id: 'o', track: 'T1', at: 0, len: 90, asset: 'ovl' }]);
    const facts = new Map([['ovl', { alpha: false }]]);
    expect(runCheck('layer-hidden', mov, extra({ sampled: layers, ...qaExtras(facts, false, undefined, true) }))).toHaveLength(1);
  });
});

describe('gaps: coverage from upper tracks', () => {
  it('a slate on an upper track over the head of the programme is not a gap, and no fix moves programme under it', () => {
    const p = landscape([
      { id: 'prog', track: 'V1', at: 90, len: 180, asset: 'cama' },
      { id: 'slate-bg', track: 'T1', at: 0, len: 90, color: '#111111' },
      { id: 'slate-title', track: 'V3', at: 0, len: 90, text: 'Launch film' },
    ]);
    expect(runCheck('gaps', p)).toEqual([]);
  });

  it('a gap only partly covered by an opaque plate: info with no move fix', () => {
    const p = landscape([
      { id: 'prog', track: 'V1', at: 90, len: 180, asset: 'cama' },
      { id: 'plate', track: 'T1', at: 0, len: 45, color: '#111111' },
    ]);
    const f = runCheck('gaps', p);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: 'info', clip: 'prog' });
    expect(f[0]!.fix).toBeUndefined();
  });

  it('a real gap with nothing over it keeps its move fix', () => {
    const p = landscape([{ id: 'a', track: 'V1', at: 0, len: 30, asset: 'cama' }, { id: 'prog', track: 'V1', at: 90, len: 90, asset: 'cama' }]);
    expect(runCheck('gaps', p)[0]).toMatchObject({ severity: 'warning', fix: 'mgl edit <file> clip.move prog at=30' });
  });
});

describe('gaps: the main video ends before its overlays (auto length)', () => {
  const p = (shotLen: number) => shortsProject({
    comps: [{ id: 'main', size: [1080, 1920], fps: 30 }],
    assets: [{ id: 'clip', src: 'media/clip.mp4' }],
    clips: [
      { id: 'shot', track: 'V1', at: 0, len: shotLen, asset: 'clip' },
      { id: 'captions', track: 'T1', at: 75, len: 90, text: 'Put your phone away' },
    ],
  } as Partial<ProjectFile>);

  it('is a warning; the fix extends the shot when its source has room', () => {
    const f = runCheck('gaps', p(90), extra({ sourceDuration: () => 6 }));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: 'warning', clip: 'shot', frame: 90, fix: 'mgl edit <file> clip.trim shot end=165' });
  });

  it('trims the overlays to the picture when the source has no room (or its length is unknown)', () => {
    expect(runCheck('gaps', p(90), extra({ sourceDuration: () => 3 }))[0]!.fix).toBe('mgl edit <file> clip.trim captions end=90');
    expect(runCheck('gaps', p(90))[0]!.fix).toBe('mgl edit <file> clip.trim captions end=90');
  });

  it('nothing when the shot runs as long as the overlays', () => {
    expect(runCheck('gaps', p(165))).toEqual([]);
  });
});

describe('black-frames: dark footage, credits and slips', () => {
  const p = landscape([{ id: 'v', track: 'V1', at: 0, len: 120, asset: 'cama' }]);
  const vl = new Map([[30, [L('v', 'video', [0, 0, 640, 360])]], [60, [L('v', 'video', [0, 0, 640, 360])]]]);

  it('dark footage with visible detail (a night shot with grey text) is not black', () => {
    // mean luma about 0.02 (under the old 0.03 cut), but the grey text is detail
    const night = img([4, 4, 4], [{ box: [260, 170, 120, 20], rgb: [150, 150, 150] }], 640, 360);
    expect(runCheck('black-frames', p, { frames: new Map([[30, night], [60, night]]), layers: vl })).toEqual([]);
  });

  it('a truly black frame of the whole clip: never a slip (it would run past the source), an info', () => {
    const black = img([0, 0, 0], [], 640, 360);
    const f = runCheck('black-frames', p, extra({ frames: new Map([[30, black], [60, black]]), layers: vl, sourceDuration: () => 4 }));
    expect(f[0]).toMatchObject({ severity: 'info', clip: 'v' });
    expect(f[0]!.fix).not.toMatch(/clip\.slip/);
  });

  it('white credits rolling over a black bg are not black frames (in the frame or rolling in from outside it)', () => {
    const credits = landscape([{ id: 'roll', track: 'T1', at: 0, len: 180, text: 'DIRECTED BY\nAda', y: [[0, 520], [179, -160]] }]);
    const onScreen = img([0, 0, 0], [{ box: [250, 100, 140, 20], rgb: [255, 255, 255] }], 640, 360);
    const rolling = { frames: new Map([[7, img([0, 0, 0], [], 640, 360)], [90, onScreen]]),
      layers: new Map([[7, [L('roll', 'text', [200, 440, 240, 160], 'DIRECTED BY')]], [90, [L('roll', 'text', [200, 100, 240, 160], 'DIRECTED BY')]]]) };
    expect(runCheck('black-frames', credits, rolling)).toEqual([]);
  });
});

describe('qa-ignore tags and project-scoped findings', () => {
  const p = shortsProject({ clips: [...shortsProject().clips!, { id: 'cr', track: 'T1', at: 0, len: 30, text: 'credits', tags: ['qa-ignore:all'] }] } as Partial<ProjectFile>);
  const audio: Finding[] = [
    { rule: 'clipping', severity: 'error', message: 'mix true peak 0.0 dBTP' },
    { rule: 'loudness', severity: 'warning', message: 'mix is -0.7 LUFS' },
    { rule: 'long-silence', severity: 'warning', frame: 10, message: 'silence' },
  ];

  it('qa-ignore:all on one clip silences that clip, never the whole mix', () => {
    expect(applyIgnores(p, 'main', audio).map((f) => f.rule)).toEqual(['clipping', 'loudness', 'long-silence']);
    expect(applyIgnores(p, 'main', [{ rule: 'tiny-text', severity: 'warning', clip: 'cr', message: 'x' }])).toEqual([]);
  });

  it('a tag naming the rule (or an alias) still opts out', () => {
    const q = shortsProject({ clips: [...shortsProject().clips!, { id: 'cr', track: 'T1', at: 0, len: 30, text: 'credits', tags: ['qa-ignore:loudness', 'qa-ignore:silence'] }] } as Partial<ProjectFile>);
    expect(applyIgnores(q, 'main', audio).map((f) => f.rule)).toEqual(['clipping']);
  });
});

describe('luma-range judges the media pixels its fix changes', () => {
  const p = landscape([{ id: 'v', track: 'V1', at: 0, len: 90, asset: 'cama' }, { id: 't', track: 'T1', at: 0, len: 90, text: 'BIG TITLE' }]);
  const titled = img([128, 128, 128], [{ box: [100, 120, 440, 120], rgb: [255, 255, 255] }], 640, 360);
  const layers = new Map([[45, [L('v', 'video', [0, 0, 640, 360]), L('t', 'text', [100, 120, 440, 120], 'BIG TITLE')]]]);

  it('white title pixels over grey video are not counted against the video', () => {
    expect(runCheck('luma-range', p, { frames: new Map([[45, titled]]), layers })).toEqual([]);
  });

  it('out-of-range video pixels are; once the clip has legalize the finding clears', () => {
    const hot = img([250, 250, 250], [], 640, 360);
    const f = runCheck('luma-range', p, { frames: new Map([[45, hot]]), layers });
    expect(f[0]).toMatchObject({ clip: 'v', fix: 'mgl edit <file> fx.add v type=legalize range=pc' });
    const legal = landscape([{ id: 'v', track: 'V1', at: 0, len: 90, asset: 'cama', fx: [{ type: 'legalize', range: 'pc' }] }]);
    expect(runCheck('luma-range', legal, { frames: new Map([[45, hot]]), layers })).toEqual([]);
  });
});

describe('caption-overlap: translucent watermarks', () => {
  const slate = (wm: Record<string, unknown>) => landscape([
    { id: 'slate-details', track: 'V3', at: 0, len: 90, text: 'Version: v3', x: 67, y: 222 },
    { id: 'wm', track: 'WM', at: 0, len: 270, text: 'CONFIDENTIAL · DRAFT v3', rotate: -20, ...wm },
  ]);
  const layers = layersAt(45, [L('slate-details', 'text', [67, 211, 507, 22], 'Version: v3'), L('wm', 'text', [120, 120, 400, 140], 'CONFIDENTIAL')]);

  it('a watermark at opacity 0.35 or tagged role:watermark does not count as an overlap', () => {
    expect(runCheck('caption-overlap', slate({ opacity: 0.35 }), { layers })).toEqual([]);
    expect(runCheck('caption-overlap', slate({ tags: ['role:watermark'] }), { layers })).toEqual([]);
    expect(runCheck('caption-overlap', slate({}), { layers })).toHaveLength(1);
  });

  it('a move fix never lands the text in another overlap at another sampled frame', () => {
    const p = landscape([
      { id: 'a', track: 'V1', at: 0, len: 90, text: 'Label A', y: 200 },
      { id: 'b', track: 'V2', at: 0, len: 90, text: 'Label B', y: 200 },
      { id: 'c', track: 'V3', at: 60, len: 30, text: 'Later', y: 160 },
    ]);
    const now = [L('a', 'text', [200, 185, 200, 30], 'Label A'), L('b', 'text', [220, 190, 200, 30], 'Label B')];
    // at frame 75 "c" sits just above where "a" would move to
    const later = [...now, L('c', 'text', [150, 145, 340, 30], 'Later')];
    const f = runCheck('caption-overlap', p, extra({ layers: layersAt(30, now), sampled: new Map([[30, now], [75, later]]) }));
    const ab = f.find((x) => x.message.includes('"b"'))!;
    expect(ab.fix ?? '').not.toMatch(/clip\.set a y=1[3-7]\d/);
  });
});
