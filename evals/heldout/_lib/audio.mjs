// Audio measures on mono Float32Array PCM.

export const db = (p) => 10 * Math.log10(Math.max(p, 1e-20));

/** RMS level in dBFS of x[i0, i1). */
export function rmsDb(x, i0 = 0, i1 = x.length) {
  let s = 0;
  i0 = Math.max(0, i0); i1 = Math.min(x.length, i1);
  for (let i = i0; i < i1; i++) s += x[i] * x[i];
  return i1 > i0 ? db(s / (i1 - i0)) : -200;
}

/** Power (dB) of the sinusoid at exactly f Hz in x[t0, t1) seconds: Hann-windowed single-bin DFT. */
export function toneDb(x, rate, f, t0, t1) {
  const i0 = Math.max(0, Math.round(t0 * rate)), i1 = Math.min(x.length, Math.round(t1 * rate)), n = i1 - i0;
  if (n < 16) return -200;
  let re = 0, im = 0, ws = 0;
  const w = 2 * Math.PI * f / rate;
  for (let k = 0; k < n; k++) {
    const win = 0.5 - 0.5 * Math.cos(2 * Math.PI * k / (n - 1)), v = x[i0 + k] * win;
    re += v * Math.cos(w * k); im -= v * Math.sin(w * k); ws += win;
  }
  return db(2 * (re * re + im * im) / (ws * ws));
}

/** In-place radix-2 FFT (re, im of length 2^k). */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j], ui = im[i + j], k = i + j + len / 2;
        const vr = re[k] * cr - im[k] * ci, vi = re[k] * ci + im[k] * cr;
        re[i + j] = ur + vr; im[i + j] = ui + vi; re[k] = ur - vr; im[k] = ui - vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

/** Welch power spectrum of x[t0, t1): {psd: Float64Array (per bin), hz: bin width}. */
export function spectrum(x, rate, { t0 = 0, t1 = x.length / rate, n = 8192 } = {}) {
  const i0 = Math.max(0, Math.round(t0 * rate)), i1 = Math.min(x.length, Math.round(t1 * rate));
  const psd = new Float64Array(n / 2), win = Float64Array.from({ length: n }, (_, k) => 0.5 - 0.5 * Math.cos(2 * Math.PI * k / (n - 1)));
  let frames = 0;
  for (let s = i0; s + n <= i1; s += n / 2) {
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let k = 0; k < n; k++) re[k] = x[s + k] * win[k];
    fft(re, im);
    for (let k = 0; k < n / 2; k++) psd[k] += re[k] * re[k] + im[k] * im[k];
    frames++;
  }
  if (frames) for (let k = 0; k < n / 2; k++) psd[k] /= frames;
  return { psd, hz: rate / n };
}

/** Total power (dB, arbitrary reference consistent across calls with the same n) in [f0, f1] Hz. */
export function bandDb({ psd, hz }, f0, f1) {
  let s = 0;
  for (let k = Math.ceil(f0 / hz); k <= Math.floor(f1 / hz) && k < psd.length; k++) s += psd[k];
  return db(s);
}

/** Envelope: RMS per hop seconds. */
export function envelope(x, rate, hop = 0.01) {
  const n = Math.max(1, Math.round(hop * rate)), out = new Float64Array(Math.floor(x.length / n));
  for (let i = 0; i < out.length; i++) { let s = 0; for (let k = 0; k < n; k++) { const v = x[i * n + k]; s += v * v; } out[i] = Math.sqrt(s / n); }
  return out;
}

/** Pearson correlation of a and b with b shifted by lag (b[i + lag] against a[i]). */
export function corr(a, b, lag = 0) {
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
  for (let i = 0; i < a.length; i++) {
    const j = i + lag;
    if (j < 0 || j >= b.length) continue;
    sa += a[i]; sb += b[j]; saa += a[i] * a[i]; sbb += b[j] * b[j]; sab += a[i] * b[j]; n++;
  }
  if (n < 2) return 0;
  const cov = sab / n - (sa / n) * (sb / n), va = saa / n - (sa / n) ** 2, vb = sbb / n - (sb / n) ** 2;
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
}

/** Best envelope correlation of out against ref within +/- maxLag seconds: {lag (s, + = out late), r}. */
export function envelopeLag(out, ref, rate, maxLag = 0.5, hop = 0.004) {
  const eo = envelope(out, rate, hop), er = envelope(ref, rate, hop), m = Math.round(maxLag / hop);
  let best = { lag: 0, r: -1 };
  for (let l = -m; l <= m; l++) { const r = corr(er, eo, l); if (r > best.r) best = { lag: l * hop, r }; }
  return best;
}
