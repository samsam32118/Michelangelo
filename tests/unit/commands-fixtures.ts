/** Shared helpers for the commands-* tests: an in-memory project with fake services. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { Project, emptyProject } from '../../src/sdk/project.js';
import type { Catalog, CommandServices } from '../../src/core/commands/index.js';
import type { ProjectFile } from '../../src/core/schema/index.js';

/** A small fake catalog: two effects and two transitions with zod params. */
export const fakeCatalog: Catalog = {
  effects: new Map([
    ['blur', { params: z.object({ radius: z.number().min(0).max(500).default(10), edges: z.enum(['extend', 'transparent']).default('extend') }) }],
    ['glow', { params: z.object({ amount: z.number().min(0).max(1).default(0.5), color: z.string().default('#ffffff') }) }],
  ]),
  transitions: new Map([
    ['crossfade', { params: z.object({}) }],
    ['wipe', { params: z.object({ direction: z.enum(['left', 'right', 'up', 'down']).default('left'), softness: z.number().min(0).default(0) }) }],
  ]),
  generators: new Map(),
  templates: new Map(),
};

export function makeProject(opts: { size?: [number, number]; services?: CommandServices; edit?: (p: ProjectFile) => void } = {}) {
  const data = emptyProject({ size: opts.size ?? [1080, 1920], fps: 30, length: 900 });
  opts.edit?.(data);
  const project = Project.create(path.join(mkdtempSync(path.join(tmpdir(), 'mgl-cmd-')), 'p.mgl.json'), data, { catalog: fakeCatalog, ...opts.services });
  const edit = (cmd: { op: string; [k: string]: unknown } | { op: string; [k: string]: unknown }[], dryRun = false) => project.edit(cmd, { save: false, dryRun });
  const clip = (id: string) => project.data.clips!.find((c) => c.id === id)!;
  return { project, edit, clip };
}
