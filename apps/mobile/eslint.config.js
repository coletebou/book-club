import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * The iOS app's own lint config (D130): React Native globals, not the browser's, and no type-
 * aware rules against the root project (the root gate does not run this; `pnpm --filter
 * @bookclub/mobile lint`, from the Mac EC2 once dependencies are installed there, does).
 */
export default tseslint.config(
  { ignores: ['**/node_modules/**', 'ios/**', 'android/**', '.expo/**', 'dist/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
);
