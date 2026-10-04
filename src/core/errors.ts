/** Every failure Michelangelo reports: a stable code, a message, and the fix. */
export type ErrorKind = 'input' | 'environment';

export interface MglErrorInfo {
  code: string;
  message: string;
  fix: string;
  /** 1-based line in the project file, when the problem is in the file */
  line?: number;
  /** JSON path of the offending value, e.g. clips[3].opacity */
  path?: string;
  didYouMean?: string[];
}

/** Codes whose cause is the environment (exit 2) rather than the input (exit 1). */
const ENVIRONMENT_CODES = new Set(['E_FFMPEG', 'E_FFMPEG_OLD', 'E_DOWNLOAD', 'E_DISK', 'E_NATIVE', 'E_PLUGIN_LOAD', 'E_TIMEOUT']);

export class MglError extends Error implements MglErrorInfo {
  code: string;
  fix: string;
  line?: number;
  path?: string;
  didYouMean?: string[];
  /** further problems found together with this one (load errors) */
  problems?: MglErrorInfo[];
  constructor(info: MglErrorInfo & { problems?: MglErrorInfo[] }) {
    super(info.message);
    this.name = 'MglError';
    this.code = info.code;
    this.fix = info.fix;
    if (info.line !== undefined) this.line = info.line;
    if (info.path !== undefined) this.path = info.path;
    if (info.didYouMean?.length) this.didYouMean = info.didYouMean;
    if (info.problems?.length) this.problems = info.problems;
  }
  get kind(): ErrorKind {
    return ENVIRONMENT_CODES.has(this.code) ? 'environment' : 'input';
  }
  get exitCode(): 1 | 2 {
    return this.kind === 'environment' ? 2 : 1;
  }
  toJSON(): MglErrorInfo & { problems?: MglErrorInfo[] } {
    const o: MglErrorInfo & { problems?: MglErrorInfo[] } = { code: this.code, message: this.message, fix: this.fix };
    if (this.line !== undefined) o.line = this.line;
    if (this.path !== undefined) o.path = this.path;
    if (this.didYouMean) o.didYouMean = this.didYouMean;
    if (this.problems) o.problems = this.problems;
    return o;
  }
}

export function fail(code: string, message: string, fix: string, extra: Partial<MglErrorInfo> = {}): never {
  throw new MglError({ code, message, fix, ...extra });
}

/** Levenshtein distance, for did-you-mean suggestions. */
export function distance(a: string, b: string): number {
  const m = a.length, n = b.length;
  const d = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = d[0]!;
    d[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = d[j]!;
      d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[n]!;
}

export function suggest(word: string, options: Iterable<string>, max = 3): string[] {
  const w = word.toLowerCase();
  return [...options]
    .map((o) => ({ o, d: o.toLowerCase().startsWith(w) || w.startsWith(o.toLowerCase()) ? 1 : distance(w, o.toLowerCase()) }))
    .filter((x) => x.d <= Math.max(2, Math.floor(word.length / 3)))
    .sort((a, b) => a.d - b.d)
    .slice(0, max)
    .map((x) => x.o);
}
