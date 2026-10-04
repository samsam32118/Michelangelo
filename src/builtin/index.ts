/** All built-in plugins. They import only from src/plugin/api.ts (enforced by tests/unit/builtin-imports.test.ts). */
import type { PluginDef } from '../plugin/api.js';
import effects from './effects/index.js';
import text from './text/index.js';
import checks from './checks/index.js';
import motion from './motion/index.js';
import { PluginRegistry } from '../plugin/registry.js';

export const builtinPlugins: PluginDef[] = [effects, text, checks, motion];

export function builtinRegistry(): PluginRegistry {
  const r = new PluginRegistry();
  for (const p of builtinPlugins) r.add(p, 'builtin');
  return r;
}
