// Runs on `pnpm install` locally AND when npm installs this package from git
// (`npx github:<user>/create-agent-factory`). It must therefore work with only
// the root devDependencies present and no pnpm available.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';

// 1. Wire up the pre-commit hook when working inside the git checkout.
if (existsSync(path.join(root, '.git'))) {
  spawnSync('git', ['config', 'core.hooksPath', '.husky'], { cwd: root, stdio: 'inherit' });
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
