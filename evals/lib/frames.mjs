// Decoded frames as RGBA images and pixel statistics on them. An image is {width, height, data: Uint8Array RGBA}.
import { FFMPEG, run } from './util.mjs';
import { probe } from './probe.mjs';

/**
 * Decode the frame at time t (seconds) of a video, or an image file, to RGBA.
 * opts.width/height scale (one may be -1 to keep aspect). Returns undefined if nothing decodes.
 */
export async function frameAt(file, t = 0, opts = {}) {
  const info = await probe(file);
  if (!info?.video) return undefined;
  let w = info.displayWidth, h = info.displayHeight;
  if (opts.width || opts.height) {
    w = opts.width > 0 ? opts.width : Math.round(((opts.height / h) * w) / 2) * 2;
    h = opts.height > 0 ? opts.height : Math.round(((opts.width / info.displayWidth) * h) / 2) * 2;
  }
  const isStill = /^(png|mjpeg|webp|bmp|tiff)$/.test(info.video.codec) && !(info.duration > 0.1);
  const seek = isStill ? [] : ['-ss', String(Math.max(0, t))];
  const vf = [`scale=${w}:${h}:flags=bicubic`, 'format=rgba'];
  const r = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...seek, '-i', file, '-frames:v', '1', '-vf', vf.join(','), '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { timeoutMs: 120_000 });
  if (r.code !== 0 || r.stdout.length < w * h * 4) {
    // seeking past the end: take the last frame
    if (!isStill && t > 0 && info.duration && t >= info.duration - 0.2) return frameAt(file, Math.max(0, info.duration - 0.1 - (opts._back ?? 0)), { ...opts, _back: (opts._back ?? 0) + 0.2 });
    return undefined;
  }
  return { width: w, height: h, data: new Uint8Array(r.stdout.buffer, r.stdout.byteOffset, w * h * 4) };
}

/** Decode every frame (scaled small) of a video: [{width,height,data}] in order. */
export async function allFrames(file, { width = 160, height = -1, fps } = {}) {
  const info = await probe(file);
  if (!info?.video) return [];
  const w = width, h = height > 0 ? height : Math.round(((width / info.displayWidth) * info.displayHeight) / 2) * 2;
  const vf = [...(fps ? [`fps=${fps}`] : []), `scale=${w}:${h}:flags=area`, 'format=rgba'];
  const r = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file, '-vf', vf.join(','), '-vsync', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { timeoutMs: 300_000 });
  if (r.code !== 0) return [];
  const size = w * h * 4, out = [];
  for (let o = 0; o + size <= r.stdout.length; o += size) out.push({ width: w, height: h, data: new Uint8Array(r.stdout.buffer, r.stdout.byteOffset + o, size) });
  return out;
}

/** A box [x, y, w, h] clamped to the image; fractions (all ≤ 1) are taken relative to the size. */
export function box(img, b) {
  if (!b) return [0, 0, img.width, img.height];
  let [x, y, w, h] = b;
  if (b.every((v) => v <= 1)) { x *= img.width; y *= img.height; w *= img.width; h *= img.height; }
  x = Math.max(0, Math.round(x)); y = Math.max(0, Math.round(y));
  w = Math.max(0, Math.min(img.width - x, Math.round(w))); h = Math.max(0, Math.min(img.height - y, Math.round(h)));
  return [x, y, w, h];
}

export const px = (img, x, y) => { const i = (y * img.width + x) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]]; };
export const luma = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

function forBox(img, b, fn) {
  const [x0, y0, w, h] = box(img, b);
  const d = img.data;
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { const i = (y * img.width + x) * 4; fn(d[i], d[i + 1], d[i + 2], x, y, i); }
  return w * h;
}

/** Mean [r, g, b] of a box. */
export function meanColor(img, b) {
  let r = 0, g = 0, bl = 0;
  const n = forBox(img, b, (R, G, B) => { r += R; g += G; bl += B; });
  return n ? [r / n, g / n, bl / n] : [0, 0, 0];
}

/** Luma statistics (0..1) of a box: mean, min, max, std. */
export function lumaStats(img, b) {
  let s = 0, s2 = 0, mn = 1, mx = 0;
  const n = forBox(img, b, (R, G, B) => { const l = luma(R, G, B); s += l; s2 += l * l; if (l < mn) mn = l; if (l > mx) mx = l; });
  const mean = n ? s / n : 0;
  return { mean, min: mn, max: mx, std: n ? Math.sqrt(Math.max(0, s2 / n - mean * mean)) : 0 };
}

/** Mean absolute difference (0..255) between two same-size images in a box, and the fraction of pixels differing by > thresh. */
export function frameDiff(a, b, { box: bx, thresh = 40 } = {}) {
  if (!a || !b || a.width !== b.width || a.height !== b.height) return { mean: 255, changed: 1 };
  let s = 0, changed = 0;
  const n = forBox(a, bx, (R, G, B, x, y, i) => {
    const d = Math.max(Math.abs(R - b.data[i]), Math.abs(G - b.data[i + 1]), Math.abs(B - b.data[i + 2]));
    s += (Math.abs(R - b.data[i]) + Math.abs(G - b.data[i + 1]) + Math.abs(B - b.data[i + 2])) / 3;
    if (d > thresh) changed++;
  });
  return { mean: n ? s / n : 0, changed: n ? changed / n : 0 };
}

/** Boolean mask (Uint8Array, 1 per pixel) of pixels satisfying pred(r, g, b, x, y). */
export function mask(img, pred, b) {
  const m = new Uint8Array(img.width * img.height);
  forBox(img, b, (R, G, B, x, y) => { if (pred(R, G, B, x, y)) m[y * img.width + x] = 1; });
  return m;
}

/** Statistics of a mask: count, fraction, centroid, bbox [x, y, w, h] (rows/cols with ≥ minPerLine pixels). */
export function maskStats(m, width, height, { minPerLine = 1 } = {}) {
  let n = 0, sx = 0, sy = 0;
  const cols = new Uint32Array(width), rows = new Uint32Array(height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (m[y * width + x]) { n++; sx += x; sy += y; cols[x]++; rows[y]++; }
  const span = (arr) => { let a = -1, b = -1; arr.forEach((v, i) => { if (v >= minPerLine) { if (a < 0) a = i; b = i; } }); return a < 0 ? null : [a, b]; };
  const cx = span(cols), cy = span(rows);
  return { count: n, fraction: n / (width * height), centroid: n ? [sx / n, sy / n] : null, bbox: cx && cy ? [cx[0], cy[0], cx[1] - cx[0] + 1, cy[1] - cy[0] + 1] : null, cols, rows };
}

/** Centroid [x, y] and count of pixels matching a predicate (null centroid when none). */
export function centroid(img, pred, b) {
  const s = maskStats(mask(img, pred, b), img.width, img.height);
  return { centroid: s.centroid, count: s.count, bbox: s.bbox };
}

/** Connected components (4-connected) of a mask: [{area, bbox, centroid}] sorted by area, largest first. */
export function components(m, width, height, minArea = 1) {
  const label = new Int32Array(width * height);
  const res = [];
  const stack = [];
  for (let start = 0; start < m.length; start++) {
    if (!m[start] || label[start]) continue;
    const id = res.length + 1;
    let area = 0, x0 = width, y0 = height, x1 = -1, y1 = -1, sx = 0, sy = 0;
    stack.push(start); label[start] = id;
    while (stack.length) {
      const p = stack.pop(), x = p % width, y = (p - x) / width;
      area++; sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, y > 0 ? p - width : -1, y < height - 1 ? p + width : -1]) {
        if (q >= 0 && m[q] && !label[q]) { label[q] = id; stack.push(q); }
      }
    }
    res.push({ area, bbox: [x0, y0, x1 - x0 + 1, y1 - y0 + 1], centroid: [sx / area, sy / area] });
  }
  return res.filter((c) => c.area >= minArea).sort((a, b) => b.area - a.area);
}

/** Distinct colour clusters in a box: greedy clustering within `radius` (RGB distance); clusters with ≥ minShare of pixels. */
export function colorClusters(img, { box: b, radius = 40, minShare = 0.02, step = 1, pred } = {}) {
  const clusters = [];
  let total = 0;
  const [x0, y0, w, h] = box(img, b);
  for (let y = y0; y < y0 + h; y += step) for (let x = x0; x < x0 + w; x += step) {
    const [R, G, B] = px(img, x, y);
    if (pred && !pred(R, G, B)) continue;
    total++;
    let best = null, bd = radius;
    for (const c of clusters) { const d = Math.hypot(c.c[0] - R, c.c[1] - G, c.c[2] - B); if (d < bd) { bd = d; best = c; } }
    if (best) { best.n++; best.s[0] += R; best.s[1] += G; best.s[2] += B; }
    else clusters.push({ c: [R, G, B], s: [R, G, B], n: 1 });
  }
  return clusters.filter((c) => c.n >= minShare * total).map((c) => ({ color: c.s.map((v) => Math.round(v / c.n)), share: c.n / total })).sort((a, b) => b.share - a.share);
}

/** Distinct value clusters per channel in a box: values with ≥ minShare frequency merged when within `gap`. */
export function channelLevels(img, { box: b, gap = 12, minShare = 0.005 } = {}) {
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  const n = forBox(img, b, (R, G, B) => { hist[0][R]++; hist[1][G]++; hist[2][B]++; });
  return hist.map((hh) => {
    const levels = [];
    let last = -1000;
    for (let v = 0; v < 256; v++) if (hh[v] >= minShare * n) { if (v - last > gap) levels.push(v); last = v; }
    return levels.length;
  });
}

const near = (a, b, t) => Math.abs(a - b) <= t;
/**
 * Glyph pixel density: the fraction of pixels in a band that look like text (near-white with near-black within
 * `reach` px, or near-black with near-white within reach: an outlined or high-contrast glyph edge).
 * Pass `ref` (a frame without text) to get the density above the reference: max(0, d - dRef).
 */
export function glyphDensity(img, { band, ref, reach = 4, white = 200, black = 70 } = {}) {
  const dens = (im) => {
    const [x0, y0, w, h] = box(im, band);
    const W = im.width, d = im.data;
    const isW = (i) => d[i] >= white && d[i + 1] >= white && d[i + 2] >= white;
    const isB = (i) => d[i] <= black && d[i + 1] <= black && d[i + 2] <= black;
    let hits = 0;
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
      const i = (y * W + x) * 4;
      const want = isW(i) ? isB : isB(i) ? isW : null;
      if (!want) continue;
      let found = false;
      for (let dy = -reach; dy <= reach && !found; dy += 2) for (let dx = -reach; dx <= reach && !found; dx += 2) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < W && yy < im.height && want(((yy * W) + xx) * 4)) found = true;
      }
      if (found) hits++;
    }
    return w * h ? hits / (w * h) : 0;
  };
  const d = dens(img);
  return ref ? Math.max(0, d - dens(ref)) : d;
}

/** Fraction of pixels in a box whose colour is far (> thresh, max channel) from a reference image or a constant colour. */
export function diffFraction(img, refOrColor, { box: b, thresh = 60 } = {}) {
  const isColor = Array.isArray(refOrColor);
  let c = 0;
  const n = forBox(img, b, (R, G, B, x, y, i) => {
    const r = isColor ? refOrColor : [refOrColor.data[i], refOrColor.data[i + 1], refOrColor.data[i + 2]];
    if (Math.max(Math.abs(R - r[0]), Math.abs(G - r[1]), Math.abs(B - r[2])) > thresh) c++;
  });
  return n ? c / n : 0;
}

/** Edge density: fraction of pixels whose horizontal or vertical luma step exceeds `thresh` (0..1). Text and graphics have edges. */
export function edgeDensity(img, { box: b, thresh = 0.25 } = {}) {
  let c = 0;
  const n = forBox(img, b, (R, G, B, x, y, i) => {
    if (x + 1 >= img.width || y + 1 >= img.height) return;
    const l = luma(R, G, B), d = img.data, j = i + 4, k = i + img.width * 4;
    if (Math.abs(l - luma(d[j], d[j + 1], d[j + 2])) > thresh || Math.abs(l - luma(d[k], d[k + 1], d[k + 2])) > thresh) c++;
  });
  return n ? c / n : 0;
}

/** Nearest-neighbour resize (for comparing regions at different scales). */
export function resize(img, w, h) {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.min(img.width - 1, Math.floor(((x + 0.5) * img.width) / w)), sy = Math.min(img.height - 1, Math.floor(((y + 0.5) * img.height) / h));
    out.set(img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (y * w + x) * 4);
  }
  return { width: w, height: h, data: out };
}

/** Crop a box out of an image. */
export function crop(img, b) {
  const [x0, y0, w, h] = box(img, b);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) out.set(img.data.subarray(((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + w) * 4), y * w * 4);
  return { width: w, height: h, data: out };
}

/** Parse "#rrggbb" to [r, g, b]. */
export function hex(c) {
  const s = String(c).replace('#', '');
  const f = s.length === 3 ? s.split('').map((x) => x + x).join('') : s.slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16));
}

/** CIE76 delta E between two sRGB colours. */
export function deltaE(a, b) {
  const lab = ([r, g, bl]) => {
    const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const [R, G, B] = [lin(r), lin(g), lin(bl)];
    const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047, Y = R * 0.2126 + G * 0.7152 + B * 0.0722, Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
  };
  const [l1, a1, b1] = lab(a), [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

export { near };

/** Dilate a mask by r px (square neighbourhood, separable): groups nearby pieces (letters of a word) into one blob. */
export function dilate(m, width, height, r) {
  const tmp = new Uint8Array(m.length), out = new Uint8Array(m.length);
  for (let y = 0; y < height; y++) {
    let run = -1e9;
    for (let x = 0; x < width; x++) { if (m[y * width + x]) run = x; if (x - run <= r) tmp[y * width + x] = 1; }
    run = 1e9;
    for (let x = width - 1; x >= 0; x--) { if (m[y * width + x]) run = x; if (run - x <= r) tmp[y * width + x] = 1; }
  }
  for (let x = 0; x < width; x++) {
    let run = -1e9;
    for (let y = 0; y < height; y++) { if (tmp[y * width + x]) run = y; if (y - run <= r) out[y * width + x] = 1; }
    run = 1e9;
    for (let y = height - 1; y >= 0; y--) { if (tmp[y * width + x]) run = y; if (run - y <= r) out[y * width + x] = 1; }
  }
  return out;
}
