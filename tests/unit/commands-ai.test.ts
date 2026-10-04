// @vitest-environment node
/** audio.speak and captions.from-speech (src/core/commands/ai.ts), the provider services (src/sdk/services.ts) and doctor's provider line. */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeProject } from './commands-fixtures.js';
import type { CommandServices, SpeakService, TranscribeService } from '../../src/core/commands/index.js';
import { estimateTimedWords, groupWords, normaliseWords } from '../../src/core/commands/ai.js';
import { makeServices, listProviders, firstProvider } from '../../src/sdk/services.js';
import { PluginRegistry } from '../../src/plugin/registry.js';
import { definePlugin, defineProvider, type SpeakProvider } from '../../src/plugin/api.js';
import { MglError } from '../../src/core/errors.js';

const WORDS = [
  { text: 'Three', start: 0.1, end: 0.35 }, { text: 'tips', start: 0.4, end: 0.7 }, { text: 'for', start: 0.72, end: 0.85 },
  { text: 'better', start: 0.9, end: 1.2 }, { text: 'sleep.', start: 1.25, end: 1.6 }, { text: 'Keep', start: 2.1, end: 2.3 },
  { text: 'it', start: 2.32, end: 2.4 }, { text: 'cool.', start: 2.45, end: 2.9 },
];
const TEXT = WORDS.map((w) => w.text).join(' ');

function memServices(o: { words?: boolean; transcribe?: boolean; speak?: boolean } = {}) {
  const files = new Map<string, Uint8Array>();
  const calls: { text: string; voice?: string; speed?: number; out: string }[] = [];
  const speak: SpeakService = {
    id: 'fake', describe: 'test voice',
    async voices() { return [{ id: 'a' }]; },
    async speak(args) { calls.push(args); files.set(args.out, new Uint8Array(100)); return o.words === false ? {} : { words: WORDS }; },
  };
  const transcribe: TranscribeService = { id: 'fake-asr', async transcribe() { return { text: TEXT, words: WORDS.map((w) => ({ ...w, end: w.end })) }; } };
  const services: CommandServices = {
    async writeFile(p, d) { files.set(p, d); },
    async fileExists(p) { return files.has(p); },
    async readText(p) { const d = files.get(p); if (!d) throw new Error(`no ${p}`); return new TextDecoder().decode(d); },
    async probe() { return { kind: 'audio', duration: 3.1, hasAudio: true }; },
    ...(o.speak === false ? {} : { speak }),
    ...(o.transcribe ? { transcribe } : {}),
  };
  return { files, calls, services };
}

function setup(o: Parameters<typeof memServices>[0] = {}) {
  const mem = memServices(o);
  return { ...mem, ...makeProject({ services: mem.services }) };
}

async function code(p: Promise<unknown>): Promise<MglError> {
  try { await p; } catch (e) { return e as MglError; }
  throw new Error('expected a failure');
}

describe('audio.speak', () => {
  it('fails with E_NO_PROVIDER, naming the plugin and the offline fallback', async () => {
    const { edit } = setup({ speak: false });
    const e = await code(edit({ op: 'audio.speak', text: 'hello' }));
    expect(e.code).toBe('E_NO_PROVIDER');
    expect(e.fix).toMatch(/flite-voice/);
    expect(e.fix).toMatch(/mgl plugin trust/);
    expect(e.fix).toMatch(/captions\.from-text/);
  });

  it('writes media/generated/vo-<hash>.wav, adds an asset and a clip on the dialogue bus, and stores the word timings', async () => {
    const { edit, project, files, calls } = setup();
    const r = await edit({ op: 'audio.speak', text: `  ${TEXT} `, voice: 'a' });
    const out = r.out[0]!;
    expect(out.src).toMatch(/^media\/generated\/vo-[0-9a-f]{12}\.wav$/);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toBe(TEXT);
    const meta = JSON.parse(new TextDecoder().decode(files.get(`${out.src}.json`)!));
    expect(meta).toMatchObject({ provider: 'fake', voice: 'a', text: TEXT, duration: 3.1 });
    expect(meta.words).toHaveLength(8);
    const clip = project.data.clips!.find((c) => c.id === out.id)!;
    expect(clip).toMatchObject({ at: 0, len: 93 });
    const track = project.data.tracks!.find((t) => t.id === clip.track)!;
    expect(track).toMatchObject({ audio: true, bus: 'dialogue' });
    expect(out).toMatchObject({ timings: 'provider', generated: true, duration: 3.1 });
    expect(r.summary.join(' ')).toMatch(/captions\.from-speech clip=/);
  });

  it('reuses the file for the same text and voice, and places the next line after the previous one', async () => {
    const { edit, project, calls } = setup();
    const a = (await edit({ op: 'audio.speak', text: 'One.' })).out[0]!;
    const b = (await edit({ op: 'audio.speak', text: 'One.' })).out[0]!;
    expect(calls).toHaveLength(1);
    expect(b.src).toBe(a.src);
    expect(b.generated).toBe(false);
    expect(b.at).toBe(a.end);
    expect(project.data.assets!.filter((x) => x.src === a.src)).toHaveLength(1);
    const c = (await edit({ op: 'audio.speak', text: 'One.', voice: 'b', at: '10s' })).out[0]!;
    expect(c.src).not.toBe(a.src);
    expect(c.at).toBe(300);
    expect(calls).toHaveLength(2);
  });

  it('works without provider word timings (timings: none) and refuses a duplicate id', async () => {
    const { edit } = setup({ words: false });
    const r = (await edit({ op: 'audio.speak', text: 'Hi there.', id: 'vo1' })).out[0]!;
    expect(r.timings).toBe('none');
    expect(r.words).toBeUndefined();
    expect((await code(edit({ op: 'audio.speak', text: 'Again.', id: 'vo1' }))).code).toBe('E_DUPLICATE_ID');
  });
});

describe('captions.from-speech', () => {
  it('uses the timings audio.speak stored: cues break at sentences, words are frame offsets', async () => {
    const { edit, project } = setup();
    await edit({ op: 'audio.speak', text: TEXT, id: 'line', at: '1s' });
    const r = (await edit({ op: 'captions.from-speech', clip: 'line', style: 'karaoke', maxWords: 3 })).out[0]!;
    expect(r.source).toBe('speak');
    const cues = project.data.cues!.filter((q) => q.clip === r.clip);
    expect(cues.map((q) => q.text)).toEqual(['Three tips', 'for better sleep.', 'Keep it cool.']); // never ends a cue on "for"
    const cap = project.data.clips!.find((c) => c.id === r.clip)!;
    expect(cap).toMatchObject({ captions: true, style: 'karaoke' });
    // the first word starts at 1s + 0.1s = frame 33
    expect(cap.at + cues[0]!.at).toBe(33);
    expect(cues[0]!.words).toEqual([0, 9]);
    for (const q of cues) expect(q.words!.every((w) => w < q.len)).toBe(true);
    // cues never overlap
    for (let i = 1; i < cues.length; i++) expect(cues[i]!.at).toBeGreaterThanOrEqual(cues[i - 1]!.at + cues[i - 1]!.len);
  });

  it('captions every voice line into one captions clip by default (or clips=[...])', async () => {
    const { edit, project } = setup();
    await edit({ op: 'audio.speak', text: 'Line one.', id: 'l1' });
    await edit({ op: 'audio.speak', text: 'Line two.', id: 'l2' });
    const r = (await edit({ op: 'captions.from-speech', maxWords: 3 })).out[0]!;
    expect(r.voices).toEqual(['l1', 'l2']);
    expect(project.data.clips!.filter((c) => c.captions)).toHaveLength(1);
    const cues = project.data.cues!.filter((q) => q.clip === r.clip);
    // both lines' words, in time order, cues never overlapping
    expect(cues.length).toBeGreaterThanOrEqual(6);
    for (let i = 1; i < cues.length; i++) expect(cues[i]!.at).toBeGreaterThanOrEqual(cues[i - 1]!.at + cues[i - 1]!.len);
    const r2 = (await edit({ op: 'captions.from-speech', clips: ['l2'], id: r.clip })).out[0]!;
    expect(r2.voices).toEqual(['l2']);
    expect((await code(edit({ op: 'captions.from-speech', clip: 'l1', clips: ['l2'] }))).code).toBe('E_ARG');
  });

  it('replaces the cues of an existing captions clip given as id', async () => {
    const { edit, project } = setup();
    await edit({ op: 'audio.speak', text: TEXT, id: 'line' });
    const a = (await edit({ op: 'captions.from-speech', clip: 'line' })).out[0]!;
    const b = (await edit({ op: 'captions.from-speech', clip: 'line', id: a.clip, maxWords: 2 })).out[0]!;
    expect(b.clip).toBe(a.clip);
    expect(project.data.cues!.filter((q) => q.clip === a.clip)).toHaveLength(b.cues as number);
    expect(project.data.clips!.filter((c) => c.captions)).toHaveLength(1);
  });

  it('uses a transcribe provider for a clip audio.speak did not make', async () => {
    const { edit, project } = setup({ transcribe: true, speak: false });
    project.data.assets = [{ id: 'rec', src: 'media/voice.wav' }];
    project.data.tracks!.push({ id: 'A9', comp: project.data.comps[0]!.id, audio: true, bus: 'dialogue' });
    (project.data.clips ??= []).push({ id: 'take', track: 'A9', at: 30, len: 120, asset: 'rec', in: 30 });
    const r = (await edit({ op: 'captions.from-speech', clip: 'take' })).out[0]!;
    expect(r.source).toBe('transcribe');
    // in=30 frames = 1s of source: the words before it are dropped
    const cues = project.data.cues!.filter((q) => q.clip === r.clip);
    expect(cues[0]!.text).toBe('sleep.');
    expect(cues[0]!.at + project.data.clips!.find((c) => c.id === r.clip)!.at).toBe(30 + Math.round(0.25 * 30));
  });

  it('estimates from the stored text when the voice has no timings and there is no transcriber', async () => {
    const { edit } = setup({ words: false });
    await edit({ op: 'audio.speak', text: TEXT, id: 'line' });
    const r = await edit({ op: 'captions.from-speech', clip: 'line' });
    expect(r.out[0]!.source).toBe('estimated');
    expect(r.notes.join(' ')).toMatch(/estimated/);
  });

  it('fails with E_NO_PROVIDER for a recorded clip and no transcriber, naming captions.from-text', async () => {
    const { edit, project } = setup({ speak: false });
    project.data.assets = [{ id: 'rec', src: 'media/voice.wav' }];
    project.data.tracks!.push({ id: 'A9', comp: project.data.comps[0]!.id, audio: true });
    (project.data.clips ??= []).push({ id: 'take', track: 'A9', at: 0, len: 120, asset: 'rec' });
    const e = await code(edit({ op: 'captions.from-speech', clip: 'take' }));
    expect(e.code).toBe('E_NO_PROVIDER');
    expect(e.fix).toMatch(/captions\.from-text voice=take/);
  });
});

describe('word helpers', () => {
  it('groupWords breaks at punctuation, maxWords and pauses', () => {
    const g = groupWords([{ text: 'a', start: 0 }, { text: 'b,', start: 0.2 }, { text: 'c', start: 0.4, end: 0.6 }, { text: 'd', start: 1.2 }, { text: 'e', start: 1.3 }], 4);
    expect(g.map((x) => x.map((w) => w.text).join(' '))).toEqual(['a b,', 'c', 'd e']);
  });
  it('groupWords leaves no lone word after a cue that broke only for length (3 + 1 → 2 + 2)', () => {
    const ws = 'no phone for the first hour.'.split(' ').map((text, i) => ({ text, start: i * 0.3, end: i * 0.3 + 0.25 }));
    expect(groupWords(ws, 3).map((x) => x.map((w) => w.text).join(' '))).toEqual(['no phone for', 'the first hour.']);
    expect(groupWords(ws.slice(0, 4).map((w, i) => (i === 3 ? { ...w, text: 'the.' } : w)), 3).map((x) => x.length)).toEqual([2, 2]);
    // a real pause keeps the lone word on its own
    const paused = ws.slice(0, 4).map((w, i) => (i === 3 ? { ...w, start: 3 } : w));
    expect(groupWords(paused, 3).map((x) => x.length)).toEqual([3, 1]);
    // a length break never ends a cue on a weak word when the next cue has room
    const ws2 = 'that changed my mornings.'.split(' ').map((text, i) => ({ text, start: i * 0.3, end: i * 0.3 + 0.25 }));
    expect(groupWords(ws2, 3).map((x) => x.map((w) => w.text).join(' '))).toEqual(['that changed', 'my mornings.']);
    const ws3 = 'Third, write down the one task that matters today.'.split(' ').map((text, i) => ({ text, start: i * 0.27, end: i * 0.27 + 0.24 }));
    expect(groupWords(ws3, 4).map((x) => x.map((w) => w.text).join(' '))).toEqual(['Third, write down', 'the one task', 'that matters today.']);
  });
  it('estimateTimedWords spans the duration in order; normaliseWords clamps and orders', () => {
    const w = estimateTimedWords('Hello there. How are you?', 2);
    expect(w).toHaveLength(5);
    expect(w[0]!.start).toBe(0);
    expect(w[4]!.end!).toBeLessThanOrEqual(2);
    expect(normaliseWords([{ text: 'b', start: 1 }, { text: 'a', start: 0.5 }, { text: ' ', start: 2 }, { text: 'c', start: 9, end: 12 }], 3)).toEqual([{ text: 'b', start: 1 }, { text: 'a', start: 1 }, { text: 'c', start: 3, end: 3 }]);
  });
});

describe('provider services', () => {
  const tone: SpeakProvider = defineProvider({
    kind: 'speak', id: 'tone', describe: 'a test tone',
    async voices() { return []; },
    async speak({ out }) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(out, new Uint8Array(200));
      return { words: [{ text: 'hi', start: 0 }] };
    },
  });
  const reg = () => new PluginRegistry().add(definePlugin({ name: 'p', providers: [tone, { kind: 'transcribe', id: 'asr', describe: 'asr', async transcribe() { return { text: '', words: [] }; } }] }), 'test');

  it('exposes the first speak/transcribe provider and lists them', () => {
    const r = reg();
    expect(firstProvider<SpeakProvider>(r, 'speak')!.id).toBe('tone');
    expect(listProviders(r)).toEqual([{ kind: 'speak', id: 'tone', describe: 'a test tone' }, { kind: 'transcribe', id: 'asr', describe: 'asr' }]);
    const s = makeServices(mkdtempSync(join(tmpdir(), 'mgl-ai-')), r);
    expect(s.speak?.id).toBe('tone');
    expect(s.transcribe?.id).toBe('asr');
    expect(makeServices(tmpdir(), new PluginRegistry()).speak).toBeUndefined();
  });

  it('speak writes only media/generated/<name>.wav inside the project, via a temp file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mgl-ai-'));
    const s = makeServices(dir, reg());
    await s.speak!.speak({ text: 'hi', out: 'media/generated/vo-x.wav' });
    expect(readFileSync(join(dir, 'media/generated/vo-x.wav')).length).toBe(200);
    for (const bad of ['../x.wav', 'media/vo.wav', 'media/generated/../../x.wav', 'media/generated/vo.mp3']) {
      expect((await code(s.speak!.speak({ text: 'hi', out: bad }))).code).toBe('E_PATH');
    }
    expect(existsSync(join(dir, 'x.wav'))).toBe(false);
  });

  it('a provider error becomes E_PROVIDER with a fix; writeFile/fileExists are attached', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mgl-ai-'));
    const bad: SpeakProvider = { ...tone, id: 'bad', async speak() { throw new Error('engine exploded\nstack'); } };
    const s = makeServices(dir, new PluginRegistry().add(definePlugin({ name: 'q', providers: [bad] }), 'test'));
    const e = await code(s.speak!.speak({ text: 'hi', out: 'media/generated/a.wav' }));
    expect(e.code).toBe('E_PROVIDER');
    expect(e.message).toMatch(/engine exploded$/);
    await s.writeFile!('media/generated/a.json', new TextEncoder().encode('{}'));
    expect(await s.fileExists!('media/generated/a.json')).toBe(true);
  });
});
