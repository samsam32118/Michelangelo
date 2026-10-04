/**
 * lower-third-pro: a template (name + role on a plate with an accent bar that grows in) and a command,
 * `lower-third-pro.add`, that places it on new tracks above everything in one step.
 */
import { definePlugin, defineTemplate, z, type CommandDef, type TemplateDef, type TemplateOutput } from 'michelangelo/plugin';

type Clip = NonNullable<TemplateOutput['clips']>[number];
const color = z.string().regex(/^(#[0-9a-fA-F]{3,8}|[a-z]+|rgba?\([^)]*\))$/, 'a colour like "#ffcc00"');

const params = z.object({
  name: z.string().min(1).default('Ada Lovelace'),
  role: z.string().default(''),
  accent: color.default('#ffb800'),
  plate: color.default('#111318'),
  side: z.enum(['left', 'right']).default('left'),
});

const template: TemplateDef = defineTemplate({
  id: 'lower-third-pro',
  describe: 'Name and role on a dark plate with an accent bar that grows in, bottom left or right; fades out at the end (5 s).',
  params,
  build({ params: raw, comp, rate, at, len: given }) {
    const p = params.parse(raw);
    const [W, H] = comp.size;
    const f = (s: number) => Math.max(1, Math.round((s * rate.num) / rate.den));
    const len = given ?? f(5);
    const u = Math.min(W, H) / 1080, r = Math.round;
    // inside the vertical safe zone (above the platform caption area) or 8% from the bottom
    const bottom = H / W > 1.5 ? H * 0.74 : H * 0.88;
    const nameSize = r(64 * u), roleSize = r(40 * u);
    const plateW = r(Math.min(W * 0.8, Math.max(p.name.length * nameSize * 0.6, p.role.length * roleSize * 0.6) + 120 * u));
    const plateH = r((p.role ? nameSize + roleSize * 1.4 : nameSize) + 70 * u);
    const margin = r(W * 0.06);
    const cx = p.side === 'left' ? margin + plateW / 2 : W - margin - plateW / 2;
    const cy = r(bottom - plateH / 2);
    const left = cx - plateW / 2 + 40 * u;
    const grow = Math.min(f(0.5), Math.floor(len / 4)), fade = Math.min(f(0.3), Math.floor(len / 4));
    const textStyle = (size: number, c: string, weight: 'bold' | 'normal') => ({ size, color: c, weight, align: 'left' as const, box: [plateW - r(80 * u), r(size * 1.3)] as [number, number], maxLines: 1 });
    const clips: Clip[] = [
      { id: 'plate', track: 'plate', at, len, shape: { type: 'rect', size: [plateW, plateH], radius: r(12 * u), fill: p.plate }, x: r(cx), y: cy, opacity: 0.92, fade: [fade, fade] },
      { id: 'bar', track: 'bar', at, len, shape: { type: 'rect', size: [r(10 * u), plateH], fill: p.accent }, x: r(p.side === 'left' ? cx - plateW / 2 + 5 * u : cx + plateW / 2 - 5 * u), y: cy, scale: [[0, [1, 0], 'outCubic'], [grow, [1, 1]]], fade: [0, fade] },
      { id: 'name', track: 'name', at, len, text: p.name, style: textStyle(nameSize, '#ffffff', 'bold'), x: r(left + (plateW - 80 * u) / 2), y: r(cy - (p.role ? roleSize * 0.7 : 0)), fade: [fade, fade] },
    ];
    if (p.role) clips.push({ id: 'role', track: 'role', at, len, text: p.role, style: textStyle(roleSize, p.accent, 'normal'), x: r(left + (plateW - 80 * u) / 2), y: r(cy + nameSize * 0.6), fade: [fade, fade] });
    return { clips, summary: `lower third "${p.name}"${p.role ? ` / "${p.role}"` : ''}` };
  },
});

const Time = z.union([z.number().int(), z.string()]);
/** A command definition; the plugin loader registers it when a project names this plugin. */
const command = <S extends z.ZodObject>(def: CommandDef<S>) => def;

const add = command({
  op: 'lower-third-pro.add', group: 'templates',
  doc: 'Add a lower-third-pro (name, role, accent colour, side) at a time; each layer goes on a new track on top of the comp.',
  schema: z.strictObject({ name: z.string().min(1), role: z.string().optional(), at: Time.optional(), len: Time.optional(), accent: color.optional(), side: z.enum(['left', 'right']).optional(), comp: z.string().optional() }),
  primary: 'name', example: { name: 'Ada Lovelace', role: 'Engineer', at: '2s' },
  apply(ctx, a) {
    const def = ctx.services.catalog?.templates.get('lower-third-pro') ?? template;
    const p = ctx.project;
    const comp = ctx.comp(a.comp ?? p.project?.main ?? (p.comps.find((c) => c.id === 'main') ?? p.comps[0]!).id);
    const at = a.at === undefined ? 0 : ctx.time(a.at, comp, 'at');
    const len = a.len === undefined ? undefined : ctx.time(a.len, comp, 'len');
    const prefix = ctx.newId('lt');
    const { at: _a, len: _l, comp: _c, ...rest } = a;
    const out = def.build({ params: rest, comp, rate: ctx.rate(comp), at, ...(len !== undefined ? { len } : {}), prefix, project: p });
    const tracks = (p.tracks ??= []);
    // new tracks go right after the comp's last visual track (on top)
    let insert = tracks.reduce((m, t, i) => (t.comp === comp.id && !t.audio ? i + 1 : m), tracks.length);
    const ids: string[] = [];
    for (const c of out.clips ?? []) {
      const track = { id: ctx.newId(`${prefix}-${c.track}`), comp: comp.id };
      tracks.splice(insert++, 0, track);
      const clip = { ...c, id: ctx.newId(`${prefix}-${c.id}`), track: track.id, tags: [...(c.tags ?? []), 'template:lower-third-pro'] };
      (p.clips ??= []).push(clip);
      ids.push(clip.id);
    }
    ctx.out.ids = ids;
    ctx.summary(`added ${out.summary ?? 'a lower third'} at frame ${at} (${ids.length} clips on new tracks).`);
  },
});

export default definePlugin({ name: 'lower-third-pro', version: '1.0.0', templates: [template], commands: [add] });
