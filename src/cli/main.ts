#!/usr/bin/env node
/** The CLI: mgl / michelangelo. Nine verbs, ≤ 40 lines of output, --json everywhere, exit codes 0 / 1 / 2. */
import { MglError, suggest } from '../core/errors.js';
import { shellSafeFix } from './shell.js';
import { readFileSync } from 'node:fs';
import { Out, errorLines, internalError, parseArgs, type ArgSpec, type Args } from './io.js';

type Verb = { spec: ArgSpec; usage: string; run: (a: Args, o: Out) => Promise<void> };

const lazy = <M>(load: () => Promise<M>, pick: (m: M) => (a: Args, o: Out) => Promise<void>) => async (a: Args, o: Out) => pick(await load())(a, o);

const VERBS: Record<string, Verb> = {
  new: { spec: { values: ['out', 'name', 'fps', 'from', 'template', 'script', 'vo', 'voice', 'media', 'style', 'music', 'cta'], bools: ['force'], alias: { o: 'out' } }, usage: 'new [preset] [-o file] [--name n] [--fps 30] [--from script.txt] [--template id] [--force]\n      one-call Short: new shorts --script script.txt [--vo vo.wav | --voice default|<id>] [--media a.mp4,b.jpg] [--style viral|bold|clean] [--music bed.mp3|none] [--cta "Follow for more"|none]', run: lazy(() => import('./new.js'), (m) => m.newProject) },
  show: { spec: { values: ['at', 'clip', 'comp', 'track', 'from', 'to'], bools: ['frames', 'assets'] }, usage: 'show <file|media> [--at t] [--clip id] [--comp id] [--track id] [--from t --to t] [--frames] [--assets] [--all]', run: lazy(() => import('./show.js'), (m) => m.show) },
  edit: { spec: { values: ['batch'], bools: ['dry-run'] }, usage: "edit <file> <op> [bare] [k=v ...] | '<json>' | --batch f.jsonl [--dry-run] | undo [n] | redo [n] | history", run: lazy(() => import('./edit.js'), (m) => m.edit) },
  check: { spec: { values: ['platform'], bools: ['strict', 'alpha', 'fix', 'dry-run'], alias: { platforms: 'platform' } }, usage: 'check <file> [--strict] [--platforms tiktok,reels,shorts] [--alpha] [--fix [--dry-run]]', run: lazy(() => import('./check.js'), (m) => m.check) },
  look: { spec: { values: ['at', 'frames', 'comp', 'platform'], bools: ['cuts', 'no-audio', 'strict', 'alpha', 'fix', 'dry-run'], alias: { n: 'frames', platforms: 'platform' } }, usage: 'look <file> [--at 1s,2.5s] [-n 12] [--comp id] [--cuts] [--no-audio] [--strict] [--platforms tiktok,reels,shorts] [--alpha] [--fix [--dry-run]]', run: lazy(() => import('./look.js'), (m) => m.look) },
  render: { spec: { values: ['range', 'still', 'comp', 'segments', 'bus', 'crf', 'bitrate', 'audio-bitrate', 'pcm', 'prores', 'timecode', 'color-range'], bools: ['draft', 'final', 'hq', 'alpha', 'detach', 'status'], alias: { 'pcm-depth': 'pcm' } }, usage: 'render <file> [out] [--draft|--final|--hq] [--range a-b] [--still t] [--alpha] [--detach] [--status] [--comp id] [--segments n]\n      delivery: [--crf n] [--bitrate 8M] [--audio-bitrate 320k] [--pcm 16|24] [--prores proxy|lt|422|hq|4444|4444xq] [--timecode 10:00:00:00] [--color-range tv|pc] [--bus <id>|all]', run: lazy(() => import('./render.js'), (m) => m.render) },
  docs: { spec: {}, usage: 'docs [topic|op|commands|format|schema|<effect>|template <id>] [--all]', run: lazy(() => import('./docs.js'), (m) => m.docs) },
  plugin: { spec: { values: ['dir'], bools: ['no-typecheck'] }, usage: 'plugin new <kind> <name> [--dir .] | test <dir> | trust <dir> | list [file]', run: lazy(() => import('./plugin.js'), (m) => m.plugin) },
  doctor: { spec: { bools: ['fetch'] }, usage: 'doctor [file] [--fetch]', run: lazy(() => import('./doctor.js'), (m) => m.doctor) },
};

const HELP = [
  'mgl (michelangelo): video editing and motion graphics from the terminal.',
  ...Object.values(VERBS).map((v) => `  mgl ${v.usage}`),
  'global: --json (one JSON object), --quiet (no hints), --debug (stacks), --all (no 40-line cap), --version',
  'exit codes: 0 ok, 1 the input is wrong, 2 the environment is wrong (e.g. no ffmpeg)',
  'start: mgl new shorts && mgl show video.mgl.json · guide: mgl docs · commands: mgl docs commands',
];

/** The package version (package.json next to src/ or dist/). */
export function version(): string {
  try { return String((JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? '0.0.0'); } catch { return '0.0.0'; }
}

export async function main(argv: string[]): Promise<number> {
  const json = argv.includes('--json'), quiet = argv.includes('--quiet'), debug = argv.includes('--debug');
  const o = new Out(json, quiet);
  const [verb, ...rest] = argv;
  try {
    if (verb === '--version' || verb === '-v' || verb === '-V' || verb === 'version') {
      const { PLUGIN_API_VERSION } = await import('../plugin/api.js');
      o.line(`mgl ${version()} (plugin API ${PLUGIN_API_VERSION}, node ${process.versions.node})`);
      o.set({ version: version(), pluginApi: PLUGIN_API_VERSION, node: process.versions.node });
      o.end();
      return 0;
    }
    if (!verb || verb === 'help' || verb === '--help' || verb === '-h' || (verb.startsWith('-') && !VERBS[verb])) {
      const v = verb === 'help' && rest[0] ? VERBS[rest[0]] : undefined;
      o.line(...(v ? `usage: mgl ${v.usage}`.split('\n') : HELP.flatMap((l) => l.split('\n'))));
      o.set({ verbs: Object.keys(VERBS) });
      o.end();
      return 0;
    }
    const v = VERBS[verb];
    if (!v) {
      const dym = suggest(verb, Object.keys(VERBS));
      throw new MglError({ code: 'E_USAGE', message: `"${verb}" is not a verb.`, fix: dym.length ? `did you mean "mgl ${dym[0]}"? (mgl help)` : `verbs: ${Object.keys(VERBS).join(', ')}` });
    }
    const a = parseArgs(rest, v.spec);
    if (a.flags.help) { o.line(...`usage: mgl ${v.usage}`.split('\n')); o.end(); return 0; }
    if (a.flags.all) o.unbounded = true;
    await v.run(a, o);
    o.end();
    return o.exit;
  } catch (e) {
    const err = e instanceof MglError ? e : internalError(e);
    // example lines in fixes are pasted into a shell: quote their values
    err.fix = await shellSafeFix(err.fix);
    if (err.problems) err.problems = await Promise.all(err.problems.map(async (p) => ({ ...p, fix: await shellSafeFix(p.fix) })));
    if (json) process.stdout.write(JSON.stringify({ ok: false, ...o.data, error: err.toJSON() }) + '\n');
    else {
      o.end();
      process.stderr.write(errorLines(err).join('\n') + '\n');
    }
    if (debug && e instanceof Error) process.stderr.write((e.stack ?? String(e)) + '\n');
    return err.exitCode;
  }
}

const isEntry = process.argv[1] && /[\\/](main\.(ts|js)|mgl|michelangelo)$/.test(process.argv[1]);
if (isEntry) {
  // exit once output is flushed, so lingering handles (decoders, workers) never keep the CLI alive
  main(process.argv.slice(2)).then((code) => {
    process.stdout.write('', () => process.exit(code));
  }, (e) => {
    process.stderr.write(`error E_INTERNAL: ${(e as Error)?.stack ?? e}\n  fix: report this; run with --debug for the stack.\n`);
    process.exitCode = 1;
  });
}
