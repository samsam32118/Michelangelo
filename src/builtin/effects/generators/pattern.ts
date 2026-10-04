import { defineGenerator, z, type Surface } from '../../../plugin/api.js';
import { colorList } from '../util.js';

type Kind = 'checker' | 'stripes' | 'dots' | 'grid';

/** Fill dst with a repeating tile of `kind`, rotated by `angle` degrees and scrolled by `offset` px. */
function fillPattern(dst: Surface, kind: Kind, size: number, colors: string[], angle: number, offset: number, line: number): void {
  const n = Math.max(1, Math.round(size)), T = kind === 'checker' ? 2 * n : n;
  const tile = dst.scratch(T, T), t = tile.ctx;
  t.fillStyle = colors[0]!;
  t.fillRect(0, 0, T, T);
  t.fillStyle = colors[1]!;
  if (kind === 'checker') { t.fillRect(n, 0, n, n); t.fillRect(0, n, n, n); }
  else if (kind === 'stripes') t.fillRect(0, 0, n / 2, n);
  else if (kind === 'dots') { t.beginPath(); t.arc(n / 2, n / 2, n * 0.3, 0, 2 * Math.PI); t.fill(); }
  else { t.fillRect(0, 0, n, Math.min(n, line)); t.fillRect(0, 0, Math.min(n, line), n); }
  const pat = dst.ctx.createPattern(tile.canvas, 'repeat');
  if (!pat) return;
  const c = dst.ctx, D = Math.hypot(dst.width, dst.height);
  c.save();
  c.translate(dst.width / 2, dst.height / 2);
  c.rotate((angle * Math.PI) / 180);
  c.translate(offset % T, 0);
  c.fillStyle = pat;
  c.fillRect(-D - T, -D - T, 2 * D + 2 * T, 2 * D + 2 * T);
  c.restore();
}

const common = {
  size: z.number().min(2).max(2000).default(64).describe('cell size in px'),
  angle: z.number().min(-360).max(360).default(0),
  speed: z.number().min(-5000).max(5000).default(0).describe('scroll speed in px per second'),
};

export const checker = defineGenerator({
  type: 'checker',
  describe: 'Checkerboard background (optionally rotated and scrolling).',
  params: z.object({ ...common, colors: colorList(['#1f1f1f', '#2e2e2e']) }),
  draw({ dst, params: p, time }) { fillPattern(dst, 'checker', p.size, p.colors, p.angle, p.speed * time, 0); },
});

export const pattern = defineGenerator({
  type: 'pattern',
  describe: 'Repeating background pattern: checker, stripes, dots or grid, optionally rotated and scrolling.',
  params: z.object({
    kind: z.enum(['checker', 'stripes', 'dots', 'grid']).default('stripes'),
    ...common,
    colors: colorList(['#111111', '#222222']).describe('background colour, then pattern colour'),
    lineWidth: z.number().min(0.5).max(200).default(2).describe('grid line width in px'),
  }),
  draw({ dst, params: p, time }) { fillPattern(dst, p.kind, p.size, p.colors, p.angle, p.speed * time, p.lineWidth); },
});
