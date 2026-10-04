import { describe, expect, it } from 'vitest';
import { builtinRegistry } from '../../src/builtin/index.js';
import { testPattern, solid, pixel, meanColor, distinctLevels, coverage, difference, renderEffect, renderTransition, renderGenerator, testProject, runCommandOn, renderProject, checkContext } from '../../src/plugin/testing.js';
import { checkPluginDef } from '../../src/plugin/validate.js';
import { defineEffect, definePlugin, z } from '../../src/plugin/api.js';

const reg = builtinRegistry();

describe('michelangelo/testing', () => {
  it('testPattern has bars and a ramp', () => {
    const s = testPattern(320, 180);
    expect(pixel(s, 10, 10)).toEqual([255, 255, 255, 255]);
    expect(pixel(s, 300, 10)).toEqual([0, 0, 0, 255]);
    expect(pixel(s, 5 * 40 + 10, 10)).toEqual([255, 0, 0, 255]);
    expect(pixel(s, 0, 170)[0]).toBe(0);
    expect(pixel(s, 319, 170)[0]).toBe(255);
    expect(distinctLevels(s, 'r', [0, 120, 320, 60])).toBeGreaterThan(200);
    expect(distinctLevels(s, 'g', [0, 0, 320, 100])).toBe(2);
    expect(coverage(s)).toBe(1);
  });

  it('meanColor, coverage and difference', () => {
    const red = solid(10, 10, '#ff0000');
    expect(meanColor(red)).toEqual([255, 0, 0, 255]);
    expect(meanColor(testPattern(), [0, 0, 40, 100])).toEqual([255, 255, 255, 255]);
    expect(difference(red, solid(10, 10, '#ff0000'))).toBe(0);
    expect(coverage(solid(10, 10, 'transparent'))).toBe(0);
  });

  it('renderEffect / renderTransition / renderGenerator drive built-in definitions', () => {
    const blur = renderEffect(reg.effects.get('blur')!, { radius: 4 });
    expect(blur.stats.coverage).toBeGreaterThan(0.9);
    expect(difference(blur.dst, blur.src)).toBeGreaterThan(0.1);
    const fade = renderTransition(reg.transitions.get('crossfade')!, 1);
    expect(difference(fade.dst, fade.to)).toBeLessThan(1);
    const gen = reg.generators.get('particles')!;
    expect(renderGenerator(gen, {}, 3).stats.coverage).toBeGreaterThan(0);
    expect(() => renderEffect(reg.effects.get('blur')!, { radius: 'big' })).toThrow(/invalid params/);
  });

  it('runCommandOn and checkContext', async () => {
    const r = await runCommandOn(testProject(), { op: 'template.apply', template: 'lower-third', params: { name: 'A' } });
    expect(r.project.clips!.length).toBeGreaterThan(1);
    expect(checkContext(testProject()).safeArea()).toEqual({ x: 16, y: 9, w: 288, h: 162 });
  });

  it('renderProject renders a frame with plugin definitions', async () => {
    const red = definePlugin({ name: 'redder', effects: [defineEffect({ type: 'redder', describe: 'All red.', params: z.object({}), draw({ dst }) { dst.ctx.fillStyle = '#ff0000'; dst.ctx.fillRect(0, 0, dst.width, dst.height); } })] });
    const p = testProject({ width: 64, height: 36 });
    p.clips![0]!.fx = [{ type: 'redder' }];
    const img = await renderProject(p, 0, { plugins: [red] });
    expect([img.width, img.height]).toEqual([64, 36]);
    expect(Array.from(img.data.subarray(0, 4))).toEqual([255, 0, 0, 255]);
  });

  it('checkPluginDef names the fix', () => {
    expect(checkPluginDef(null)[0]).toMatch(/fix: /);
    expect(checkPluginDef({ name: 'x' })[0]).toMatch(/defines nothing/);
    expect(checkPluginDef({ name: 'x', commands: [{ op: 'y.z', doc: 'd', schema: z.object({}), apply() {} }] })[0]).toMatch(/must be named "x.<verb>"/);
    expect(checkPluginDef({ name: 'x', effects: [{ type: 'e', describe: 'd', params: z.object({ a: z.number() }), draw() {} }] }, true)[0]).toMatch(/param "a" has no default/);
    expect(checkPluginDef(definePlugin({ name: 'x', effects: [defineEffect({ type: 'e', describe: 'd', params: z.object({}), draw() {} })] }), true)).toEqual([]);
  });
});
