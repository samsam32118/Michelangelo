/**
 * Generate the published JSON Schema of the project file (schema/v1.json) from the zod input schemas.
 * `--check` exits 1 when the committed file is out of date.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { inputSchemas, FORMAT_VERSION } from '../src/core/schema/index.js';
import { DEFAULTS } from '../src/core/format.js';

export const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema', `v${FORMAT_VERSION}.json`);

export function schemaText(): string {
  const s = z.toJSONSchema(inputSchemas.File, { unrepresentable: 'any' }) as Record<string, any>;
  // the defaults the writer omits (filled in on read)
  for (const [table, defaults] of Object.entries(DEFAULTS)) {
    const props = s.properties?.[table]?.items?.properties as Record<string, Record<string, unknown>> | undefined;
    for (const [k, v] of Object.entries(defaults ?? {})) if (props?.[k]) props[k] = { ...props[k], default: v };
  }
  const out = {
    $schema: s.$schema,
    $id: `https://michelangelo.dev/schema/v${FORMAT_VERSION}.json`,
    title: 'Michelangelo project file',
    description: 'One entity per line; times are frames (integers) or edge forms ("2.5s", "1:02.5", "00:01:02:15"). Generated from src/core/schema by scripts/gen-schema.ts.',
    ...Object.fromEntries(Object.entries(s).filter(([k]) => k !== '$schema')),
  };
  return JSON.stringify(out, null, 2) + '\n';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = schemaText();
  if (process.argv.includes('--check')) {
    const cur = existsSync(SCHEMA_PATH) ? readFileSync(SCHEMA_PATH, 'utf8') : '';
    if (cur !== text) {
      console.error(`${SCHEMA_PATH} is out of date. fix: npm run schema`);
      process.exit(1);
    }
    console.log('schema/v1.json is up to date');
  } else {
    mkdirSync(dirname(SCHEMA_PATH), { recursive: true });
    writeFileSync(SCHEMA_PATH, text);
    console.log(`wrote ${SCHEMA_PATH}`);
  }
}
