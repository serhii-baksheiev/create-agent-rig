import { execFile } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initProject } from '../src/commands/init.js';
import { planUpgrade } from '../src/commands/upgrade.js';
import type { UpgradePlan } from '../src/commands/upgrade.js';
import { MANIFEST_REL, readManifest } from '../src/lib/manifest.js';

// What this file is about: the CLI's *report* on its own work — the plan
// header, the flags it accepts, and the summary line. None of that is
// reachable from `planUpgrade`: `renderUpgradePlan`, `runUpgrade` and `runInit`
// live in `src/index.ts` behind a top-level `main()`, so the only honest entry
// point is the binary. These tests spawn it.
//
// 🔴 The build is written OUTSIDE `packages/cli/dist` on purpose. A test that
// compiles into the shared `dist` re-opens the measured race that
// `test/template/e2e-pack.test.ts` documents: the e2e suite's `npm pack` READS
// that directory while a concurrent `tsc` rewrites it, and the tarball captures
// a half-written CLI. Compiling into a private sandbox also means these tests
// never assert against a stale `dist` — `pnpm test:unit` does not build.
//
// The sandbox reproduces the two things the CLI walks up to find (see
// `src/templates.ts`, three levels above the module): `templates/` and the root
// `package.json`. Hence `<sandbox>/packages/cli/dist/index.js`.

const exec = promisify(execFile);
/** An ANSI colour escape — what "plain output" means, mechanically. */
// An ANSI colour escape, built rather than written as a literal: a control
// character inside a regex literal is a lint error (no-control-regex).
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[`);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let sandbox: string;
let cliBin: string;
let repo: string;

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

const runCli = async (cwd: string, args: string[]): Promise<CliRun> => {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cliBin, ...args], { cwd });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
};

/** The single line of a report that matches `pattern` — `undefined` if none does. */
const lineMatching = (text: string, pattern: RegExp): string | undefined =>
  text.split('\n').find((line) => pattern.test(line));

/** Every integer the summary line states, in order. */
const numbersIn = (line: string): number[] => (line.match(/\d+/g) ?? []).map(Number);

const sum = (numbers: number[]): number => numbers.reduce((total, n) => total + n, 0);

const abs = (rel: string): string => path.join(repo, ...rel.split('/'));

/** The rig as `init` leaves it: files installed, manifest written. */
const installRig = (): Promise<unknown> => initProject(repo, {});

/**
 * Give `.claude/settings.json` bytes nothing vouches for, which is what turns
 * it into a `wiring` action: hook wiring is handed over, never replaced.
 */
async function editTheHookWiring(): Promise<void> {
  const settings = abs('.claude/settings.json');
  const parsed = JSON.parse(await readFile(settings, 'utf8')) as Record<string, unknown>;
  parsed['env'] = { MINE: '1' };
  await writeFile(settings, `${JSON.stringify(parsed, null, 2)}\n`);
}

/** The plan the spawned CLI will compute for this repo, as ground truth. */
const groundTruth = (): Promise<UpgradePlan> => planUpgrade(repo);

beforeAll(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), 'caf-cli-report-build-'));
  const outDir = path.join(sandbox, 'packages', 'cli', 'dist');
  await mkdir(path.join(sandbox, 'packages', 'cli'), { recursive: true });
  await symlink(path.join(repoRoot, 'templates'), path.join(sandbox, 'templates'), 'dir');
  await copyFile(path.join(repoRoot, 'package.json'), path.join(sandbox, 'package.json'));
  await exec(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      '-p',
      path.join(repoRoot, 'packages', 'cli', 'tsconfig.build.json'),
      '--outDir',
      outDir,
    ],
    { cwd: repoRoot },
  );
  cliBin = path.join(outDir, 'index.js');
}, 120_000);

afterAll(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

beforeEach(async () => {
  // realpath: the child process reads `process.cwd()`, which on macOS resolves
  // /var → /private/var. Same path in both halves keeps the in-process plan and
  // the spawned CLI's plan comparable.
  repo = await realpath(await mkdtemp(path.join(tmpdir(), 'caf-cli-report-')));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('the upgrade plan header states what it knows, not what it infers', () => {
  it('does not tell a rig whose manifest was deleted that it predates 0.4.0', async () => {
    await installRig();
    // Proof the claim is false for this rig: it was installed by THIS version,
    // and this version writes a manifest — so 0.4.0 or later. Deleting the
    // manifest is exactly what forces the conservative matching path, and the
    // header cannot tell that rig from a genuinely old one.
    const installed = await readManifest(repo);
    const [major = 0, minor = 0] = (installed?.version ?? '0.0.0').split('.').map(Number);
    expect(
      major * 1000 + minor,
      'fixture: this rig is not newer than 0.4.0',
    ).toBeGreaterThanOrEqual(4);
    await rm(abs(MANIFEST_REL));

    const run = await runCli(repo, ['upgrade', '--dry-run']);
    expect(run.code, run.stderr).toBe(0);
    const line = lineMatching(run.stdout, /no manifest/i);
    expect(line, 'the plan printed no line about the missing manifest at all').toBeTruthy();
    // It may name "installed before 0.4.0" as one possibility; what it may not
    // do is state an age it has no evidence for.
    expect(line).not.toMatch(/\ba pre-0\.4\.0 rig\b/);
    // and it must cover the population it just met: the manifest was deleted
    expect(line).toMatch(/delet/i);
  });

  it('still says it is matching files against released versions', async () => {
    await installRig();
    await rm(abs(MANIFEST_REL));

    const run = await runCli(repo, ['upgrade', '--dry-run']);
    expect(run.code, run.stderr).toBe(0);
    const line = lineMatching(run.stdout, /no manifest/i);
    expect(line).toMatch(/matching files against released versions/);
  });
});

describe('--no-color is accepted wherever the help advertises it', () => {
  it('upgrade accepts --no-color and prints plain output', async () => {
    await installRig();

    const run = await runCli(repo, ['upgrade', '--dry-run', '--no-color']);
    expect(run.stderr).not.toMatch(/Unknown option/);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain('agent-rig upgrade');
    expect(run.stdout).not.toMatch(ANSI);
  });

  it('init accepts --no-color and prints plain output', async () => {
    await writeFile(abs('package.json'), '{"name":"host"}\n');

    const run = await runCli(repo, ['init', '--dry-run', '--no-color']);
    expect(run.stderr).not.toMatch(/Unknown option/);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain('agent-rig init');
    expect(run.stdout).not.toMatch(ANSI);
  });

  it.each(['upgrade', 'init'])(
    '%s still refuses a flag nothing advertises, with the usage',
    async (subcommand) => {
      await installRig();

      const run = await runCli(repo, [subcommand, '--dry-run', '--polish-my-shoes']);
      expect(run.code).toBe(1);
      expect(run.stderr).toMatch(/Unknown option/);
      expect(run.stderr).toContain('Usage: create-agent-rig');
    },
  );
});

describe('the plan summary accounts for every file it planned', () => {
  it('counts the hook wiring it handed over — it printed a line for it', async () => {
    await installRig();
    await editTheHookWiring();

    const plan = await groundTruth();
    expect(
      plan.actions.some((a) => a.verdict === 'wiring'),
      'fixture: no wiring action, so this test would pin nothing',
    ).toBe(true);
    // A `deleted` action is uncounted today for the same reason, and this test
    // is about the wiring one — keep the fixture free of the other case so a
    // failure here has exactly one cause.
    expect(
      plan.actions.some((a) => a.verdict === 'deleted'),
      'fixture: a deleted action would confound the count',
    ).toBe(false);

    const run = await runCli(repo, ['upgrade', '--dry-run']);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain('.claude/settings.json');
    const summary = lineMatching(run.stdout, /to replace/);
    expect(summary, 'the plan printed no summary line').toBeTruthy();
    expect(
      sum(numbersIn(summary ?? '')),
      `the summary accounts for fewer files than the plan has (${plan.actions.length}); ` +
        `the wiring hand-over printed above it is in none of its buckets`,
    ).toBe(plan.actions.length);
  });

  it('renders a plan with no wiring action exactly as it does today', async () => {
    await installRig();

    const plan = await groundTruth();
    expect(
      plan.actions.some((a) => a.verdict === 'wiring'),
      'fixture: a fresh rig should have nothing handed over',
    ).toBe(false);

    const run = await runCli(repo, ['upgrade', '--dry-run']);
    expect(run.code, run.stderr).toBe(0);
    const summary = lineMatching(run.stdout, /to replace/);
    // the four buckets, unchanged and in order: the fix for the wiring count is
    // additive, so a plan with nothing handed over reads exactly as before
    expect(summary).toMatch(
      /^ {2}\d+ to replace, \d+ new, \d+ yours \(kept\), \d+ already current$/,
    );
    expect(sum(numbersIn(summary ?? ''))).toBe(plan.actions.length);
  });
});
