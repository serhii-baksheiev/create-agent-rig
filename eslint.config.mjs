import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  {
    // Templates are self-contained projects with their own lint setup; they are
    // linted in place, never by the root toolchain.
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'templates/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: globals.node } },
  prettierConfig,
);
