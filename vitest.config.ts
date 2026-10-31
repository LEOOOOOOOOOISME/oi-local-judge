import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'tests/**/*.test.ts'],
    pool: 'forks',
    maxWorkers: 4,
    minWorkers: 1,
    testTimeout: 20000,
  },
});
