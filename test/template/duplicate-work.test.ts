import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stubCommand, type StubHandle } from '../helpers/stub-command.js';

// RP-222 — "Detect duplicate ticket branches and PRs before parallel work"
// (.claude/runs/20260924-070359-rp-222/brief.md). Before a controller claims a
// ticket, or ships a PR for one, it checks whether ANOTHER branch or open PR
// already carries the same ticket id — using only bounded, native git/GitHub
// evidence (`git ls-remote --heads origin`, `gh pr list --search`), never a
// branch registry this rig would have to keep in sync.
//
// This file is written against `.claude/scripts/duplicate-work.mjs`, which
// does not exist yet — every test below is RED because the script (and its
// two wiring points, `layers.json` and the loop/pr-ship skills) are absent.
//
// The independent oracle (`invariants.md`): every scenario's expected verdict
// comes from what the fixture itself set up — which branches were pushed to a
// REAL bare `origin`, and what a stubbed `gh` was told to answer — never from
// calling the script's own matching function to compute the "expected" value.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universalDir = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const scriptsDir = path.join(universalDir, '.claude', 'scripts');
const scriptPath = (name: string) => path.join(scriptsDir, name);
const load = (name: string) => import(pathToFileURL(scriptPath(name)).href);
const skillPath = (...parts: string[]) =>
  path.join(universalDir, '.claude', 'skills', ...parts, 'SKILL.md');

const { readFile } = await import('node:fs/promises');

// --- git plumbing, following revalidate.test.ts's gitFixture shape ---------

const { withoutGitLocation } = (await import(
  pathToFileURL(path.join(scriptsDir, 'preflight.mjs')).href
)) as {
  withoutGitLocation: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
};

const run = (
  file: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string; out: string }> =>
  new Promise((resolve) => {
    execFile(file, args, { cwd, env }, (error, stdout, stderr) => {
      resolve({
        code: error ? ((error as { code?: number }).code ?? 1) : 0,
        stdout,
        stderr,
        out: stdout + stderr,
      });
    });
  });

const git = async (args: string[], cwd: string): Promise<string> => {
  const result = await run(
    'git',
    ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args],
    cwd,
    withoutGitLocation(),
  );
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.out}`);
  return result.stdout.trim();
};

/** Clone `origin`, create `branch`, commit a trivial file, push it — a second
 *  controller's session, never touching the shared `checkout`'s own HEAD. */
const pushOtherBranch = async (root: string, origin: string, branch: string): Promise<void> => {
  const dir = await mkdtemp(path.join(root, 'other-'));
  await git(['clone', '-q', origin, dir], root);
  await git(['checkout', '-q', '-b', branch], dir);
  await writeFile(path.join(dir, 'note.txt'), `${branch}\n`);
  await git(['add', '-A'], dir);
  await git(['commit', '-q', '-m', `work on ${branch}`], dir);
  await git(['push', '-q', 'origin', branch], dir);
};

const hermeticEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  if (!('RIG_RUN_DIR' in extra)) delete env.RIG_RUN_DIR;
  return env;
};

interface DuplicateWorkMatch {
  source: string;
  ref: string;
  field: string;
  url?: string;
}
interface DuplicateWorkSourceStatus {
  name: string;
  status: string;
}
interface DuplicateWorkResult {
  ticket: string;
  verdict: string;
  matches: DuplicateWorkMatch[];
  sources: DuplicateWorkSourceStatus[];
}

const runCli = (
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; out: string; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      [scriptPath('duplicate-work.mjs'), ...args],
      { cwd, env },
      (error, stdout, stderr) => {
        resolve({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          out: stdout + stderr,
          stdout,
          stderr,
        });
      },
    );
  });

const runCliJson = async (
  cwd: string,
  ticket: string,
  env: NodeJS.ProcessEnv,
): Promise<DuplicateWorkResult> => {
  const result = await runCli(cwd, ['--ticket', ticket, '--json'], env);
  return JSON.parse(result.stdout.trim()) as DuplicateWorkResult;
};

/** A `gh` stub that answers `pr list` with a fixed array, everything else fails. */
const ghListing = (prs: Array<Record<string, unknown>>): Promise<StubHandle> =>
  stubCommand(
    'gh',
    [
      "if (args[0] === 'pr' && args[1] === 'list') {",
      `  return { stdout: ${JSON.stringify(JSON.stringify(prs))} + '\\n' };`,
      '}',
      'return { exitCode: 1 };',
    ].join('\n'),
  );

/** A `gh` that always fails, the way a missing binary or a network error would
 *  look to a caller reading its exit code and stderr. */
const ghFailing = (): Promise<StubHandle> =>
  stubCommand('gh', "process.stderr.write('gh: command not found\\n'); return { exitCode: 127 };");

describe('matchesTicket — a token match bounded by non-alphanumerics, never fuzzy', () => {
  it.each([
    ['RP-220', 'feat/rp-220-verified-claims', true],
    ['RP-220', 'fix/RP-220', true],
    ['RP-220', 'x (RP-220)', true],
    ['RP-220', 'rp-2200', false],
    ['RP-220', 'rp-22', false],
    ['RP-220', 'xrp-220', false],
    ['RP-220', 'feat/rp-2201-x', false],
  ])('matchesTicket(%j, %j) -> %p', async (id, text, expected) => {
    const { matchesTicket } = await load('duplicate-work.mjs');
    expect(matchesTicket(id, text)).toBe(expected);
  });

  // The brief's second id shape: a bare issue number, matched only as `#<n>`
  // in a title or a `<type>/<n>-` branch token — never as a number loose in text.
  it.each([
    ['220', 'fix/220-my-work', true],
    ['220', 'closes #220', true],
    ['220', 'there were 220 of them', false],
    ['220', '2200', false],
  ])('matchesTicket(%j, %j) -> %p (bare issue number)', async (id, text, expected) => {
    const { matchesTicket } = await load('duplicate-work.mjs');
    expect(matchesTicket(id, text)).toBe(expected);
  });
});

describe('duplicate-work CLI — real git evidence, a stubbed gh', () => {
  let root: string;
  let origin: string;
  let checkout: string;
  const OWN_BRANCH = 'feat/rp-9002-my-work';

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'duplicate-work-'));
    origin = path.join(root, 'origin.git');
    checkout = path.join(root, 'checkout');
    await mkdir(origin);
    await git(['init', '--bare', '-b', 'master'], origin);
    await git(['clone', '-q', origin, checkout], root);
    await writeFile(path.join(checkout, 'README.md'), 'seed\n');
    await git(['add', '-A'], checkout);
    await git(['commit', '-q', '-m', 'seed'], checkout);
    await git(['push', '-q', '-u', 'origin', 'master'], checkout);
    // The shared checkout's own HEAD, pushed to origin — every later scenario
    // runs with this as `git rev-parse --abbrev-ref HEAD`, so it doubles as
    // the fixture for "own branch/PR excluded" (RP-9002) without needing a
    // second checkout.
    await git(['checkout', '-q', '-b', OWN_BRANCH], checkout);
    await writeFile(path.join(checkout, 'a.txt'), 'a\n');
    await git(['add', '-A'], checkout);
    await git(['commit', '-q', '-m', 'own work'], checkout);
    await git(['push', '-q', '-u', 'origin', OWN_BRANCH], checkout);
  }, 30_000);

  afterAll(async () => {
    // best-effort; a leftover temp dir is not this suite's concern beyond cleanup hygiene
  });

  it('exit 0, verdict clean — no other branch or PR carries the id, both sources read', async () => {
    const gh = await ghListing([]);
    try {
      const result = await runCli(checkout, ['--ticket', 'RP-9001'], hermeticEnv());
      expect(result.code, result.out).toBe(0);
      expect(result.out).toMatch(/clean/i);
    } finally {
      gh.restore();
    }
  });

  it('reports the shape { ticket, verdict, matches, sources } on the clean run', async () => {
    const gh = await ghListing([]);
    try {
      const parsed = await runCliJson(checkout, 'RP-9012', hermeticEnv());
      expect(parsed.ticket).toBe('RP-9012');
      expect(parsed.verdict).toBe('clean');
      expect(parsed.matches).toEqual([]);
      expect(parsed.sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'branch', status: 'read' }),
          expect.objectContaining({ name: 'pr', status: 'read' }),
        ]),
      );
    } finally {
      gh.restore();
    }
  });

  it('exit 2, verdict duplicate-work — another branch on origin carries the id', async () => {
    await pushOtherBranch(root, origin, 'feat/rp-9003-another-session');
    const gh = await ghListing([]);
    try {
      const parsed = await runCliJson(checkout, 'RP-9003', hermeticEnv());
      expect(parsed.verdict).toBe('duplicate-work');
      const match = parsed.matches.find((m) => m.source === 'branch');
      expect(match, JSON.stringify(parsed)).toBeDefined();
      expect(match!.ref).toMatch(/rp-9003-another-session/i);
      expect(typeof match!.field).toBe('string');
      expect(match!.field.length).toBeGreaterThan(0);

      const text = await runCli(checkout, ['--ticket', 'RP-9003'], hermeticEnv());
      expect(text.code).toBe(2);
      expect(text.out).toMatch(/re-read/i);
      expect(text.out).toMatch(/take over/i);
      expect(text.out).toMatch(/tracker/i);
      expect(text.out).toMatch(/never start a second/i);
    } finally {
      gh.restore();
    }
  });

  it("exit 0 — the checkout's own branch and its own open PR are excluded, not counted as duplicates", async () => {
    const gh = await ghListing([
      {
        number: 42,
        title: `feat: my own work (RP-9002)`,
        headRefName: OWN_BRANCH,
        url: 'https://example.invalid/acme/widgets/pull/42',
      },
    ]);
    try {
      const result = await runCli(checkout, ['--ticket', 'RP-9002'], hermeticEnv());
      expect(result.code, result.out).toBe(0);
      expect(result.out).toMatch(/clean/i);
    } finally {
      gh.restore();
    }
  });

  it('exit 2, source pr — an open PR from another branch carries the id in its title', async () => {
    const gh = await ghListing([
      {
        number: 7,
        title: 'fix: add a route (RP-9004)',
        headRefName: 'fix/some-other-branch',
        url: 'https://example.invalid/acme/widgets/pull/7',
      },
    ]);
    try {
      const parsed = await runCliJson(checkout, 'RP-9004', hermeticEnv());
      expect(parsed.verdict).toBe('duplicate-work');
      const match = parsed.matches.find((m) => m.source === 'pr');
      expect(match, JSON.stringify(parsed)).toBeDefined();
      expect(match!.field).toBe('title');
      expect(match!.url).toBe('https://example.invalid/acme/widgets/pull/7');
    } finally {
      gh.restore();
    }
  });

  it("exit 0 — gh's fuzzy search returns a PR whose title/head do not carry the exact token, filtered out client-side", async () => {
    const gh = await ghListing([
      {
        number: 8,
        title: 'chore: unrelated RP-90050 cleanup',
        headRefName: 'chore/rp-90050-cleanup',
        url: 'https://example.invalid/acme/widgets/pull/8',
      },
    ]);
    try {
      const result = await runCli(checkout, ['--ticket', 'RP-9005'], hermeticEnv());
      expect(result.code, result.out).toBe(0);
      expect(result.out).toMatch(/clean/i);
    } finally {
      gh.restore();
    }
  });

  it('exit 3, verdict unverifiable — gh is missing/failing, never reported as clean', async () => {
    const gh = await ghFailing();
    try {
      const parsed = await runCliJson(checkout, 'RP-9006', hermeticEnv());
      expect(parsed.verdict).toBe('unverifiable');
      expect(parsed.verdict).not.toBe('clean');
      const prSource = parsed.sources.find((s) => s.name === 'pr');
      expect(prSource, JSON.stringify(parsed)).toBeDefined();
      expect(prSource!.status).toBe('unavailable');
      const branchSource = parsed.sources.find((s) => s.name === 'branch');
      expect(branchSource?.status).toBe('read');

      const text = await runCli(checkout, ['--ticket', 'RP-9006'], hermeticEnv());
      expect(text.code).toBe(3);
    } finally {
      gh.restore();
    }
  });

  it('exit 3 — no origin remote at all', async () => {
    const noRemote = await mkdtemp(path.join(root, 'no-origin-'));
    await git(['init', '-q', '-b', 'master'], noRemote);
    await writeFile(path.join(noRemote, 'x.txt'), 'x\n');
    await git(['add', '-A'], noRemote);
    await git(['commit', '-q', '-m', 'seed'], noRemote);
    const gh = await ghListing([]);
    try {
      const result = await runCli(noRemote, ['--ticket', 'RP-9010'], hermeticEnv());
      expect(result.code, result.out).toBe(3);
    } finally {
      gh.restore();
    }
  });

  // 🔴 Exit code 1 alone is not evidence of the intended usage refusal: with
  // the script absent, node's own MODULE_NOT_FOUND also exits 1, and a test
  // that stopped at the exit code would "pass" against nothing. The two
  // assertions below rule that out: the output must mention the offending
  // flag/usage, and must NOT be a node stack trace.
  it('exit 1 — no --ticket given', async () => {
    const gh = await ghListing([]);
    try {
      const result = await runCli(checkout, [], hermeticEnv());
      expect(result.code, result.out).toBe(1);
      expect(result.out).not.toMatch(/MODULE_NOT_FOUND|Cannot find module|node:internal/);
      expect(result.out).toMatch(/--ticket|usage/i);
    } finally {
      gh.restore();
    }
  });

  it('exit 1 — an invalid --ticket value that is not a ticket-id or bare issue number shape', async () => {
    const gh = await ghListing([]);
    try {
      const result = await runCli(checkout, ['--ticket', 'not an id!!'], hermeticEnv());
      expect(result.code, result.out).toBe(1);
      expect(result.out).not.toMatch(/MODULE_NOT_FOUND|Cannot find module|node:internal/);
      expect(result.out).toMatch(/--ticket|usage/i);
    } finally {
      gh.restore();
    }
  });

  it('writes one duplicate-work event to events.jsonl when RIG_RUN_DIR is declared', async () => {
    const runDir = await mkdtemp(path.join(tmpdir(), 'duplicate-work-run-'));
    const gh = await ghListing([]);
    try {
      const result = await runCli(
        checkout,
        ['--ticket', 'RP-9013'],
        hermeticEnv({ RIG_RUN_DIR: runDir }),
      );
      expect(result.code, result.out).toBe(0);
      const journal = (await load('run-journal.mjs')) as {
        readRun: (input: { runDir: string }) => { events: Array<{ kind: string; data: unknown }> };
      };
      const { events } = journal.readRun({ runDir });
      const own = events.filter((e) => e.kind === 'duplicate-work');
      expect(own, JSON.stringify(events)).toHaveLength(1);
      expect((own[0]!.data as { ticket?: string }).ticket).toBe('RP-9013');
    } finally {
      gh.restore();
    }
  });

  it('writes nothing when RIG_RUN_DIR is undeclared', async () => {
    const gh = await ghListing([]);
    try {
      const result = await runCli(checkout, ['--ticket', 'RP-9014'], hermeticEnv());
      expect(result.code, result.out).toBe(0);
      // No default run-directory convention may be invented under the cwd —
      // silent, like every other optional trace in this rig.
      expect(existsSync(path.join(checkout, '.claude', 'runs'))).toBe(false);
    } finally {
      gh.restore();
    }
  });
});

describe('duplicate-work.mjs is wired into the workflow layer', () => {
  it('layers.json lists the script under the workflow array', async () => {
    const manifest = JSON.parse(
      await readFile(path.join(universalDir, 'layers.json'), 'utf8'),
    ) as Record<string, string[]>;
    expect(manifest['workflow']).toContain('.claude/scripts/duplicate-work.mjs');
  });

  it('the loop skill names duplicate-work.mjs before a claim', async () => {
    const content = await readFile(skillPath('loop'), 'utf8');
    expect(content).toMatch(/duplicate-work\.mjs/);
  });

  it('the pr-ship skill names duplicate-work.mjs as a HOLD blocker before the PR', async () => {
    const content = await readFile(skillPath('pr-ship'), 'utf8');
    expect(content).toMatch(/duplicate-work\.mjs/);
  });
});
