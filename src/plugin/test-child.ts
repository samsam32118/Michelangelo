/**
 * Child process of `mgl plugin test`: imports the plugin (with the library's resolve hook), validates its
 * definition deeply and renders .preview.png. Prints one line: MGL_RESULT <json>.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import type { PluginDef, Surface } from './api.js';
import { pluginEntry } from './loader.js';
import { checkPluginDef, kindsOf } from './validate.js';
import { builtinRegistry } from '../builtin/index.js';
import { effectFilters, renderEffect, renderGenerator, renderTransition, savePNG, solid } from './testing.js';

interface Result { name?: string; errors: string[]; kinds: string[]; preview?: string; previewOf?: string; filters?: string[] }

/** Generators draw on transparency: show them over a dark background. */
function overDark(s: Surface): Surface {
  const bg = solid(s.width, s.height, '#202024');
  bg.ctx.drawImage(s.canvas, 0, 0);
  return bg;
}

async function main(dir: string): Promise<Result> {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
  let def: PluginDef;
  try {
    const mod = (await import(pathToFileURL(pluginEntry(dir, pkg)).href)) as { default?: PluginDef };
    def = mod.default as PluginDef;
  } catch (e) {
    return { errors: [`the entry failed to import: ${(e as Error).stack ?? String(e)} (fix: correct the error above).`], kinds: [] };
  }
  const errors = checkPluginDef(def, true);
  if (errors.length) return { errors, kinds: [] };
  // the same clash check the loader does: an item named like a built-in cannot load in a project
  if (builtinRegistry().plugins.has(def.name)) return { errors: [`plugin name "${def.name}" is a built-in plugin's name, so projects would never load it (fix: rename the plugin in package.json and definePlugin).`], kinds: [] };
  try { builtinRegistry().add(def, dir); } catch (e) {
    return { errors: [`${(e as Error).message} by a built-in, so the plugin cannot load in a project (fix: rename it, e.g. prefix it with the plugin name).`], kinds: [] };
  }
  const r: Result = { name: def.name, errors, kinds: kindsOf(def) };
  // source/audio-stage effects: their default filters must pass the allowlist (a render would refuse them)
  for (const e of def.effects ?? []) {
    if (!e.source && !e.audio) continue;
    try {
      const f = await effectFilters(e, {});
      r.filters = [...(r.filters ?? []), `${e.type}: ${[f.sourceGraph && `source ${f.sourceGraph}`, f.audioGraph && `audio ${f.audioGraph}`].filter(Boolean).join('; ') || '(no filters with default params)'}`];
    } catch (err) {
      const x = err as { message?: string; fix?: string };
      r.errors.push(`effect "${e.type}" with default params: ${x.message ?? String(err)}${x.fix ? ` (fix: ${x.fix})` : ''}`);
    }
  }
  const W = 480, H = 270, file = join(dir, '.preview.png');
  try {
    const fx = def.effects?.find((e) => e.draw), tr = def.transitions?.[0], gen = def.generators?.[0];
    const shot = fx ? { s: renderEffect(fx, {}, { width: W, height: H, frame: 15 }).dst, of: `effect ${fx.type}` }
      : tr ? { s: renderTransition(tr, 0.5, { width: W, height: H, frame: 15 }).dst, of: `transition ${tr.type} at progress 0.5` }
      : gen ? { s: overDark(renderGenerator(gen, {}, 15, { width: W, height: H }).dst), of: `generator ${gen.type} at frame 15, over dark grey` } : undefined;
    if (shot) { await savePNG(shot.s, file); r.preview = file; r.previewOf = shot.of; }
  } catch (e) {
    r.errors.push(`rendering the preview with default params threw: ${(e as Error).stack ?? String(e)} (fix: make draw work with the defaults).`);
  }
  return r;
}

const dir = process.argv[2];
if (dir) {
  const r = await main(dir).catch((e: unknown) => ({ errors: [String((e as Error).stack ?? e)], kinds: [] }));
  process.stdout.write(`\nMGL_RESULT ${JSON.stringify(r)}\n`);
}
