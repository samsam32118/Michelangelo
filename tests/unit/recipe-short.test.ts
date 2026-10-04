// @vitest-environment node
/** recipe.short (one-call Short) and `mgl new shorts --script`: valid, overlap-free, QA-clean projects. */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { create, type MglProject } from '../../src/sdk/index.js';
import { speakService } from '../../src/sdk/services.js';
import { captionLines, hookText, markKeywords, segmentTimes, sentences, LOOKS } from '../../src/core/commands/recipe.js';
import { stripEmphasis } from '../../src/core/captions.js';
import type { Clip } from '../../src/core/schema/index.js';
import { mgl, tempDir } from './cli-fixtures.js';

const SCRIPT = 'Most people waste their mornings. Here are three habits that changed mine. First, no phone for the first hour. Second, ten minutes of sunlight before coffee. Third, write down the one task that matters today. Try it for a week and watch what happens.';

const ff = (args: string[], cwd: string) => execFileSync('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...args], { cwd, stdio: ['ignore', 'ignore', 'pipe'] });

let tmp: ReturnType<typeof tempDir>;
beforeAll(() => {
  tmp = tempDir('mgl-recipe-');
  writeFileSync(join(tmp.dir, 'script.txt'), SCRIPT + '\n');
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', 'a.mp4'], tmp.dir);
  ff(['-f', 'lavfi', '-i', 'mandelbrot=s=640x360:r=30', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', 'b.mp4'], tmp.dir);
  ff(['-f', 'lavfi', '-i', 'color=c=#3a6ea5:s=540x960', '-frames:v', '1', 'c.jpg'], tmp.dir);
  // a deterministic voice-over: the script spoken by flite, with a pause between sentences
  ff(['-f', 'lavfi', '-i', `flite=textfile=script.txt:voice=slt`, '-ar', '48000', 'vo.wav'], tmp.dir);
  ff(['-f', 'lavfi', '-i', 'sine=f=220:d=30,volume=0.4', '-ar', '48000', 'bed.wav'], tmp.dir);
});
afterAll(() => tmp?.cleanup());

let n = 0;
async function short(fields: Record<string, unknown>, preset = 'shorts'): Promise<MglProject> {
  const p = await create(join(tmp.dir, `s${++n}.mgl.json`), { preset });
  await p.edit({ op: 'recipe.short', script: SCRIPT, ...fields });
  return p;
}

const clipsOf = (p: MglProject) => p.data.clips ?? [];
const end = (c: Clip) => c.at + c.len;
function clip(p: MglProject, id: string): Clip {
  const c = clipsOf(p).find((x) => x.id === id);
  if (!c) throw new Error(`no clip ${id}`);
  return c;
}

/** No two clips on one track overlap; the main track covers the whole piece without gaps. */
function assertLayout(p: MglProject) {
  const byTrack = new Map<string, Clip[]>();
  for (const c of clipsOf(p)) byTrack.set(c.track, [...(byTrack.get(c.track) ?? []), c]);
  for (const [t, cs] of byTrack) {
    cs.sort((a, b) => a.at - b.at);
    for (let i = 1; i < cs.length; i++) expect(cs[i]!.at, `${t}: ${cs[i - 1]!.id} / ${cs[i]!.id}`).toBeGreaterThanOrEqual(end(cs[i - 1]!));
  }
  const total = Math.max(...clipsOf(p).map(end));
  const bg = (byTrack.get('V1') ?? []).sort((a, b) => a.at - b.at);
  expect(bg[0]!.at).toBe(0);
  for (let i = 1; i < bg.length; i++) expect(bg[i]!.at).toBe(end(bg[i - 1]!));
  expect(end(bg[bg.length - 1]!)).toBe(total);
}

async function assertClean(p: MglProject) {
  expect(p.issues).toEqual([]);
  expect(p.problems).toEqual([]);
  const rep = await p.check();
  expect(rep.problems).toEqual([]);
  expect(rep.findings.filter((f) => f.severity !== 'info')).toEqual([]);
}

describe('recipe.short helpers', () => {
  it('marks numbers as caption keywords unless the script marks its own', () => {
    expect(markKeywords('Here are three habits. First, no phone. Save 10% today.')).toBe('Here are *three* habits. *First*, no phone. Save *10%* today.');
    expect(markKeywords('I *love* three things.')).toBe('I *love* three things.');
    expect(markKeywords('The one task, for sixty minutes.')).toBe('The one task, for *sixty* minutes.');
    expect(hookText(stripEmphasis('*Three* habits that work.')).text).toBe('Three habits that work');
  });
  it('splits sentences and picks a hook', () => {
    expect(sentences('One two. Three four!\nFive?')).toEqual(['One two.', 'Three four!', 'Five?']);
    expect(hookText('Most people waste their mornings.')).toEqual({ text: 'Most people waste their mornings', whole: true });
    expect(hookText('Stop scrolling, this one trick saves you an hour every single day.')).toEqual({ text: 'Stop scrolling', whole: false });
    expect(hookText('This is a very long first sentence that has no commas in it at all.').text).toMatch(/…$/);
  });
  it('balances caption pages and never leaves one word alone', () => {
    const lines = captionLines('Here are three habits that changed mine.', 3).split('\n');
    expect(lines).toEqual(['Here are three', 'habits that', 'changed mine.']);
    for (const s of sentences(SCRIPT)) for (const l of captionLines(s, 3).split('\n')) {
      expect(l.split(' ').length).toBeLessThanOrEqual(3);
      if (s.split(' ').length > 1) expect(l.split(' ').length).toBeGreaterThan(1);
    }
  });
  it('segments backgrounds at sentence ends, merging short and splitting long ones', () => {
    expect(segmentTimes([30, 40, 200], 300, 20, 100)).toEqual([[0, 40], [40, 120], [120, 200], [200, 300]]);
    expect(segmentTimes([], 90, 20, 100)).toEqual([[0, 90]]);
  });
});

describe('recipe.short', () => {
  it('script only: a complete, QA-clean 9:16 Short', async () => {
    const p = await short({});
    assertLayout(p);
    await assertClean(p);
    const ids = clipsOf(p).map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['hook', 'captions', 'bg1', 'progress-fill', 'cta-label', 'cta-button', 'particles']));
    const hook = clip(p, 'hook'), cap = clip(p, 'captions');
    expect(hook.text).toBe('Most people waste their mornings');
    // captions start when the hook (the first sentence) ends, at ~2.6 words per second
    expect(cap.at).toBe(end(hook));
    const words = SCRIPT.split(/\s+/).length;
    expect(Math.abs(end(cap) - Math.round((words / 2.6) * 30))).toBeLessThanOrEqual(1);
    expect((p.data.cues ?? []).every((q) => q.text.split(' ').length <= LOOKS.viral.maxWords)).toBe(true);
    // a new background per sentence, with transitions rotating among several types (never flash)
    const bgs = clipsOf(p).filter((c) => c.track === 'V1');
    expect(bgs.length).toBeGreaterThanOrEqual(sentences(SCRIPT).length);
    expect(bgs.every((c) => c.gen)).toBe(true);
    const types = bgs.slice(1).map((c) => c.transition?.in?.type);
    expect(types.every(Boolean)).toBe(true);
    expect(types).not.toContain('flash');
    expect(new Set(types).size).toBeGreaterThanOrEqual(4);
    // the CTA ends the piece; the progress bar spans it
    expect(end(clip(p, 'cta-button'))).toBe(end(bgs[bgs.length - 1]!));
    expect(clip(p, 'progress-fill').len).toBe(end(bgs[bgs.length - 1]!));
    expect(p.data.project?.platform).toBe('shorts');
    // the frame QA (rendered pixels) is clean too
    const look = await p.look({ frames: 6, audio: false });
    expect(look.findings.filter((f) => f.severity !== 'info')).toEqual([]);
  });

  it('script + voice-over: captions follow the speech, music is ducked, loudness set', async () => {
    const p = await short({ vo: 'vo.wav', music: 'bed.wav', style: 'clean' });
    assertLayout(p);
    await assertClean(p);
    const vo = clip(p, 'vo'), cap = clip(p, 'captions');
    expect(vo.at).toBe(0);
    expect(end(cap)).toBeLessThanOrEqual(end(vo));
    expect(cap.at).toBe(end(clip(p, 'hook')));
    const total = Math.max(...clipsOf(p).map(end));
    expect(total).toBeGreaterThan(end(vo));
    expect(clip(p, 'bed').len).toBe(total);
    const buses = new Map((p.data.buses ?? []).map((b) => [b.id, b]));
    expect(buses.get('music')?.duck).toMatchObject({ by: 'dialogue' });
    expect(buses.get('master')?.loudness?.lufs).toBe(-14);
    expect(p.data.styles?.map((s) => s.id)).toEqual(['clean-caption', 'clean-hook']);
  });

  it('script + media: b-roll shots with ken-burns / punch-ins, inside their sources', async () => {
    const p = await short({ media: ['a.mp4', 'b.mp4', 'c.jpg'], style: 'bold', cta: 'Save this' });
    assertLayout(p);
    await assertClean(p);
    const bgs = clipsOf(p).filter((c) => c.track === 'V1');
    expect(bgs.length).toBeGreaterThanOrEqual(6);
    const srcs = new Map((p.data.assets ?? []).map((a) => [a.id, a.src]));
    expect(new Set(bgs.map((c) => srcs.get(c.asset!)))).toEqual(new Set(['a.mp4', 'b.mp4', 'c.jpg']));
    // every shot moves: keyframed scale (ken-burns or punch-in)
    expect(bgs.every((c) => Array.isArray(c.scale))).toBe(true);
    // video shots stay inside their source (3 s and 4 s at 30 fps) and leave a handle for the transition
    const frames: Record<string, number> = { 'a.mp4': 120, 'b.mp4': 90 };
    for (const c of bgs) {
      const f = frames[srcs.get(c.asset!)!];
      if (f !== undefined) expect((c.in ?? 0) + c.len).toBeLessThanOrEqual(f);
    }
    expect(clip(p, 'cta-label').text).toBe('Save this');
    const look = await p.look({ frames: 6, audio: false });
    expect(look.findings.filter((f) => f.severity !== 'info')).toEqual([]);
  });

  it('is deterministic and honours len, hook, captions, cta and seed', async () => {
    const a = await short({ seed: 2 }), b = await short({ seed: 2 });
    expect(a.text()).toBe(b.text());
    const c = await short({ hook: false, captions: false, cta: false, len: '12s', platform: 'tiktok' });
    expect(clipsOf(c).some((x) => x.id === 'hook' || x.id === 'captions' || x.id.startsWith('cta'))).toBe(false);
    expect(Math.max(...clipsOf(c).map(end))).toBe(360);
    expect(c.data.project?.platform).toBe('tiktok');
    assertLayout(c);
    await assertClean(c);
  });

  it('reads the script from a file and refuses a comp that already has clips', async () => {
    const p = await create(join(tmp.dir, 'file.mgl.json'), { preset: 'shorts' });
    await p.edit({ op: 'recipe.short', script: 'script.txt' });
    expect(clip(p, 'hook').text).toBe('Most people waste their mornings');
    await expect(p.edit({ op: 'recipe.short', script: SCRIPT })).rejects.toMatchObject({ code: 'E_NOT_EMPTY' });
    const q = await create(join(tmp.dir, 'bad.mgl.json'), { preset: 'shorts' });
    await expect(q.edit({ op: 'recipe.short', script: SCRIPT, vo: 'c.jpg' })).rejects.toMatchObject({ code: 'E_ARG' });
  });

  it('adds a generated music bed, SFX on the cuts and ducking (audio.music, audio.auto-sfx)', async () => {
    const p = await short({ vo: 'vo.wav' });
    const bed = clip(p, 'bed');
    const asset = p.data.assets!.find((a) => a.id === bed.asset)!;
    expect(asset.src).toMatch(/^media\/generated\/music-/);
    expect(p.data.tracks!.find((t) => t.id === bed.track)!.bus).toBe('music');
    expect(p.data.buses?.find((b) => b.id === 'music')?.duck).toBeTruthy();
    const sfx = clipsOf(p).filter((c) => c.tags?.includes('auto-sfx'));
    expect(sfx.length).toBeGreaterThan(2);
    // per-kind levels (tuned over the -18 LUFS bed), no extra cut
    for (const c of sfx) expect(c.gain ?? 0).toBeGreaterThan(-8);
    await assertClean(p);
    const quiet = await short({ vo: 'vo.wav', music: false });
    expect(clipsOf(quiet).some((c) => c.id === 'bed')).toBe(false);
  });

  it('voice=: speaks the script with the speak provider and captions follow its word timings', async () => {
    const p = await create(join(tmp.dir, 'voice.mgl.json'), { preset: 'shorts' });
    const seen: { text: string; voice?: string }[] = [];
    p.services.speak = speakService(p.dir, {
      kind: 'speak', id: 'fake', describe: 'test voice', voices: async () => [{ id: 'v1' }],
      async speak(a) {
        seen.push({ text: a.text, ...(a.voice ? { voice: a.voice } : {}) });
        const words = a.text.split(' ');
        ff(['-f', 'lavfi', '-i', `sine=f=300:d=${(words.length * 0.4).toFixed(2)}`, '-ar', '48000', a.out], tmp.dir);
        return { words: words.map((w, i) => ({ text: w, start: i * 0.4, end: i * 0.4 + 0.35 })) };
      },
    });
    await p.edit({ op: 'recipe.short', script: SCRIPT, voice: 'v1', music: false });
    expect(seen).toEqual([{ text: SCRIPT, voice: 'v1' }]);
    const vo = clip(p, 'vo');
    expect(p.data.assets!.find((a) => a.id === vo.asset)!.src).toMatch(/^media\/generated\/vo-/);
    const words = SCRIPT.split(' ').length;
    expect(vo.len).toBe(Math.round(words * 0.4 * 30));
    // cues follow the word timings: a cue starting with "Second," starts at that word's time
    const capClip = clip(p, 'captions');
    // keywords (numbers) come back marked on the spoken cues: "*Second*, ten minutes" → emphasis
    const second = p.data.cues!.find((q) => q.clip === 'captions' && q.text.startsWith('*Second*,'))!;
    expect(capClip.at + second.at).toBe(Math.round(SCRIPT.split(' ').indexOf('Second,') * 0.4 * 30));
    assertLayout(p);
    await assertClean(p);
    await expect(p.edit({ op: 'recipe.short', script: SCRIPT, comp: 'main', vo: 'vo.wav', voice: true })).rejects.toMatchObject({ code: 'E_ARG' });
    const q = await create(join(tmp.dir, 'novoice.mgl.json'), { preset: 'shorts' });
    await expect(q.edit({ op: 'recipe.short', script: SCRIPT, voice: true })).rejects.toMatchObject({ code: 'E_NO_PROVIDER' });
    // two steps: audio.speak first, then the recipe with vo=<its clip> (the only clip allowed in the comp)
    const r = await create(join(tmp.dir, 'twostep.mgl.json'), { preset: 'shorts' });
    r.services.speak = p.services.speak;
    await r.edit({ op: 'audio.speak', text: SCRIPT, id: 'line1' });
    await r.edit({ op: 'recipe.short', script: SCRIPT, vo: 'line1', music: false });
    const s2 = r.data.cues!.find((q) => q.clip === 'captions' && q.text.startsWith('*Second*,'))!;
    expect(clip(r, 'captions').at + s2.at).toBe(Math.round(SCRIPT.split(' ').indexOf('Second,') * 0.4 * 30));
    await assertClean(r);
  });
});

describe('mgl new shorts --script', () => {
  it('builds the Short in one call and prints the next steps', async () => {
    const r = await mgl(['new', 'shorts', '--script', 'script.txt', '--vo', 'vo.wav', '--media', 'a.mp4,c.jpg', '--style', 'viral', '-o', 'cli.mgl.json'], { cwd: tmp.dir });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/built a viral Short of [\d.]+s/);
    expect(r.lines).toContain('next: mgl look cli.mgl.json');
    expect(r.lines).toContain('next: mgl render cli.mgl.json cli.mp4');
    const text = readFileSync(join(tmp.dir, 'cli.mgl.json'), 'utf8');
    expect(text).toContain('"src": "vo.wav"');
    const c = await mgl(['check', 'cli.mgl.json'], { cwd: tmp.dir });
    expect(c.stdout).toContain('ok (no problems, no QA findings)');
    const bad = await mgl(['new', 'shorts', '--vo', 'vo.wav', '-o', 'x.mgl.json'], { cwd: tmp.dir });
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('--vo needs --script');
  });
});
