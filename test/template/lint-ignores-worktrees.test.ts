import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// RP-155. The `worktree-task` skill puts a session's worktree under
// `.claude/worktrees/<name>/` — a full checkout carrying its own
// eslint.config.mjs and tsconfig.json. With one on disk, `pnpm lint` in the
// MAIN checkout failed on every TypeScript file with typescript-eslint's
// "No tsconfigRootDir was set, and multiple candidate TSConfigRootDirs are
// present: <main> and <main>/.claude/worktrees/<name>" — 397–399 errors —
// and it surfaced at the Stop gate, which measures `pnpm lint`, so a session
// with a live worktree could not end cleanly. The root config ignored dist,
// node_modules, coverage and templates, and nothing under .claude/worktrees/.
// `isPathIgnored` asks the config, not the disk: no probe file needs to exist.
const eslint = new ESLint({ cwd: repoRoot });

describe('the root lint never walks into a linked worktree', () => {
  it('ignores every path under .claude/worktrees/, so a sibling checkout is not linted as this one', async () => {
    const worktree = path.join(repoRoot, '.claude', 'worktrees', 'probe');
    expect(await eslint.isPathIgnored(path.join(worktree, 'vitest.config.ts'))).toBe(true);
    expect(
      await eslint.isPathIgnored(path.join(worktree, 'packages', 'cli', 'src', 'index.ts')),
    ).toBe(true);
  });

  it("still lints this checkout's own files — the ignore is the worktree directory, not .claude/", async () => {
    expect(await eslint.isPathIgnored(path.join(repoRoot, 'vitest.config.ts'))).toBe(false);
    expect(
      await eslint.isPathIgnored(path.join(repoRoot, '.claude', 'scripts', 'queue', 'index.mjs')),
    ).toBe(false);
  });
});
