import { test, assert, loadPlugin, tempFile, checkSpeakProvider } from 'michelangelo/testing';

const plugin = await loadPlugin(import.meta.url);
const kokoro = plugin.providers!.find((p) => p.id === 'kokoro')!;
// the plugin's own helpers (lazy, like its Node built-ins)
const { chunks, phonemeWords, matchWords, spokenCount, letterOutline, phonemeOutline, outlineSimilarity, wav, toPcm16, FRAME, VOICES } = await import('../src/index.js');

/** Recorded from the model (af_heart, q8): its phoneme tokens and per-token durations (frames of 25 ms). */
const RECORDED: { text: string; tokens: string; durations: number[]; expect: Record<string, string | null> }[] = [
  {
    text: "It costs $5.99 — that's 100% cheaper than the 3rd option!",
    tokens: '$ɪt kˈɔsts fˈaɪv dˈɑːlɚz ænd nˈaɪndi nˈaɪn sˈɛnts — ðæts wˈʌn hˈʌndɹɪd pɚsˈɛnt tʃˈiːpɚ ðɐn ðə θˈɜːd ˈɑːpʃən!$',
    durations: [14, 2, 1, 2, 2, 3, 2, 2, 2, 2, 3, 2, 3, 3, 2, 2, 2, 2, 3, 2, 2, 3, 4, 3, 3, 1, 1, 1, 2, 1, 2, 1, 1, 1, 2, 2, 2, 1, 2, 2, 2, 2, 3, 2, 3, 2, 2, 2, 16, 3, 1, 2, 3, 2, 2, 2, 2, 1, 1, 1, 1, 2, 1, 1, 1, 2, 1, 1, 1, 1, 2, 2, 3, 2, 2, 1, 1, 1, 2, 2, 1, 2, 1, 2, 3, 4, 2, 1, 1, 1, 1, 1, 2, 3, 1, 2, 2, 1, 1, 2, 2, 1, 2, 3, 3, 3, 14, 6, 1],
    expect: { '$5.99': 'fˈaɪv dˈɑːlɚz ænd nˈaɪndi nˈaɪn sˈɛnts', '100%': 'wˈʌn hˈʌndɹɪd pɚsˈɛnt', '3rd': 'θˈɜːd', 'option!': 'ˈɑːpʃən' },
  },
  {
    text: 'I never thought I would say this, but the cheapest option turned out to be the best one by far.',
    tokens: '$aɪ nˈɛvɚ θˈɔːt aɪ wʊd sˈeɪ ðˈɪs, bˌʌt ðə tʃˈiːpɪst ˈɑːpʃən tˈɜːnd ˈaʊt təbi ðə bˈɛst wˈʌn baɪ fˈɑːɹ.$',
    durations: [14, 2, 2, 2, 1, 2, 2, 2, 2, 3, 1, 2, 1, 1, 1, 2, 1, 1, 1, 1, 1, 2, 2, 1, 2, 2, 2, 2, 1, 3, 3, 14, 3, 2, 1, 1, 1, 1, 1, 1, 2, 3, 3, 1, 2, 1, 2, 3, 2, 2, 2, 2, 3, 2, 2, 3, 3, 3, 3, 3, 2, 2, 1, 1, 1, 1, 1, 2, 2, 2, 1, 2, 1, 2, 2, 2, 2, 1, 1, 2, 2, 2, 2, 2, 1, 1, 1, 1, 2, 1, 2, 2, 2, 2, 3, 2, 4, 2, 3, 13, 6, 1],
    // espeak fused "to be" into one phoneme word (null: shares a phoneme word)
    expect: { to: null, be: null, cheapest: 'tʃˈiːpɪst', 'far.': 'fˈɑːɹ' },
  },
];

test('one speak provider with English voices, af_heart first', async () => {
  assert.equal(kokoro.kind, 'speak');
  if (kokoro.kind !== 'speak') return;
  const v = await kokoro.voices();
  assert.equal(v[0]!.id, 'af_heart');
  assert.ok(v.length >= 20 && v.every((x) => /^[ab][fm]_/.test(x.id) && /^en-(US|GB)$/.test(x.lang ?? '')));
  assert.equal(v.length, VOICES.length);
});

test('model tokens become phoneme words with times; text words map onto them, numbers and fused words included', () => {
  for (const r of RECORDED) {
    const tokens = [...r.tokens];
    assert.equal(tokens.length, r.durations.length);
    const ph = phonemeWords(tokens, r.durations);
    // the leading pad is silence: the first word starts after it
    assert.equal(ph[0]!.start, r.durations[0]! * FRAME);
    const words = matchWords(r.text.split(' '), ph);
    assert.ok(words, r.text);
    assert.deepEqual(words!.map((w) => w.text), r.text.split(' '));
    for (let i = 1; i < words!.length; i++) assert.ok(words![i]!.start >= words![i - 1]!.start, `${words![i]!.text} starts in order`);
    for (const [word, phon] of Object.entries(r.expect)) {
      const w: { text: string; start: number; end: number } = words!.find((x: { text: string }) => x.text === word)!;
      const covered = ph.filter((p) => p.end > p.start && p.start >= w.start - 1e-9 && p.end <= w.end + 1e-9).map((p) => p.phonemes).join(' ');
      // a fused phoneme word is shared by its text words: each covers part of it
      if (phon === null) assert.ok(w.end > w.start && !covered, word);
      else assert.equal(covered, phon, word);
    }
  }
});

test('no match → undefined (Michelangelo then aligns by sound)', () => {
  const ph = phonemeWords([...'$hɛloʊ$'], [5, 2, 2, 2, 2, 2, 5]);
  assert.equal(matchWords(['completely', 'different', 'words', 'here'], ph), undefined);
});

test('helpers: chunks, spoken counts, sound outlines', () => {
  assert.deepEqual(chunks('One. Two three!  Four?', 12), ['One.', 'Two three!', 'Four?']);
  const long = Array.from({ length: 80 }, () => 'word').join(' ');
  assert.ok(chunks(long).every((c) => c.length <= 280));
  assert.equal(chunks(long).join(' '), long);
  assert.deepEqual(['1999,', '$5.99', '100%', 'U.S.', '-5°C', '25,000'].map(spokenCount), [3, 6, 3, 1, 4, 3]);
  assert.equal(letterOutline('thought'), 'Tt');
  assert.equal(phonemeOutline('θˈɔːt'), 'Tt');
  assert.ok(outlineSimilarity(letterOutline('cheaper'), phonemeOutline('tʃˈiːpɚ')) === 1);
});

test('wav() and toPcm16(): 24 kHz 16-bit mono, peak at -3 dBFS', () => {
  const pcm = toPcm16(Float32Array.from({ length: 480 }, (_, i) => Math.sin(i / 10) * 0.5));
  const peak = Math.max(...Array.from(pcm, Math.abs));
  assert.ok(Math.abs(20 * Math.log10(peak / 32767) + 3) < 0.05);
  const b = wav(pcm), v = new DataView(b.buffer);
  assert.equal(String.fromCharCode(...b.subarray(0, 4)), 'RIFF');
  assert.equal(v.getUint32(24, true), 24000);
  assert.equal(v.getUint32(40, true), 960);
});

test('an unknown voice fails with the list (before loading the model)', async () => {
  if (kokoro.kind !== 'speak') return;
  await assert.rejects(kokoro.speak({ text: 'hi', voice: 'nope', out: tempFile('x.wav') }), /no voice "nope".*af_heart/);
});

// The real model: only when asked (it needs `npm install` here and downloads ~330 MB on first use).
test('speaks with word timings (MGL_KOKORO_TEST=1)', async () => {
  if (process.env.MGL_KOKORO_TEST !== '1' || kokoro.kind !== 'speak') return;
  const out = tempFile('k.wav');
  const r = await kokoro.speak({ text: 'Three tips for better sleep. Keep your room cool.', out });
  const words = r.words ?? [];
  assert.deepEqual(words.map((w) => w.text), ['Three', 'tips', 'for', 'better', 'sleep.', 'Keep', 'your', 'room', 'cool.']);
  for (let i = 1; i < words.length; i++) assert.ok(words[i]!.start > words[i - 1]!.start);
  // a sentence pause between "sleep." and "Keep"
  assert.ok(words[5]!.start - (words[4]!.end ?? words[4]!.start) > 0.15);
  // what audio.speak needs from any speak provider
  assert.deepEqual((await checkSpeakProvider(kokoro, { text: "It's 5 o'clock — time for tea." })).problems, []);
});
