import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const src = (p: string) => fileURLToPath(new URL(`./src/${p}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^michelangelo\/plugin$/, replacement: src('plugin/api.ts') },
      { find: /^michelangelo\/testing$/, replacement: src('plugin/testing.ts') },
      { find: /^michelangelo$/, replacement: src('sdk/index.ts') },
    ],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts', 'examples/plugins/*/test/*.test.ts'],
    testTimeout: 120_000,
    pool: 'forks',
  },
});
