/**
 * Worker process entry for the render pipeline: `node pipeline-worker.js <job.json>`.
 * - segment: render frames [a, b) of a project (canonical JSON) to a video-only segment; prints "frames N" lines.
 * - detached: run a whole render and keep .mgl/<project>/render.json current.
 * On failure the last stderr line is the MglError as JSON.
 */
import { readFileSync } from 'node:fs';
import { MglError } from '../core/errors.js';
import type { ProjectFile } from '../core/schema/index.js';
import { renderSegment, runDetached, type WorkerJob } from './pipeline.js';

async function main() {
  const file = process.argv[2];
  if (!file) throw new MglError({ code: 'E_USAGE', message: 'pipeline-worker needs a job file.', fix: 'run it through render() or renderDetached(), not by hand.' });
  const job = JSON.parse(readFileSync(file, 'utf8')) as WorkerJob;
  if (job.mode === 'segment') {
    const project = JSON.parse(readFileSync(job.project, 'utf8')) as ProjectFile;
    let last = 0;
    await renderSegment(project, job, (n) => {
      const now = Date.now();
      if (now - last > 200) { last = now; process.stdout.write(`frames ${n}\n`); }
    });
    process.stdout.write(`frames ${job.range![1] - job.range![0]}\n`);
  } else await runDetached(job);
}

main().then(() => process.exit(0), (e: unknown) => {
  const j = e instanceof MglError ? e.toJSON() : { code: 'E_RENDER', message: String((e as Error)?.message ?? e), fix: 'render with segments: 1 to see the full error.' };
  process.stderr.write(`${(e as Error)?.stack ?? ''}\n${JSON.stringify(j)}\n`);
  process.exit(1);
});
