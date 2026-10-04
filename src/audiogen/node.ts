/**
 * The file services the generators need (writeFile, fileExists), bound to a project folder. Writes are allowed
 * only directly inside <project>/media/generated/ (no other path, no symlinked folder that leaves the project).
 * The SDK attaches these to a project's services: Object.assign(services, generatedFileServices(dir)).
 */
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep, isAbsolute } from 'node:path';
import { fail } from '../core/errors.js';
import { GENERATED_DIR } from './index.js';

const NAME = /^media\/generated\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

function target(projectDir: string, rel: string): string {
  if (!NAME.test(rel)) fail('E_PATH', `generated files go directly in ${GENERATED_DIR}/, not "${rel}".`, `use a name like ${GENERATED_DIR}/music-<hash>.wav.`);
  return resolve(projectDir, rel);
}

function assertInside(projectDir: string, dir: string) {
  const root = realpathSync(projectDir), real = realpathSync(dir);
  const r = relative(root, real);
  if (r === '..' || r.startsWith('..' + sep) || isAbsolute(r)) fail('E_PATH', `${GENERATED_DIR} leaves the project folder (a symlink?).`, `make ${GENERATED_DIR} a real folder inside the project.`);
}

export function generatedFileServices(projectDir: string) {
  return {
    async writeFile(rel: string, data: Uint8Array): Promise<void> {
      const abs = target(projectDir, rel);
      await mkdir(dirname(abs), { recursive: true });
      assertInside(projectDir, dirname(abs));
      const tmp = `${abs}.${process.pid}.tmp`;
      await writeFile(tmp, data);
      await rename(tmp, abs);
    },
    async fileExists(rel: string): Promise<boolean> {
      if (!NAME.test(rel)) return false;
      const abs = resolve(projectDir, rel);
      if (!existsSync(abs)) return false;
      try { return (await stat(abs)).isFile(); } catch { return false; }
    },
  };
}
