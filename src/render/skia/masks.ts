/** Masks (rect/ellipse/path, feather, invert, add/subtract/intersect) and track mattes (alpha/luma). */
import { Path2D } from '@napi-rs/canvas';
import type { Surface } from '../../plugin/api.js';
import type { Matrix, ResolvedMask } from '../types.js';

function maskPath(m: ResolvedMask): Path2D {
  const p = new Path2D();
  if (m.shape === 'path') return new Path2D(m.d ?? '');
  const [x, y, w, h] = m.box ?? [0, 0, 0, 0];
  if (m.shape === 'ellipse') p.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, 2 * Math.PI);
  else if (m.radius) p.roundRect(x, y, w, h, Math.min(m.radius, Math.abs(w) / 2, Math.abs(h) / 2));
  else p.rect(x, y, w, h);
  return p;
}

const scaleOf = (t: Matrix) => Math.sqrt(Math.abs(t[0] * t[3] - t[1] * t[2]));

/**
 * Cut `target` by its masks. `compT` maps comp px → target px, `layerT` maps layer px → target px
 * (used for masks with space "clip").
 */
export function applyMasks(target: Surface, masks: ResolvedMask[], compT: Matrix, layerT: Matrix): void {
  if (!masks.length) return;
  const acc = target.scratch();
  const first = masks[0]!.mode ?? 'add';
  if (first !== 'add') { acc.ctx.fillStyle = '#fff'; acc.ctx.fillRect(0, 0, acc.width, acc.height); }
  for (const m of masks) {
    const piece = acc.scratch();
    const c = piece.ctx;
    const t = m.space === 'clip' ? layerT : compT;
    const alpha = m.opacity ?? 1;
    const feather = (m.feather ?? 0) * scaleOf(t);
    if (m.invert) { c.fillStyle = `rgba(255,255,255,${alpha})`; c.fillRect(0, 0, piece.width, piece.height); c.globalCompositeOperation = 'destination-out'; c.fillStyle = '#fff'; }
    else c.fillStyle = `rgba(255,255,255,${alpha})`;
    if (feather > 0) c.filter = `blur(${feather / 2}px)`;
    c.setTransform(t[0], t[1], t[2], t[3], t[4], t[5]);
    c.fill(maskPath(m));
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.filter = 'none';
    const mode = m.mode ?? 'add';
    acc.ctx.globalCompositeOperation = mode === 'subtract' ? 'destination-out' : mode === 'intersect' ? 'destination-in' : 'source-over';
    acc.ctx.drawImage(piece.canvas, 0, 0);
    acc.ctx.globalCompositeOperation = 'source-over';
  }
  const tc = target.ctx;
  tc.save();
  tc.setTransform(1, 0, 0, 1, 0, 0);
  tc.globalAlpha = 1;
  tc.globalCompositeOperation = 'destination-in';
  tc.drawImage(acc.canvas, 0, 0);
  tc.restore();
}

/** Keep `target` only where `matte` is opaque (alpha) or bright (luma); inverted modes keep the rest. */
export function applyMatte(target: Surface, matte: Surface, mode: 'alpha' | 'luma' | 'alpha-inverted' | 'luma-inverted'): void {
  if (mode.startsWith('luma')) {
    const px = matte.pixels();
    for (let i = 0; i < px.length; i += 4) {
      const l = (0.2126 * px[i]! + 0.7152 * px[i + 1]! + 0.0722 * px[i + 2]!) / 255;
      px[i + 3] = px[i + 3]! * l;
      px[i] = px[i + 1] = px[i + 2] = 255;
    }
    matte.commit();
  }
  const tc = target.ctx;
  tc.save();
  tc.setTransform(1, 0, 0, 1, 0, 0);
  tc.globalAlpha = 1;
  tc.globalCompositeOperation = mode.endsWith('inverted') ? 'destination-out' : 'destination-in';
  tc.drawImage(matte.canvas, 0, 0);
  tc.restore();
}
