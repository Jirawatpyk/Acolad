// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', 'coverage/', 'logs/', 'state/', '.remember/', '*.cjs'],
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
      'src/runtime/once.ts',
      'src/runtime/main.ts',
    ],
    rules: { 'no-console': 'off' },
  },
);
