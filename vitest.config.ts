import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['tests/**/*.test.ts', 'src/**/*.test.ts', 'examples/plugins/*/test/*.test.ts'], testTimeout: 60_000, pool: 'forks' } });
