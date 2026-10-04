import { describe, expect, it } from 'vitest';
import type { ProjectFile } from '../../src/core/schema/index.js';
import type { AudioAnalysisReport } from '../../src/media/types.js';
import { layersAt, runCheck, shortsProject } from './qa-fixtures.js';

const bgLayer = { clipId: 'bg', kind: 'video', box: [0, 0, 1080, 1920] as [number, number, number, number] };

describe('project stage', () => {
  it('gaps: finds a black gap on the main track and the black tail; none when contiguous', () => {
    const p = shortsProject({ clips: [
      { id: 'a', track: 'V1', at: 0, len: 60, color: '#ff0000' },
      { id: 'b', track: 'V1', at: 90, len: 60, color: '#00ff00' },
      { id: 't', track: 'T1', at: 0, len: 300, text: 'hi' },
    ] } as Partial<ProjectFile>);
    const f = runCheck('gaps', p);
    expect(f).toHaveLength(2);
    expect(f[0]).toMatchObject({ rule: 'gaps', clip: 'b', frame: 60, fix: 'mgl edit <file> clip.move b at=60' });
    expect(f[0]!.message).toContain('2.00s–3.00s');
    expect(f[1]!.fix).toBe('mgl edit <file> comp.set main length=auto');
    expect(runCheck('gaps', shortsProject())).toEqual([]);
  });

  it('text-outside-safe: a caption in the shorts bottom bar is flagged with a move fix; a centred title is not', () => {
    const p = shortsProject({ clips: [...shortsProject().clips!, { id: 'cap', track: 'T1', at: 0, len: 90, text: 'Subscribe now', y: 1700 }] } as Partial<ProjectFile>);
    const low = runCheck('text-outside-safe', p, { layers: layersAt(45, [bgLayer, { clipId: 'cap', kind: 'text', box: [300, 1660, 480, 80], text: 'Subscribe now' }]) });
    expect(low).toHaveLength(1);
    expect(low[0]).toMatchObject({ clip: 'cap', frame: 45, box: [300, 1660, 480, 80] });
    expect(low[0]!.message).toMatch(/cap.*bottom.*shorts-safe.*1\.50s/);
    // bottom of safe area = 1536 → move up by 204 → y = 1700 - 204
    expect(low[0]!.fix).toBe('mgl edit <file> clip.set cap y=1496');
    const ok = runCheck('text-outside-safe', p, { layers: layersAt(45, [{ clipId: 'cap', kind: 'text', box: [300, 900, 480, 80] }]) });
    expect(ok).toEqual([]);
  });

  it('text-outside-safe: too wide → maxWidth', () => {
    const f = runCheck('text-outside-safe', shortsProject(), { layers: layersAt(0, [{ clipId: 't', kind: 'captions', box: [20, 900, 1040, 80] }]) });
    expect(f[0]!.fix).toBe('mgl edit <file> clip.set t style.maxWidth=896');
  });

  it('tiny-text: under 2.5% of the frame height (48 px at 1920)', () => {
    const p = shortsProject();
    const small = runCheck('tiny-text', p, { layers: layersAt(10, [{ clipId: 't', kind: 'text', box: [400, 900, 200, 40], text: 'fine print', fontPx: 30 }]) });
    expect(small).toHaveLength(1);
    expect(small[0]!.message).toContain('30px');
    expect(small[0]!.fix).toBe('mgl edit <file> clip.set t style.size=58');
    expect(runCheck('tiny-text', p, { layers: layersAt(10, [{ clipId: 't', kind: 'text', box: [400, 900, 200, 80], fontPx: 72 }]) })).toEqual([]);
  });

  it('caption-overlap: caption box over a logo; background video and disjoint boxes are fine', () => {
    const p = shortsProject({ clips: [...shortsProject().clips!, { id: 'logo', track: 'T1', at: 0, len: 300, asset: 'bgv', y: 1300 }] } as Partial<ProjectFile>);
    const cap = { clipId: 'subs', kind: 'captions', box: [200, 1250, 680, 120] as [number, number, number, number], text: 'hello there' };
    const logo = { clipId: 'logo', kind: 'image', box: [440, 1200, 200, 200] as [number, number, number, number] };
    const f = runCheck('caption-overlap', p, { layers: layersAt(60, [bgLayer, logo, cap]) });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ clip: 'subs', frame: 60, box: [440, 1250, 200, 120] });
    expect(f[0]!.message).toContain('"logo"');
    expect(f[0]!.fix).toMatch(/^mgl edit <file> clip\.set logo y=\d+$/);
    expect(runCheck('caption-overlap', p, { layers: layersAt(60, [bgLayer, { ...logo, box: [440, 200, 200, 200] }, cap]) })).toEqual([]);
  });

  it('clip-past-end: trims to the comp end, or asks for length=auto when it starts after', () => {
    const p = shortsProject({ clips: [{ id: 'bg', track: 'V1', at: 0, len: 330, color: '#000' }, { id: 'late', track: 'T1', at: 310, len: 10, text: 'x' }] } as Partial<ProjectFile>);
    const f = runCheck('clip-past-end', p);
    expect(f.map((x) => x.fix)).toEqual(['mgl edit <file> clip.trim bg end=300', 'mgl edit <file> comp.set main length=auto']);
    expect(runCheck('clip-past-end', shortsProject())).toEqual([]);
    expect(runCheck('clip-past-end', shortsProject({ comps: [{ id: 'main', size: [1080, 1920], fps: 30, length: 'auto' }] } as Partial<ProjectFile>))).toEqual([]);
  });

  it('keyframes-outside: keys after the clip end', () => {
    const p = shortsProject({ clips: [{ id: 'bg', track: 'V1', at: 0, len: 60, color: '#000', opacity: [[0, 0], [30, 1], [90, 0]] }] } as unknown as Partial<ProjectFile>);
    const f = runCheck('keyframes-outside', p);
    expect(f).toHaveLength(1);
    expect(f[0]!.fix).toBe('mgl edit <file> key.remove bg prop=opacity at=90');
    const ok = shortsProject({ clips: [{ id: 'bg', track: 'V1', at: 0, len: 60, color: '#000', opacity: [[0, 0], [60, 1]], scale: [1, 1] }] } as unknown as Partial<ProjectFile>);
    expect(runCheck('keyframes-outside', ok)).toEqual([]);
  });
});

/** A frame image at `scale` of 1080x1920, filled with rgb, with optional rects. */
function img(rgb: [number, number, number], scale = 0.1, rects: { box: [number, number, number, number]; rgb: [number, number, number] }[] = []) {
  const width = Math.round(1080 * scale), height = Math.round(1920 * scale), data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const r = rects.find(({ box: b }) => x >= b[0] * scale && x < (b[0] + b[2]) * scale && y >= b[1] * scale && y < (b[1] + b[3]) * scale);
    data.set([...(r?.rgb ?? rgb), 255], (y * width + x) * 4);
  }
  return { width, height, data, scale };
}

describe('frame stage', () => {
  it('black-frames: a black sampled frame in a video clip; bright frames pass; fades are intentional', () => {
    const p = shortsProject();
    const frames = new Map([[30, img([0, 0, 0])], [60, img([0, 0, 0])], [90, img([120, 120, 120])]]);
    const layers = new Map([[30, [bgLayer]], [60, [bgLayer]], [90, [bgLayer]]]);
    const f = runCheck('black-frames', p, { frames, layers });
    expect(f).toHaveLength(1);
    // no known source length: a slip could run past the source, so an info with an ignore tag
    expect(f[0]).toMatchObject({ severity: 'info', clip: 'bg', frame: 30, fix: 'mgl edit <file> clip.set bg \'tags=["qa-ignore:black-frames"]\'' });
    expect(f[0]!.message).toContain('1.00s–2.00s');
    // a probed source with a handle: slip past the dark run at the head of the clip (frames 30-60 → by 90)
    const g = runCheck('black-frames', p, { frames, layers, sourceDuration: () => 20 });
    expect(g[0]).toMatchObject({ severity: 'warning', clip: 'bg', fix: 'mgl edit <file> clip.slip bg by=90' });
    // a source with no handle (10 s source, 10 s clip): no slip
    expect(runCheck('black-frames', p, { frames, layers, sourceDuration: () => 10 })[0]).toMatchObject({ severity: 'info' });
    const faded = shortsProject({ clips: [{ id: 'bg', track: 'V1', at: 0, len: 300, asset: 'bgv', fade: [45, 0] }] } as Partial<ProjectFile>);
    expect(runCheck('black-frames', faded, { frames: new Map([[30, img([0, 0, 0])]]), layers })).toEqual([]);
  });

  it('frozen: identical frames of the same video clip; moving frames pass', () => {
    const p = shortsProject();
    const layers = new Map([[30, [bgLayer]], [60, [bgLayer]]]);
    const f = runCheck('frozen', p, { frames: new Map([[30, img([50, 80, 90])], [60, img([50, 80, 90])]]), layers });
    expect(f).toHaveLength(1);
    // no known source end: info, and never a (ripple) trim
    expect(f[0]).toMatchObject({ severity: 'info', clip: 'bg' });
    expect(f[0]!.fix).toBeUndefined();
    expect(runCheck('frozen', p, { frames: new Map([[30, img([50, 80, 90])], [60, img([150, 80, 90])]]), layers })).toEqual([]);
  });

  it('overlap-alpha: caption over the opaque logo pixels vs over empty background', () => {
    const p = shortsProject({ comps: [{ id: 'main', size: [1080, 1920], fps: 30, length: 300, bg: '#000000' }], clips: [] } as Partial<ProjectFile>);
    const cap = { clipId: 'subs', kind: 'captions', box: [200, 1250, 680, 120] as [number, number, number, number] };
    const logo = { clipId: 'logo', kind: 'image', box: [440, 1200, 200, 200] as [number, number, number, number] };
    const layers = new Map([[60, [logo, cap]]]);
    const over = runCheck('overlap-alpha', p, { layers, frames: new Map([[60, img([0, 0, 0], 0.25, [{ box: logo.box, rgb: [255, 0, 0] }])]]) });
    expect(over).toHaveLength(1);
    expect(over[0]!.rule).toBe('overlap-alpha');
    // logo box is mostly transparent (only a corner is drawn): no finding
    const sparse = runCheck('overlap-alpha', p, { layers, frames: new Map([[60, img([0, 0, 0], 0.25, [{ box: [440, 1200, 40, 40], rgb: [255, 0, 0] }])]]) });
    expect(sparse).toEqual([]);
  });

  it('text-cut-off: text box crossing the frame edge', () => {
    const p = shortsProject({ clips: [{ id: 't', track: 'T1', at: 0, len: 60, text: 'WIDE', x: 1000 }] } as Partial<ProjectFile>);
    const f = runCheck('text-cut-off', p, { layers: layersAt(0, [{ clipId: 't', kind: 'text', box: [800, 900, 400, 100] }]) });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: 'error', box: [800, 900, 280, 100], fix: 'mgl edit <file> clip.set t x=880' });
    expect(runCheck('text-cut-off', p, { layers: layersAt(0, [{ clipId: 't', kind: 'text', box: [600, 900, 400, 100] }]) })).toEqual([]);
  });
});

const report = (o: Partial<AudioAnalysisReport> & { integrated?: number; truePeak?: number }): AudioAnalysisReport => ({
  duration: 10, silences: [], beats: [], rms: [], ...o, loudness: { integrated: o.integrated ?? -14, truePeak: o.truePeak ?? -2, lra: 5 },
});

describe('audio stage', () => {
  const p = shortsProject({
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'A1', comp: 'main', audio: true, bus: 'dialogue' }, { id: 'A2', comp: 'main', audio: true, bus: 'music' }],
    assets: [{ id: 'vo', src: 'vo.wav' }, { id: 'bed', src: 'bed.mp3' }],
    clips: [{ id: 'bg', track: 'V1', at: 0, len: 300, color: '#123' }, { id: 'vo1', track: 'A1', at: 30, len: 200, asset: 'vo' }, { id: 'bed1', track: 'A2', at: 0, len: 300, asset: 'bed' }],
  } as Partial<ProjectFile>);

  it('clipping above -1 dBTP', () => {
    expect(runCheck('clipping', p, { audio: report({ truePeak: -0.3 }) })[0]!.fix).toBe('mgl edit <file> audio.normalize peak=-1');
    expect(runCheck('clipping', p, { audio: report({ truePeak: -1.5 }) })).toEqual([]);
  });

  it('loudness off the platform target (-14) or the master bus target', () => {
    const f = runCheck('loudness', p, { audio: report({ integrated: -20 }) });
    expect(f[0]!.message).toContain('6.0 LU under');
    expect(f[0]!.fix).toBe('mgl edit <file> audio.normalize lufs=-14');
    expect(runCheck('loudness', p, { audio: report({ integrated: -15.5 }) })).toEqual([]);
    const withTarget = { ...p, buses: [{ id: 'master', loudness: { lufs: -23 } }] } as ProjectFile;
    expect(runCheck('loudness', withTarget, { audio: report({ integrated: -15.5 }) })[0]!.fix).toBe('mgl edit <file> audio.normalize lufs=-23');
  });

  it('music-over-voice without ducking; none once ducked', () => {
    const f = runCheck('music-over-voice', p, { audio: report({}) });
    expect(f[0]).toMatchObject({ clip: 'bed1', frame: 30, fix: 'mgl edit <file> audio.duck bus=music by=dialogue db=9' });
    const ducked = { ...p, buses: [{ id: 'music', duck: { by: 'dialogue', db: 9 } }] } as ProjectFile;
    expect(runCheck('music-over-voice', ducked, { audio: report({}) })).toEqual([]);
  });

  it('long-silence inside the content only', () => {
    const f = runCheck('long-silence', p, { audio: report({ silences: [{ start: 0, end: 1 }, { start: 3, end: 6 }, { start: 9.5, end: 10 }] }) });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ frame: 90, clip: 'vo1', fix: 'mgl edit <file> audio.cut-silences vo1 min=2s' });
  });
});
