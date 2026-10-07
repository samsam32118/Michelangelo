/** The storyboard's images, page and its place in `look` / render (fake stills: no ffmpeg, no browser). */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadImage } from '@napi-rs/canvas';
import type { ProjectFile } from '../../src/core/schema/index.js';
import { builtinRegistry } from '../../src/builtin/index.js';
import { registerFonts } from '../../src/render/text.js';
import { assignFindings, buildStoryboard, readPrevious, writeSnapshot } from '../../src/qa/storyboard.js';
import { drawScene, drawStoryboard, ROW_MAX, SHEET_MAX, storyLayout } from '../../src/qa/storyboard-draw.js';
import { pageData, storyboardPage } from '../../src/qa/storyboard-page.js';
import { look, lookDir, momentFrames, soloProject, writeStoryboard } from '../../src/qa/look.js';
import { formatLook } from '../../src/qa/format.js';

registerFonts();

/** 14 s at 30 fps: hook title, two backgrounds, captions with three sentences, music, and an idea scene at the end. */
function story(): ProjectFile {
  return {
    michelangelo: 1,
    project: { platform: 'shorts' },
    comps: [{ id: 'main', size: [1080, 1920], fps: 30, length: 420, bg: '#101010' }],
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'T1', comp: 'main' }, { id: 'C1', comp: 'main' }, { id: 'A2', comp: 'main', audio: true, bus: 'music' }],
    assets: [{ id: 'mus', src: 'lavfi:sine' }],
    clips: [
      { id: 'bg1', track: 'V1', at: 0, len: 150, color: '#336699' },
      { id: 'bg2', track: 'V1', at: 150, len: 180, color: '#996633' },
      { id: 'hook', track: 'T1', at: 0, len: 60, text: 'Three tips </script><script>alert(1)</script>' },
      { id: 'caps', track: 'C1', at: 60, len: 270, captions: true },
      { id: 'bed', track: 'A2', at: 0, len: 330, asset: 'mus', gain: -9 },
    ],
    cues: [
      { id: 'q1', clip: 'caps', at: 0, len: 90, text: 'Put your phone away.' },
      { id: 'q3', clip: 'caps', at: 90, len: 90, text: 'Work in 25-minute blocks!' },
      { id: 'q5', clip: 'caps', at: 180, len: 90, text: 'Follow for more' },
    ],
    markers: [{ id: 'timer', comp: 'main', at: 330, len: 90, scene: true, note: 'show a timer counting down' }],
  } as unknown as ProjectFile;
}

/** RGBA frames of one colour per frame (no renderer); records each call. */
function fakeStills(calls: { frames: number[]; scale?: number; hidden: string[]; bg?: string }[] = []) {
  return async (p: ProjectFile, o: { frames: number[]; scale?: number }) => {
    calls.push({ frames: o.frames, ...(o.scale !== undefined ? { scale: o.scale } : {}), hidden: (p.clips ?? []).filter((c) => c.hidden).map((c) => c.id), ...(p.comps[0]!.bg ? { bg: p.comps[0]!.bg } : {}) });
    const s = o.scale ?? 1, w = Math.max(2, Math.round(1080 * s)), h = Math.max(2, Math.round(1920 * s));
    return o.frames.map((frame) => {
      const data = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) data.set([40 + (frame % 200), 120, 200, 255], i * 4);
      return { frame, image: { width: w, height: h, data }, layers: [] };
    });
  };
}

const px = (cv: { getContext(t: '2d'): { getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } } }, x: number, y: number) => [...cv.getContext('2d').getImageData(x, y, 1, 1).data.slice(0, 3)];

describe('storyboard layout and drawing', () => {
  it('keeps the long edge ≤ 1568, ≤ 12 tiles a row and tiles ≤ 640 px tall; a few scenes read as one row', () => {
    for (const [W, H] of [[1080, 1920], [1920, 1080], [1080, 1080], [3840, 2160]] as const) {
      for (let n = 1; n <= 24; n++) {
        const l = storyLayout(n, W, H);
        expect(Math.max(l.width, l.height)).toBeLessThanOrEqual(SHEET_MAX);
        expect(l.cols).toBeLessThanOrEqual(ROW_MAX);
        expect(l.cols * l.rows).toBeGreaterThanOrEqual(n);
        expect(l.tileH).toBeLessThanOrEqual(640);
      }
    }
    expect(storyLayout(6, 1080, 1920).rows).toBe(1);
    expect(storyLayout(24, 1080, 1920).rows).toBeGreaterThanOrEqual(2);
  });

  it('draws tiles, an idea as a note card, an issue frame and the lane strip, at the layout size', () => {
    const sb = buildStoryboard(story(), 'main');
    expect(sb.scenes.map((s) => s.idea)).toEqual([false, false, false, false, true]);
    assignFindings(sb, [{ rule: 'x', severity: 'warning', message: 'caption under the buttons', frame: 200 }]);
    const tiles = new Map(sb.scenes.filter((s) => !s.idea).map((s) => [s.n, { width: 54, height: 96, data: new Uint8Array(54 * 96 * 4).fill(255) }]));
    const { canvas, layout } = drawStoryboard(sb, tiles);
    expect([canvas.width, canvas.height]).toEqual([layout.width, layout.height]);
    expect(Math.max(canvas.width, canvas.height)).toBeLessThanOrEqual(SHEET_MAX);
    expect(layout.rows).toBe(1);
    const x0 = Math.floor((layout.width - (layout.cols * layout.tileW + 6 * (layout.cols - 1))) / 2), tileX = (i: number) => x0 + i * (layout.tileW + 6);
    expect(px(canvas, tileX(0) + layout.tileW / 2, 6 + layout.tileH / 2)).toEqual([255, 255, 255]); // the frame
    expect(px(canvas, tileX(4) + layout.tileW / 2, 6 + layout.tileH - 8)).toEqual([0x2b, 0x2a, 0x1f]); // the note card
    const issue = sb.scenes.findIndex((s) => s.findings.length);
    expect(px(canvas, tileX(issue) + 1, 6 + layout.tileH / 2)).toEqual([0xff, 0xb0, 0x20]); // amber frame
    // the music lane (5th row of the strip) has a block under the first scene
    const stripY = layout.height - (16 + 6 * 15 + 4) - 6;
    expect(px(canvas, 6 + 76 + 20, stripY + 16 + 4 * 15 + 7)).toEqual([0xe8, 0x43, 0x6a]);
  });

  it('level 2: three moments and each visual lane alone, long edge ≤ 1568', () => {
    const sb = buildStoryboard(story(), 'main');
    const img = { width: 108, height: 192, data: new Uint8Array(108 * 192 * 4).fill(255) };
    const cv = drawScene(sb, sb.scenes[1]!, { moments: [{ label: 'start', image: img }, { label: 'middle', image: img }, { label: 'end' }], solos: [{ lane: 'picture', image: img }, { lane: 'graphics', empty: true }, { lane: 'captions' }] });
    expect(Math.max(cv.width, cv.height)).toBeLessThanOrEqual(SHEET_MAX);
    expect(cv.height).toBeGreaterThan(cv.width); // 9:16 tiles in a 3 × 2 grid
  });

  it('a lane alone hides the other lanes on the comp, and drops the comp bg above the picture', () => {
    const p = story();
    const g = soloProject(p, 'main', 'graphics');
    expect(g.clips!.filter((c) => c.hidden).map((c) => c.id).sort()).toEqual(['bg1', 'bg2', 'caps']);
    expect(g.comps[0]!.bg).toBeUndefined();
    const pic = soloProject(p, 'main', 'picture');
    expect(pic.clips!.filter((c) => c.hidden).map((c) => c.id).sort()).toEqual(['caps', 'hook']);
    expect(pic.comps[0]!.bg).toBe('#101010');
    expect(p.clips!.some((c) => c.hidden)).toBe(false); // a copy
    const sb = buildStoryboard(p, 'main');
    expect(momentFrames(sb, sb.scenes[0]!)).toEqual([2, 30, 57]);
  });
});

describe('storyboard page', () => {
  it('is self-contained: inline script and data, no external URLs, project text cannot close the script', () => {
    const p = story(), sb = buildStoryboard(p, 'main');
    const img = 'data:image/jpeg;base64,AAAA';
    const images = new Map(sb.scenes.map((s) => [s.n, { tile: img, moments: [{ label: 'start', src: img }, { label: 'middle', src: img }, { label: 'end', src: img }], solos: [{ lane: 'picture' as const, src: img }] }]));
    const html = storyboardPage(pageData(sb, p, { file: 'video.mgl.json', images }));
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<script[^>]+src=|<link\b|<img[^>]+src="(?!data:)/);
    expect(html.match(/<\/script>/g)).toHaveLength(2); // the data block and the script, nothing from the project
    const data = JSON.parse(/<script type="application\/json" id="data">(.*?)<\/script>/s.exec(html)![1]!);
    expect(data.scenes).toHaveLength(5);
    expect(data.scenes[0].items.find((i: { clip: string }) => i.clip === 'hook')).toMatchObject({ cmd: 'mgl edit video.mgl.json clip.set hook text="…" y=…', docs: 'mgl docs clip.set' });
    expect(data.lanes.map((l: { lane: string }) => l.lane)).toEqual(['picture', 'graphics', 'captions', 'voice', 'music', 'sfx']);
    expect(html).toContain('prefers-color-scheme:dark');
    const js = /<script>(.*?)<\/script>/s.exec(html)![1]!;
    expect(js.trim().split('\n').length).toBeLessThanOrEqual(80);
    expect(() => new Function(js)).not.toThrow(); // it parses
  });
});

describe('look draws the storyboard', () => {
  it('default look: 12 QA frames plus the scene middles in one stills call, storyboard sheet, page, snapshot, ● next time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mgl-sb-look-')), file = join(dir, 'video.mgl.json');
    const p = story();
    writeFileSync(file, JSON.stringify(p, null, 2));
    const calls: Parameters<typeof fakeStills>[0] = [];
    const r = await look(p, { baseDir: dir, file, audio: false, registry: builtinRegistry(), deps: { renderStills: fakeStills(calls) } });
    expect(r.frames).toHaveLength(12);
    expect(calls[0]!.frames.slice(0, 12)).toEqual(r.frames);
    expect(calls[0]!.frames).toEqual(expect.arrayContaining([30, 105, 195, 285])); // scene middles in the same call
    expect(calls[0]!.scale).toBeCloseTo(r.scale);
    expect(r.sheet).toBe(join(lookDir(file), 'sheet.png'));
    const sheet = await loadImage(readFileSync(r.sheet));
    expect([sheet.width, sheet.height]).toEqual(r.size);
    expect(Math.max(...r.size)).toBeLessThanOrEqual(SHEET_MAX);
    expect(r.storyboard!.scenes.map((s) => s.marks[0] === 'idea')).toEqual([false, false, false, false, true]);
    expect(r.storyboard!.page).toBe(join(lookDir(file), 'storyboard.html'));
    const html = readFileSync(r.storyboard!.page!, 'utf8');
    expect(html).toContain('data:image/jpeg;base64,');
    expect(html).not.toMatch(/https?:\/\//);
    // level 2 for the page only where there is something to dig into: scene 1 has an issue (tiny hook text), the rest show their middle
    expect(r.storyboard!.scenes.map((s) => s.marks.includes('issue'))).toEqual([true, false, false, false, true]);
    expect(calls.slice(1).every((c) => c.frames.every((f) => f < 60))).toBe(true);
    // solos: graphics without the comp bg, other lanes hidden
    const g = calls.find((c) => c.hidden.includes('bg1') && c.hidden.includes('caps'));
    expect(g).toBeDefined();
    expect(g!.bg).toBeUndefined();
    expect(readPrevious(file)?.project).toEqual(p);
    const lines = formatLook(r, { file: 'video.mgl.json', cwd: dir });
    expect(lines[0]).toMatch(/^wrote \.mgl\/video\/look\/sheet\.png \(storyboard: 5 scenes, \d+x\d+; QA on 12 frames/);
    expect(lines[1]).toBe('page: .mgl/video/look/storyboard.html');
    expect(lines[2]).toMatch(/^ {2}1 "Three tips/);
    expect(lines[6]).toMatch(/^ {2}5 note "show a timer counting down" 11\.0–14\.0s idea\b/);
    expect(lines.length).toBeLessThanOrEqual(40);

    const q = structuredClone(p);
    (q.clips!.find((c) => c.id === 'bg2') as { color: string }).color = '#00ff00';
    const calls2: Parameters<typeof fakeStills>[0] = [];
    const r2 = await look(q, { baseDir: dir, file, audio: false, registry: builtinRegistry(), deps: { renderStills: fakeStills(calls2) } });
    expect(r2.storyboard!.scenes.filter((s) => s.marks.includes('changed')).map((s) => s.n)).toEqual([3, 4]);
    // the changed scenes get their start / end and each layer alone for the page: graphics without the comp bg, other lanes hidden
    expect(calls2.length).toBeGreaterThan(1);
    expect(calls2[1]!.frames).toEqual(expect.arrayContaining([152, 237]));
    const html2 = readFileSync(r2.storyboard!.page!, 'utf8');
    expect(html2).toMatch(/● changed since the storyboard of /);
    expect(html2).toContain('<pre>1 &quot;Three tips'); // level 1 as text, readable without the script
    expect(formatLook(r2, { file: 'video.mgl.json', cwd: dir })[1]).toMatch(/● = changed since the storyboard of /);
  });

  it('--at / -n / --cuts keep the contact sheet and write no page', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mgl-sb-look-'));
    const pagePath = join(lookDir(join(dir, 'v.mgl.json')), 'storyboard.html');
    await look(story(), { baseDir: dir, file: join(dir, 'v.mgl.json'), audio: false, registry: builtinRegistry(), deps: { renderStills: fakeStills() } });
    expect(existsSync(pagePath)).toBe(true);
    const r = await look(story(), { baseDir: dir, file: join(dir, 'v.mgl.json'), n: 4, audio: false, registry: builtinRegistry(), deps: { renderStills: fakeStills() } });
    expect(r.storyboard).toBeUndefined();
    expect(r.grid[0] * r.grid[1]).toBe(4);
    expect(existsSync(pagePath)).toBe(false); // an earlier page would no longer match the sheet
  });

  it('--scene: scene-<n>.png with three moments and each lane alone, the level-2 text; by number or id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mgl-sb-scene-')), file = join(dir, 'v.mgl.json');
    const calls: Parameters<typeof fakeStills>[0] = [];
    const r = await look(story(), { baseDir: dir, file, scene: 'q3', registry: builtinRegistry(), deps: { renderStills: fakeStills(calls) } });
    expect(r.sheet).toBe(join(lookDir(file), 'scene-3.png'));
    expect(r.frames).toEqual([152, 195, 237]);
    expect(Math.max(...r.size)).toBeLessThanOrEqual(SHEET_MAX);
    expect(calls).toHaveLength(3); // the moments, the picture alone, the captions alone (no graphics in scene 3)
    expect(r.storyboard!.detail![0]).toMatch(/^scene 3 "Work in 25-minute blocks!"/);
    expect(readPrevious(file)).toBeUndefined(); // one scene is not a storyboard: the next one still compares with the last full one
    const lines = formatLook(r, { file: 'v.mgl.json', cwd: dir });
    expect(lines[0]).toMatch(/^wrote \.mgl\/v\/look\/scene-3\.png \(scene 3 of 5/);
    await expect(look(story(), { baseDir: dir, file, scene: 9, registry: builtinRegistry(), deps: { renderStills: fakeStills() } })).rejects.toMatchObject({ code: 'E_ARG' });
  });

  it('writeStoryboard (render): the image and the page at the given paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mgl-sb-render-')), file = join(dir, 'v.mgl.json');
    const s = await writeStoryboard(story(), { baseDir: dir, file, registry: builtinRegistry(), png: join(dir, 'out', 'v.storyboard.png'), html: join(dir, 'out', 'v.storyboard.html'), deps: { renderStills: fakeStills() } });
    expect(existsSync(s.png) && existsSync(s.html)).toBe(true);
    expect(Math.max(...s.size)).toBeLessThanOrEqual(SHEET_MAX);
    expect(s.storyboard.scenes).toHaveLength(5);
    expect(readPrevious(file)).toBeDefined();
    // right after a look of the same project, the look's frame and sound findings stay (render runs only the project checks)
    writeSnapshot(file, story(), new Date(), { comp: 'main', findings: [{ rule: 'silence', severity: 'warning', message: 'silence in vo', frame: 200 }] });
    const again = await writeStoryboard(story(), { baseDir: dir, file, registry: builtinRegistry(), deps: { renderStills: fakeStills() } });
    expect(again.storyboard.scenes[2]!.issue).toBe('silence in vo');
    expect(readPrevious(file)?.findings?.some((f) => f.message === 'silence in vo')).toBe(true);
  });
});
