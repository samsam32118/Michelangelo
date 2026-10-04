/** Helpers to turn zod issues into precise messages: "missing" only when the key is absent, otherwise the expected type and the value found. */
import type { z } from 'zod';

type Path = PropertyKey[];

/** Whether `path` exists in `raw` (the parent is an object/array that has the key), and the value there. */
export function lookupPath(raw: unknown, path: Path): { present: boolean; value?: unknown } {
  let cur: unknown = raw;
  for (const k of path) {
    if (cur === null || typeof cur !== 'object') return { present: false };
    const o = cur as Record<PropertyKey, unknown>;
    if (!(k in o) || o[k] === undefined) return { present: false };
    cur = o[k];
  }
  return { present: true, value: cur };
}

const TYPE_WORDS: Record<string, string> = {
  int: 'an integer', number: 'a number', boolean: 'true or false', string: 'a string', array: 'a list', object: 'an object',
  tuple: 'a list', bigint: 'an integer', null: 'null', nan: 'a number',
};

/** "an integer", "a number or a string", ... for a type or union issue; undefined when not derivable. */
export function expectedText(issue: z.core.$ZodIssue): string | undefined {
  if (issue.code === 'invalid_type') return TYPE_WORDS[issue.expected] ?? issue.expected;
  if (issue.code === 'invalid_union') {
    const words: string[] = [];
    for (const branch of issue.errors) {
      const top = branch.find((b) => b.path.length === 0);
      if (!top) continue;
      const w = top.code === 'invalid_type' ? TYPE_WORDS[top.expected] ?? top.expected : top.code === 'invalid_value' ? top.values.map((v) => JSON.stringify(v)).join(' or ') : undefined;
      if (w && !words.includes(w)) words.push(w);
    }
    if (words.length === 2 && words.includes('an integer') && words.includes('a string')) return 'frames (an integer) or a time like "2s"';
    return words.length ? words.join(' or ') : undefined;
  }
  return undefined;
}

/** A short rendering of a found value: `"yes" (a string)`, `30.5`, `true`. */
export function foundText(v: unknown): string {
  let s: string;
  try { s = JSON.stringify(v) ?? String(v); } catch { s = String(v); }
  if (s.length > 40) s = s.slice(0, 37) + '...';
  if (typeof v === 'string') return `${s} (a string)`;
  if (Array.isArray(v)) return `${s} (a list)`;
  if (v && typeof v === 'object') return `${s} (an object)`;
  return s;
}
