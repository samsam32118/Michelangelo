/** CLI plumbing: argument parsing, the 40-line output budget, JSON mode, error printing. */
import { MglError, fail, suggest, type MglErrorInfo } from '../core/errors.js';

export const MAX_LINES = 40;

export interface ArgSpec {
  /** flags that take a value (without dashes) */
  values?: string[];
  /** boolean flags */
  bools?: string[];
  /** short → long */
  alias?: Record<string, string>;
}

export interface Args { pos: string[]; flags: Record<string, string | boolean> }

const GLOBAL_BOOLS = ['json', 'quiet', 'debug', 'help', 'all'];

/** Parse argv for a verb. `k=v` words and negative numbers are positional. */
export function parseArgs(argv: string[], spec: ArgSpec = {}): Args {
  const values = new Set(spec.values ?? []);
  const bools = new Set([...GLOBAL_BOOLS, ...(spec.bools ?? [])]);
  const alias = { h: 'help', ...(spec.alias ?? {}) };
  const pos: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith('-') || a === '-' || /^-\.?\d/.test(a)) { pos.push(a); continue; }
    let name = a.replace(/^--?/, '');
    let value: string | undefined;
    const eq = name.indexOf('=');
    if (eq >= 0) { value = name.slice(eq + 1); name = name.slice(0, eq); }
    name = (alias as Record<string, string>)[name] ?? name; // short flags (-n) and alternate spellings (--platforms)
    if (bools.has(name)) {
      if (value !== undefined) fail('E_ARG', `--${name} takes no value.`, `write --${name} alone.`);
      flags[name] = true;
    } else if (values.has(name)) {
      if (value === undefined) {
        value = argv[++i];
        if (value === undefined) fail('E_ARG', `--${name} needs a value.`, `e.g. --${name} <value>.`);
      }
      flags[name] = value;
    } else {
      const dym = suggest(name, [...values, ...bools]);
      fail('E_ARG', `unknown option ${a}.`, dym.length ? `did you mean --${dym[0]}? (mgl help)` : `options: ${[...values, ...bools].map((f) => '--' + f).join(' ')}`);
    }
  }
  return { pos, flags };
}

export const str = (a: Args, k: string): string | undefined => (typeof a.flags[k] === 'string' ? (a.flags[k] as string) : undefined);
export const bool = (a: Args, k: string): boolean => a.flags[k] === true;
export function int(a: Args, k: string): number | undefined {
  const v = str(a, k);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) fail('E_ARG', `--${k} must be a whole number, got "${v}".`, `e.g. --${k} 4`);
  return n;
}

/** Collected output of a verb: text lines (budgeted) and the JSON result. */
export class Out {
  private buf: string[] = [];
  private written = 0;
  /** print all lines (docs --all, show --all) */
  unbounded = false;
  data: Record<string, unknown> = {};
  exit = 0;
  constructor(readonly json: boolean, readonly quiet: boolean) {}

  line(...lines: string[]) { if (!this.json) this.buf.push(...lines.flatMap((l) => l.split('\n'))); }
  /** a hint (next steps); dropped with --quiet */
  hint(s: string) { if (!this.quiet) this.line(s); }
  /** write buffered lines now (render's estimate line comes before the render runs) */
  flush() {
    if (this.json || !this.buf.length) return;
    const room = this.unbounded ? Infinity : MAX_LINES - this.written;
    const out = this.buf.slice(0, Math.max(0, room));
    this.buf = this.buf.slice(out.length);
    if (out.length) process.stdout.write(out.join('\n') + '\n');
    this.written += out.length;
  }
  set(o: Record<string, unknown>) { Object.assign(this.data, o); }
  end() {
    if (this.json) { process.stdout.write(JSON.stringify({ ok: this.exit === 0, ...this.data }) + '\n'); return; }
    const room = MAX_LINES - this.written;
    if (!this.unbounded && this.buf.length > room) {
      const keep = Math.max(0, room - 1);
      const more = this.buf.length - keep;
      this.buf = [...this.buf.slice(0, keep), `… ${more} more (use --all or --json)`];
    }
    this.flush();
  }
}

/** Truncate a line for display. */
export function clip(s: string, n = 160): string { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

export function errorLines(e: MglErrorInfo & { problems?: MglErrorInfo[] }, max = 5): string[] {
  const lines = [`error ${e.code}: ${e.message}`, `  fix: ${e.fix}`];
  const rest = (e.problems ?? []).filter((p) => p.message !== e.message);
  for (const p of rest.slice(0, max - 1)) lines.push(`error ${p.code}: ${p.message}`, `  fix: ${p.fix}`);
  if (rest.length > max - 1) lines.push(`… ${rest.length - (max - 1)} more problems (mgl check <file> lists all)`);
  return lines;
}

export function internalError(e: unknown): MglError {
  return new MglError({ code: 'E_INTERNAL', message: `unexpected error: ${(e as Error)?.message ?? String(e)}`, fix: 'report this; run with --debug for the stack.' });
}

export function bytesText(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export function secondsText(s: number): string {
  return s < 10 ? `${s.toFixed(1)} s` : s < 120 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}
