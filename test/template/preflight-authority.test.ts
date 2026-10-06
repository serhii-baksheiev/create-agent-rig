import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { removeFixture } from '../helpers/remove-fixture.js';
import { stubCommand, type StubHandle } from '../helpers/stub-command.js';

/**
 * RP-343 slice A — preflight reports a truthful authority posture.
 *
 * `.claude/scripts/lib/authority.mjs` (RP-339) is the single source of truth
 * for execution mode / decision authority / publication authority. This file
 * pins that `preflight.mjs`:
 *
 *  - accepts `--unattended` and `--decision-authority <value>` (space-
 *    separated only — the `--decision-authority=<value>` form is not
 *    recognised as supplying a value);
 *  - adds a top-level `authority` key to `--json` output that is exactly
 *    `authorityPosture({ executionMode, decisionAuthority })`;
 *  - renders three lines in the non-JSON block: execution mode, decision
 *    authority, publication authority;
 *  - refuses (exit 1, no report on stdout) a `--decision-authority` value
 *    that is not exactly `owner` or `delegated`, naming both accepted words
 *    on stderr;
 *  - never changes `verdict`/`checks`/`uncheckedConditions` by virtue of the
 *    new flags — delegation never turns STOP/CAUTION into GO;
 *  - is purely observational: running it with the new flags writes nothing;
 *  - builds the authority block from `lib/authority.mjs`, never restating the
 *    closed vocabulary itself.
 *
 * Fixture/spawn style is reused from preflight-queue.test.ts (full fixture
 * copy of the scripts dir, git/gh stubbed on PATH) and preflight-posture.test.ts
 * (the kill switch is armed through `AGENT_LOOP_STOP` pointing at a real file
 * — the same fixture mechanism `stop-flag.mjs`'s own tests use).
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptsDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'scripts');
const preflightModulePath = path.join(scriptsDir, 'preflight.mjs');

type Check = { ok: boolean | string; detail?: string; id?: string; outcome?: string };
type Authority = {
  schemaVersion: 1;
  executionMode: string;
  decisionAuthority: string;
  publicationAuthority: string;
};
type Report = {
  verdict: string;
  checks: Record<string, Check>;
  unchecked: string[];
  uncheckedConditions: { id: string; outcome: string; detail: string }[];
  rendered: string;
  authority?: Authority;
};

const contract = {
  schemaVersion: 1,
  detection: {
    mode: 'pull',
    sources: ['run-state', 'journal'],
    acceptedLatency: '24h',
    push: false,
  },
  pairedFacts: [],
};

const fixture = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'preflight-authority-'));
  const claude = path.join(root, '.claude');
  await mkdir(claude, { recursive: true });
  await cp(scriptsDir, path.join(claude, 'scripts'), { recursive: true });
  await mkdir(path.join(root, '.rig'), { recursive: true });
  await writeFile(path.join(root, '.rig', 'revalidation.json'), `${JSON.stringify(contract)}\n`);
  await writeFile(path.join(root, 'PLAN.md'), '# Plan\n\n## Agent queue\n\n## Operator queue\n');
  return root;
};

let stubs: StubHandle[] = [];

afterEach(async () => {
  const restoring = [...stubs].reverse();
  stubs = [];
  for (const stub of restoring) stub.restore();
});

// Deterministic, network-free answers for the probes this file does not
// exercise: git reports the local branch level with origin, gh reports no
// deploy history.
const stubProbes = async () => {
  stubs.push(
    await stubCommand(
      'git',
      "if (args.includes('symbolic-ref')) return { stdout: 'origin/master\\n' }; if (args.includes('rev-parse')) return { stdout: 'same-sha\\n' }; return {};",
    ),
  );
  stubs.push(await stubCommand('gh', "return { stdout: '[]\\n' };"));
};

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

const runCli = (root: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
  new Promise<CliResult>((resolve) => {
    execFile(
      process.execPath,
      [path.join(root, '.claude', 'scripts', 'preflight.mjs'), ...args],
      {
        cwd: root,
        env: {
          ...process.env,
          GIT_DIR: undefined,
          GIT_WORK_TREE: undefined,
          RIG_RUN_DIR: undefined,
          JIRA_BASE_URL: undefined,
          JIRA_EMAIL: undefined,
          JIRA_API_TOKEN: undefined,
          ...env,
        },
      },
      (error, stdout, stderr) => {
        resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
      },
    );
  });

const preflightJson = async (
  root: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = {},
): Promise<Report> => {
  const result = await runCli(root, ['--json', ...args], env);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Report;
};

const preflightRendered = async (
  root: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = {},
): Promise<string> => {
  const result = await runCli(root, args, env);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  return result.stdout;
};

/** A recursive, order-independent fingerprint of every file under `root`. */
const snapshotTree = async (root: string): Promise<string> => {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .sort();
  const hash = createHash('sha256');
  for (const relative of files) {
    hash.update(relative);
    hash.update(await readFile(path.join(root, relative)));
  }
  return `${files.length} files / ${hash.digest('hex')}`;
};

const EXECUTION_DECISION_CASES: {
  name: string;
  args: string[];
  expected: { executionMode: string; decisionAuthority: string };
}[] = [
  {
    name: 'no flags',
    args: [],
    expected: { executionMode: 'attended', decisionAuthority: 'owner' },
  },
  {
    name: '--unattended --decision-authority delegated',
    args: ['--unattended', '--decision-authority', 'delegated'],
    expected: { executionMode: 'unattended', decisionAuthority: 'delegated' },
  },
  {
    name: '--decision-authority owner',
    args: ['--decision-authority', 'owner'],
    expected: { executionMode: 'attended', decisionAuthority: 'owner' },
  },
];

describe('preflight --json carries an authority key built from authorityPosture (RP-343)', () => {
  it.each(EXECUTION_DECISION_CASES)(
    'reports $name as { executionMode: $expected.executionMode, decisionAuthority: $expected.decisionAuthority, publicationAuthority: owner }',
    async ({ args, expected }) => {
      const root = await fixture();
      try {
        await stubProbes();
        const result = await preflightJson(root, args);
        expect(result.authority).toEqual({
          schemaVersion: 1,
          executionMode: expected.executionMode,
          decisionAuthority: expected.decisionAuthority,
          publicationAuthority: 'owner',
        });
      } finally {
        await removeFixture(root);
      }
    },
  );
});

describe('preflight renders the authority posture as three lines (RP-343)', () => {
  it.each(EXECUTION_DECISION_CASES)(
    'renders "Execution mode: $expected.executionMode", "Decision authority: $expected.decisionAuthority" and "Publication authority: owner", each exactly once, for $name',
    async ({ args, expected }) => {
      const root = await fixture();
      try {
        await stubProbes();
        const rendered = await preflightRendered(root, args);
        const occurrences = (needle: string) =>
          rendered.split('\n').filter((line) => line.trim() === needle).length;
        expect(occurrences(`Execution mode: ${expected.executionMode}`), rendered).toBe(1);
        expect(occurrences(`Decision authority: ${expected.decisionAuthority}`), rendered).toBe(1);
        expect(occurrences('Publication authority: owner'), rendered).toBe(1);
      } finally {
        await removeFixture(root);
      }
    },
  );
});

describe('preflight accepts only the space-separated --decision-authority form (RP-343)', () => {
  it('a missing value after --decision-authority refuses: exit 1, no report on stdout, both words on stderr', async () => {
    const root = await fixture();
    try {
      await stubProbes();
      const result = await runCli(root, ['--decision-authority']);
      expect(result.code).toBe(1);
      expect(result.stdout).not.toMatch(/verdict/i);
      expect(result.stdout.trim()).not.toMatch(/^\{/);
      expect(result.stderr).toMatch(/owner/);
      expect(result.stderr).toMatch(/delegated/);
    } finally {
      await removeFixture(root);
    }
  });

  // A flag spelled in a form preflight does not read must not silently leave
  // the run at the default: the operator asked for an authority, so a form
  // that cannot carry it refuses rather than reporting owner.
  it('--decision-authority=delegated refuses rather than silently reading as owner', async () => {
    const root = await fixture();
    try {
      await stubProbes();
      const result = await runCli(root, ['--decision-authority=delegated']);
      expect(result.code).toBe(1);
      expect(result.stdout).not.toMatch(/verdict/i);
      expect(result.stdout.trim()).not.toMatch(/^\{/);
      expect(result.stderr).toMatch(/owner/);
      expect(result.stderr).toMatch(/delegated/);
    } finally {
      await removeFixture(root);
    }
  });
});

describe('preflight refuses an unrecognised --decision-authority value (RP-343)', () => {
  it.each([
    ['Delegated', ['--decision-authority', 'Delegated']],
    ['yes', ['--decision-authority', 'yes']],
    ['controller', ['--decision-authority', 'controller']],
    ['an empty string', ['--decision-authority', '']],
    ['a missing value', ['--decision-authority']],
  ])(
    '%s: exit 1, nothing resembling a verdict block or JSON report on stdout',
    async (_case, args) => {
      const root = await fixture();
      try {
        await stubProbes();
        const result = await runCli(root, args as string[]);
        expect(result.code).toBe(1);
        expect(result.stdout).not.toMatch(/verdict/i);
        expect(result.stdout.trim()).not.toMatch(/^\{/);
        expect(result.stderr).toMatch(/owner/);
        expect(result.stderr).toMatch(/delegated/);
      } finally {
        await removeFixture(root);
      }
    },
  );

  it('refuses the same way under --json — never reported as owner or delegated', async () => {
    const root = await fixture();
    try {
      await stubProbes();
      const result = await runCli(root, ['--json', '--decision-authority', 'controller']);
      expect(result.code).toBe(1);
      expect(result.stdout).not.toMatch(/"authority"/);
      expect(result.stdout.trim()).not.toMatch(/^\{/);
      expect(result.stderr).toMatch(/owner/);
      expect(result.stderr).toMatch(/delegated/);
    } finally {
      await removeFixture(root);
    }
  });
});

describe('the authority flags change nothing else preflight reports (RP-343)', () => {
  it('verdict, checks and uncheckedConditions are deep-equal with and without the flags, on an ordinary CAUTION fixture', async () => {
    const root = await fixture();
    try {
      await stubProbes();
      const bare = await preflightJson(root, []);
      const flagged = await preflightJson(root, [
        '--unattended',
        '--decision-authority',
        'delegated',
      ]);
      expect(flagged.verdict).toEqual(bare.verdict);
      expect(flagged.checks).toEqual(bare.checks);
      expect(flagged.uncheckedConditions).toEqual(bare.uncheckedConditions);
      // Sanity: this fixture is not vacuously GO either way, and delegation
      // did not quietly turn a non-GO verdict into one.
      expect(bare.verdict).not.toBe('GO');
    } finally {
      await removeFixture(root);
    }
  });

  it('a delegated, unattended run still reports STOP when the kill switch is armed — delegation never clears it', async () => {
    const root = await fixture();
    const stopFlagPath = path.join(root, 'armed-kill-switch');
    await writeFile(stopFlagPath, 'stop\n');
    try {
      await stubProbes();
      const env = { AGENT_LOOP_STOP: stopFlagPath };
      const bare = await preflightJson(root, [], env);
      const flagged = await preflightJson(
        root,
        ['--unattended', '--decision-authority', 'delegated'],
        env,
      );
      expect(bare.verdict).toBe('STOP');
      expect(flagged.verdict).toBe('STOP');
      expect(flagged.checks).toEqual(bare.checks);
      expect(flagged.uncheckedConditions).toEqual(bare.uncheckedConditions);
    } finally {
      await removeFixture(root);
    }
  });
});

describe('preflight with the authority flags is purely observational (RP-343)', () => {
  it('writes nothing to the fixture tree', async () => {
    const root = await fixture();
    try {
      await stubProbes();
      const before = await snapshotTree(root);
      await preflightJson(root, ['--unattended', '--decision-authority', 'delegated']);
      const after = await snapshotTree(root);
      expect(after).toBe(before);
    } finally {
      await removeFixture(root);
    }
  });
});

describe('preflight.mjs builds the authority block from lib/authority.mjs, not a restatement (RP-343)', () => {
  it('imports from ./lib/authority.mjs', async () => {
    const content = await readFile(preflightModulePath, 'utf8');
    expect(content).toMatch(/from\s+['"]\.\/lib\/authority\.mjs['"]/);
  });

  it('never spells the closed vocabulary word "delegated" itself — it reads it from the contract', async () => {
    const content = await readFile(preflightModulePath, 'utf8');
    expect(content).not.toMatch(/['"]delegated['"]/);
  });

  // pathToFileURL import sanity: the module this test reads as text is the
  // same one `node .claude/scripts/preflight.mjs` runs — not a stale copy.
  it('the file read as text is importable as the preflight module', async () => {
    const mod = (await import(pathToFileURL(preflightModulePath).href)) as Record<string, unknown>;
    expect(typeof mod.report).toBe('function');
  });
});
