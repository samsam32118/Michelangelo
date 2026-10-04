// Frame-counter fixtures: each frame carries its index as a 12-bit binary code in the top band (black/white
// stripes, least significant bit on the left) plus, when drawtext exists, the number for humans. Decoding is
// robust to scaling and compression, unlike OCR.
import { ffmpeg } from './util.mjs';
import { ensureDir, X264, hasDrawtext, drawtext } from './fixtures.mjs';
import { box, meanColor, luma } from './frames.mjs';

export const BITS = 12;

/** Write a counter video: `d` seconds at `fps`, size w x h; the code band is the top quarter. */
export async function counterVideo(out, { d = 10, fps = 30, w = 1280, h = 720, bg = 'gray' } = {}) {
  ensureDir(out);
  await hasDrawtext();
  const sw = w / BITS, bandH = Math.round(h / 4);
  const boxes = [`drawbox=x=0:y=0:w=${w}:h=${bandH}:color=black:t=fill`];
  for (let b = 0; b < BITS; b++) boxes.push(`drawbox=x=${Math.round(b * sw + sw * 0.1)}:y=${Math.round(bandH * 0.1)}:w=${Math.round(sw * 0.8)}:h=${Math.round(bandH * 0.8)}:color=white:t=fill:enable='eq(mod(floor(n/${2 ** b}),2),1)'`);
  const txt = drawtext('%{frame_num}', { fontsize: Math.round(h / 3), y: `${Math.round(h * 0.45)}` }).replace("\\%{frame_num}", '%{frame_num}');
  await ffmpeg(['-f', 'lavfi', '-i', `color=${bg}:size=${w}x${h}:rate=${fps}:duration=${d}`, '-vf', [...boxes, ...(txt ? [txt] : [])].join(','), ...X264, '-g', '15', out]);
  return out;
}

/**
 * Read the counter from a frame. `region` is where the counter video sits in the frame ([x, y, w, h], default
 * the whole frame). Returns the frame number, or -1 when the band does not look like a code.
 */
export function readCounter(img, region) {
  const [x0, y0, w, h] = region ? box(img, region) : [0, 0, img.width, img.height];
  const sw = w / BITS, bandH = h / 4;
  let v = 0;
  for (let b = 0; b < BITS; b++) {
    const c = meanColor(img, [x0 + b * sw + sw * 0.3, y0 + bandH * 0.3, sw * 0.4, bandH * 0.4]);
    const l = luma(...c);
    if (l > 0.6) v |= 1 << b;
    else if (l > 0.35) return -1;
  }
  return v;
}
