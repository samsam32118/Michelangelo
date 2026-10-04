/**
 * A small semver subset for plugin manifests: versions `1.2.3[-pre]`, ranges with `^`, `~`, `x`/`*`
 * wildcards, partial versions, comparators (`>= > <= < =`), hyphen ranges and `||`.
 */
export type Version = [number, number, number, string];

export function parseVersion(v: string): Version | undefined {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\s*$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? ''] : undefined;
}

export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  if (a[3] === b[3]) return 0;
  if (!a[3]) return 1; // a release is above its prereleases
  if (!b[3]) return -1;
  return a[3] < b[3] ? -1 : 1;
}

type Op = '>=' | '>' | '<=' | '<' | '=';
interface Comparator { op: Op; v: Version }

/** A partial version: missing or wildcard parts are undefined. */
function partial(s: string): (number | undefined)[] | undefined {
  const m = /^v?(\d+|[xX*])?(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(s);
  if (!m || s === '') return s === '' ? [undefined, undefined, undefined] : undefined;
  const parts = [m[1], m[2], m[3]].map((p) => (p === undefined || /^[xX*]$/.test(p) ? undefined : Number(p)));
  // anything after a wildcard is a wildcard too
  const cut = parts.findIndex((p) => p === undefined);
  return cut < 0 ? parts : parts.map((p, i) => (i >= cut ? undefined : p));
}

const ver = (a = 0, b = 0, c = 0, pre = ''): Version => [a, b, c, pre];

function prerelease(s: string): string {
  return /-([0-9A-Za-z.-]+)/.exec(s.replace(/\+.*$/, ''))?.[1] ?? '';
}

/** Comparators for one range term (`^1.2`, `>=1.0.0`, `1.x`, ...). */
function term(t: string): Comparator[] | undefined {
  const m = /^(\^|~>?|>=|<=|>|<|=)?\s*(.*)$/.exec(t.trim());
  if (!m) return undefined;
  const op = m[1] ?? '', body = m[2]!;
  const p = partial(body);
  if (!p) return undefined;
  const [a, b, c] = p;
  const pre = prerelease(body);
  const any: Comparator[] = [{ op: '>=', v: ver(0, 0, 0) }];
  if (a === undefined) return op === '<' || op === '>' ? [{ op: '<', v: ver(0, 0, 0) }] : any;
  const lo = ver(a, b, c, pre);
  const upper = (i: number): Version => (i === 0 ? ver(a + 1, 0, 0, '0') : i === 1 ? ver(a, b! + 1, 0, '0') : ver(a, b!, c! + 1, '0'));
  // index of the first missing part (3 = complete version)
  const missing = b === undefined ? 1 : c === undefined ? 2 : 3;
  switch (op) {
    case '^': {
      const i = a > 0 || missing === 1 ? 0 : b! > 0 || missing === 2 ? 1 : 2;
      return [{ op: '>=', v: lo }, { op: '<', v: upper(i) }];
    }
    case '~': case '~>':
      return [{ op: '>=', v: lo }, { op: '<', v: upper(missing === 1 ? 0 : 1) }];
    case '>=': return [{ op: '>=', v: lo }];
    case '<': return [{ op: '<', v: missing === 3 ? lo : ver(a, b, c, '0') }];
    case '>': return missing === 3 ? [{ op: '>', v: lo }] : [{ op: '>=', v: upper(missing - 1) }];
    case '<=': return missing === 3 ? [{ op: '<=', v: lo }] : [{ op: '<', v: upper(missing - 1) }];
    default:
      return missing === 3 ? [{ op: '=', v: lo }] : [{ op: '>=', v: lo }, { op: '<', v: upper(missing - 1) }];
  }
}

/** Parse a range into alternatives (OR) of comparator sets (AND); undefined when invalid. */
export function parseRange(range: string): Comparator[][] | undefined {
  const out: Comparator[][] = [];
  for (const alt of range.split('||')) {
    const s = alt.trim().replace(/(>=|<=|>|<|=|\^|~>?)\s+/g, '$1');
    const hy = /^(\S+)\s+-\s+(\S+)$/.exec(s);
    if (hy) {
      const a = term('>=' + hy[1]), b = term('<=' + hy[2]);
      if (!a || !b) return undefined;
      out.push([...a, ...b]);
      continue;
    }
    const set: Comparator[] = [];
    for (const t of s ? s.split(/\s+/) : ['*']) {
      const c = term(t);
      if (!c) return undefined;
      set.push(...c);
    }
    out.push(set);
  }
  return out;
}

export function validRange(range: string): boolean {
  return parseRange(range) !== undefined;
}

/** True when `version` satisfies `range`. A prerelease only matches comparators on the same x.y.z. */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version), r = parseRange(range);
  if (!v || !r) return false;
  return r.some((set) => {
    if (v[3] && !set.some((c) => c.v[3] && c.v[3] !== '0' && c.v[0] === v[0] && c.v[1] === v[1] && c.v[2] === v[2])) return false;
    return set.every(({ op, v: cv }) => {
      const d = compareVersions(v, cv);
      return op === '>=' ? d >= 0 : op === '>' ? d > 0 : op === '<=' ? d <= 0 : op === '<' ? d < 0 : d === 0;
    });
  });
}
