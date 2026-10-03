/** Surface: the plugin API's drawable RGBA buffer, backed by a Skia canvas. */
import { createCanvas, type Canvas } from '@napi-rs/canvas';
import type { Surface } from './api.js';

export function createSurface(width: number, height: number): Surface {
  const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
  const canvas: Canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  let img: ReturnType<typeof ctx.getImageData> | null = null;
  const s: Surface = {
    width: w,
    height: h,
    ctx,
    canvas,
    pixels() {
      img = ctx.getImageData(0, 0, w, h);
      return img.data;
    },
    commit() {
      if (img) { ctx.putImageData(img, 0, 0); img = null; }
    },
    clear() {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, w, h);
      ctx.restore();
    },
    scratch(sw?: number, sh?: number) { return createSurface(sw ?? w, sh ?? h); },
  };
  return s;
}

/** Copy raw RGBA bytes into a new surface. */
export function surfaceFromRGBA(width: number, height: number, data: Uint8Array | Uint8ClampedArray): Surface {
  const s = createSurface(width, height);
  const id = s.ctx.createImageData(width, height);
  id.data.set(data);
  s.ctx.putImageData(id, 0, 0);
  return s;
}
