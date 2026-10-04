import { test, assert, loadPlugin, tempFile, runCommandOn, testProject } from 'michelangelo/testing';

const plugin = await loadPlugin(import.meta.url);
const flite = plugin.providers!.find((p) => p.id === 'flite')!;
const { readFile } = await import('node:fs/promises');
// the plugin's own helpers (lazy, like its Node built-ins)
const { phrases, syllables, voicedSpan, wav } = await import('../src/index.ts');

/** samples and rate of a 16-bit mono WAV */
function readWav(b: Uint8Array) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { riff: String.fromCharCode(...b.subarray(0, 4)), rate: v.getUint32(24, true), bits: v.getUint16(34, true), samples: v.getUint32(40, true) / 2 };
}

test('the plugin provides one speak provider with the four flite voices', async () => {
  assert.equal(flite.kind, 'speak');
  if (flite.kind !== 'speak') return;
  assert.deepEqual((await flite.voices()).map((v) => v.id), ['slt', 'kal', 'rms', 'awb']);
});

test('text splits into phrases at punctuation, with longer pauses after sentences', () => {
  const p = phrases('Hello there, friend. Ready?  Go');
  assert.deepEqual(p.map((x) => x.text), ['Hello there,', 'friend.', 'Ready?', 'Go']);
  assert.ok(p[1]!.pause > p[0]!.pause);
  assert.equal(syllables('banana'), 3);
  assert.equal(syllables('the'), 1);
  assert.equal(syllables('42'), 4);
});

test('wav() writes a valid 48 kHz header and voicedSpan trims silence', () => {
  const pcm = new Int16Array(1000);
  pcm.fill(5000, 200, 700);
  assert.deepEqual(voicedSpan(pcm), [200, 700]);
  const h = readWav(wav(pcm));
  assert.deepEqual(h, { riff: 'RIFF', rate: 48000, bits: 16, samples: 1000 });
});

test('speak writes 48 kHz speech with increasing word timings, the same bytes every time', async () => {
  if (flite.kind !== 'speak') return;
  const a = tempFile('a.wav'), b = tempFile('b.wav');
  const r = await flite.speak({ text: 'Three tips for better sleep. Keep it cool, and dark.', voice: 'slt', out: a });
  await flite.speak({ text: 'Three tips for better sleep. Keep it cool, and dark.', voice: 'slt', out: b });
  const A = await readFile(a), B = await readFile(b);
  const h = readWav(A);
  assert.equal(h.rate, 48000);
  const dur = h.samples / 48000;
  assert.ok(dur > 1.5 && dur < 6, `duration ${dur}`);
  assert.ok(A.equals(B), 'deterministic');
  const w = r.words!;
  assert.equal(w.length, 10);
  assert.equal(w[0]!.text, 'Three');
  for (let i = 1; i < w.length; i++) assert.ok(w[i]!.start > w[i - 1]!.start);
  assert.ok(w[w.length - 1]!.end! <= dur);
  // the pause after "sleep." is longer than the gap between two words of a phrase
  assert.ok(w[5]!.start - w[4]!.end! > w[2]!.start - w[1]!.end!);
});

test('speed 1.5 is shorter; an unknown voice is refused', async () => {
  if (flite.kind !== 'speak') return;
  const a = tempFile('n.wav'), b = tempFile('f.wav');
  await flite.speak({ text: 'A quick test line.', out: a });
  await flite.speak({ text: 'A quick test line.', speed: 1.5, out: b });
  assert.ok(readWav(await readFile(b)).samples < readWav(await readFile(a)).samples * 0.8);
  await assert.rejects(flite.speak({ text: 'hi', voice: 'nope', out: tempFile('x.wav') }), /no voice "nope"/);
});

test('flite-voice.voices lists the voices', async () => {
  const r = await runCommandOn(testProject(), { op: 'flite-voice.voices' }, { plugins: [plugin] });
  assert.equal((r.out as { voices: unknown[] }).voices.length, 4);
});
