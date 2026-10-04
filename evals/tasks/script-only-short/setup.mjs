import { join } from 'node:path';
import * as F from '../../lib/fixtures.mjs';

export const SENTENCES = [
  'Your phone is stealing three hours of your day.',
  'Here is how to take them back.',
  'Turn off every notification that is not from a person.',
  'Move social apps off your home screen.',
  'Charge your phone outside the bedroom.',
  'Try it for one week and count the hours you win back.',
];

export async function setup(dir) {
  F.writeText(join(dir, 'script.txt'), SENTENCES.join(' ') + '\n');
  return F.finish(dir, { sentences: SENTENCES });
}
