import { readFileSync } from 'node:fs';
const b = readFileSync('beat.wav');
let off = 12, data, rate = 48000, bits = 16;
while (off < b.length) {
  const id = b.toString('ascii', off, off + 4), sz = b.readUInt32LE(off + 4);
  if (id === 'fmt ') { rate = b.readUInt32LE(off + 12); bits = b.readUInt16LE(off + 22); }
  if (id === 'data') { data = b.subarray(off + 8, off + 8 + sz); break; }
  off += 8 + sz + (sz & 1);
}
const n = data.length / (bits / 8), win = rate / 100; // 10 ms
const rms = [];
for (let i = 0; i + win <= n; i += win) {
  let s = 0;
  for (let j = i; j < i + win; j++) { const v = bits === 16 ? data.readInt16LE(j * 2) / 32768 : data.readFloatLE(j * 4); s += v * v; }
  rms.push(Math.sqrt(s / win));
}
const max = Math.max(...rms);
let prev = 0, last = -1;
for (let k = 0; k < rms.length; k++) {
  if (rms[k] > max * 0.3 && prev <= max * 0.3 && k - last > 10) { console.log((k / 100).toFixed(2)); last = k; }
  prev = rms[k];
}
