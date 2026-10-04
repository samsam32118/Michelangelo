/** Shared helpers for the text / captions / templates tests. */
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Project, emptyProject } from '../../src/sdk/project.js';
import { builtinRegistry } from '../../src/builtin/index.js';
import type { CommandServices } from '../../src/core/commands/index.js';
import type { ProjectFile } from '../../src/core/schema/index.js';

export function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'mgl-text-'));
}

/** An in-memory project with the built-in catalog and file reading relative to a temp dir. */
export function makeProject(opts: { size?: [number, number]; fps?: number | string; length?: number; files?: Record<string, string>; services?: CommandServices; edit?: (p: ProjectFile) => void } = {}) {
  const dir = tempDir();
  for (const [name, text] of Object.entries(opts.files ?? {})) writeFileSync(path.join(dir, name), text);
  const data = emptyProject({ size: opts.size ?? [1080, 1920], fps: opts.fps ?? 30, length: opts.length ?? 900 });
  opts.edit?.(data);
  const services: CommandServices = {
    catalog: builtinRegistry().catalog(),
    readText: async (p) => readFileSync(path.join(dir, p), 'utf8'),
    ...opts.services,
  };
  const project = Project.create(path.join(dir, 'p.mgl.json'), data, services);
  const edit = (cmd: { op: string; [k: string]: unknown } | { op: string; [k: string]: unknown }[]) => project.edit(cmd, { save: false });
  return { project, edit, dir };
}
