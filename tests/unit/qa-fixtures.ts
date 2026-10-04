import type { ProjectFile } from '../../src/core/schema/index.js';
import type { Finding } from '../../src/plugin/api.js';
import { builtinChecks } from '../../src/builtin/checks/index.js';
import { makeContext, type Layers } from '../../src/qa/check.js';

/** A 1080x1920 30 fps shorts project with a background video track and a text track. */
export function shortsProject(extra: Partial<ProjectFile> = {}): ProjectFile {
  return {
    michelangelo: 1,
    project: { platform: 'shorts' },
    assets: [{ id: 'bgv', src: 'lavfi:testsrc2' }],
    comps: [{ id: 'main', size: [1080, 1920], fps: 30, length: 300 }],
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'T1', comp: 'main' }],
    clips: [{ id: 'bg', track: 'V1', at: 0, len: 300, asset: 'bgv' }],
    ...extra,
  } as ProjectFile;
}

export function runCheck(id: string, project: ProjectFile, extra: Parameters<typeof makeContext>[3] = {}): Finding[] {
  const def = builtinChecks.find((c) => c.id === id)!;
  return def.run(makeContext(project, 'main', undefined, extra)) as Finding[];
}

export const layersAt = (frame: number, ls: { clipId: string; kind: string; box: [number, number, number, number]; text?: string; fontPx?: number }[]): Layers => new Map([[frame, ls]]);
