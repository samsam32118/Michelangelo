import { describe, it, expect, beforeAll } from 'vitest';
import { builtinRegistry } from '../../src/builtin/index.js';
import { createTextLayouter } from '../../src/render/text.js';
import { evaluate } from '../../src/render/evaluate.js';
import { makeProject } from './text-fixtures.js';
import { templates, safeRect } from '../../src/builtin/text/index.js';
import { normaliseAndValidate } from '../../src/core/load.js';
import type { Clip, ProjectFile } from '../../src/core/schema/index.js';

const SIZES: [number, number][] = [[1080, 1920], [1920, 1080], [1080, 1080]];

/** Comp-px box of a clip at rest, from its explicit size (shapes) or text box (templates always give one). */
function restBox(c: Clip): [number, number, number, number] | undefined {
  const size = c.shape?.size ?? (typeof c.style === 'object' ? c.style.box : undefined);
  if (!size || typeof c.x !== 'number' || typeof c.y !== 'number') return undefined;
  const [ax, ay] = c.anchor ?? [0.5, 0.5];
  return [c.x - ax * size[0], c.y - ay * size[1], size[0], size[1]];
}

describe('template.apply', () => {
  const registry = builtinRegistry();
  let layouter: ReturnType<typeof createTextLayouter>;
  beforeAll(() => { layouter = createTextLayouter(); });
  for (const t of templates) {
    for (const size of SIZES) {
      it(`${t.id} at ${size[0]}x${size[1]} validates, does not overlap and stays in the safe area`, async () => {
        const { project, edit } = makeProject({ size, edit: (p) => { p.assets = [{ id: 'cam', src: 'cam.mp4' }]; p.clips = [{ id: 'shot', track: 'V1', at: 0, len: 900, asset: 'cam' }]; } });
        const r = await edit({ op: 'template.apply', template: t.id, at: '1s' });
        expect(r.issues).toEqual([]);
        const v = normaliseAndValidate(structuredClone(project.data) as unknown as Record<string, unknown>);
        expect(v.problems.filter((p) => p.severity === 'error')).toEqual([]);
        const ids = r.out[0]!.ids as string[];
        // the renderer resolves every style and animation the template uses
        for (const f of [30, 75]) expect(evaluate(project.data, 'main', f, { layouter, registry, assetKind: () => 'video' }).nodes.length).toBeGreaterThan(1);
        expect(ids.length).toBeGreaterThan(0);
        const S = safeRect(size[0], size[1]);
        const trackOrder = project.data.tracks!.map((x) => x.id);
        for (const id of ids) {
          const c = project.clip(id)!;
          expect(c.tags).toEqual([`template:${t.id}`]);
          expect(c.at).toBeGreaterThanOrEqual(30);
          expect(trackOrder.indexOf(c.track)).toBeGreaterThan(trackOrder.indexOf('V1'));
          if (c.text !== undefined) expect(typeof c.style === 'object' && c.style.box, `${id} has a text box`).toBeTruthy();
          if (c.color !== undefined) continue; // full-frame background
          const b = restBox(c);
          expect(b, `${id} has a known box`).toBeTruthy();
          const [x, y, w, h] = b!;
          expect(x, `${id} left`).toBeGreaterThanOrEqual(S.x0 - 0.5);
          expect(y, `${id} top`).toBeGreaterThanOrEqual(S.y0 - 0.5);
          expect(x + w, `${id} right`).toBeLessThanOrEqual(S.x1 + 0.5);
          expect(y + h, `${id} bottom`).toBeLessThanOrEqual(S.y1 + 0.5);
        }
      });
    }
  }

  it('applies twice with unique ids, places layers on free tracks, keeps track order', async () => {
    const { project, edit } = makeProject();
    const a = await edit({ op: 'template.apply', template: 'lower-third', at: 0, params: { name: 'Ada', role: 'Engineer' } });
    const b = await edit({ op: 'template.apply', template: 'lower-third', at: '1s', len: '2s', params: { name: 'Grace' } });
    const ia = a.out[0]!.ids as string[], ib = b.out[0]!.ids as string[];
    expect(ia).toContain('lower-third-name');
    expect(ib).toContain('lower-third2-name');
    expect(project.clip('lower-third2-name')!.text).toBe('Grace');
    expect(project.clip('lower-third2-bar')!.len).toBe(60);
    // the second is above the first (they overlap in time)
    const order = project.data.tracks!.map((t) => t.id);
    expect(order.indexOf(project.clip('lower-third2-bar')!.track)).toBeGreaterThan(order.indexOf(project.clip('lower-third-role')!.track));
    expect(project.issues).toEqual([]);
  });

  it('progress-bar spans the comp length with a keyframed width', async () => {
    const { project, edit } = makeProject({ length: 450 });
    await edit({ op: 'template.apply', template: 'progress-bar', params: { position: 'top' } });
    const fill = project.clip('progress-bar-fill')!;
    expect(fill).toMatchObject({ at: 0, len: 450, anchor: [0, 0.5] });
    expect(fill.scale).toEqual([[0, [0, 1]], [449, [1, 1]]]);
  });

  it('cta uses the label param and keyframes a pop + bounce', async () => {
    const { project, edit } = makeProject();
    await edit({ op: 'template.apply', template: 'cta', params: { label: 'Follow' } });
    expect(project.clip('cta-label')!.text).toBe('Follow');
    const scale = project.clip('cta-button')!.scale as [number, number][];
    expect(scale[0]![1]).toBe(0.6);
    expect(scale.filter((k) => k[1] === 1.08)).toHaveLength(2);
  });

  it('reports unknown templates, bad params and taken prefixes with fixes', async () => {
    const { edit } = makeProject({ edit: (p: ProjectFile) => { p.clips = [{ id: 'x-title', track: 'T1', at: 0, len: 10, text: 'a' }]; } });
    await expect(edit({ op: 'template.apply', template: 'intr' })).rejects.toMatchObject({ code: 'E_UNKNOWN_TEMPLATE', fix: expect.stringMatching(/intro/) });
    await expect(edit({ op: 'template.apply', template: 'listicle-item', params: { number: 'one' } })).rejects.toMatchObject({ code: 'E_ARG', fix: expect.stringMatching(/number/) });
    await expect(edit({ op: 'template.apply', template: 'title', prefix: 'x' })).rejects.toMatchObject({ code: 'E_DUPLICATE_ID' });
    await expect(edit({ op: 'template.apply', template: 'title', track: 'T1' })).rejects.toMatchObject({ code: 'E_OVERLAP' });
  });

  it('is frame-exact at 29.97 fps', async () => {
    const { project, edit } = makeProject({ fps: '30000/1001' });
    await edit({ op: 'template.apply', template: 'intro', at: '2s', params: { subtitle: 'Sub' } });
    const all = project.data.clips!;
    expect(all.every((c) => Number.isInteger(c.at) && Number.isInteger(c.len))).toBe(true);
    expect(project.clip('intro-bg')).toMatchObject({ at: 60, len: 120 });
  });
});
