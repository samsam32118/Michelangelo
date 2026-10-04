/** WAV encoding/decoding (PCM 16-bit, stereo or mono, 48 kHz by default) for the generators: pure, no I/O. */
import { SR, rng } from './dsp.js';

/** Encode channels as 16-bit PCM WAV with seeded TPDF dither (deterministic bytes). */
export function encodeWav(chans: Float32Array[], sampleRate = SR, seed = 1): Uint8Array {
  const nch = chans.length, n = chans[0]!.length;
  const dataBytes = n * nch * 2;
  const out = new Uint8Array(44 + dataBytes);
  const v = new DataView(out.buffer);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
  str(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nch, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * nch * 2, true); v.setUint16(32, nch * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, dataBytes, true);
  const r = rng(seed);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) {
    const x = chans[c]![i]! * 32767 + (r() - r());
    v.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(x))), true);
    o += 2;
  }
  return out;
}

/** Decode a 16-bit PCM WAV (as written by encodeWav) back to float channels. */
export function decodeWav(bytes: Uint8Array): { sampleRate: number; chans: Float32Array[] } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let o = 12, nch = 2, sampleRate = SR, bits = 16;
  while (o + 8 <= bytes.length) {
    const id = tag(o), size = v.getUint32(o + 4, true);
    if (id === 'fmt ') { nch = v.getUint16(o + 10, true); sampleRate = v.getUint32(o + 12, true); bits = v.getUint16(o + 22, true); }
    if (id === 'data') {
      if (bits !== 16) throw new Error('only 16-bit PCM is supported');
      const n = Math.floor(size / (2 * nch));
      const chans = Array.from({ length: nch }, () => new Float32Array(n));
      for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) chans[c]![i] = v.getInt16(o + 8 + (i * nch + c) * 2, true) / 32768;
      return { sampleRate, chans };
    }
    o += 8 + size + (size & 1);
  }
  throw new Error('WAV has no data chunk');
}
