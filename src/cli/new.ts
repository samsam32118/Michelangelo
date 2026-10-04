/** `mgl new`: create a project from a preset, optionally with a first edit from a script or a template. */
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fail } from '../core/errors.js';
import type { Command } from '../core/commands/registry.js';
import { PRESETS } from '../core/commands/structure.js';
import { create, workDir } from '../sdk/index.js';
import { bool, str, type Args, type Out } from './io.js';

/** Words per second used to estimate a script's spoken length. */
export const WORDS_PER_SECOND = 2.6;

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'video';
}

/** Is `dir` inside a git work tree? */
function inGitRepo(dir: string): boolean {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return true;
    if (dirname(d) === d) return false;
  }
}

function ignoreWorkDir(dir: string): string | undefined {
  if (!inGitRepo(dir)) return undefined;
  const f = join(dir, '.gitignore');
  if (existsSync(f)) {
    const text = readFileSync(f, 'utf8');
    if (text.split('\n').some((l) => ['.mgl', '.mgl/', '/.mgl', '/.mgl/'].includes(l.trim()))) return undefined;
    appendFileSync(f, `${text.endsWith('\n') || !text ? '' : '\n'}.mgl/\n`);
    return 'appended .mgl/ to .gitignore';
  }
  writeFileSync(f, '.mgl/\n');
  return 'created .gitignore with .mgl/';
}

/** The first edit for a script: a background, a title card, and captions over the estimated spoken length. */
export function scriptCommands(script: string, [width, height]: [number, number] = [1080, 1920]): Command[] {
  const text = script.replace(/\r/g, '').trim();
  if (!text) fail('E_ARG', 'the script is empty.', 'write the narration as plain text, one or more sentences.');
  const words = text.split(/\s+/).filter(Boolean).length;
  const firstLine = text.split('\n').find((l) => l.trim())!.trim();
  const title = (firstLine.split(/(?<=[.!?])\s/)[0] ?? firstLine).replace(/[.!]+$/, '').slice(0, 60);
  const titleLen = 2.5;
  const speech = Math.max(2, Math.round((words / WORDS_PER_SECOND) * 10) / 10);
  const total = Math.round((titleLen + speech) * 10) / 10;
  return [
    { op: 'clip.add', id: 'bg', track: 'V1', at: 0, len: `${total}s`, gen: { type: 'gradient', colors: ['#1e3c72', '#2a5298'], angle: 90 } },
    { op: 'clip.add', id: 'title', track: 'T1', at: 0, len: `${titleLen}s`, text: title, style: { base: 'title', maxWidth: Math.round(width * 0.74) }, animate: { in: 'pop', by: 'word' } },
    { op: 'captions.from-text', text, id: 'subs', at: `${titleLen}s`, len: `${speech}s`, style: 'karaoke', maxWords: 4 },
    { op: 'clip.set', id: 'subs', y: Math.round(height * 0.68) },
  ];
}

export async function newProject(a: Args, o: Out) {
  const preset = a.pos[0] ?? 'shorts';
  if (a.pos.length > 1) fail('E_USAGE', `new takes one preset; got extra "${a.pos[1]}".`, 'name the file with -o: mgl new shorts -o focus.mgl.json');
  if (!PRESETS[preset]) fail('E_PRESET', `"${preset}" is not a preset.`, `use one of: ${Object.keys(PRESETS).join(', ')}.`);
  const name = str(a, 'name');
  const file = str(a, 'out') ?? `${name ? slug(name) : 'video'}.mgl.json`;
  if (!/\.json$/.test(file)) fail('E_ARG', `the project file should end in .mgl.json (got ${file}).`, `-o ${file.replace(/\.[^./]*$/, '')}.mgl.json`);
  const fpsArg = str(a, 'fps');
  const fps = fpsArg === undefined ? 30 : /^\d+$/.test(fpsArg) ? Number(fpsArg) : fpsArg;
  const from = str(a, 'from'), template = str(a, 'template');
  let script: string | undefined;
  if (from) {
    try { script = readFileSync(from, 'utf8'); } catch { fail('E_NO_FILE', `${from} does not exist.`, 'give the path of a plain-text script (relative to the current directory).'); }
  }
  if (existsSync(file) && !bool(a, 'force')) fail('E_EXISTS', `${file} already exists.`, `choose another name (-o other.mgl.json), or add --force to overwrite it.`);
  const p = await create(file, { preset, fps, ...(name ? { name } : {}), force: true, save: false });
  rmSync(join(workDir(file), 'history.json'), { force: true }); // a replaced project starts with no history
  const cmds: Command[] = [];
  if (script !== undefined) cmds.push(...scriptCommands(script, p.data.comps[0]!.size));
  if (template) cmds.push({ op: 'template.apply', template, at: 0 });
  let summary: string[] = [];
  if (cmds.length) summary = (await p.edit(cmds, { save: false })).summary;
  await p.save({ force: true });
  const ignore = ignoreWorkDir(dirname(resolve(file)));
  const lines = p.text().split('\n').length - 1;
  const c = p.data.comps[0]!;
  const clips = p.data.clips?.length ?? 0, cues = p.data.cues?.length ?? 0;
  o.line(`created ${file} (${lines} lines, ${preset} ${c.size[0]}x${c.size[1]} ${c.fps}fps${clips ? `, ${clips} clips` : ''}${cues ? `, ${cues} cues` : ''})`);
  for (const s of summary) o.line(`  ${s}`);
  if (ignore) o.line(ignore);
  o.hint(`next: mgl show ${file}`);
  o.set({ file: resolve(file), name: basename(file), lines, preset, size: c.size, fps: c.fps, clips, cues, summary });
}
