import { execFile } from 'node:child_process';
import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gitEnv } from '../lib/git-env.js';
import { initProject } from './init.js';

/** A user-facing failure: message is printed as-is, no stack trace. */
export class CreateError extends Error {}

export interface CreateOptions {
  cwd: string;
  /**
   * Initialise git with a baseline commit (default true) so the first change —
   * human or agent — diffs against a pristine template. Never fatal: a missing
   * git skips silently.
   */
  git?: boolean;
}

export interface CreateResult {
  projectDir: string;
  projectName: string;
}

/**
 * A safe, predictable project name — also what ends up in a filename (the
 * kill switch, `~/.claude/<name>-loop-STOP`) and inside a single-quoted string
 * literal in a generated script (`stop-flag.mjs`), so it is validated
 * up front rather than silently slugged. There is no npm scope to validate
 * for any more (RP-177 retired the application skeleton this pattern used to
 * double as): the shape survives only because it is still the right shape for
 * a directory/kill-switch name, not because anything downstream reads it as a
 * package identifier.
 *
 * No trailing `-` or `.`: `projectNameFor` (the name `init` would derive from
 * this same directory with no identity supplied) strips both, and a name this
 * pattern accepted but that function would rewrite is exactly the mismatch
 * that once made a freshly created rig fail to match its own installed files
 * on the very next `upgrade`.
 */
const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

/**
 * `create <dir>` — a thin convenience wrapper (RP-177): make the directory,
 * run the same install `init` runs inside it, then commit the pristine
 * baseline. There is only one payload flavour; this command's entire value is
 * not having to `mkdir`, `cd` and run `init` by hand.
 */
export async function createProject(dirArg: string, options: CreateOptions): Promise<CreateResult> {
  const projectDir = path.resolve(options.cwd, dirArg);
  const projectName = path.basename(projectDir);

  if (!NAME_PATTERN.test(projectName)) {
    throw new CreateError(
      `Invalid project name "${projectName}": use lowercase letters, digits, ".", "_" and "-", ` +
        'starting and ending with a letter or digit.',
    );
  }

  await ensureEmptyOrAbsent(projectDir);
  await mkdir(projectDir, { recursive: true });

  if (options.git !== false) {
    await initGitRepository(projectDir);
  }

  await initProject(projectDir, {
    project: { name: projectName, scope: projectName, region: '' },
  });

  if (options.git !== false) {
    await commitGitBaseline(projectDir);
  }

  return { projectDir, projectName };
}

const run = promisify(execFile);

const gitInvocation = (projectDir: string) => ({
  quiet: ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false'],
  where: { cwd: projectDir, env: gitEnv() },
});

async function initGitRepository(projectDir: string): Promise<void> {
  const { quiet, where } = gitInvocation(projectDir);
  try {
    await run('git', [...quiet, 'init', '--quiet'], where);
  } catch {
    // git missing or unusable — generation never fails on this.
  }
}

async function commitGitBaseline(projectDir: string): Promise<void> {
  // Disable git's background maintenance for these one-shot commands: a commit
  // can otherwise fork an auto-gc / maintenance process that keeps writing to
  // .git/objects/pack after we return — a non-deterministic tail that races any
  // caller cleaning up the directory, and pointless work on a one-commit repo.
  const { quiet, where } = gitInvocation(projectDir);
  try {
    await run('git', [...quiet, 'add', '-A'], where);
    // Explicit identity: the baseline must commit even where git has no
    // global user configured (fresh machines, CI). --no-verify here shields
    // the baseline from the USER'S global hooks only — the generated
    // project's own gates do not exist yet, so nothing is being bypassed.
    await run(
      'git',
      [
        ...quiet,
        '-c',
        'user.name=create-agent-rig',
        '-c',
        'user.email=create-agent-rig@localhost',
        'commit',
        '--quiet',
        '--no-verify',
        '-m',
        'Pristine template (create-agent-rig)',
      ],
      where,
    );
  } catch {
    // git missing or unusable — generation never fails on this.
  }
}

async function ensureEmptyOrAbsent(dir: string): Promise<void> {
  let stats;
  try {
    stats = await stat(dir);
  } catch {
    return; // does not exist — fine
  }
  if (!stats.isDirectory()) {
    throw new CreateError(`Target "${dir}" exists and is not a directory.`);
  }
  const entries = await readdir(dir);
  if (entries.length > 0) {
    throw new CreateError(
      `Target directory "${dir}" is not empty (${entries.length} entries). ` +
        'Choose a new directory — the generator never overwrites existing files.',
    );
  }
}
