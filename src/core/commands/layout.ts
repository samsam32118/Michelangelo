/** Layout commands: layout.grid (split screens and grids of clips). */
import { z } from 'zod';
import { fail } from '../errors.js';
import { defineCommand } from './registry.js';
import { Id, type Mask } from '../schema/index.js';
import { isKeyframes } from '../load.js';
import { layerBox } from './clip.js';

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

/** A mask layout.grid wrote earlier: a plain clip-space rect (no feather, radius, invert, mode or opacity). */
function isGridMask(m: Mask): boolean {
  return m.shape === 'rect' && m.space === 'clip' && !isKeyframes(m.box) && m.feather === undefined && m.radius === undefined && m.invert === undefined && (m.mode === undefined || m.mode === 'intersect') && m.opacity === undefined;
}

defineCommand({
  op: 'layout.grid', group: 'layout',
  doc: 'Place clips into the cells of a grid (split screens, 2x2 walls), in reading order: cols=/rows= (default: a near-square grid), gap= px between cells, box=[x, y, w, h] the grid area in comp px (default: the whole frame), fit=cover (default; fills each cell and crops the overflow with a clip-space rect mask) or contain (whole picture, letterboxed in the cell). Sets x, y and scale (media sizes come from the probe); re-running replaces the crop mask.',
  schema: z.strictObject({
    ids: z.array(Id).min(1), cols: z.number().int().min(1).optional(), rows: z.number().int().min(1).optional(), gap: z.number().min(0).optional(),
    box: z.tuple([z.number(), z.number(), z.number().positive(), z.number().positive()]).optional(), fit: z.enum(['cover', 'contain']).optional(),
  }),
  example: { ids: ['camA', 'camB'], cols: 1, gap: 8 },
  async apply(ctx, p) {
    const clips = [...new Set(p.ids)].map((id) => ctx.clip(id));
    const comp = ctx.compOfClip(clips[0]!);
    for (const c of clips) {
      if (ctx.compOfClip(c).id !== comp.id) fail('E_ARG', `clip "${c.id}" is in comp "${ctx.compOfClip(c).id}", not "${comp.id}".`, 'lay out clips of one comp at a time.');
      if (ctx.track(c.track).audio) fail('E_ARG', `clip "${c.id}" is an audio clip.`, 'lay out visual clips only.');
      if (c.locked || ctx.track(c.track).locked) fail('E_LOCKED', `clip "${c.id}" (or its track) is locked.`, `unlock it: mgl edit <file> clip.set ${c.id} locked=false`);
      for (const k of ['x', 'y', 'scale'] as const) if (isKeyframes(c[k])) fail('E_KEYFRAMED', `clip "${c.id}" ${k} is animated by keyframes; layout.grid sets a constant.`, `remove them first: mgl edit <file> key.clear ${c.id} prop=${k}`);
    }
    const n = clips.length;
    const cols = p.cols ?? (p.rows ? Math.ceil(n / p.rows) : Math.ceil(Math.sqrt(n)));
    const rows = p.rows ?? Math.ceil(n / cols);
    if (rows * cols < n) fail('E_ARG', `a ${cols}x${rows} grid has ${rows * cols} cells for ${n} clips.`, `use cols=${cols} rows=${Math.ceil(n / cols)}, or omit rows=.`);
    const [W, H] = comp.size;
    const [bx, by, bw, bh] = p.box ?? [0, 0, W, H];
    const gap = p.gap ?? 0;
    const cw = (bw - gap * (cols - 1)) / cols, ch = (bh - gap * (rows - 1)) / rows;
    if (cw <= 1 || ch <= 1) fail('E_RANGE', `the cells would be ${round(cw, 1)}x${round(ch, 1)} px.`, 'use a smaller gap= or fewer columns/rows.');
    const fit = p.fit ?? 'cover';
    const cells: { id: string; box: [number, number, number, number] }[] = [];
    for (const [i, c] of clips.entries()) {
      const r = Math.floor(i / cols), col = i % cols;
      const x0 = bx + col * (cw + gap), y0 = by + r * (ch + gap);
      cells.push({ id: c.id, box: [round(x0, 2), round(y0, 2), round(cw, 2), round(ch, 2)] });
      if (c.anchor && (c.anchor[0] !== 0.5 || c.anchor[1] !== 0.5)) { delete c.anchor; ctx.note(`reset the anchor of "${c.id}" to its centre.`); }
      if (c.rotate !== undefined && c.rotate !== 0) ctx.note(`"${c.id}" is rotated; its cell is computed unrotated.`);
      c.x = round(x0 + cw / 2, 2);
      c.y = round(y0 + ch / 2, 2);
      const masks = (c.masks ?? []).filter((m) => !isGridMask(m));
      const lb = await layerBox(ctx, c);
      if (!lb.known) {
        ctx.note(`"${c.id}" is ${c.text !== undefined ? 'text' : 'a shape'}: centred in its cell, not scaled.`);
        if (masks.length) c.masks = masks; else delete c.masks;
        continue;
      }
      const s = fit === 'contain' ? Math.min(cw / lb.w, ch / lb.h) : Math.max(cw / lb.w, ch / lb.h);
      c.scale = round(s, 4);
      if (fit === 'cover' && (s * lb.w > cw + 0.5 || s * lb.h > ch + 0.5)) {
        const fw = Math.min(1, cw / (s * lb.w)), fh = Math.min(1, ch / (s * lb.h));
        const m: Mask = { shape: 'rect', space: 'clip', box: [round((1 - fw) / 2, 5), round((1 - fh) / 2, 5), round(fw, 5), round(fh, 5)] };
        if (masks.length) m.mode = 'intersect';
        masks.push(m);
      }
      if (masks.length) c.masks = masks; else delete c.masks;
    }
    ctx.out.cells = cells;
    ctx.summary(`laid out ${n} clip(s) in a ${cols}x${rows} grid (${round(cw, 1)}x${round(ch, 1)} px cells, ${fit}).`);
  },
});
