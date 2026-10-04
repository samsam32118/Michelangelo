import { test, assert, loadPlugin, tempFile, runCommandOn, testProject } from 'michelangelo/testing';

const plugin = await loadPlugin(import.meta.url);
const piper = plugin.providers!.find((p) => p.id === 'piper')!;
const { readFile, writeFile, mkdir, mkdtemp, chmod } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
// the plugin's own helpers (lazy, like its Node built-ins)
const { syllables, estimateWords, voicedSpan, wav, listVoices } = await import('../src/index.ts');

/**
 * A stand-in for the Piper binary, so the tests need no model: it reads the text on stdin and writes a 22.05 kHz
 * WAV with 0.3 s of silence, a tone as long as `length_scale` seconds, and 0.3 s of silence.
 */
const FAKE = `#!/bin/sh
out=""; scale=1
while [ $# -gt 0 ]; do case "$1" in --output_file) out="$2"; shift 2 ;; --length_scale) scale="$2"; shift 2 ;; *) shift ;; esac; done
cat > /dev/null
exec "\${MGL_FFMPEG:-ffmpeg}" -hide_banner -nostdin -loglevel error -y -f lavfi -i "sine=f=220:d=$scale" -af "adelay=300:all=1,apad=pad_dur=0.3,volume=4" -ar 22050 -ac 1 "$out"
`;

/** a $PIPER_HOME with the fake binary and two (empty) voice models */
async function fakeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'piper-home-'));
  await mkdir(join(home, 'piper'));
  await writeFile(join(home, 'piper', 'piper'), FAKE);
  await chmod(join(home, 'piper', 'piper'), 0o755);
  await writeFile(join(home, 'en_US-test-medium.onnx'), '');
  await writeFile(join(home, 'en_US-test-medium.onnx.json'), JSON.stringify({ language: { code: 'en_US', name_english: 'English' }, dataset: 'test', audio: { quality: 'medium', sample_rate: 22050 } }));
  await writeFile(join(home, 'de_DE-bare-low.onnx'), '');
  return home;
}

/** samples and rate of a 16-bit mono WAV */
function readWav(b: Uint8Array) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { riff: String.fromCharCode(...b.subarray(0, 4)), rate: v.getUint32(24, true), samples: v.getUint32(40, true) / 2 };
}

test('the plugin provides one speak provider', () => {
  assert.equal(piper.kind, 'speak');
  assert.equal(plugin.commands![0]!.op, 'piper-voice.voices');
});

test('word timings follow syllables and pause after punctuation, inside the voiced span', () => {
  assert.equal(syllables('banana'), 3);
  assert.equal(syllables('42'), 4);
  const w = estimateWords('Robots are broke. Not late, broke.', 0.04, 3.04);
  assert.deepEqual(w.map((x) => x.text), ['Robots', 'are', 'broke.', 'Not', 'late,', 'broke.']);
  assert.equal(w[0]!.start, 0.04);
  assert.ok(Math.abs(w.at(-1)!.end - 3.04) < 0.002, `ends with the speech: ${w.at(-1)!.end}`);
  for (let i = 1; i < w.length; i++) assert.ok(w[i]!.start >= w[i - 1]!.end);
  // the gap after "broke." (a sentence) is longer than after "late," and both are longer than between plain words
  const gap = (i: number) => w[i + 1]!.start - w[i]!.end;
  assert.ok(gap(2) > gap(4) && gap(4) > gap(0) + 0.01);
});

test('wav() writes a valid 48 kHz header and voicedSpan trims silence', () => {
  const pcm = new Int16Array(1000);
  pcm.fill(5000, 200, 700);
  assert.deepEqual(voicedSpan(pcm), [200, 700]);
  assert.deepEqual(readWav(wav(pcm)), { riff: 'RIFF', rate: 48000, samples: 1000 });
});

test('voices are the .onnx files of $PIPER_HOME, described from their .onnx.json', async () => {
  const home = await fakeHome();
  assert.deepEqual(listVoices(home), [
    { id: 'de_DE-bare-low' },
    { id: 'en_US-test-medium', describe: 'English, test, medium', lang: 'en-US' },
  ]);
  assert.deepEqual(listVoices(join(home, 'missing')), []);
});

test('speak runs piper, resamples to 48 kHz, trims the silence and honours speed', async () => {
  if (piper.kind !== 'speak') return;
  process.env.PIPER_HOME = await fakeHome();
  try {
    const a = tempFile('a.wav'), b = tempFile('b.wav');
    const r = await piper.speak({ text: 'Three tips for better sleep.', voice: 'en_US-test-medium', out: a });
    const h = readWav(await readFile(a));
    assert.equal(h.rate, 48000);
    const dur = h.samples / 48000;
    assert.ok(dur > 0.95 && dur < 1.2, `1 s of tone plus 40 ms each side, not the 0.6 s of silence: ${dur}`);
    assert.equal(r.words!.length, 5);
    assert.ok(r.words!.at(-1)!.end! <= dur);
    await piper.speak({ text: 'Three tips for better sleep.', speed: 2, out: b });   // default voice: the first by name
    assert.ok(readWav(await readFile(b)).samples < h.samples * 0.65);
    await assert.rejects(piper.speak({ text: 'hi', voice: 'nope', out: tempFile('x.wav') }), /no voice "nope".*en_US-test-medium/);
  } finally { delete process.env.PIPER_HOME; }
});

test('without models, speak says where to put them; piper-voice.voices lists what is there', async () => {
  if (piper.kind !== 'speak') return;
  const home = await fakeHome();
  process.env.PIPER_HOME = join(home, 'empty');
  try {
    await assert.rejects(piper.speak({ text: 'hi', out: tempFile('y.wav') }), /no voices in .*PIPER_HOME/);
    process.env.PIPER_HOME = home;
    const r = await runCommandOn(testProject(), { op: 'piper-voice.voices' }, { plugins: [plugin] });
    assert.equal((r.out as { voices: unknown[] }).voices.length, 2);
  } finally { delete process.env.PIPER_HOME; }
});
