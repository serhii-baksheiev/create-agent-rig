import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  {
    // Templates are self-contained projects with their own lint setup; they are
    // linted in place, never by the root toolchain.
    //
    // `.claude/worktrees/` holds sibling checkouts (the `worktree-task` skill puts
    // a session's worktree there), each with its own eslint.config.mjs and
    // tsconfig.json. Linted from here, typescript-eslint saw two project roots and
    // refused every TypeScript file — measured at the Stop gate as 397–399 parsing
    // errors (RP-155). This literal is one of the exclusions RP-155's shared
    // scan-exclusion helper will own; until that helper exists it is a second copy,
    // stated as such. Pinned by test/template/lint-ignores-worktrees.test.ts ›
    // "ignores every path under .claude/worktrees/, so a sibling checkout is not
    // linted as this one" and › "still lints this checkout's own files — the
    // ignore is the worktree directory, not .claude/".
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'templates/**',
      '.claude/worktrees/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: globals.node } },
  prettierConfig,
);
