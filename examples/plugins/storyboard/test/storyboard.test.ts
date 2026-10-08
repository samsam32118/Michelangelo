import { test, assert, loadPlugin, testProject, runCommandOn, checkContext } from 'michelangelo/testing';

const plugin = await loadPlugin(import.meta.url);
type Project = ReturnType<typeof testProject>;
type Result = Awaited<ReturnType<typeof runCommandOn>>;
interface Beat { id: string; at: number; len: number; clips: string[] }

const STORY = `# Morning habits

## hook
> Most people waste their mornings.
shot: gen:gradient #1e3c72 #2a5298
text: Stop wasting mornings

> Here are three habits that changed mine.
shot: gen:gradient #000000 #333333
shot: gen:gradient #ffffff #cccccc
cut-on: three

## habit1
> First, no phone for the first hour.
text: 1. No phone | at=+0.3s

## outro
dur: 2s
shot: gen:gradient #111111 #222222
text: Follow for more
`;

/** Offline stand-ins for the SDK services: files in memory, a speak provider with word timings, a probe. */
function services(files: Record<string, string> = {}) {
  const spoken: string[] = [];
  return {
    spoken, files,
    readText: async (f: string) => { if (!(f in files)) throw new Error(`no ${f}`); return files[f]!; },
    writeFile: async (f: string, d: Uint8Array) => { files[f] = new TextDecoder().decode(d); },
    fileExists: async (f: string) => f in files,
    // 0.3 s per word, starting 0.1 s in, 0.2 s of silence at the end
    probe: async (f: string) => ({ kind: 'audio' as const, duration: f.endsWith('.wav') && files[`${f}.words`] ? Number(files[`${f}.words`]) * 0.3 + 0.3 : 4 }),
    // no loudness envelope: word times are then estimated across the recording
    analyzeAudio: async () => ({ silences: [], duration: 4 }),
    speak: {
      id: 'fake',
      voices: async () => [],
      speak: async ({ text, out }: { text: string; out: string }) => {
        spoken.push(text);
        const words = text.split(/\s+/);
        files[out] = 'RIFF';
        files[`${out}.words`] = String(words.length);
        return { words: words.map((w, i) => ({ text: w, start: 0.1 + i * 0.3 })) };
      },
    },
  };
}

const project = () => testProject({ width: 1920, height: 1080, seconds: 2 });
const apply = (p: Project, cmd: Record<string, unknown>, svc: object = services()) => runCommandOn(p, { op: 'storyboard.apply', ...cmd }, { plugins: [plugin], services: svc });
const beats = (r: Result) => r.out.beats as Beat[];
const clip = (r: Result, id: string) => r.project.clips!.find((c) => c.id === id)!;
const sb = (r: Result, role: string) => r.project.clips!.filter((c) => c.tags?.includes(`sb-role:${role}`)).sort((a, b) => a.at - b.at);

test('reading speed: beats tile the timeline, shots hold through a beat without one, markers name every beat and scene', async () => {
  const r = await apply(project(), { text: STORY });
  const b = beats(r);
  assert.deepEqual(b.map((x) => x.id), ['hook-1', 'hook-2', 'habit1-1', 'outro-1']);
  for (let i = 1; i < b.length; i++) assert.equal(b[i]!.at, b[i - 1]!.at + b[i - 1]!.len, 'no gap between beats');
  assert.equal(b[3]!.len, 60, 'dur: 2s on a silent beat');
  const shots = sb(r, 'shot');
  assert.deepEqual(shots.map((c) => c.id), ['hook-1-shot', 'hook-2-shot', 'hook-2-shot2', 'outro-1-shot']);
  assert.equal(shots[2]!.at + shots[2]!.len, b[3]!.at, 'habit1-1 has no shot: the one before holds');
  for (let i = 1; i < shots.length; i++) assert.equal(shots[i]!.at, shots[i - 1]!.at + shots[i - 1]!.len);
  assert.equal(clip(r, 'habit1-1-text').at, b[2]!.at + 9, 'text at=+0.3s');
  const m = new Map(r.project.markers!.map((x) => [x.id, x]));
  assert.equal(m.get('sb-hook-2')!.at, b[1]!.at);
  assert.equal(m.get('sbs-hook')!.len, b[0]!.len + b[1]!.len);
  assert.equal(r.project.comps[0]!.length, r.out.length, 'the comp grows to fit');
  assert.equal(r.out.timing, 'reading');
});

test('voice: one line per beat, cuts land on the cut-on word, and a second run re-speaks only the changed line and keeps hand edits', async () => {
  const svc = services({ 'v.storyboard.md': STORY });
  const r1 = await apply(project(), { file: 'v.storyboard.md', voice: true }, svc);
  const b = beats(r1);
  assert.equal(svc.spoken.length, 3);
  const vo = sb(r1, 'vo');
  assert.deepEqual(vo.map((c) => c.id), ['hook-1-vo', 'hook-2-vo', 'habit1-1-vo']);
  assert.ok(vo.every((c, i) => c.at === b[i]!.at + 3), 'the voice starts 3 frames (lead) after the cut');
  // "three" is word 4 of "Here are three habits ...": 0.1 + 2 × 0.3 = 0.7 s after the voice starts, cut 3 frames before
  assert.equal(clip(r1, 'hook-2-shot2').at, vo[1]!.at + 21 - 3);

  // hand edits: move the title up, nudge the third beat's text into the wrong place
  const p = structuredClone(r1.project);
  p.clips!.find((c) => c.id === 'hook-1-text')!.y = 300;
  p.clips!.find((c) => c.id === 'hook-1-text')!.style = 'subtitle';
  p.clips!.find((c) => c.id === 'habit1-1-text')!.at += 400;
  const found = plugin.checks![0]!.run(checkContext(p)) as { severity: string; clip?: string }[];
  assert.ok(found.some((f) => f.severity === 'error' && f.clip === 'habit1-1-text'), 'the check sees the text moved out of its beat');

  // a longer first line: only it is spoken again (the file and options are remembered), later beats move
  svc.files['v.storyboard.md'] = STORY.replace('Most people waste their mornings.', 'Most people waste the first hour of their mornings.');
  const r2 = await runCommandOn(p, { op: 'storyboard.apply' }, { plugins: [plugin], services: svc });
  assert.equal(svc.spoken.length, 4);
  assert.equal(svc.spoken[3], 'Most people waste the first hour of their mornings.');
  const b2 = beats(r2);
  assert.equal(b2[1]!.at - b[1]!.at, 4 * 9, 'four more words: 1.2 s later');
  assert.equal(clip(r2, 'hook-1-text').y, 300, 'the hand-moved title keeps its y');
  assert.equal(clip(r2, 'hook-1-text').style, 'subtitle', 'and its hand-set style');
  assert.equal(clip(r2, 'habit1-1-text').at, b2[2]!.at + 9, 'timing is the storyboard\'s again');
  assert.deepEqual(plugin.checks![0]!.run(checkContext(r2.project)), []);
  const vo1 = new Set(r2.project.clips!.map((c) => c.asset));
  assert.ok(r2.project.assets!.every((a) => vo1.has(a.id)), 'the old voice of the changed line is gone');
});

test('a recording: beats start at their first word, silent beats only before or after the voice', async () => {
  const svc = services({ 'media/vo.wav.words': '13' });
  const story = '## intro\ndur: 1s\ntext: Hello\n\n## main\n> One two three four five six.\nshot: gen:solid\n> Seven eight nine ten eleven twelve thirteen.\nshot: gen:solid\n';
  const r = await apply(project(), { text: story, vo: 'media/vo.wav', captions: true }, svc);
  const b = beats(r);
  assert.equal(r.out.timing, 'recording');
  assert.equal(clip(r, 'sb-vo').at, 30, 'the recording starts after the 1 s intro');
  assert.equal(b[1]!.at, 30);
  assert.ok(b[2]!.at > b[1]!.at + 30 && b[2]!.at < clip(r, 'sb-vo').at + clip(r, 'sb-vo').len);
  assert.equal(b[2]!.at + b[2]!.len, clip(r, 'sb-vo').at + clip(r, 'sb-vo').len, 'the last line ends with the recording');
  assert.ok(r.project.cues!.length > 0 && clip(r, 'sb-captions').tags!.includes('sb-role:captions'));

  await assert.rejects(apply(project(), { text: '> One two.\n>\ndur: 1s\n> Three four.\n', vo: 'media/vo.wav' }, svc), /silent but sits between voice lines/);
});

test('mistakes in the storyboard name the line and the fix', async () => {
  await assert.rejects(apply(project(), { text: '> Hi.\nshoot: a.mp4\n' }), (e: Error & { fix?: string }) => /line 2: "shoot:" is not a directive/.test(e.message) && /shot:/.test(e.fix ?? ''));
  await assert.rejects(apply(project(), { text: '> Hi there.\ntext: A\ntext: B\n' }), /line 3: beat "s1-1" has a second "text:"/);
  await assert.rejects(apply(project(), { text: '> Hi there.\nshot: gen:solid\nshot: gen:solid\ncut-on: banana\n' }), /"banana" is not in its line/);
  await assert.rejects(apply(project(), { text: '## a\nshot: gen:solid\n' }), /no voice line, so it needs a length/);
  await assert.rejects(apply(project(), { text: '> Hi.\nshot: x.mp4 | zoom=2\n' }), /"zoom=2" is not an option of "shot:"/);
});

test('the check finds gaps and text too short to read; detach unlinks everything', async () => {
  const r = await apply(project(), { text: '> A quick line.\nshot: gen:solid\n> Another quick line here.\nshot: gen:solid\ntext: A rather long card that nobody can read this fast\ndur: max 1s\n' });
  const p = structuredClone(r.project);
  p.clips!.find((c) => c.id === 's1-2-shot')!.len -= 10;
  p.clips!.find((c) => c.id === 's1-1-shot')!.len -= 5;
  const found = plugin.checks![0]!.run(checkContext(p)) as { severity: string; message: string }[];
  assert.ok(found.some((f) => f.severity === 'warning' && /gap of 5 frame/.test(f.message)));
  assert.ok(found.some((f) => f.severity === 'warning' && /needs .* to be read/.test(f.message)));

  const d = await runCommandOn(r.project, { op: 'storyboard.detach' }, { plugins: [plugin] });
  assert.ok(d.project.clips!.every((c) => !c.tags?.some((t) => t.startsWith('sb'))));
  assert.ok((d.project.markers ?? []).every((m) => !m.id.startsWith('sb')));
  assert.deepEqual(plugin.checks![0]!.run(checkContext(d.project)), []);
});
