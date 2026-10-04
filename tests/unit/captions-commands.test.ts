import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { makeProject } from './text-fixtures.js';
import { parseSrt } from '../../src/core/captions.js';
import { analyzeAudio } from '../../src/media/analysis.js';

const SRT = [
  '1', '00:00:01,000 --> 00:00:02,483', 'Put your phone', '',
  '2', '00:00:02,483 --> 00:00:04,017', 'in another room', '',
  '3', '00:00:05,300 --> 00:00:07,950', 'and start the timer.', '',
].join('\n');

const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nPut <00:00:01.300>your <00:00:01.600>phone\n\n00:00:02.000 --> 00:00:03.000\naway now\n';

describe('captions.import', () => {
  it('creates a captions clip spanning the cues, cue times within one frame of the file', async () => {
    for (const fps of [30, '30000/1001', 25]) {
      const { project, edit } = makeProject({ fps, files: { 'subs.srt': SRT } });
      const r = await edit({ op: 'captions.import', file: 'subs.srt' });
      const clip = project.clip(r.out[0]!.clip as string)!;
      expect(clip).toMatchObject({ captions: true, style: 'caption' });
      const num = fps === '30000/1001' ? 30000 / 1001 : (fps as number);
      const cues = project.data.cues!;
      const src = parseSrt(SRT).cues;
      expect(cues.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
      cues.forEach((q, i) => {
        expect(Math.abs(clip.at + q.at - src[i]!.start * num)).toBeLessThanOrEqual(1);
        expect(Math.abs(clip.at + q.at + q.len - src[i]!.end * num)).toBeLessThanOrEqual(1);
        expect(q.words).toBeUndefined();
      });
      expect(clip.at + clip.len).toBe(clip.at + cues[2]!.at + cues[2]!.len);
      expect(project.issues).toEqual([]);
    }
  });
  it('takes word times from VTT, estimates them with words=true, applies offset and style', async () => {
    const { project, edit } = makeProject({ files: { 'a.vtt': VTT, 's.srt': SRT } });
    await edit({ op: 'captions.import', file: 'a.vtt', id: 'subs', style: 'karaoke', offset: '1s' });
    const subs = project.clip('subs')!;
    expect(subs).toMatchObject({ at: 60, len: 60, style: 'karaoke' });
    expect(project.data.cues![0]).toMatchObject({ clip: 'subs', at: 0, len: 30, text: 'Put your phone', words: [0, 9, 18] });
    expect(project.data.cues![1]!.words).toEqual([0, 16]); // estimated: the file has word times elsewhere
    await edit({ op: 'captions.import', file: 's.srt', words: true, track: 'T1' });
    const est = project.data.cues!.filter((q) => q.clip !== 'subs');
    expect(est.every((q) => q.words?.length === q.text.split(' ').length && q.words[0] === 0)).toBe(true);
  });
  it('fills an existing captions clip (replacing its cues) and places new clips on free tracks', async () => {
    const { project, edit } = makeProject({ files: { 's.srt': SRT }, edit: (p) => { p.clips = [{ id: 't', track: 'T1', at: 0, len: 300, text: 'Hi' }, { id: 'cap', track: 'V1', at: 0, len: 600, captions: true }]; } });
    await edit({ op: 'captions.import', file: 's.srt' });
    const created = project.data.clips!.find((c) => c.captions && c.id !== 'cap')!;
    expect(created.track).not.toBe('T1');
    expect(project.data.tracks!.some((t) => t.id === created.track)).toBe(true);
    await edit({ op: 'cue.add', clip: 'cap', at: 0, len: 10, text: 'old' });
    const r = await edit({ op: 'captions.import', file: 's.srt', clip: 'cap' });
    const cues = project.data.cues!.filter((q) => q.clip === 'cap');
    expect(cues.map((q) => q.text)).toEqual(['Put your phone', 'in another room', 'and start the timer.']);
    expect(cues[0]!.at).toBe(30);
    expect(r.notes.join(' ')).toMatch(/replaced/);
  });
  it('refuses a missing file and a non-captions clip with a fix', async () => {
    const { edit } = makeProject({ files: { 's.srt': SRT }, edit: (p) => { p.clips = [{ id: 't', track: 'T1', at: 0, len: 30, text: 'Hi' }]; } });
    await expect(edit({ op: 'captions.import', file: 'nope.srt' })).rejects.toMatchObject({ code: 'E_NO_FILE' });
    await expect(edit({ op: 'captions.import', file: 's.srt', clip: 't' })).rejects.toMatchObject({ code: 'E_NOT_CAPTIONS' });
  });
});

describe('captions.from-text', () => {
  const voice = (p: import('../../src/core/schema/index.js').ProjectFile) => {
    p.assets = [{ id: 'vo-wav', src: 'vo.wav' }];
    p.clips = [{ id: 'vo', track: 'A1', at: 30, len: 300, asset: 'vo-wav', in: 0 }];
  };
  it('times chunks to speech segments of the voice clip', async () => {
    // speech 0–2 s and 4–6 s of the source; the clip starts at frame 30
    const analyzeAudio = async () => ({ duration: 10, silences: [{ start: 2, end: 4 }, { start: 6, end: 10 }] });
    const { project, edit } = makeProject({ edit: voice, services: { analyzeAudio } });
    const r = await edit({ op: 'captions.from-text', text: 'One two three four. Five six seven eight.', voice: 'vo', maxWords: 4, style: 'karaoke' });
    const clip = project.clip(r.out[0]!.clip as string)!;
    const cues = project.data.cues!.map((q) => [clip.at + q.at, clip.at + q.at + q.len, q.text]);
    expect(cues).toEqual([[30, 90, 'One two three four.'], [150, 210, 'Five six seven eight.']]);
    expect(project.data.cues!.every((q) => q.words?.length === 4)).toBe(true);
    expect(clip.style).toBe('karaoke');
  });
  it('into an existing clip that starts after the speech: moves the clip start, cue times stay >= 0', async () => {
    // speech 0–2 s and 4–6 s of the source; the voice starts at frame 30, the captions clip at 75
    const analyzeAudio = async () => ({ duration: 10, silences: [{ start: 2, end: 4 }, { start: 6, end: 10 }] });
    const { project, edit } = makeProject({ edit: (p) => { voice(p); p.clips!.push({ id: 'subs', track: 'T1', at: 75, len: 60, captions: true, x: [[0, 100], [30, 200]] }); }, services: { analyzeAudio } });
    const r = await edit({ op: 'captions.from-text', text: 'One two three four. Five six seven eight.', voice: 'vo', clip: 'subs', maxWords: 4 });
    const clip = project.clip('subs')!;
    expect(clip.at).toBe(30);
    expect(project.data.cues!.every((q) => q.at >= 0)).toBe(true);
    expect(project.data.cues!.map((q) => [clip.at + q.at, q.text])).toEqual([[30, 'One two three four.'], [150, 'Five six seven eight.']]);
    expect(clip.x).toEqual([[45, 100], [75, 200]]); // keyframes stay at the same comp frames
    expect(clip.at + clip.len).toBe(210);
    expect(r.notes.join(' ')).toMatch(/moved the start of "subs"/);
    expect(project.issues).toEqual([]);
  });
  it('into an existing clip blocked by an earlier clip on its track: refuses with a ready command', async () => {
    const analyzeAudio = async () => ({ duration: 10, silences: [{ start: 2, end: 4 }, { start: 6, end: 10 }] });
    const { project, edit } = makeProject({ edit: (p) => { voice(p); p.clips!.push({ id: 't', track: 'T1', at: 0, len: 75, text: 'Hi' }, { id: 'subs', track: 'T1', at: 75, len: 60, captions: true }); }, services: { analyzeAudio } });
    await expect(edit({ op: 'captions.from-text', text: 'One two three four.', voice: 'vo', clip: 'subs' })).rejects.toMatchObject({ code: 'E_OVERLAP', fix: expect.stringMatching(/clip\.trim t end=30/) });
    expect(project.data.cues ?? []).toEqual([]);
  });
  it('spreads chunks evenly without a voice and respects maxWords', async () => {
    const { project, edit } = makeProject({ files: { 'script.txt': 'a b c d e f\ng h' } });
    await edit({ op: 'captions.from-text', file: 'script.txt', at: 0, len: 80, maxWords: 3, words: false });
    const cues = project.data.cues!;
    expect(cues.map((q) => q.text)).toEqual(['a b c', 'd e f', 'g h']);
    expect(cues.map((q) => [q.at, q.len])).toEqual([[0, 30], [30, 30], [60, 20]]);
    expect(cues[0]!.words).toBeUndefined();
  });
  it('works with real speech (flite) and media analysis', async () => {
    const { dir, project, edit } = makeProject({ edit: voice });
    const wav = path.join(dir, 'vo.wav');
    try {
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'flite=text=Hello there my friend:voice=slt', '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono:d=1.5', '-f', 'lavfi', '-i', 'flite=text=See you again soon:voice=slt',
        '-filter_complex', '[0:a]aresample=8000[a];[2:a]aresample=8000[c];[a][1:a][c]concat=n=3:v=0:a=1', wav]);
    } catch { return; } // ffmpeg without flite: covered by the fake test above
    expect(existsSync(wav)).toBe(true);
    project.services.analyzeAudio = (src, o) => analyzeAudio(path.join(dir, src), o);
    project.data.clips![0]!.len = 300;
    await edit({ op: 'captions.from-text', text: 'Hello there my friend. See you again soon.', voice: 'vo', maxWords: 4 });
    const [a, b] = project.data.cues!;
    const clip = project.data.clips!.find((c) => c.captions)!;
    // the second cue starts after the 1.5 s pause
    expect(clip.at + b!.at - (clip.at + a!.at + a!.len)).toBeGreaterThanOrEqual(30);
  });
});

describe('cue editing', () => {
  const base = (p: import('../../src/core/schema/index.js').ProjectFile) => {
    p.clips = [{ id: 'subs', track: 'T1', at: 30, len: 300, captions: true }];
    p.cues = [
      { id: 'c1', clip: 'subs', at: 0, len: 40, text: 'one two three four', words: [0, 10, 20, 30] },
      { id: 'c2', clip: 'subs', at: 40, len: 20, text: 'five six' },
      { id: 'c3', clip: 'subs', at: 100, len: 20, text: 'seven' },
    ];
  };
  it('splits by word index and by time', async () => {
    const { project, edit } = makeProject({ edit: base });
    const r = await edit({ op: 'cue.split', id: 'c1', word: 2 });
    const second = r.out[0]!.id as string;
    expect(project.data.cues!.find((q) => q.id === 'c1')).toMatchObject({ at: 0, len: 20, text: 'one two', words: [0, 10] });
    expect(project.data.cues!.find((q) => q.id === second)).toMatchObject({ at: 20, len: 20, text: 'three four', words: [0, 10] });
    await edit({ op: 'cue.split', id: 'c2', at: 10 });
    expect(project.data.cues!.find((q) => q.id === 'c2')).toMatchObject({ len: 10, text: 'five' });
    await expect(edit({ op: 'cue.split', id: 'c3', word: 1 })).rejects.toMatchObject({ code: 'E_RANGE' });
  });
  it('merges consecutive cues, refusing gaps with other cues', async () => {
    const { project, edit } = makeProject({ edit: base });
    await expect(edit({ op: 'cue.merge', ids: ['c1', 'c3'] })).rejects.toMatchObject({ code: 'E_ARG', message: expect.stringMatching(/c2/) });
    await edit({ op: 'cue.merge', ids: ['c2', 'c1'] });
    const m = project.data.cues!.find((q) => q.id === 'c1')!;
    expect(m).toMatchObject({ at: 0, len: 60, text: 'one two three four five six' });
    expect(m.words).toHaveLength(6);
    expect(m.words!.slice(0, 5)).toEqual([0, 10, 20, 30, 40]);
    expect(project.data.cues!.some((q) => q.id === 'c2')).toBe(false);
  });
  it('adds, sets, removes and shifts cues', async () => {
    const { project, edit } = makeProject({ edit: base });
    await expect(edit({ op: 'cue.add', clip: 'subs', at: 50, len: 20, text: 'x' })).rejects.toMatchObject({ code: 'E_OVERLAP' });
    const r = await edit({ op: 'cue.add', clip: 'subs', at: '2s', len: 15, text: 'new one', words: [0, 7] });
    expect(project.data.cues!.find((q) => q.id === r.out[0]!.id)).toMatchObject({ at: 60, words: [0, 7] });
    await expect(edit({ op: 'cue.add', clip: 'subs', at: 200, len: 15, text: 'a b', words: [0] })).rejects.toMatchObject({ code: 'E_WORDS' });
    await edit({ op: 'cue.set', id: 'c1', text: 'just three words' });
    expect(project.data.cues!.find((q) => q.id === 'c1')!.words).toHaveLength(3);
    await edit({ op: 'cue.set', id: 'c1', words: null });
    expect(project.data.cues!.find((q) => q.id === 'c1')!.words).toBeUndefined();
    await edit({ op: 'captions.shift', id: 'subs', by: 10 });
    expect(project.data.cues!.find((q) => q.id === 'c3')!.at).toBe(110);
    await expect(edit({ op: 'captions.shift', id: 'subs', by: -20 })).rejects.toMatchObject({ code: 'E_RANGE' });
    await edit({ op: 'cue.remove', ids: ['c2', 'c3'] });
    expect(project.data.cues!.map((q) => q.id).sort()).toEqual(['c1', r.out[0]!.id].sort());
  });
  it('styles a captions clip by id or by merging fields', async () => {
    const { project, edit } = makeProject({ edit: base });
    await edit({ op: 'captions.style', id: 'subs', style: 'karaoke' });
    await edit({ op: 'captions.style', id: 'subs', style: { highlight: '#00e5ff', maxWords: 3 } });
    expect(project.clip('subs')!.style).toEqual({ base: 'karaoke', highlight: '#00e5ff', maxWords: 3 });
    await edit({ op: 'captions.style', id: 'subs', style: { maxWords: null } });
    expect(project.clip('subs')!.style).toEqual({ base: 'karaoke', highlight: '#00e5ff' });
    await expect(edit({ op: 'captions.style', id: 'subs', style: 'nope' })).rejects.toMatchObject({ code: 'E_REF' });
    await expect(edit({ op: 'captions.style', id: 'subs', style: { size: 'big' } })).rejects.toMatchObject({ code: 'E_ARG' });
  });
});
