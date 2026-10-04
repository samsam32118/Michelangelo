/** `mgl check [--fix]`: without --fix the check verb of edit.ts; with --fix, verified auto-fixes in one undo step. */
import { open, parsePlatforms } from '../sdk/index.js';
import { bool, str, type Args, type Out } from './io.js';

export async function check(a: Args, o: Out) {
  if (!bool(a, 'fix')) return (await import('./edit.js')).check(a, o);
  const file = a.pos[0];
  let p;
  try { p = await open(file!); } catch {
    return (await import('./edit.js')).check(a, o); // prints the load errors (nothing to fix automatically)
  }
  const { fixCheck, formatFix, fixJson } = await import('../qa/fix.js');
  const { displayName } = await import('../qa/look.js');
  const shown = displayName(file!);
  const platform = str(a, 'platform');
  const r = await fixCheck(p, { displayFile: shown, ...(platform ? { platforms: parsePlatforms(platform) } : {}), ...(bool(a, 'alpha') ? { alpha: true } : {}), ...(bool(a, 'dry-run') ? { dryRun: true } : {}) });
  o.line(...formatFix(r, shown, 'check'));
  if (bool(a, 'strict') && r.remaining.some((f) => f.severity === 'error')) o.exit = 1;
  o.set({ file, fix: fixJson(r), issues: r.remaining.length, findings: r.remaining });
}
