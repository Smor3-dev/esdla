import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    setupFiles: ['tests/setup-env.ts'],
    fileParallelism: false, // los tests de integración comparten una base Postgres real (PGlite)
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
