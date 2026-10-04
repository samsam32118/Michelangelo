// Validates the held-out graders: for every task, setup into a temp dir and confirm the grade FAILS with no
// outputs; where a reference.mjs exists, run it on a fresh setup and confirm the grade PASSES.
// Usage: node evals/heldout/_validate.mjs [task ...] [--keep]
import { readdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2), keep = argv.includes('--keep');
const only = argv.filter((a) => !a.startsWith('--'));
const tasks = readdirSync(here, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('_') && existsSync(join(here, e.name, 'grade.mjs')))
  .map((e) => e.name).filter((t) => !only.length || only.includes(t)).sort();
const load = (t, f) => import(pathToFileURL(join(here, t, f)).href);
const brief = (r) => r.checks.map((c) => `${c.pass ? 'ok ' : 'XX '} ${c.name}: ${c.detail}`).join('\n    ');

const summary = { tasks: tasks.length, setupGrade: 0, failsOnEmpty: 0, references: 0, referencesPass: 0 };
let ok = true;
for (const t of tasks) {
  const t0 = Date.now();
  const { setup } = await load(t, 'setup.mjs'), { grade } = await load(t, 'grade.mjs');
  summary.setupGrade++;
  const empty = mkdtempSync(join(tmpdir(), `mglh-${t}-empty-`));
  try {
    await setup(empty);
    const r = await grade(empty);
    const good = !r.pass && r.checks.length > 0;
    if (good) summary.failsOnEmpty++; else ok = false;
    console.log(`${good ? 'PASS' : 'FAIL'} ${t}: grade on empty outputs ${r.pass ? 'PASSED (bad)' : 'failed (good)'}, score ${r.score}`);
  } catch (e) { ok = false; console.log(`FAIL ${t}: empty run threw ${e?.stack ?? e}`); }
  finally { if (!keep) rmSync(empty, { recursive: true, force: true }); }
  if (existsSync(join(here, t, 'reference.mjs'))) {
    summary.references++;
    const dir = mkdtempSync(join(tmpdir(), `mglh-${t}-ref-`));
    try {
      await setup(dir);
      const { reference } = await load(t, 'reference.mjs');
      await reference(dir);
      const r = await grade(dir);
      if (r.pass) summary.referencesPass++; else ok = false;
      console.log(`${r.pass ? 'PASS' : 'FAIL'} ${t}: reference ${r.pass ? 'passes' : 'FAILS'} (score ${r.score})\n    ${brief(r)}`);
      // Mutants: degraded variants of the reference output (black, static, silent, gamed) that must fail.
      if (existsSync(join(here, t, 'mutants.mjs'))) {
        const { mutants } = await load(t, 'mutants.mjs');
        for (const m of mutants) {
          const restore = await m.apply(dir);
          const rm = await grade(dir);
          await restore?.();
          summary.mutants = (summary.mutants ?? 0) + 1;
          if (!rm.pass) summary.mutantsFail = (summary.mutantsFail ?? 0) + 1; else ok = false;
          console.log(`${rm.pass ? 'FAIL' : 'PASS'} ${t}: mutant "${m.name}" ${rm.pass ? 'PASSES the grade (bad)' : `fails (good): ${rm.checks.filter((c) => !c.pass).map((c) => c.name.slice(0, 50)).join(' | ')}`}`);
        }
      }
    } catch (e) { ok = false; console.log(`FAIL ${t}: reference threw ${e?.stack ?? e}`); }
    finally { if (!keep) rmSync(dir, { recursive: true, force: true }); else console.log(`    kept ${dir}`); }
  }
  console.log(`     (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}
console.log(JSON.stringify(summary));
process.exit(ok ? 0 : 1);
