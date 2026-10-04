/** `mgl look [--fix]`: without --fix the look verb of render.ts; with --fix, verified auto-fixes judged on rendered frames. */
import { parseRate, parseTime } from '../core/time.js';
import { assertRenderable, open, parsePlatforms } from '../sdk/index.js';
import { bool, int, str, type Args, type Out } from './io.js';

export async function look(a: Args, o: Out) {
  if (!bool(a, 'fix')) return (await import('./render.js')).look(a, o);
  const file = a.pos[0];
  if (!file) return (await import('./render.js')).look(a, o); // prints the usage error
  const p = await open(file);
  assertRenderable(p);
  const { resolveComp } = await import('../render/pipeline.js');
  const comp = resolveComp(p.data, str(a, 'comp'));
  const rate = parseRate(comp.fps);
  const { fixLook, formatFix, fixJson } = await import('../qa/fix.js');
  const { displayName } = await import('../qa/look.js');
  const shown = displayName(file);
  const at = str(a, 'at')?.split(',').map((x) => x.trim()).filter(Boolean).map((x) => parseTime(/^\d+$/.test(x) ? Number(x) : x, rate, 'at'));
  const n = int(a, 'frames'), platform = str(a, 'platform');
  const r = await fixLook(p, {
    displayFile: shown, comp: comp.id, ...(at?.length ? { frames: at } : {}), ...(n !== undefined ? { n } : {}),
    ...(bool(a, 'cuts') ? { cuts: true } : {}), ...(bool(a, 'no-audio') ? { audio: false } : {}),
    ...(platform ? { platforms: parsePlatforms(platform) } : {}), ...(bool(a, 'alpha') ? { alpha: true } : {}), ...(bool(a, 'safe') ? { safe: true } : {}), ...(bool(a, 'dry-run') ? { dryRun: true } : {}),
  });
  const lines = formatFix(r, shown, 'look');
  o.line(...lines.slice(0, 9), `sheet: ${displayName(r.report.sheet)}`);
  if (bool(a, 'strict') && r.remaining.some((f) => f.severity === 'error')) o.exit = 1;
  o.set({ file, fix: fixJson(r), ...r.report, issues: r.remaining.length });
}
