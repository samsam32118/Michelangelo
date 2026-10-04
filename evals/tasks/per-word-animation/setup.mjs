import * as F from '../../lib/fixtures.mjs';

export async function setup(dir) {
  return F.finish(dir, { phrase: 'Make every second count' });
}
