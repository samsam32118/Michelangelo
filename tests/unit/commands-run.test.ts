import { it, expect } from 'vitest';
import { defineCommand, invertPatch, applyPatch, runCommand, listCommands } from '../../src/core/commands/registry.js';
import '../../src/core/commands/index.js';
import { z } from 'zod';
import { testProject } from '../../src/plugin/testing.js';

// a command that builds with other commands through ctx.run (API 1.6)
if (!listCommands().some((c) => c.op === 'test.pair')) defineCommand({
  op: 'test.pair', group: 'test', doc: 'Two texts, one after the other.', example: {},
  schema: z.strictObject({ bad: z.boolean().optional() }),
  async apply(ctx, p) {
    const a = await ctx.run({ op: 'clip.add', id: 'one', track: 'V1', at: 0, len: 10, text: 'One' });
    await ctx.run({ op: 'clip.add', id: 'two', track: 'V1', at: 10, len: 10, text: 'Two', ...(p.bad ? { colour: 'red' } : {}) });
    ctx.out.first = a.id;
    ctx.summary('added a pair.');
  },
});

it('ctx.run applies nested commands inside the caller\'s single undo step', async () => {
  const base = testProject();
  base.clips = [];
  const r = await runCommand(base, { op: 'test.pair' });
  expect(r.out).toEqual({ first: 'one' });
  expect(r.summaries).toEqual(['added a pair.']); // nested summaries are dropped
  expect(r.project.clips!.map((c) => c.id)).toEqual(['one', 'two']);
  expect(applyPatch(r.project, invertPatch(r.patch))).toEqual(base);
});

it('a nested command is validated like a top-level one', async () => {
  const base = testProject();
  base.clips = [];
  await expect(runCommand(base, { op: 'test.pair', bad: true })).rejects.toMatchObject({ code: 'E_ARG', message: expect.stringMatching(/^clip\.add: "colour" is not a field/) });
});
