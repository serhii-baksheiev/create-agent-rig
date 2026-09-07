import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import { SCAN_IGNORE_GLOBS } from './test/helpers/scan-exclusions.mjs';

export default tseslint.config(
  {
    // Templates are self-contained projects with their own lint setup; they are
    // linted in place, never by the root toolchain. `dist` and `coverage` are
    // build output this lint never reads.
    //
    // What every repository scan skips — node_modules, .git, and the sibling
    // checkouts under `.claude/worktrees/` — comes from the one shared list
    // (RP-155): linted from here, a nested checkout's own eslint.config.mjs and
    // tsconfig.json made typescript-eslint see two project roots and refuse every
    // TypeScript file, measured at the Stop gate as 397–399 parsing errors.
    // Pinned by test/template/lint-ignores-worktrees.test.ts ›
    // "ignores every path under .claude/worktrees/, so a sibling checkout is not
    // linted as this one" and › "still lints this checkout's own files — the
    // ignore is the worktree directory, not .claude/", and by
    // test/template/scan-exclusions.test.ts › "eslint.config.mjs takes its
    // ignores from the helper, not from literals".
    ignores: ['**/dist/**', '**/coverage/**', 'templates/**', ...SCAN_IGNORE_GLOBS],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: globals.node } },
  prettierConfig,
);
