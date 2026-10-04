import { describe, expect, it } from 'vitest';
import { inside, safeArea, uiZones, SAFE_PLATFORMS } from '../../src/qa/safezones.js';

describe('safe zones', () => {
  it('9:16 platforms keep text clear of the header, actions and caption bar', () => {
    for (const p of ['shorts', 'tiktok', 'reels']) {
      const r = safeArea(p, 1080, 1920);
      const zones = uiZones(p, 1080, 1920);
      expect(zones.map((z) => z.name)).toHaveLength(3);
      for (const z of zones) {
        // the safe rect does not intersect any UI zone
        const ix = Math.min(r.x + r.w, z.rect.x + z.rect.w) - Math.max(r.x, z.rect.x);
        const iy = Math.min(r.y + r.h, z.rect.y + z.rect.h) - Math.max(r.y, z.rect.y);
        expect(ix <= 0 || iy <= 0, `${p} ${z.name}`).toBe(true);
      }
      expect(r.w).toBeGreaterThan(800);
      expect(r.h).toBeGreaterThan(1300);
    }
  });

  it('shorts numbers', () => {
    expect(safeArea('shorts', 1080, 1920)).toEqual({ x: 54, y: 154, w: 896, h: 1382 });
  });

  it('youtube and none are title-safe 90% with no UI zones', () => {
    expect(safeArea('youtube', 1920, 1080)).toEqual({ x: 96, y: 54, w: 1728, h: 972 });
    expect(safeArea(undefined, 1920, 1080)).toEqual(safeArea('none', 1920, 1080));
    expect(safeArea('unknown', 1920, 1080)).toEqual(safeArea('none', 1920, 1080));
    expect(uiZones('youtube', 1920, 1080)).toEqual([]);
    expect(SAFE_PLATFORMS).toContain('reels');
  });

  it('inside with tolerance', () => {
    const r = { x: 10, y: 10, w: 100, h: 100 };
    expect(inside([10, 10, 100, 100], r)).toBe(true);
    expect(inside([9.5, 10, 100, 100], r)).toBe(true);
    expect(inside([5, 10, 100, 100], r)).toBe(false);
  });
});
