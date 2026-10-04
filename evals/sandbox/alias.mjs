// Anonymous aliases of held-out task ids (DESIGN §16.1). Public logs, directories, result.json and summaries of a
// held-out set name a task only by its alias. The alias is an HMAC of the id keyed by a secret kept in the private
// results dir (never in the repository), so a guessed id cannot be confirmed by hashing it.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const ALIAS_KEY_FILE = 'alias-key';
export const ALIAS_RE = /^h-[0-9a-f]{6,}$/;

/** Is `s` a held-out alias (h-<hex>)? */
export const isAlias = (s) => typeof s === 'string' && ALIAS_RE.test(s);

/** Is `set` a held-out set name (heldout, heldout2, ...)? */
export const isHiddenSet = (set) => /^heldout\d*$/.test(String(set ?? ''));

/**
 * The alias of a held-out task id: h-<6 hex> of HMAC-SHA256(key, id). Without a key it is the legacy unsalted
 * sha256 prefix (only for reading old results; the runner always passes a key).
 */
export function aliasOf(task, key) {
  const h = key ? createHmac('sha256', key) : createHash('sha256');
  return 'h-' + h.update(String(task)).digest('hex').slice(0, 6);
}

/** The alias key in privateDir (created, mode 0600, when missing). */
export function loadAliasKey(privateDir) {
  const f = join(privateDir, ALIAS_KEY_FILE);
  if (!existsSync(f)) {
    mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    try { writeFileSync(f, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' }); } catch (e) { if (e?.code !== 'EEXIST') throw e; }
  }
  const k = readFileSync(f, 'utf8').trim();
  if (k.length < 32) throw new Error(`${f} holds no usable alias key. fix: delete it to have a new one made (aliases then change).`);
  return k;
}
