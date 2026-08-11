import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 15000,
    server: {
      deps: {
        external: ['node:sqlite'],
      },
    },
  },
});
