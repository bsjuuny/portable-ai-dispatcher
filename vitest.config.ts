import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    // No hard-failing coverage threshold here on purpose: a gate that fails the build
    // creates an incentive to weaken assertions or skip tests to hit a number. Instead
    // the real per-module percentages are read from coverage-summary.json and reported
    // verbatim, gaps named explicitly, after every run.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/cli/index.ts'],
    },
  },
});
