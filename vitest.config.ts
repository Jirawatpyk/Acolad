import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Headroom for the real-Chromium integration tests, whose per-test time grows
    // under v8 coverage instrumentation (npm run test:coverage) — 30s was too tight
    // once the XTM integration suite was added.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/detection/**', 'src/state/**', 'src/reporting/**'],
      exclude: ['**/types.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 70,
      },
      reporter: ['text', 'html'],
    },
  },
});
