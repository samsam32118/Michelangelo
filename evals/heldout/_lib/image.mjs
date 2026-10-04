// Pixel measures on RGB images {width, height, data} and gray buffers.

export const hexRGB = (hex) => { const h = hex.replace('#', ''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };

/** Luma (BT.709) as Float32Array; accepts an RGB image or a gray Uint8Array (returned as floats). */
export function luma(img) {
  if (img instanceof Uint8Array) return Float32Array.from(img);
  const n = img.width * img.height, out = new Float32Array(n), d = img.data;
  for (let i = 0; i < n; i++) out[i] = 0.2126 * d[3 * i] + 0.7152 * d[3 * i + 1] + 0.0722 * d[3 * i + 2];
  return out;
}

export function meanStd(arr) {
  let s = 0, s2 = 0;
  for (const v of arr) { s += v; s2 += v * v; }
  const m = s / arr.length;
  return { mean: m, std: Math.sqrt(Math.max(0, s2 / arr.length - m * m)) };
}

/**
 * SSIM of two same-size images (luma), 8x8 windows at stride 4. `exclude` = [x0, y0, x1, y1] (pixels) skips
 * windows whose centre lies inside it.
 */
export function ssim(a, b, w, h, { exclude } = {}) {
  if (!a || !b) return 0;
  const A = luma(a), B = luma(b);
  if (a.width) { w = a.width; h = a.height; }
  if (A.length !== B.length) return 0;
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
  let sum = 0, n = 0;
  for (let y = 0; y + 8 <= h; y += 4) for (let x = 0; x + 8 <= w; x += 4) {
    if (exclude && x + 4 >= exclude[0] && x + 4 < exclude[2] && y + 4 >= exclude[1] && y + 4 < exclude[3]) continue;
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let j = 0; j < 8; j++) {
      const o = (y + j) * w + x;
      for (let i = 0; i < 8; i++) { const p = A[o + i], q = B[o + i]; sa += p; sb += q; saa += p * p; sbb += q * q; sab += p * q; }
    }
    const ma = sa / 64, mb = sb / 64, va = saa / 64 - ma * ma, vb = sbb / 64 - mb * mb, cv = sab / 64 - ma * mb;
    sum += ((2 * ma * mb + C1) * (2 * cv + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
    n++;
  }
  return n ? sum / n : 0;
}

const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const LIN = Float64Array.from({ length: 256 }, (_, i) => lin(i));
const fLab = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
export function lab(r, g, b) {
  const R = LIN[r], G = LIN[g], B = LIN[b];
  const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047, y = 0.2126 * R + 0.7152 * G + 0.0722 * B, z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const fx = fLab(x), fy = fLab(y), fz = fLab(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
export const deltaE = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

/** Mask (Uint8Array) of pixels within dE of colour `hex`, optionally limited to region [x0,y0,x1,y1]. */
export function colorMask(img, hex, dE, region) {
  const ref = lab(...hexRGB(hex)), { width: W, height: H, data: d } = img, m = new Uint8Array(W * H);
  const [x0, y0, x1, y1] = region ?? [0, 0, W, H];
  const cache = new Map();
  for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
    const i = y * W + x, key = (d[3 * i] << 16) | (d[3 * i + 1] << 8) | d[3 * i + 2];
    let v = cache.get(key);
    if (v === undefined) { v = deltaE(lab(d[3 * i], d[3 * i + 1], d[3 * i + 2]), ref) < dE ? 1 : 0; cache.set(key, v); }
    m[i] = v;
  }
  return m;
}

/** Count of set pixels in a mask inside region. */
export function maskCount(m, W, region) {
  const H = m.length / W, [x0, y0, x1, y1] = region ?? [0, 0, W, H];
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) n += m[y * W + x];
  return n;
}

/** Connected components (4-neighbour) of a mask, largest first: {area, cx, cy, x0, y0, x1, y1}. */
export function blobs(m, W, { minArea = 1 } = {}) {
  const H = m.length / W, lbl = new Int32Array(W * H), stack = new Int32Array(W * H), res = [];
  let next = 0;
  for (let s = 0; s < m.length; s++) {
    if (!m[s] || lbl[s]) continue;
    next++;
    let sp = 0, area = 0, sx = 0, sy = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
    stack[sp++] = s; lbl[s] = next;
    while (sp) {
      const p = stack[--sp], x = p % W, y = (p - x) / W;
      area++; sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      const nb = [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1];
      for (const q of nb) if (q >= 0 && m[q] && !lbl[q]) { lbl[q] = next; stack[sp++] = q; }
    }
    if (area >= minArea) res.push({ area, cx: sx / area, cy: sy / area, x0, y0, x1, y1 });
  }
  return res.sort((a, b) => b.area - a.area);
}

/** Mask of pixels whose Sobel luma gradient exceeds thr. */
export function edgeMask(img, thr = 120) {
  const W = img.width, H = img.height, L = luma(img), m = new Uint8Array(W * H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    const gx = L[i - W + 1] + 2 * L[i + 1] + L[i + W + 1] - L[i - W - 1] - 2 * L[i - 1] - L[i + W - 1];
    const gy = L[i + W - 1] + 2 * L[i + W] + L[i + W + 1] - L[i - W - 1] - 2 * L[i - W] - L[i - W + 1];
    m[i] = Math.hypot(gx, gy) > thr ? 1 : 0;
  }
  return m;
}

/** Fraction of pixels in region whose Sobel luma gradient exceeds `thr` (text edges are dense). */
export function edgeDensity(img, region, thr = 120) {
  const W = img.width, H = img.height, L = luma(img);
  const [x0, y0, x1, y1] = region ?? [0, 0, W, H];
  let n = 0, tot = 0;
  for (let y = Math.max(1, y0); y < Math.min(H - 1, y1); y++) for (let x = Math.max(1, x0); x < Math.min(W - 1, x1); x++) {
    const i = y * W + x;
    const gx = L[i - W + 1] + 2 * L[i + 1] + L[i + W + 1] - L[i - W - 1] - 2 * L[i - 1] - L[i + W - 1];
    const gy = L[i + W - 1] + 2 * L[i + W] + L[i + W + 1] - L[i - W - 1] - 2 * L[i - W] - L[i - W + 1];
    if (Math.hypot(gx, gy) > thr) n++;
    tot++;
  }
  return tot ? n / tot : 0;
}

/** Mask of pixels where two same-size RGB images differ by more than thr in some channel. */
export function diffMask(a, b, thr = 60) {
  const n = a.width * a.height, m = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const d = Math.max(Math.abs(a.data[3 * i] - b.data[3 * i]), Math.abs(a.data[3 * i + 1] - b.data[3 * i + 1]), Math.abs(a.data[3 * i + 2] - b.data[3 * i + 2]));
    m[i] = d > thr ? 1 : 0;
  }
  return m;
}

/** Mean absolute luma difference of two images/gray buffers. */
export function meanAbsDiff(a, b) {
  const A = luma(a), B = luma(b);
  if (A.length !== B.length) return 255;
  let s = 0;
  for (let i = 0; i < A.length; i++) s += Math.abs(A[i] - B[i]);
  return s / A.length;
}

/** Average RGB of a region. */
export function avgRGB(img, [x0, y0, x1, y1]) {
  const s = [0, 0, 0];
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = 3 * (y * img.width + x); s[0] += img.data[i]; s[1] += img.data[i + 1]; s[2] += img.data[i + 2]; n++; }
  return s.map((v) => Math.round(v / n));
}

/** Number of distinct-ish colours: std of luma plus channel spread (0 for a single colour image). */
export function colourSpread(img) {
  const { std } = meanStd(luma(img));
  let rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0;
  for (let i = 0; i < img.data.length; i += 3) {
    const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
    if (r < rmin) rmin = r; if (r > rmax) rmax = r; if (g < gmin) gmin = g; if (g > gmax) gmax = g; if (b < bmin) bmin = b; if (b > bmax) bmax = b;
  }
  return { std, range: Math.max(rmax - rmin, gmax - gmin, bmax - bmin) };
}

/** Longest vertical run of set pixels in any column of a mask. */
export function longestVerticalRun(m, W) {
  const H = m.length / W;
  let best = 0;
  for (let x = 0; x < W; x++) {
    let run = 0;
    for (let y = 0; y < H; y++) { if (m[y * W + x]) { run++; if (run > best) best = run; } else run = 0; }
  }
  return best;
}
