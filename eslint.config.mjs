import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

// Structural shell-injection guard: only process-runner.ts may spawn a process.
// Every other file is banned from importing child_process/execa at the ESLint
// level, not just by convention - see docs/architecture.md.
const noSpawnImports = [
  'error',
  {
    paths: [
      { name: 'child_process', message: 'Only src/process/process-runner.ts may spawn processes.' },
      { name: 'node:child_process', message: 'Only src/process/process-runner.ts may spawn processes.' },
      { name: 'execa', message: 'Only src/process/process-runner.ts may import execa.' },
    ],
  },
];

export default [
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', '.dispatcher/**'] },
  js.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { project: './tsconfig.json', sourceType: 'module' },
      globals: { ...globals.node },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,
      // TypeScript's own compiler (via `pnpm typecheck`) catches genuine undefined
      // references more accurately than this JS-level rule, which false-positives on
      // ambient type namespaces like `NodeJS.ProcessEnv` used in type position.
      'no-undef': 'off',
      'no-console': 'error',
      'no-restricted-imports': noSpawnImports,
    },
  },
  {
    files: ['tsup.config.ts', 'vitest.config.ts', 'eslint.config.mjs', 'prettier.config.mjs'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { sourceType: 'module' },
      globals: { ...globals.node },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,
      'no-undef': 'off',
    },
  },
  {
    files: ['src/process/process-runner.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: ['src/cli/**/*.ts'],
    rules: {
      // CLI entry points are the one place allowed to print to the terminal directly.
      'no-console': 'off',
    },
  },
  {
    files: ['tests/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { project: './tsconfig.json', sourceType: 'module' },
      globals: { ...globals.node },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,
      'no-undef': 'off',
      'no-restricted-imports': 'off',
      'no-console': 'off',
    },
  },
  prettierConfig,
];
