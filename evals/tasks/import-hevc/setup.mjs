import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as F from '../../lib/fixtures.mjs';
import { ffmpeg } from '../../lib/util.mjs';

export async function setup(dir) {
  const tmp = mkdtempSync(join(tmpdir(), 'mgl-hevc-'));
  try {
    const raw = join(tmp, 'raw.mov');
    await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=10', '-vf', 'drawbox=x=0:y=0:w=300:h=300:color=red:t=fill',
      '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p', raw]);
    // iPhone-style: stored landscape, displayed portrait through the display matrix
    await ffmpeg(['-display_rotation', '90', '-i', raw, '-c', 'copy', join(dir, 'phone.mov')]);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  // golden: the displayed (autorotated) source frame at 2 s, by plain ffmpeg
  await F.framePng(join(dir, 'phone.mov'), 2, F.golden(dir, 'src_2s.png'));
  return F.finish(dir, {});
}
