// Runs on `pnpm install` locally AND when npm installs this package from git
// (`npx github:<user>/create-agent-rig`). It must therefore work with only
// the root devDependencies present and no pnpm available.
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';

/**
 * The environment `git config` runs under, minus anything that could point it
 * at another repository's config file.
 *
 * This script runs from `pnpm install`, and a pre-commit hook can reach an
 * install — a hook-started process inherits an absolute `GIT_DIR`, and
 * `core.hooksPath` would then be written into somebody ELSE's repository.
 *
 * ⚠ The canonical list lives in `packages/cli/src/lib/git-env.ts` and this is a
 * deliberate second copy, because `prepare` step 1 runs *before* step 2 builds
 * the TypeScript that would make it importable. The subset is not a smaller
 * opinion about that list: `git config --local` resolves its target file only
 * through `GIT_DIR`/`GIT_COMMON_DIR`, and `GIT_CONFIG` names a config file
 * outright. `GIT_WORK_TREE` and `GIT_INDEX_FILE` cannot move it, so stripping
 * them here would be noise.
 *
 * Exported so the behaviour is testable — importing this module must not build
 * anything, hence the entry-point guard at the bottom.
 */
export const gitConfigEnv = (env = process.env) => {
  const sanitised = { ...env };
  for (const key of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_CONFIG']) delete sanitised[key];
  return sanitised;
};

/**
 * Build from a clean output directory. TypeScript overwrites emitted files,
 * but it does not remove JavaScript whose source disappeared; without this
 * boundary `npm pack` can publish retired commands from an older checkout.
 */
export function buildCli() {
  const dist = path.join(root, 'packages/cli/dist');
  rmSync(dist, { recursive: true, force: true });

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
  return result.status ?? 1;
}

function main() {
  // 1. Wire up the pre-commit hook when working inside the git checkout.
  if (
    !process.argv.includes('--build-only') &&
    !process.env.CI &&
    existsSync(path.join(root, '.git'))
  ) {
    spawnSync('git', ['config', 'core.hooksPath', '.husky'], {
      cwd: root,
      env: gitConfigEnv(),
      stdio: 'inherit',
    });
  }

  // 2. Build the CLI so the `bin` entry exists (required for git/tarball installs).
  process.exit(buildCli());
}

// Run only when executed, never when imported: a test that imports this module
// to check one exported function must not trigger a build or touch git config.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
