import { defineConfig } from 'vitest/config';

/**
 * The directories the constitution's coverage requirement governs (Principle II), and the
 * ONE list that both measures and gates them: `include` and `thresholds` are generated
 * from it below, so a directory added here cannot end up measured-but-ungated. Code
 * outside this list is exempt by default, which is why `src/straker/**` is on it (003
 * FR-013a, V18): a second bot's decision and state logic would otherwise ship with the
 * coverage requirement silently not applied to it.
 *
 * `src/shared/**` is on it for the same reason and more sharply: what lives there is real
 * policy (a delivery retry schedule, a corruption-quarantine sequence, a log retention) and
 * BOTH bots run on it, so a regression there is a regression in two places at once. It was
 * extracted out of gated areas — leaving it ungated would have quietly lowered the bar on
 * code that had already cleared it.
 */
const GATED_AREAS = ['detection', 'state', 'reporting', 'schedule', 'straker', 'shared'] as const;

/** Constitution II: >= 80% for core logic. Branches sit at 70 as they always have. */
const AREA_GATE = { lines: 80, functions: 80, statements: 80, branches: 70 };

/**
 * One threshold GROUP per area, and deliberately NO global one.
 *
 * A single global threshold could not fail because of Straker, and coupled the two bots
 * in the process. Measured on 2026-09-11: the global figure was 94.56% before
 * `src/straker/**` joined the include list and 89.45% after, while `src/straker/` on its
 * own sat at 79.93% - under the bar, with nothing going red. The XTM areas were
 * subsidising it. That runs the other way too: Straker coverage slipping would fail the
 * gate that governs the LIVE XTM bot, which is the coupling FR-024/FR-026 exist to
 * prevent. Per-area groups make each area answer for itself, at the same numbers.
 *
 * The global keys are omitted rather than kept alongside these, because Vitest counts
 * every file into the global set INCLUDING files already matched by a glob - leaving a
 * global number here would simply re-create the coupling. With all four absent, Vitest
 * skips the global set and checks only the groups below.
 */
function areaGlob(dir: string): string {
  // Both separator spellings, in one key, on purpose. Vitest matches threshold globs
  // against `path.relative(root, file)` - backslashes on Windows, forward slashes in CI -
  // and calls picomatch with no options, so picomatch 4 never applies its Windows
  // normalisation (its `options.windows` default is only filled in when an options object
  // is passed at all). A key matching nothing is NOT an error: an empty group summarises
  // as 100% and passes silently, which is the exact "green gate over ungoverned code"
  // this file is here to prevent. Verified to match on both platforms and at any depth.
  return `{src/${dir}/**,src\\\\${dir}\\\\**}`;
}

const areaThresholds: Record<string, typeof AREA_GATE> = {};
for (const dir of GATED_AREAS) {
  areaThresholds[areaGlob(dir)] = AREA_GATE;
}

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
      include: GATED_AREAS.map((dir) => `src/${dir}/**`),
      // Type-only after 003: the runtime members that used to live in
      // `src/straker/types.ts` — real decision predicates this exclusion was hiding from
      // the gate — moved to `src/straker/outcomePolicy.ts` and are covered there. The
      // exclusion is honest again; do not undo either half.
      exclude: ['**/types.ts'],
      // No entry-point exclusion is claimed here. T067 pre-authorised excluding genuine
      // process entries (`reconMain.ts`, `main()`) over lowering a threshold, and that
      // authority is deliberately unused: measured on 2026-09-11 `src/straker/` clears
      // every number above WITH those files counted, so excluding them would be tuning a
      // passing figure upward rather than fixing anything. If `reconMain.ts`'s 0% ever
      // becomes the difference, the answer is T072 deleting it, not an exclude line.
      thresholds: areaThresholds,
      reporter: ['text', 'html'],
    },
  },
});
