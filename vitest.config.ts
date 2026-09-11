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
      // The gate names its directories explicitly, so code outside this list is exempt by
      // default. `src/straker/**` is listed for exactly that reason (003 FR-013a, V18): a
      // second bot's decision and state logic would otherwise ship with the constitution's
      // coverage requirement silently not applied to it, and a gate reporting green while
      // not covering the code it governs is worse than no gate at all.
      // Until the rest of feature 003 lands these modules sit below the thresholds, and
      // that is the gate working. The way out is finishing the code and its tests (T067),
      // never lowering a threshold or excluding the directory back out.
      include: [
        'src/detection/**',
        'src/state/**',
        'src/reporting/**',
        'src/schedule/**',
        'src/straker/**',
      ],
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
