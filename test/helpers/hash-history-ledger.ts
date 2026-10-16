import { execFileSync } from 'node:child_process';
// @ts-expect-error — a plain .mjs rulebook script
import { withoutGitLocation } from '../../.claude/scripts/git-env.mjs';

export type Ledger = Record<string, string | null>;
export type GitCommand = (args: string[], input?: string) => string;

export const gitAt =
  (cwd: string): GitCommand =>
  (args, input) =>
    execFileSync('git', args, { cwd, env: withoutGitLocation(), input, encoding: 'utf8' });

export const assertLedgerCommitPackages = (ledger: Ledger, git: GitCommand): void => {
  const entries: Array<[string, string]> = [];

  for (const [version, sha] of Object.entries(ledger)) {
    if (sha === null) continue;
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error(`${version}: expected a 40-character lowercase hexadecimal commit sha`);
    }

    entries.push([version, sha]);
  }

  if (entries.length === 0) return;

  const commitChecks = git(
    ['cat-file', '--batch-check'],
    `${entries.map(([, sha]) => `${sha}^{commit}`).join('\n')}\n`,
  );
  const commitLines = commitChecks.endsWith('\n')
    ? commitChecks.slice(0, -1).split('\n')
    : commitChecks.split('\n');

  if (commitLines.length !== entries.length) {
    throw new Error('release ledger: incomplete commit batch response');
  }

  for (const [index, [version, sha]] of entries.entries()) {
    const match = /^([0-9a-f]{40}) (\S+) (\d+)$/.exec(commitLines[index] ?? '');
    if (match?.[1] !== sha || match[2] !== 'commit') {
      throw new Error(`${version}: ${sha} is not a commit`);
    }
  }

  const packageBlobs = Buffer.from(
    git(['cat-file', '--batch'], `${entries.map(([, sha]) => `${sha}:package.json`).join('\n')}\n`),
    'utf8',
  );
  let offset = 0;

  for (const [version, sha] of entries) {
    const headerEnd = packageBlobs.indexOf(0x0a, offset);
    if (headerEnd === -1) {
      throw new Error(`${version} -> ${sha}: missing package.json blob`);
    }

    const header = packageBlobs.subarray(offset, headerEnd).toString('utf8');
    const match = /^([0-9a-f]{40}) blob (\d+)$/.exec(header);
    const size = Number(match?.[2]);
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;

    if (!match || !Number.isSafeInteger(size) || contentEnd >= packageBlobs.length) {
      throw new Error(`${version} -> ${sha}: missing package.json blob`);
    }
    if (packageBlobs[contentEnd] !== 0x0a) {
      throw new Error(`${version} -> ${sha}: malformed package.json blob`);
    }

    let pkg: { version?: string };
    try {
      pkg = JSON.parse(packageBlobs.subarray(contentStart, contentEnd).toString('utf8')) as {
        version?: string;
      };
    } catch {
      throw new Error(`${version} -> ${sha}: malformed package.json blob`);
    }

    if (pkg.version !== version) {
      throw new Error(`${version} -> ${sha}: package.json has version ${String(pkg.version)}`);
    }

    offset = contentEnd + 1;
  }

  if (offset !== packageBlobs.length) {
    throw new Error('release ledger: malformed package batch response');
  }
};
