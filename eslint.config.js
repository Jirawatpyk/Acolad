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
    ],
    rules: { 'no-console': 'off' },
  },
  {
    // Standalone Node CLI tools (recon, etc.) — outside tsconfig; print to stdout
    // by design and use node globals (process/console). TS checks undefined names,
    // so no-undef is off here as it is for src/ under typescript-eslint.
    files: ['scripts/**/*.ts'],
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
