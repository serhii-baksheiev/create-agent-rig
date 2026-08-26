// The two git questions a proposal's `asOf` needs answered (AR-116):
// which commit is HEAD, and what changed between a commit and HEAD.
//
// Kept out of `core.mjs`, which is pure, and out of the adapters, which would
// otherwise each spawn git their own way. Both answers are `null` when git
// cannot answer — no checkout, an unknown commit, a shallow clone — and
// `overtakenOf` in core.mjs turns that `null` into an "unanswerable" finding
// rather than a clean one.

import { execFileSync } from 'node:child_process';
import { withoutGitLocation } from '../git-env.mjs';

const git = (args, cwd) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: withoutGitLocation(),
  }).trim();

/** HEAD of the checkout at `cwd`, or null where there is none. */
export const headShaOf = ({ cwd = process.cwd() } = {}) => {
  try {
    const sha = git(['rev-parse', 'HEAD'], cwd);
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
};

/** Paths changed between `asOf` and `head`, or null when git cannot say. */
export const changedSinceOf = ({ cwd = process.cwd(), asOf, head = 'HEAD' } = {}) => {
  if (typeof asOf !== 'string' || !/^[0-9a-f]{7,40}$/.test(asOf)) return null;
  try {
    return git(['diff', '--name-only', '-z', asOf, head], cwd).split('\0').filter(Boolean);
  } catch {
    return null;
  }
};
