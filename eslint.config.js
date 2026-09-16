// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/',
      'dist-recon/',
      'node_modules/',
      'coverage/',
      'logs/',
      'state/',
      '.remember/',
      '*.cjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-floating-promises': 'off',
      'no-console': ['error', { allow: ['error'] }],
    },
  },
  {
    // CLI entrypoints/reports print to stdout by design
    files: [
      'src/runtime/requeue.ts',
      'src/runtime/latencyReport.ts',
      'src/runtime/catchRateReport.ts',
      'src/runtime/once.ts',
      'src/runtime/main.ts',
      // Straker's entry points are deliberately absent: `main.ts` reports only through
      // `console.error`, which the rule already allows, and `winRateReport.ts`,
      // `combinedSummary.ts` and `requeue.ts` write to `process.stdout` directly. None
      // needs the exemption, and an allowlist entry that exempts nothing reads as
      // permission the next person will use.
    ],
    rules: { 'no-console': 'off' },
  },
  {
    // Standalone Node CLI tools (recon, diagnostics, etc.) — outside tsconfig; print
    // to stdout by design and use node globals (process/console). TS checks undefined
    // names, so no-undef is off here as it is for src/ under typescript-eslint. Covers
    // both .ts sources and .mjs runners (e.g. verify-fix.mjs imports the built dist/).
    files: ['scripts/**/*.ts', 'scripts/**/*.mjs'],
    rules: {
      'no-console': 'off',
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
