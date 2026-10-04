// @vitest-environment node
/**
 * The social starter set: hook-title and follow-outro templates, hormozi and word-pop caption styles, the snap text
 * animation, whip and zoom-punch transitions, and the bundled Montserrat / Bebas Neue fonts.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GlobalFonts } from '@napi-rs/canvas';
import { builtinRegistry } from '../../src/builtin/index.js';
import { styles, textAnimations, templates, socialTemplates } from '../../src/builtin/text/index.js';
import { estimateLines } from '../../src/builtin/text/social.js';
import { registerFonts, createTextLayouter } from '../../src/render/text.js';
import { resolveStyle, evaluateLayers } from '../../src/render/evaluate.js';
import { look } from '../../src/qa/look.js';
import { makeProject } from './text-fixtures.js';
import { runTransition, solid, surface, px, diff } from './effects-fixtures.js';

const SIZES: [number, number][] = [[1080, 1920], [1920, 1080], [1080, 1080]];
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('bundled display fonts', () => {
  it('registers Montserrat (400/700/800/900) and Bebas Neue from fonts/', () => {
    registerFonts();
    const fam = (n: string) => GlobalFonts.families.find((f: { family: string }) => f.family === n) as { styles: { weight: number }[] } | undefined;
    expect(fam('Bebas Neue')).toBeTruthy();
    const weights = fam('Montserrat')!.styles.map((s) => s.weight).sort((a, b) => a - b);
    for (const w of [400, 700, 800, 900]) expect(weights).toContain(w);
  });
  it('Montserrat 900 is wider than 400 (static weights, not a variable font stuck on one weight)', () => {
    const layouter = createTextLayouter();
    const st = (weight: number) => ({ font: 'Montserrat', size: 100, weight, color: '#fff', align: 'center' as const, lineHeight: 1, letterSpacing: 0 });
    expect(layouter.layout('FOLLOW', st(900)).w).toBeGreaterThan(layouter.layout('FOLLOW', st(400)).w * 1.02);
  });
});

describe('caption styles and the snap animation', () => {
  const registry = builtinRegistry();
  it('hormozi: heavy upper-case Montserrat, 3 words a page, yellow spoken word; word-pop: one Bebas Neue word at a time', () => {
    const p = { michelangelo: 1, comps: [{ id: 'main', size: [1080, 1920], fps: 30 }] } as never;
    const h = resolveStyle('hormozi', p, registry.styles);
    expect(h).toMatchObject({ font: 'Montserrat', weight: 900, uppercase: true, maxWords: 3, highlight: '#ffe01b' });
    const w = resolveStyle('word-pop', p, registry.styles);
    expect(w).toMatchObject({ font: 'Bebas Neue', maxWords: 1, maxLines: 1, uppercase: true });
    for (const id of ['hormozi', 'word-pop']) expect(styles.find((s) => s.id === id)!.describe).toMatch(/e\.g\. captions\.from-text/);
  });
  it('a hormozi page of three words fits the 800 px caption width without shrinking much', () => {
    const p = { michelangelo: 1, comps: [{ id: 'main', size: [1080, 1920], fps: 30 }] } as never;
    const st = resolveStyle('hormozi', p, registry.styles);
    const l = createTextLayouter().layout('this one habit', st);
    expect(l.lines.length).toBe(1);
    expect(l.size).toBeGreaterThan(0.9 * st.size);
  });
  it('snap starts big and invisible, undershoots, and rests at 1', () => {
    const snap = textAnimations.find((a) => a.id === 'snap')!;
    expect(snap.state(0)).toMatchObject({ scale: 1.6, opacity: 0 });
    expect(snap.state(0.55).scale).toBeCloseTo(0.96);
    expect(snap.state(1).scale).toBeCloseTo(1);
    expect(snap.state(1).opacity).toBe(1);
    // monotonic fall to the undershoot
    for (let q = 0.05; q < 0.55; q += 0.05) expect(snap.state(q).scale!).toBeLessThan(snap.state(q - 0.05).scale!);
  });
});

describe('social templates', () => {
  const registry = builtinRegistry();
  const layouter = createTextLayouter();
  it('are registered with the other templates and documented with an example', () => {
    expect(socialTemplates.map((t) => t.id)).toEqual(['hook-title', 'follow-outro']);
    for (const t of socialTemplates) {
      expect(templates).toContain(t);
      expect(registry.templates.get(t.id)).toBe(t);
      expect(t.describe).toMatch(/e\.g\. template\.apply/);
    }
  });

  it('estimateLines wraps greedily and caps', () => {
    expect(estimateLines('Stop doing this', 798, 112, 3)).toBe(2);
    expect(estimateLines('Stop doing this', 1300, 120, 3)).toBe(1);
    expect(estimateLines('one two three four five six seven eight nine ten', 300, 100, 3)).toBe(3);
  });

  it('hook-title: kicker, words snapping in, highlight sticker after the words; no scrim or kicker when asked', async () => {
    const { project, edit } = makeProject();
    await edit({ op: 'template.apply', template: 'hook-title', at: 0, params: { kicker: '3 tips', text: 'Stop doing this', highlight: 'every morning' } });
    const ids = (project.data.clips ?? []).map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['hook-title-scrim', 'hook-title-kicker', 'hook-title-text', 'hook-title-highlight']));
    const text = project.clip('hook-title-text')!, hl = project.clip('hook-title-highlight')!;
    expect(text.animate).toMatchObject({ in: 'snap', by: 'word' });
    expect(hl.at).toBeGreaterThan(text.at);
    expect((hl.style as { font: string }).font).toBe('Montserrat');
    const b = makeProject();
    await b.edit({ op: 'template.apply', template: 'hook-title', at: 0, params: { text: 'Wait for it', highlight: '', scrim: false } });
    expect((b.project.data.clips ?? []).map((c) => c.id)).toEqual(['hook-title-text']);
  });

  it('follow-outro: platform labels, the pointer clicks and the button turns into the done state', async () => {
    const { project, edit } = makeProject();
    await edit({ op: 'template.apply', template: 'follow-outro', at: 0, params: { handle: '@studio.mia', platform: 'tiktok' } });
    expect(project.clip('follow-outro-button-label')!.text).toBe('Follow');
    expect(project.clip('follow-outro-done-label')!.text).toBe('Following');
    expect(project.clip('follow-outro-initial')!.text).toBe('S');
    const btn = project.clip('follow-outro-button')!, done = project.clip('follow-outro-done')!, ripple = project.clip('follow-outro-ripple')!;
    expect(done.at).toBe(btn.at + btn.len);
    expect(ripple.at).toBeLessThan(done.at);
    // the pointer rests below the label's text box (it never covers the text) and is stacked above it
    const ptr = project.clip('follow-outro-pointer')!, lab = project.clip('follow-outro-button-label')!;
    const tipY = (ptr.y as number) - ptr.anchor![1] * ptr.shape!.size![1];
    expect(tipY).toBeGreaterThan((lab.y as number) + (lab.style as { box: [number, number] }).box[1] / 2);
    const order = project.data.tracks!.map((t) => t.id);
    expect(order.indexOf(ptr.track)).toBeGreaterThan(order.indexOf(lab.track));
    expect(order.indexOf(project.clip('follow-outro-ripple')!.track)).toBeLessThan(order.indexOf(lab.track));
    const yt = makeProject();
    await yt.edit({ op: 'template.apply', template: 'follow-outro', at: 0, params: { click: false } });
    expect(yt.project.clip('follow-outro-button-label')!.text).toBe('Subscribe');
    expect(yt.project.clip('follow-outro-pointer')).toBeUndefined();
    expect(yt.project.clip('follow-outro-done')).toBeUndefined();
  });

  for (const t of socialTemplates) for (const size of SIZES) {
    it(`${t.id} at ${size.join('x')}: every layer stays inside the frame, text at least 2.5% of the height`, async () => {
      const { project, edit } = makeProject({ size });
      await edit({ op: 'template.apply', template: t.id, at: 0, len: '5s', params: {} });
      for (const f of [60, 100, 140]) for (const l of evaluateLayers(project.data, 'main', f, { layouter, registry, assetKind: () => 'video' })) {
        if (l.kind === 'gen' || l.clipId.endsWith('-glow') || l.clipId.endsWith('-scrim')) continue;
        const [x, y, w, h] = l.box;
        expect(x, `${l.clipId} left @${f}`).toBeGreaterThanOrEqual(0);
        expect(y, `${l.clipId} top @${f}`).toBeGreaterThanOrEqual(0);
        expect(x + w, `${l.clipId} right @${f}`).toBeLessThanOrEqual(size[0]);
        expect(y + h, `${l.clipId} bottom @${f}`).toBeLessThanOrEqual(size[1]);
        if (l.fontPx !== undefined) expect(l.fontPx, `${l.clipId} font px`).toBeGreaterThanOrEqual(0.025 * size[1]);
      }
    });
  }

  for (const [id, params] of [['hook-title', { kicker: '3 tips', text: 'Stop doing this', highlight: 'every morning' }], ['follow-outro', { handle: '@studio.mia', title: 'Follow for daily tips' }]] as const) {
    for (const [i, size] of SIZES.entries()) {
      it(`${id} at ${size.join('x')}: look (rendered frames + QA) has no findings`, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mgl-social-'));
        dirs.push(dir);
        const platform = (['shorts', 'youtube', 'none'] as const)[i];
        const { project, edit } = makeProject({ size, length: 150, edit: (p) => { p.project = { ...(p.project ?? {}), platform }; } });
        await edit({ op: 'clip.add', color: '#3b5b8c', id: 'bg', track: 'V1', at: 0, len: '5s' });
        await edit({ op: 'template.apply', template: id, at: 0, len: '5s', params });
        const r = await look(project.data, { baseDir: dir, file: join(dir, 'p.mgl.json'), n: 6, audio: false, registry });
        expect(r.findings.filter((f) => f.severity !== 'info').map((f) => `${f.rule}: ${f.message}`)).toEqual([]);
      }, 60_000);
    }
  }
});

describe('whip and zoom-punch transitions', () => {
  const W = 96, H = 64;
  /** vertical stripes every 8 px: horizontal motion blur flattens them, vertical blur does not */
  const stripes = (c1: string, c2: string) => surface(W, H, (x) => { x.fillStyle = c1; x.fillRect(0, 0, W, H); x.fillStyle = c2; for (let i = 0; i < W; i += 8) x.fillRect(i, 0, 4, H); });
  const rowSpread = (s: ReturnType<typeof solid>, y: number) => { const v: number[] = []; for (let x = 8; x < W - 8; x++) v.push(px(s, x, y)[0]); return Math.max(...v) - Math.min(...v); };

  it('whip is sharp at the ends and smeared along its direction at the cut', () => {
    const from = stripes('#000000', '#ff0000'), to = stripes('#000000', '#ff0000');
    expect(rowSpread(runTransition('whip', from, to, 0.02), 32)).toBeGreaterThan(200);
    expect(rowSpread(runTransition('whip', from, to, 0.5), 32)).toBeLessThan(60);
    expect(rowSpread(runTransition('whip', from, to, 0.5, { blur: 0 }), 32)).toBeGreaterThan(200);
    // a vertical whip leaves vertical stripes sharp
    expect(rowSpread(runTransition('whip', from, to, 0.5, { direction: 'up' }), 32)).toBeGreaterThan(200);
  });
  it('whip moves the picture the given way: at 0.75 a left whip shows mostly `to`, entering from the right', () => {
    const out = runTransition('whip', solid(W, H, '#ff0000'), solid(W, H, '#0000ff'), 0.75, { blur: 0 });
    expect(px(out, W - 4, 32)[2]).toBeGreaterThan(200);
    expect(px(out, 2, 32)[0]).toBeGreaterThan(200);
    const right = runTransition('whip', solid(W, H, '#ff0000'), solid(W, H, '#0000ff'), 0.75, { blur: 0, direction: 'right' });
    expect(px(right, 2, 32)[2]).toBeGreaterThan(200);
  });
  it('whip keeps an opaque frame opaque (no dark or transparent edges)', () => {
    const out = runTransition('whip', solid(W, H, '#ffffff'), solid(W, H, '#ffffff'), 0.5);
    for (const [x, y] of [[0, 0], [W - 1, H - 1], [0, H / 2], [W - 1, H / 2]] as const) expect(px(out, x, y)).toEqual([255, 255, 255, 255]);
  });

  it('zoom-punch: zooms into `from` before the cut and settles `to` after it, with a flash at the cut', () => {
    // a centred white square on black: zooming in makes it bigger
    const target = () => surface(W, H, (x) => { x.fillStyle = '#000'; x.fillRect(0, 0, W, H); x.fillStyle = '#fff'; x.fillRect(W / 2 - 10, H / 2 - 10, 20, 20); });
    const before = runTransition('zoom-punch', target(), solid(W, H, '#0000ff'), 0.45, { blur: 0, flash: 0 });
    expect(px(before, W / 2 + 13, H / 2)[0]).toBeGreaterThan(200); // outside the original square, inside the zoomed one
    const after = runTransition('zoom-punch', solid(W, H, '#ff0000'), solid(W, H, '#0000ff'), 0.55, { flash: 0 });
    expect(px(after, 5, 5)).toEqual([0, 0, 255, 255]);
    const cut = runTransition('zoom-punch', solid(W, H, '#000000'), solid(W, H, '#000000'), 0.5, { flash: 0.5 });
    expect(px(cut, 5, 5)[0]).toBeGreaterThan(100);
    expect(px(runTransition('zoom-punch', solid(W, H, '#000000'), solid(W, H, '#000000'), 0.5, { flash: 0 }), 5, 5)[0]).toBe(0);
  });
  it('zoom-punch blur softens edges; both transitions are deterministic', () => {
    const target = () => stripes('#000000', '#ffffff');
    const sharp = runTransition('zoom-punch', target(), target(), 0.4, { blur: 0, flash: 0 });
    const soft = runTransition('zoom-punch', target(), target(), 0.4, { blur: 1, flash: 0 });
    /** pixels between black and white (blurred) in the outer columns, where a zoom blur is strongest */
    const mids = (o: ReturnType<typeof solid>) => { let n = 0; for (let y = 0; y < H; y += 4) for (const x of [1, 2, 3, 4, W - 5, W - 4, W - 3, W - 2]) { const v = px(o, x, y)[0]; if (v > 40 && v < 215) n++; } return n; };
    expect(mids(soft)).toBeGreaterThan(mids(sharp) + 10);
    for (const t of ['whip', 'zoom-punch']) expect(diff(runTransition(t, target(), solid(W, H, '#00ff00'), 0.4), runTransition(t, target(), solid(W, H, '#00ff00'), 0.4))).toBe(0);
  });
});
