// Runs on `pnpm install` locally AND when npm installs this package from git
// (`npx github:<user>/create-agent-rig`). It must therefore work with only
// the root devDependencies present and no pnpm available.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';

// 1. Wire up the pre-commit hook when working inside the git checkout.
//
// The environment is stripped of the variables that locate a repository, or an
// inherited GIT_DIR writes this setting into somebody ELSE's config — and this
// script runs from `pnpm install`, which a pre-commit hook can reach.
//
// ⚠ The canonical list lives in `packages/cli/src/lib/git-env.ts`, and this is a
// deliberate second copy: prepare runs *before* the TypeScript build that would
// make it importable. Kept to the two variables that matter for `git config`
// rather than the full list, so the duplication cannot drift into a
// disagreement about what the full list is.
if (existsSync(path.join(root, '.git'))) {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_COMMON_DIR;
  spawnSync('git', ['config', 'core.hooksPath', '.husky'], { cwd: root, env, stdio: 'inherit' });
}

// 2. Build the CLI so the `bin` entry exists (required for git/tarball installs).
const require = createRequire(import.meta.url);
const tscPath = path.join(
  path.dirname(require.resolve('typescript/package.json')),
  'lib',
  'tsc.js',
);
const result = spawnSync(
  process.execPath,
  [tscPath, '-p', path.join(root, 'packages/cli/tsconfig.build.json')],
  { cwd: root, stdio: 'inherit' },
);
process.exit(result.status ?? 1);
