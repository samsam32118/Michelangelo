import { describe, it, expect, beforeAll } from 'vitest';
import { builtinRegistry } from '../../src/builtin/index.js';
import { createTextLayouter } from '../../src/render/text.js';
import { evaluateLayers } from '../../src/render/evaluate.js';
import { safeArea, inside } from '../../src/qa/safezones.js';
import { makeProject } from './text-fixtures.js';
import { templates } from '../../src/builtin/text/index.js';

const SIZES: [number, number][] = [[1080, 1920], [720, 1280], [1920, 1080], [1080, 1080]];
const PARAMS: Record<string, Record<string, unknown>> = {
  intro: { title: 'Three tips to focus', subtitle: 'A short guide' },
  'lower-third': { name: 'Ada Lovelace', role: 'Engineer' },
  quote: { author: 'Leonardo da Vinci' },
  'end-card': {},
  'listicle-item': { text: 'Put your phone away' },
  'hook-title': { kicker: '3 tips', text: 'Stop doing this', highlight: 'every morning' },
  'follow-outro': { handle: '@studio.mia', title: 'Follow for daily tips', platform: 'tiktok' },
};

describe('built-in text passes QA text size and safe area', () => {
  const registry = builtinRegistry();
  let layouter: ReturnType<typeof createTextLayouter>;
  beforeAll(() => { layouter = createTextLayouter(); });

  for (const t of templates) for (const size of SIZES) {
    it(`${t.id} at ${size[0]}x${size[1]}: every text is at least 2.5% of the frame height at rest`, async () => {
      const { project, edit } = makeProject({ size });
      await edit({ op: 'template.apply', template: t.id, at: 0, len: '5s', params: PARAMS[t.id] ?? {} });
      const best = new Map<string, number>();
      for (const f of [75, 90, 105]) for (const l of evaluateLayers(project.data, 'main', f, { layouter, registry, assetKind: () => 'video' })) {
        if (l.fontPx !== undefined) best.set(l.clipId, Math.max(best.get(l.clipId) ?? 0, l.fontPx));
      }
      for (const [id, px] of best) expect(px, `${id} font px`).toBeGreaterThanOrEqual(0.025 * size[1]);
    });
  }

  it('lower-third text is not shrunk to fit its box on shorts (the QA size fix would loop)', async () => {
    const { project, edit } = makeProject();
    await edit({ op: 'template.apply', template: 'lower-third', at: 0, params: PARAMS['lower-third'] });
    for (const id of ['lower-third-name', 'lower-third-role']) {
      const c = project.clip(id)!;
      const st = c.style as { size: number };
      const l = evaluateLayers(project.data, 'main', 90, { layouter, registry, assetKind: () => 'video' }).find((x) => x.clipId === id)!;
      expect(l.fontPx, id).toBeCloseTo(st.size, 0);
    }
    // the plate still holds both lines
    const plate = project.clip('lower-third-plate')!, role = project.clip('lower-third-role')!, name = project.clip('lower-third-name')!;
    const ph = plate.shape!.size![1], py = plate.y as number;
    const box = (c: typeof role) => (c.style as { box: [number, number] }).box;
    expect((name.y as number) - box(name)[1] / 2).toBeGreaterThanOrEqual(py - ph / 2);
    expect((role.y as number) + box(role)[1] / 2).toBeLessThanOrEqual(py + ph / 2);
  });

  for (const style of ['caption']) {
    it(`a centred "${style}" text clip stays inside the shorts safe area (SKILL.md quick-start)`, async () => {
      const { project, edit } = makeProject();
      await edit({ op: 'clip.add', text: 'Three tips to focus better every single day', id: 'title', track: 'T1', at: 0, len: '3s', style });
      const l = evaluateLayers(project.data, 'main', 45, { layouter, registry, assetKind: () => 'video' }).find((x) => x.clipId === 'title')!;
      expect(inside(l.box, safeArea('shorts', 1080, 1920)), JSON.stringify(l.box)).toBe(true);
    });
  }
});
