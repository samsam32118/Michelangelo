// @vitest-environment node
/** ui-overlap: captions, text and stickers under the TikTok / Reels / Shorts interface; look --safe outlines. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProjectFile } from '../../src/core/schema/index.js';
import { open } from '../../src/sdk/index.js';
import { layersAt, runCheck, shortsProject } from './qa-fixtures.js';
import '../../src/core/commands/index.js';

type Box = [number, number, number, number];
const bg = { clipId: 'bg', kind: 'video', box: [0, 0, 1080, 1920] as Box };

/** A 1080x1920 project; `platform` unset by default (the case v3 shipped with). */
function vertical(clips: unknown[], platform?: string): ProjectFile {
  const p = shortsProject({ clips: [...shortsProject().clips!, ...clips] } as Partial<ProjectFile>);
  if (platform) p.project = { platform } as ProjectFile['project'];
  else delete p.project;
  return p;
}

describe('ui-overlap', () => {
  it('no platform set: a caption low in a 9:16 frame is flagged for TikTok, Reels and Shorts, with one fix that clears all three', () => {
    const p = vertical([{ id: 'caps', track: 'T1', at: 0, len: 90, text: 'wait for it', y: 1700 }]);
    const f = runCheck('ui-overlap', p, { layers: layersAt(45, [bg, { clipId: 'caps', kind: 'captions', box: [300, 1660, 480, 80], text: 'wait for it' }]) });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule: 'ui-overlap', severity: 'error', clip: 'caps', frame: 45, box: [300, 1660, 480, 80] });
    expect(f[0]!.message).toBe('caption cue "wait for it" (caps) is under the TikTok caption and sound (80 px), Reels caption and audio (80 px) and Shorts title and channel (80 px) at 1.50s');
    // shared safe area of the three: bottom = TikTok's 1516 → move up 224
    expect(f[0]!.fix).toBe('mgl edit <file> clip.set caps y=1476');
  });

  it('the fix clears every panel: re-checked at the new position, nothing is found', () => {
    const p = vertical([{ id: 'caps', track: 'T1', at: 0, len: 90, text: 'wait for it', y: 1476 }]);
    expect(runCheck('ui-overlap', p, { layers: layersAt(45, [bg, { clipId: 'caps', kind: 'captions', box: [300, 1436, 480, 80] }]) })).toEqual([]);
  });

  it('a sticker in the TikTok button column is a warning for TikTok only, moved left', () => {
    const p = vertical([{ id: 'emoji', track: 'T1', at: 0, len: 90, asset: 'bgv', x: 990, y: 700 }]);
    const f = runCheck('ui-overlap', p, { layers: layersAt(30, [bg, { clipId: 'emoji', kind: 'image', box: [940, 650, 100, 100] }]) });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: 'warning', clip: 'emoji' });
    expect(f[0]!.message).toBe('sticker (image) (emoji) is under the TikTok actions (78 px) at 1.00s');
    expect(f[0]!.fix).toBe('mgl edit <file> clip.set emoji x=878');
  });

  it('a sticker larger than the safe area is scaled down and moved in; a full-width layer counts only when tagged sticker', () => {
    // full width is picture, not a sticker, unless tagged
    const untagged = vertical([{ id: 'plate', track: 'T1', at: 0, len: 90, color: '#000000', x: 540, y: 1650 }]);
    expect(runCheck('ui-overlap', untagged, { layers: layersAt(30, [bg, { clipId: 'plate', kind: 'solid', box: [0, 1500, 1080, 300] }]) })).toEqual([]);
    const p = vertical([{ id: 'plate', track: 'T1', at: 0, len: 90, color: '#000000', x: 540, y: 1650, tags: ['sticker'] }]);
    const f = runCheck('ui-overlap', p, { layers: layersAt(30, [bg, { clipId: 'plate', kind: 'solid', box: [0, 1500, 1080, 300] }]) });
    expect(f[0]!.fix).toMatch(/^mgl edit <file> clip\.set plate scale=0\.79\d* x=\d+ y=\d+$/);
  });

  it('a full-frame background, a moving crawl and a clip tagged qa-ignore:ui are not flagged', () => {
    const p = vertical([
      { id: 'crawl', track: 'T1', at: 0, len: 90, text: 'BREAKING', x: [[0, 1200], [89, -200]], y: 1700 },
      { id: 'credit', track: 'T1', at: 0, len: 90, text: 'photo: NASA', y: 1880, tags: ['qa-ignore:ui'] },
    ]);
    const layers = new Map([
      [10, [bg, { clipId: 'crawl', kind: 'text', box: [900, 1660, 600, 80] as Box }, { clipId: 'credit', kind: 'text', box: [400, 1860, 280, 40] as Box }]],
      [60, [bg, { clipId: 'crawl', kind: 'text', box: [100, 1660, 600, 80] as Box }, { clipId: 'credit', kind: 'text', box: [400, 1860, 280, 40] as Box }]],
    ]);
    expect(runCheck('ui-overlap', p, { layers })).toEqual([]);
  });

  it('one platform named: only its interface counts, and the fix uses its own safe area', () => {
    const p = vertical([{ id: 'caps', track: 'T1', at: 0, len: 90, text: 'hi', y: 1700 }], 'shorts');
    const f = runCheck('ui-overlap', p, { layers: layersAt(45, [bg, { clipId: 'caps', kind: 'captions', box: [300, 1660, 480, 80] }]) });
    expect(f[0]!.message).toContain('under the Shorts title and channel (80 px)');
    expect(f[0]!.message).not.toMatch(/TikTok|Reels/);
    expect(f[0]!.fix).toBe('mgl edit <file> clip.set caps y=1496');
  });

  it('horizontal comps and youtube projects are skipped', () => {
    const wide = vertical([{ id: 'caps', track: 'T1', at: 0, len: 90, text: 'hi', y: 1000 }]);
    wide.comps[0]!.size = [1920, 1080];
    expect(runCheck('ui-overlap', wide, { layers: layersAt(45, [{ clipId: 'caps', kind: 'captions', box: [700, 1000, 480, 60] }]) })).toEqual([]);
    const yt = vertical([{ id: 'caps', track: 'T1', at: 0, len: 90, text: 'hi', y: 1700 }], 'youtube');
    expect(runCheck('ui-overlap', yt, { layers: layersAt(45, [{ clipId: 'caps', kind: 'captions', box: [300, 1660, 480, 80] }]) })).toEqual([]);
  });

  it('check --fix moves a low caption clear of all three interfaces (end to end, real layout)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mgl-ui-'));
    const file = join(dir, 'v.mgl.json');
    writeFileSync(file, JSON.stringify(vertical([{ id: 'caps', track: 'T1', at: 0, len: 90, text: 'wait for it', style: { size: 72 }, y: 1760 }])));
    const { fixCheck } = await import('../../src/qa/fix.js');
    const r = await fixCheck(await open(file));
    expect(r.before.some((f) => f.rule === 'ui-overlap' && f.clip === 'caps')).toBe(true);
    expect(r.remaining.filter((f) => f.rule === 'ui-overlap')).toEqual([]);
    const y = (await open(file)).data.clips!.find((c) => c.id === 'caps')!.y as number;
    expect(y).toBeLessThan(1516);
  });
});

describe('look --safe', () => {
  it('outlines the three interfaces on the sheet and the crop of a finding; the render itself has no outlines', async () => {
    const { loadImage } = await import('@napi-rs/canvas');
    const { readFileSync } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'mgl-safe-'));
    const file = join(dir, 'v.mgl.json');
    const p = vertical([{ id: 'caps', track: 'T1', at: 0, len: 300, text: 'wait for it', style: { size: 72 }, y: 1760 }]);
    p.assets = [];
    p.clips = [{ id: 'bg', track: 'V1', at: 0, len: 300, color: '#202020' }, ...p.clips!.filter((c) => c.id === 'caps')];
    writeFileSync(file, JSON.stringify(p));
    const proj = await open(file);
    const r = await proj.look({ frames: 2, audio: false, safe: true });
    expect((r.notes as string[]).join(' ')).toMatch(/--safe: interface panels outlined .*tiktok cyan, reels magenta, shorts yellow/);
    const ui = r.findings.findIndex((f) => f.rule === 'ui-overlap');
    expect(ui).toBeGreaterThanOrEqual(0);
    const crop = r.crops.find((c) => c.finding === ui)!;
    // count outline colours in the sheet and the crop
    const colours = async (path: string) => {
      const img = await loadImage(readFileSync(path));
      const { createCanvas } = await import('@napi-rs/canvas');
      const cv = createCanvas(img.width, img.height), cx = cv.getContext('2d');
      cx.drawImage(img, 0, 0);
      const d = cx.getImageData(0, 0, img.width, img.height).data;
      let cyan = 0, magenta = 0, yellow = 0;
      for (let i = 0; i < d.length; i += 4) {
        const [R, G, B] = [d[i]!, d[i + 1]!, d[i + 2]!];
        if (R < 80 && G > 200 && B > 200) cyan++;
        if (R > 200 && G < 120 && B > 180) magenta++;
        if (R > 220 && G > 180 && B < 60) yellow++;
      }
      return { cyan, magenta, yellow };
    };
    for (const path of [r.sheet, crop.path]) {
      const c = await colours(path);
      expect(c.cyan, path).toBeGreaterThan(50);
      expect(c.magenta, path).toBeGreaterThan(50);
      expect(c.yellow, path).toBeGreaterThan(50);
    }
    const plain = await proj.look({ frames: 2, audio: false });
    expect(await colours(plain.sheet)).toEqual({ cyan: 0, magenta: 0, yellow: 0 });
  }, 60_000);
});
