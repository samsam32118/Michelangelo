import { join } from 'node:path';
import { writeText, finish } from '../_lib/fixtures.mjs';

export const ROWS = [['Email', 12, '#dc2626'], ['Search', 30, '#f59e0b'], ['Social', 45, '#16a34a'], ['Video', 22, '#2563eb'], ['Direct', 60, '#9333ea']];

export async function setup(dir) {
  writeText(join(dir, 'stats.csv'), `label,value,colour\n${ROWS.map((r) => r.join(',')).join('\n')}\n`);
  return finish(dir, { rows: ROWS });
}
