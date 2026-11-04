import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '.cache/**',
      '.spikes/**',
      '.data/**',
      '.claude/**',
      'e2e/reports/**',
      'e2e/.tmp/**',
      'apps/web/public/**',
      'apps/web/dev-dist/**',
      // The iOS app (D130): React Native globals and its own tsconfig, not this project's; it
      // keeps its own eslint.config.js, run from apps/mobile once its dependencies are installed.
      'apps/mobile/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      '@typescript-eslint/only-throw-error': 'error',
      // Fastify handlers are async by convention even when they do not await; no-floating-promises
      // still catches the dangerous case (a forgotten await).
      '@typescript-eslint/require-await': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    files: ['**/*.test.{ts,tsx}', 'e2e/**/*.ts', 'scripts/**/*.{ts,mjs,js}'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },
  {
    // Command-line tools talk to the terminal.
    files: ['apps/server/src/cli/index.ts', '**/build.mjs', '**/scripts/*.mjs', '**/scripts/*.ts', 'e2e/lighthouse/*.mjs', 'e2e/report/*.mjs', 'tools/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
  },
);
