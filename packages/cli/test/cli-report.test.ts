import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
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
import { AGENTS_MD_RESCUE, planUpgrade } from '../src/commands/upgrade.js';
import type { UpgradePlan } from '../src/commands/upgrade.js';
import { MANIFEST_REL, readManifest, sha256, writeManifest } from '../src/lib/manifest.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';

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
/**
 * An ANSI colour escape. ⚠ This is a weak check by construction: the spawned
 * child writes to a pipe and this CLI's palette is TTY-gated, so plain output
 * here is not evidence the flag was honoured. The load-bearing assertion in
 * both flag tests is the ABSENCE of "Unknown option".
 */
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

const runCli = async (cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<CliRun> => {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cliBin, ...args], {
      cwd,
      ...(env ? { env } : {}),
    });
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

/**
 * A stable, sorted, DEEP listing of every file and directory under `dir` —
 * the ground truth for "did this run touch the filesystem at all" (RP-239
 * A1, round 3). Used in place of a second run of the same command in the
 * same directory: the round-2 oracles ran the same argv with `--help`
 * dropped, in the SAME repo, as their "what would this have done" check —
 * exactly the shape the code-reviewer HOLD on PR #317 (r2) showed can itself
 * mutate state (`uninstall --json --yes --help` removed all 63 installed
 * files). A filesystem snapshot never runs the command under test twice.
 */
const snapshot = async (dir: string): Promise<string[]> =>
  (await readdir(dir, { recursive: true })).sort();

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

/**
 * Rewrites `rel` AND its manifest entry, so the rig "recognises" the new
 * bytes as its own — the same fixture idiom `upgrade.test.ts`'s
 * `pretendInstalled` uses, needed here to reach the RP-186 held-back
 * scenario: a fresh `installRig()` from THIS build already installs the new
 * shim/canonical split, so there is no other way to put CLAUDE.md back into
 * the pre-RP-186, "would become `update`" state this test needs.
 */
async function pretendInstalled(rel: string, content: string): Promise<void> {
  await writeFile(abs(rel), content);
  const manifest = await readManifest(repo);
  if (manifest === null) throw new Error('fixture: no manifest');
  manifest.files[rel] = sha256(content);
  await writeManifest(repo, manifest);
}

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
  await removeFixture(sandbox);
});

beforeEach(async () => {
  // realpath: the child process reads `process.cwd()`, which on macOS resolves
  // /var → /private/var. Same path in both halves keeps the in-process plan and
  // the spawned CLI's plan comparable.
  repo = await realpath(await mkdtemp(path.join(tmpdir(), 'caf-cli-report-')));
});

afterEach(async () => {
  await removeFixture(repo);
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
    const line = lineMatching(run.stdout, /manifest/i);
    expect(line, 'the plan printed no line about the missing manifest at all').toBeTruthy();
    // It may name "installed before 0.4.0" as one possibility; what it may not
    // do is state an age it has no evidence for.
    expect(line).not.toMatch(/\ba pre-0\.4\.0 rig\b/);
    // and it must not swap one false claim for another: `bootstrapped` is
    // `manifest === null`, which `readManifest` also returns for a manifest that
    // is PRESENT and unparseable — so a line asserting the file is absent is
    // false for that rig, exactly as an age claim is false for this one.
    expect(line).toMatch(/no readable manifest/i);
    // the causes are offered, none of them asserted
    expect(line).toMatch(/delet/i);
    expect(line).toMatch(/unparseable|unreadable/i);
  });

  it('says the same of a manifest that is present and unparseable', async () => {
    await installRig();
    // `parseManifest` voids this, so `readManifest` returns null and the run
    // takes the bootstrapped branch with the file still on disk. This is the
    // population the 0.5.0 notes single out, and the header may not tell it that
    // there is no manifest here.
    await writeFile(abs(MANIFEST_REL), '{"version":"0.5.0","files":\n');

    const run = await runCli(repo, ['upgrade', '--dry-run']);
    expect(run.code, run.stderr).toBe(0);
    const line = lineMatching(run.stdout, /manifest/i);
    expect(line, 'the plan printed no line about the manifest at all').toBeTruthy();
    expect(line).toMatch(/no readable manifest/i);
    expect(line).toMatch(/unparseable|unreadable/i);
    // the file is right there — the header may not claim otherwise
    expect(line).not.toMatch(/no manifest here/i);
  });

  it('still says it is matching files against released versions', async () => {
    await installRig();
    await rm(abs(MANIFEST_REL));

    const run = await runCli(repo, ['upgrade', '--dry-run']);
    expect(run.code, run.stderr).toBe(0);
    const line = lineMatching(run.stdout, /manifest/i);
    expect(line).toMatch(/matching files against released versions/);
  });

  // RP-180 round 4, blocker A(4): a bootstrapped run that inferred the
  // workflow layer from disk says so, and from how much evidence — never
  // silently. Round 3's plan had no such line at all.
  it('says the workflow layer was inferred from disk, and from how much of it, on a bootstrapped workflow rig', async () => {
    await initProject(repo, { withWorkflow: true });
    await rm(abs(MANIFEST_REL));

    const run = await runCli(repo, ['upgrade', '--dry-run']);
    expect(run.code, run.stderr).toBe(0);
    const line = lineMatching(run.stdout, /workflow layer inferred/i);
    expect(line, 'the plan printed no line about the inferred layer at all').toBeTruthy();
    expect(line).toMatch(/inferred from \d+ of \d+ files on disk/);
  });

  // The reverse: a Core-only rig with a single stray workflow-layer file,
  // bootstrapped, says the file was seen and left alone — never claims the
  // layer.
  it('says a stray workflow-layer file was seen and left below quorum, never adopted, on a bootstrapped Core-only rig', async () => {
    await installRig();
    await mkdir(path.dirname(abs('journal/README.md')), { recursive: true });
    await writeFile(abs('journal/README.md'), 'not a rig file\n');
    await rm(abs(MANIFEST_REL));

    const run = await runCli(repo, ['upgrade', '--dry-run']);
    expect(run.code, run.stderr).toBe(0);
    const line = lineMatching(run.stdout, /workflow-layer files found on disk/i);
    expect(line, 'the plan printed no line about the stray file at all').toBeTruthy();
    expect(line).toMatch(/below quorum/i);
    expect(line).not.toMatch(/inferred/i);
  });

  it.each([
    'retired.md\n  - forged destructive action',
    `retired.md${String.fromCharCode(27)}[2Jforged destructive action`,
    `retired.md\u202Eforged destructive action`,
    `retired.md\u2066forged destructive action\u2069`,
  ])('does not let a manifest file key forge the upgrade plan: %j', async (forgedRel) => {
    await installRig();
    const manifest = await readManifest(repo);
    expect(manifest, 'fixture: init did not write a readable manifest').not.toBeNull();
    const files = { ...manifest!.files, [forgedRel]: '0'.repeat(64) };
    await writeFile(abs(MANIFEST_REL), `${JSON.stringify({ ...manifest!, files }, null, 2)}\n`);

    const run = await runCli(repo, ['upgrade', '--dry-run']);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout, 'an unsafe manifest key reached the terminal verbatim').not.toContain(
      forgedRel,
    );
  });
});

// RP-206 item U5 / RP-202's own rule extended: the dry run must exit 1
// wherever the real run would refuse. RP-202 (#270) covered only the
// AGENTS.md.rig-new rescue path; the manifest itself has the identical
// disagreement. `readManifest` (planning) reads `.claude/.rig-manifest.json`
// with a plain `readFile`, which follows a symlink, so `--dry-run` prints a
// full plan and exits 0 for a symlinked manifest — while `applyUpgrade`'s
// preflight (`writableOnDisk` → `resolveWritableInside` in safe-path.ts)
// refuses the symlinked leaf before writing anything, exit 1.
describe('upgrade — a symlinked manifest refuses in both --dry-run and --yes', () => {
  it('a dry run exits 1 exactly where the real run refuses a symlinked manifest, and nothing on disk changes', async (context) => {
    const outside = await mkdtemp(path.join(tmpdir(), 'caf-cli-report-manifest-outside-'));
    try {
      await installRig();
      const manifestBytes = await readFile(abs(MANIFEST_REL), 'utf8');
      // A decoy carrying the SAME bytes as the real manifest: `readManifest`
      // reads straight through the symlink at plan time and sees a valid,
      // parseable manifest — the plan is not merely absent-manifest
      // bootstrapping, it is the ordinary case with an extra unsafe leaf.
      const decoy = path.join(outside, 'decoy-manifest.json');
      await writeFile(decoy, manifestBytes);
      await rm(abs(MANIFEST_REL));
      try {
        await symlink(decoy, abs(MANIFEST_REL), 'file');
      } catch {
        context.skip();
        return;
      }

      const repoBefore = (await readdir(repo)).sort();
      const claudeBefore = (await readdir(abs('.claude'))).sort();

      const dry = await runCli(repo, ['upgrade', '--dry-run']);
      // The exact refusal `applyUpgrade`'s preflight (`writableOnDisk`) gives
      // for this path — both modes must say the same thing, wherever it
      // lands (stdout for a dry-run notice, stderr for a thrown UpgradeError).
      expect(dry.stdout + dry.stderr).toContain(`Refusing to touch "${MANIFEST_REL}"`);
      expect(dry.code, dry.stderr).toBe(1);

      const repoAfter = (await readdir(repo)).sort();
      const claudeAfter = (await readdir(abs('.claude'))).sort();
      expect(repoAfter).toEqual(repoBefore);
      expect(claudeAfter).toEqual(claudeBefore);
      expect(await readFile(decoy, 'utf8')).toBe(manifestBytes);

      const real = await runCli(repo, ['upgrade', '--yes']);
      expect(real.code, real.stderr).toBe(1);
      expect(real.stdout + real.stderr).toContain(`Refusing to touch "${MANIFEST_REL}"`);
      expect(await readFile(decoy, 'utf8')).toBe(manifestBytes);
    } finally {
      await removeFixture(outside);
    }
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

describe('re-running init over a rig it owns', () => {
  it('does not call unchanged manifest-owned hook wiring unwired', async () => {
    await installRig();

    const run = await runCli(repo, ['init']);

    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain('Installed 0 files');
    expect(run.stdout).not.toMatch(/hooks are NOT wired/i);
    expect(run.stdout).not.toMatch(/nothing enforces the rules/i);
  });
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

  it('lists the two occasional buckets in the order the plan prints them', async () => {
    await installRig();
    await editTheHookWiring();
    // A file the rig installed and the user removed — the `deleted` verdict,
    // which no test covered until this one, and the second half of the pair the
    // ordering claim in `renderUpgradePlan` is about.
    await rm(abs('.claude/rules/workflow.md'));

    const plan = await groundTruth();
    expect(
      plan.actions.some((a) => a.verdict === 'wiring'),
      'fixture: no wiring action',
    ).toBe(true);
    expect(
      plan.actions.some((a) => a.verdict === 'deleted'),
      'fixture: no deleted action',
    ).toBe(true);

    const run = await runCli(repo, ['upgrade', '--dry-run']);
    expect(run.code, run.stderr).toBe(0);
    const summary = lineMatching(run.stdout, /to replace/);
    expect(summary, 'the plan printed no summary line').toBeTruthy();

    // Both present, and `deleted` before `wiring` — the only ordering the
    // comment at the call site claims. It deliberately does NOT claim the
    // summary follows the plan's whole order: the plan prints `deleted` before
    // `conflict` and the summary prints it after.
    const removed = (summary ?? '').indexOf('you removed');
    const wiring = (summary ?? '').indexOf('wiring handed over');
    expect(removed, 'the deleted bucket is missing from the summary').toBeGreaterThan(-1);
    expect(wiring, 'the wiring bucket is missing from the summary').toBeGreaterThan(-1);
    expect(removed).toBeLessThan(wiring);
    // and it still adds up with both of them in it
    expect(sum(numbersIn(summary ?? ''))).toBe(plan.actions.length);
  });

  // RP-180 round 5: run 1 (bootstrapped) declines to recreate 5 hand-deleted
  // workflow files and now RECORDS them as deleted; run 2 (an entirely
  // ordinary upgrade against the manifest run 1 just wrote) must report
  // ZERO new files and count all 5 as "you removed (left removed)" — never
  // silently proposing to restore an operator's deliberate deletion.
  it('a second, ordinary upgrade after a bootstrapped adoption reports 0 new and counts the hand-deleted files as removed', async () => {
    await initProject(repo, { withWorkflow: true });
    const handDeleted = [
      '.claude/scripts/queue/as-of.mjs',
      '.claude/scripts/queue/checkout.mjs',
      '.claude/scripts/revalidation-report.mjs',
      '.agents/skills/pr-ship/SKILL.md',
      '.claude/scripts/preflight.mjs',
    ];
    for (const rel of handDeleted) await rm(abs(rel));
    await rm(abs(MANIFEST_REL));

    const run1 = await runCli(repo, ['upgrade', '--yes']);
    expect(run1.code, run1.stderr).toBe(0);

    const run2 = await runCli(repo, ['upgrade', '--dry-run']);
    expect(run2.code, run2.stderr).toBe(0);
    for (const rel of handDeleted) {
      expect(run2.stdout, rel).toContain(rel);
      const line = lineMatching(run2.stdout, new RegExp(rel.replace(/[.]/g, '\\.')));
      expect(line, rel).toContain('installed by the rig, removed since — not restored');
    }
    const summary = lineMatching(run2.stdout, /to replace/);
    expect(summary, 'the plan printed no summary line').toBeTruthy();
    expect(summary).toMatch(/\b0 new\b/);
    expect(summary).toMatch(/5 you removed \(left removed\)/);
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

  // code-reviewer round 1 (PR #332) blocker 5: nothing exercised the CLI's
  // own rendering of a `seeded` verdict (RP-257) — the `=` mark on its own
  // line, and "N yours (seeded once)" in the summary (`MARK.seeded`, the
  // `seeded` entry in the `occasional` table, `index.ts`).
  it('renders the `=` mark and "yours (seeded once)" for an edited PLAN.md', async () => {
    await installRig();
    await writeFile(
      abs('PLAN.md'),
      `${await readFile(abs('PLAN.md'), 'utf8')}\n- add a GET /notes/:id route through every layer (TDD)\n`,
    );

    const plan = await groundTruth();
    expect(plan.actions.find((a) => a.rel === 'PLAN.md')?.verdict, 'fixture').toBe('seeded');

    const run = await runCli(repo, ['upgrade', '--dry-run']);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/^ {2}= PLAN\.md {2}— seeded once by the rig/m);
    const summary = lineMatching(run.stdout, /to replace/);
    expect(summary, 'the plan printed no summary line').toBeTruthy();
    expect(summary).toMatch(/\b1 yours \(seeded once\)/);
  });

  // PR #241 round 3 advisory: a held-back CLAUDE.md is `conflict` in verdict
  // name only — it is this release's OWN old content, re-vouched pending a
  // fix to AGENTS.md, not the user's bytes kept aside. Counting it under
  // "yours (kept)" would tell the reader the opposite of what happened.
  it('counts a held-back CLAUDE.md separately from "yours (kept)"', async () => {
    await installRig();
    const preRp186Text = [
      '# __PROJECT_NAME__',
      '',
      '## One operating system, two harnesses',
      '',
      'Old shared rulebook text.',
      '',
      '```elevated-paths',
      '.claude/',
      '```',
      '',
    ].join('\n');
    await pretendInstalled('CLAUDE.md', preRp186Text);
    await writeFile(abs('AGENTS.md'), '# not the rulebook at all\n');

    const run = await runCli(repo, ['upgrade', '--dry-run']);
    expect(run.code, run.stderr).toBe(0);
    const summary = lineMatching(run.stdout, /to replace/);
    expect(summary, 'the plan printed no summary line').toBeTruthy();
    expect(summary).toMatch(/1 held back \(see reason above\)/);
    // AGENTS.md's own conflict is the only ordinary "yours (kept)" here —
    // CLAUDE.md must not inflate that count.
    expect(summary).toMatch(/\b1 yours \(kept\)/);
  });
});

// PR #241 round 4, blocker 1 (code, security, CLI-UX): the previous remedy for
// an unresolved AGENTS.md printed the rendered content to stdout and asked a
// human to paste it back verbatim — measured, by all three lenses independently,
// to not actually be pasteable. The fix writes the rendered bytes to a real
// sibling file (`AGENTS_MD_RESCUE`) instead, and these tests exercise it AT
// THE CLI BOUNDARY (the spawned, built binary) rather than through
// `plan.contents`, which is exactly the map the previous test of "the remedy
// works" trusted circularly.
//
// Round 5 design ruling: the rescue file exists ONLY in the GENUINELY
// held-back state — absent AGENTS.md, or one with no readable
// `elevated-paths` block. A fresh `installRig()` already has CLAUDE.md AS
// the shim (verdict `unchanged`), so merely breaking AGENTS.md's CONTENT
// does not by itself reach the held-back state any more (round 4's own bug,
// gate cycle 4 blocker 1) — every genuinely-held-back test below also
// simulates a pre-migration, still-pristine CLAUDE.md
// (`pretendInstalled('CLAUDE.md', PRE_RP186_TEXT)`), the same fixture idiom
// `upgrade.test.ts` uses for the identical reason.
describe('AGENTS.md.rig-new — the CLI-boundary remedy for a GENUINELY held-back AGENTS.md', () => {
  const PRE_RP186_TEXT = [
    '# __PROJECT_NAME__',
    '',
    '## One operating system, two harnesses',
    '',
    'Old shared rulebook text.',
    '',
    '```elevated-paths',
    '.claude/',
    '```',
    '',
  ].join('\n');

  /** Puts AGENTS.md into `conflict`, with NO readable rulebook content. */
  async function breakAgentsMd(): Promise<void> {
    await writeFile(abs('AGENTS.md'), '# not the rulebook at all\n');
  }

  /** The genuinely held-back precondition: see the file-level comment above. */
  async function makeClaudePristine(): Promise<void> {
    await pretendInstalled('CLAUDE.md', PRE_RP186_TEXT);
  }

  const sha256Hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

  it('the rescue file is byte-identical to an independently-rendered AGENTS.md for the same project — not `plan.contents`', async () => {
    await installRig();
    await makeClaudePristine();
    await breakAgentsMd();

    const run = await runCli(repo, ['upgrade', '--yes']);
    expect(run.code, run.stderr).toBe(0);

    const rescueBytes = await readFile(abs(AGENTS_MD_RESCUE));
    const rescueHash = sha256Hex(rescueBytes);

    // Independent oracle: a SEPARATE `initProject` call, into a SEPARATE
    // directory, forced to the same project name — a different code path
    // than `applyUpgrade`'s `plan.contents` map, computed fresh here rather
    // than trusted from the run under test.
    const projectName = (await readManifest(repo))!.project.name;
    const oracleDir = await mkdtemp(path.join(tmpdir(), 'caf-agents-oracle-'));
    try {
      await initProject(oracleDir, {
        project: { name: projectName, scope: projectName, region: '' },
      });
      const oracleHash = sha256Hex(await readFile(path.join(oracleDir, 'AGENTS.md')));
      expect(rescueHash).toBe(oracleHash);
    } finally {
      await removeFixture(oracleDir);
    }
  });

  it('moving the rescue file over AGENTS.md and re-running upgrade finishes the migration', async () => {
    await installRig();
    await makeClaudePristine();
    await breakAgentsMd();

    const run1 = await runCli(repo, ['upgrade', '--yes']);
    expect(run1.code, run1.stderr).toBe(0);
    await expect(readFile(abs(AGENTS_MD_RESCUE))).resolves.toBeTruthy();

    await rename(abs(AGENTS_MD_RESCUE), abs('AGENTS.md'));

    const run2 = await runCli(repo, ['upgrade', '--yes']);
    expect(run2.code, run2.stderr).toBe(0);

    // The exact first-line contract a shim must meet (round 3's own fix),
    // not a re-implementation of it.
    const claudeMd = await readFile(abs('CLAUDE.md'), 'utf8');
    expect(claudeMd.split(/\r?\n/, 1)[0]).toBe('@AGENTS.md');
    await expect(readFile(abs(AGENTS_MD_RESCUE))).rejects.toThrow();
    // Round 5 advisory: a positive completion line on the run that actually
    // adopts the shim.
    expect(run2.stdout).toContain('CLAUDE.md now imports AGENTS.md.');
  });

  it('a dry run writes no rescue file at all, and says a real run would', async () => {
    await installRig();
    await makeClaudePristine();
    await breakAgentsMd();
    const before = (await readdir(repo)).sort();

    const run = await runCli(repo, ['upgrade', '--dry-run']);
    expect(run.code, run.stderr).toBe(0);

    const after = (await readdir(repo)).sort();
    expect(after).toEqual(before);
    expect(run.stdout).toMatch(/will write/i);
    expect(run.stdout).toContain(AGENTS_MD_RESCUE);
  });

  // RP-192 item 9: the dry run said "a real run refuses" and still exited 0,
  // so a script gating on `upgrade --dry-run` was told the run would succeed.
  it('a dry run exits 1 exactly where the real run refuses an unsafe rescue path', async () => {
    await installRig();
    await makeClaudePristine();
    await breakAgentsMd();
    await mkdir(abs(AGENTS_MD_RESCUE));

    const dry = await runCli(repo, ['upgrade', '--dry-run']);
    expect(dry.stdout).toContain('A real run refuses to touch it rather than write through it.');
    expect(dry.code, dry.stderr).toBe(1);
    const real = await runCli(repo, ['upgrade', '--yes']);
    expect(real.code, real.stderr).toBe(1);
  });

  it('never overwrites a pre-existing AGENTS.md.rig-new that differs from the rendered bytes, and NEVER prints `mv` for it', async () => {
    await installRig();
    await makeClaudePristine();
    await breakAgentsMd();
    // A hostile pre-planted rescue file — measured (gate cycle 4, blocker
    // 2): the previous rule printed `mv` for this anyway, which installs
    // whatever is here as the live rulebook the moment it is followed.
    await writeFile(
      abs(AGENTS_MD_RESCUE),
      '# hostile\n\n```elevated-paths\n```\n', // "Everything is Tier 0"
    );

    const run = await runCli(repo, ['upgrade', '--yes']);
    expect(run.code, run.stderr).toBe(0);
    expect(await readFile(abs(AGENTS_MD_RESCUE), 'utf8')).toBe(
      '# hostile\n\n```elevated-paths\n```\n',
    );
    expect(run.stdout).toMatch(/already exists with content that is NOT this run's rendering/i);
    expect(run.stdout).not.toContain(`mv ${AGENTS_MD_RESCUE}`);
    expect(run.stdout).toContain(`rm ${AGENTS_MD_RESCUE}`);
  });

  it('stdout never quotes the rulebook, and its last non-empty lines are the concrete remedy', async () => {
    await installRig();
    await makeClaudePristine();
    await breakAgentsMd();

    const run = await runCli(repo, ['upgrade', '--yes']);
    expect(run.code, run.stderr).toBe(0);
    // Short: the previous remedy's rendered-content dump is gone entirely.
    expect(run.stdout).not.toContain('## One operating system, two harnesses');
    expect(run.stdout).not.toContain('```elevated-paths');

    const nonEmpty = run.stdout
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
    expect(nonEmpty.slice(-2)).toEqual([
      `  mv ${AGENTS_MD_RESCUE} AGENTS.md`,
      '  create-agent-rig upgrade',
    ]);
    // And it says outright that the migration is not finished — never a bare
    // "Wrote N files." that reads as success.
    expect(run.stdout).toMatch(/migration is NOT finished/);
  });

  it('also names the held-back CLAUDE.md consequence when a pristine CLAUDE.md is held back', async () => {
    await installRig();
    await makeClaudePristine();
    await breakAgentsMd();

    const run = await runCli(repo, ['upgrade', '--yes']);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/CLAUDE\.md is held back/);
    expect(run.stdout).toMatch(/shimming it now would/);
    const nonEmpty = run.stdout
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
    expect(nonEmpty.slice(-2)).toEqual([
      `  mv ${AGENTS_MD_RESCUE} AGENTS.md`,
      '  create-agent-rig upgrade',
    ]);
  });

  it('once AGENTS.md resolves, a leftover matching rescue file is cleaned up and reported', async () => {
    await installRig();
    await makeClaudePristine();
    await breakAgentsMd();
    const run1 = await runCli(repo, ['upgrade', '--yes']);
    expect(run1.code, run1.stderr).toBe(0);

    // COPY, not move: AGENTS.md is resolved the same way a user following the
    // instruction would, but the rescue file is deliberately left behind too
    // — the leftover this test is about. A `rename` here would remove it
    // itself, leaving nothing for the next `upgrade` to clean up.
    await copyFile(abs(AGENTS_MD_RESCUE), abs('AGENTS.md'));

    const run2 = await runCli(repo, ['upgrade', '--yes']);
    expect(run2.code, run2.stderr).toBe(0);
    await expect(readFile(abs(AGENTS_MD_RESCUE))).rejects.toThrow();
    expect(run2.stdout).toMatch(/Removed a leftover/);
  });

  // Round 5, blocker 3: refused BEFORE any other write, exit 1, a clean
  // payload message (never a stack trace), and — the load-bearing assertion
  // gate cycle 4 asked for — ZERO files changed and the manifest untouched,
  // hashed before and after.
  it('a symlinked AGENTS.md.rig-new in the held-back state: exit 1, a clean message, zero files changed', async (context) => {
    const outside = await mkdtemp(path.join(tmpdir(), 'caf-cli-report-outside-'));
    try {
      const target = path.join(outside, 'outside.md');
      await writeFile(target, 'OUTSIDE BYTES\n');
      await installRig();
      await makeClaudePristine();
      await breakAgentsMd();
      try {
        await symlink(target, abs(AGENTS_MD_RESCUE), 'file');
      } catch {
        context.skip();
        return;
      }
      const manifestBefore = await readFile(abs(MANIFEST_REL), 'utf8');
      const claudeMdBefore = await readFile(abs('CLAUDE.md'), 'utf8');

      const run = await runCli(repo, ['upgrade', '--yes']);
      expect(run.code).toBe(1);
      expect(run.stderr).not.toContain('at '); // no stack trace frame
      expect(run.stderr.toLowerCase()).toMatch(/not a plain file|refus/);

      expect(await readFile(target, 'utf8')).toBe('OUTSIDE BYTES\n');
      expect(await readFile(abs('CLAUDE.md'), 'utf8')).toBe(claudeMdBefore);
      expect(await readFile(abs(MANIFEST_REL), 'utf8')).toBe(manifestBefore);
    } finally {
      await removeFixture(outside);
    }
  });

  it('a directory at AGENTS.md.rig-new in the held-back state: exit 1, a clean message, no EISDIR crash', async () => {
    await installRig();
    await makeClaudePristine();
    await breakAgentsMd();
    await mkdir(abs(AGENTS_MD_RESCUE));
    const manifestBefore = await readFile(abs(MANIFEST_REL), 'utf8');

    const run = await runCli(repo, ['upgrade', '--yes']);
    expect(run.code).toBe(1);
    expect(run.stderr).not.toContain('EISDIR');
    expect(run.stderr).not.toContain('at '); // no stack trace frame
    expect(await readFile(abs(MANIFEST_REL), 'utf8')).toBe(manifestBefore);
  });
});

// Round 5, blocker 1/2: the central case the round-5 ruling exists for — a
// CUSTOMISED AGENTS.md that still carries a readable `elevated-paths` block
// is the shipped rulebook's own designed steady state (extend the block for
// your own paths), not a broken rulebook. It must be QUIET: the ordinary
// `! AGENTS.md — edited since it was installed` line and nothing else.
describe('a customised-but-readable AGENTS.md conflict is QUIET — no rescue file, no "migration" wording (round 5)', () => {
  it('fresh init, then a path line added to elevated-paths: upgrade --yes is silent about it, exit 0, AGENTS.md unchanged', async () => {
    await installRig();
    const original = await readFile(abs('AGENTS.md'), 'utf8');
    const customised = original.replace(
      '```elevated-paths\n',
      '```elevated-paths\nmy-own-service/\n',
    );
    expect(customised).not.toBe(original); // fixture sanity: the edit landed
    await writeFile(abs('AGENTS.md'), customised);
    const before = (await readdir(repo)).sort();

    const run = await runCli(repo, ['upgrade', '--yes']);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).not.toMatch(/migration/i);
    expect(run.stdout).not.toContain(AGENTS_MD_RESCUE);
    expect((await readdir(repo)).sort()).toEqual(before);
    expect(await readFile(abs('AGENTS.md'), 'utf8')).toBe(customised);
    // The one line this DOES earn — the ordinary, generic conflict line
    // every other kept file gets, nothing AGENTS.md-specific.
    const line = lineMatching(run.stdout, /AGENTS\.md/);
    expect(line).toMatch(/edited since it was installed/);
  });
});

// RP-239 (onboarding-friction triage, comment 20140), finding A1: no
// subcommand accepts `--help` today — each one falls through to whatever
// that subcommand does with an argument it does not recognise (a
// `parseArgs` failure, a usage exit, or — for `setup` — the interactive
// wizard's non-interactive refusal). Desired: `<cmd> --help` prints that
// subcommand's own usage to stdout and exits 0, the same way the top-level
// `--help`/`-h` already does (`main()`'s `values.help` branch in
// src/index.ts) — never running the command, never touching the
// filesystem, and never falling into the setup wizard.
describe('`--help` on a subcommand (RP-239 A1)', () => {
  // Each assertion below is expected to fail against today's build, for the
  // reason the finding names for that subcommand: `init`/`upgrade` treat
  // `--help` as an unrecognised `parseArgs` option (exit 1, "Unknown
  // option"); `uninstall` the same, with node's own suggestion to place it
  // after `--` since positionals are allowed there; `doctor` exits 2 with
  // "doctor accepts only --json"; `memory` exits 2 with "memory needs a
  // verb" (`--help` is not `doctor`/`load`); `setup` falls into the
  // wizard's non-interactive refusal, exit 1, because a verb starting with
  // `-` that is not `--memory-root` routes there today.
  it('init --help prints usage to stdout, exits 0, and writes nothing', async () => {
    const before = (await readdir(repo)).sort();

    const run = await runCli(repo, ['init', '--help']);

    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).not.toMatch(/Unknown option/);
    expect(run.stdout).toContain('create-agent-rig init [--dry-run] [--layer workflow]');
    expect((await readdir(repo)).sort()).toEqual(before);
  });

  it('upgrade --help prints usage to stdout, exits 0, and touches nothing', async () => {
    await installRig();
    const manifestBefore = await readFile(abs(MANIFEST_REL), 'utf8');
    const before = (await readdir(repo)).sort();

    const run = await runCli(repo, ['upgrade', '--help']);

    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).not.toMatch(/Unknown option/);
    expect(run.stdout).toContain('create-agent-rig upgrade [--dry-run] [--yes]');
    expect((await readdir(repo)).sort()).toEqual(before);
    expect(await readFile(abs(MANIFEST_REL), 'utf8')).toBe(manifestBefore);
  });

  it('uninstall --help prints usage to stdout, exits 0, and removes nothing', async () => {
    await installRig();
    const manifestBefore = await readFile(abs(MANIFEST_REL), 'utf8');
    const before = (await readdir(repo)).sort();

    const run = await runCli(repo, ['uninstall', '--help']);

    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).not.toMatch(/Unknown option/);
    expect(run.stdout).toContain(
      'create-agent-rig uninstall [dir] [--dry-run] [--yes] [--detach] [--json]',
    );
    expect((await readdir(repo)).sort()).toEqual(before);
    expect(await readFile(abs(MANIFEST_REL), 'utf8')).toBe(manifestBefore);
  });

  // RP-260 round 2, code-reviewer round-1 blocker: a run whose only preserved
  // path is one `init` kept (a user-owned file, `manifest.kept`) now removes
  // the manifest and reports "uninstalled" — production already does this
  // (`uninstall.ts`'s manifest-removal check excludes `kept: true` actions).
  // The help text had not caught up: it still claimed an unconditional gate
  // ("nothing was preserved") and never named the kept-by-init exception.
  it('uninstall --help no longer claims the manifest survives whenever anything was preserved', async () => {
    const run = await runCli(repo, ['uninstall', '--help']);

    expect(run.code, run.stderr).toBe(0);
    // the old, now-false claim: removal gated on an unconditional "nothing
    // was preserved" — true of every preserved reason, including kept-by-init
    expect(run.stdout).not.toMatch(/succeeded AND nothing was\s+preserved/);
  });

  it('uninstall --help states a user-owned file init kept does not hold the manifest', async () => {
    const run = await runCli(repo, ['uninstall', '--help']);

    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toMatch(
      /kept by init[\s\S]{0,120}(does not|doesn't|never)\s+(hold|keep)s?\s+the manifest/i,
    );
  });

  it('doctor --help prints usage to stdout and exits 0, never the "accepts only --json" refusal', async () => {
    const run = await runCli(repo, ['doctor', '--help']);

    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).not.toContain('doctor accepts only --json');
    expect(run.stdout).toContain('create-agent-rig doctor [--json]');
  });

  it('memory --help prints usage to stdout and exits 0, never "memory needs a verb"', async () => {
    const run = await runCli(repo, ['memory', '--help']);

    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).not.toMatch(/memory needs a verb/);
    expect(run.stdout).toContain('create-agent-rig memory <doctor|load> [args…]');
  });

  it('setup --help prints usage to stdout and exits 0, never entering the interactive wizard', async () => {
    const run = await runCli(repo, ['setup', '--help']);

    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).not.toContain('setup-wizard-requires-an-interactive-terminal');
    expect(run.stdout).toContain('Choose a provider and harness interactively');
  });
});

// RP-239, finding A5: `upgrade`'s "new version" line for a conflicted file
// prints `action.templatePath` — an ABSOLUTE path on the machine that ran
// the CLI (an npx-cache path such as `~/.npm/_npx/<hash>/…` in the field,
// this sandbox's own build root here). Desired: name the package version
// (`create-agent-rig@<version>`) and the path INSIDE the package
// (`templates/agent-os/universal/<rel>`), never the host filesystem path.
describe('a conflict names the package, never a filesystem cache path (RP-239 A5)', () => {
  it('the "new version" line names create-agent-rig@<version> and the in-package template path', async () => {
    await installRig();
    const rel = '.claude/rules/workflow.md';
    const edited = `${await readFile(abs(rel), 'utf8')} `;
    await writeFile(abs(rel), edited);

    const run = await runCli(repo, ['upgrade', '--dry-run']);
    expect(run.code, run.stderr).toBe(0);
    const line = lineMatching(run.stdout, /new version:/);
    expect(line, 'fixture: no conflict action printed a "new version" line').toBeTruthy();

    const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(line).toContain(`create-agent-rig@${pkg.version}`);
    expect(line).toContain(
      ['templates', 'agent-os', 'universal', '.claude', 'rules', 'workflow.md'].join('/'),
    );
    // Never the absolute path on the machine that built/ran this CLI —
    // `sandbox` stands in here for what an npx cache path is in the field.
    expect(line).not.toContain(sandbox);
  });
});

// RP-239, finding A6: `applyUpgrade` always rewrites the manifest
// (`upgrade.ts`, `await writeManifest(repoDir, plan.manifest)`, unconditional),
// but a run that replaced zero files says only "Wrote 0 files." — read as
// "nothing happened at all". Desired: the same line also reflects the
// manifest write, WITHOUT dropping the exact substring
// `test/e2e/agents-md-migration.test.ts` pins ("a legacy rig whose
// AGENTS.md was customised … a second run is a no-op" › `toContain('Wrote
// 0 files.')`).
describe('a no-op upgrade still reports the manifest write (RP-239 A6)', () => {
  it('a fresh install immediately re-upgraded: "Wrote 0 files." names the manifest write on the same line', async () => {
    await installRig();

    const run = await runCli(repo, ['upgrade', '--yes']);

    expect(run.code, run.stderr).toBe(0);
    // The pinned substring — never remove or reword this part of the line.
    expect(run.stdout).toContain('Wrote 0 files.');
    // But the same line must say the manifest was rewritten, not leave a
    // reader thinking this run did nothing at all.
    expect(run.stdout).toMatch(/Wrote 0 files\.[^\n]*manifest/i);
  });
});

// RP-239 A1, round 3 (code-reviewer HOLD on PR #317, r2): round 2's
// `stripHelpIfJson` dropped `--help`/`-h` from the args a subcommand's own
// parsing ever saw whenever `--json` was present, so the command ran exactly
// as if `--help` had never been typed — on `uninstall --json --yes --help`,
// against an INSTALLED rig, that meant a real, consented removal: every one
// of the 63 installed files gone (base 1.0.1, with no help-awareness at all,
// refused the same argv outright; round 1's own stripping-free build removed
// nothing either — round 2 is the one build in this sequence that deletes).
// `setup add <id> --json --yes --help` reaches the identical shape: stripped
// down to `setup add <id> --json --yes`, it is a fully consented apply.
//
// Loop decision: `--help`/`-h` never causes a command to execute. Once
// `--json` is among a subcommand's arguments, the help flag is answered
// differently — it is NEITHER stripped NOR short-circuited. The command
// parses its ENTIRE, unmodified argument list exactly as it would with no
// help-awareness in the picture at all — i.e. exactly as released 1.0.1
// parsed that same argv, before this PR existed. For `init`/`upgrade`, which
// never declared a `--json` option, that argv fails `parseArgs` outright
// (an unrecognised option) precisely because `--json` itself is unrecognised
// there — `--help` never gets a chance to be the thing that fails.
// `uninstall` does declare `--json`, so there `--help` alone is the
// unrecognised option, same refusal shape. `setup`'s dispatch reaches its own
// per-verb `--json`-aware refusal (the wizard's non-interactive refusal for
// the bare form, `runIntegrationsCommand`'s own parse-refusal for `add`).
// `doctor` already refuses any option it does not know, which `-h` is.
// Without `--json` present at all, round 1's short-circuit is unaffected:
// usage prose, exit 0, nothing touched — pinned above, in "`--help` on a
// subcommand (RP-239 A1)".
//
// Each test below never re-runs the command under test in the SAME
// directory to build its expectation — that is exactly the shape that hid
// round 2's bug (an independent "with --help dropped" run in the same repo
// silently performed the destructive act the assertions then measured as
// "answered with JSON"). The oracle here is filesystem state captured
// BEFORE the run under test, plus the shape of `stdout` alone.
describe('`--json` present: `--help`/`-h` is inert — never stripped, never short-circuited (RP-239 A1, round 3)', () => {
  /**
   * `docs/command-contract.md`'s Output rule ("Under --json, stdout carries
   * exactly one JSON object and nothing else") allows for a refusal that
   * never reaches JSON-payload construction at all (a raw `parseArgs`
   * throw, handled before the command's own `json` flag is even read) to
   * print nothing on stdout instead — the usage/error prose for such a
   * refusal goes to stderr in every command below. Either shape is
   * acceptable here; usage PROSE on stdout is not.
   */
  const stdoutIsEmptyOrOneJsonObject = (stdout: string): boolean => {
    if (stdout.trim() === '') return true;
    try {
      return JSON.stringify(JSON.parse(stdout.trim())) === stdout.trim();
    } catch {
      return false;
    }
  };

  it('uninstall --json --yes --help leaves every installed file in place, never removes anything, and prints no usage prose to stdout', async () => {
    const configHome = await mkdtemp(path.join(tmpdir(), 'caf-cli-report-uninstall-help-'));
    try {
      await installRig();
      const manifestBefore = await readFile(abs(MANIFEST_REL), 'utf8');
      const before = await snapshot(repo);

      const run = await runCli(repo, ['uninstall', '--json', '--yes', '--help'], {
        ...process.env,
        HOME: configHome,
        APPDATA: configHome,
      });

      expect(run.code, JSON.stringify({ stdout: run.stdout, stderr: run.stderr })).not.toBe(0);
      expect(
        stdoutIsEmptyOrOneJsonObject(run.stdout),
        `stdout was neither empty nor one JSON object: ${JSON.stringify(run.stdout)}`,
      ).toBe(true);
      expect(run.stdout).not.toContain('Usage: create-agent-rig');
      expect(run.stdout).not.toContain('agent-rig uninstall');
      // The load-bearing assertion: nothing on disk moved at all.
      expect(await snapshot(repo)).toEqual(before);
      expect(await readFile(abs(MANIFEST_REL), 'utf8')).toBe(manifestBefore);
    } finally {
      await removeFixture(configHome);
    }
  });

  it('setup add <id> --json --yes --help writes no wiring at all, and never answers as a completed apply', async () => {
    // figma-mcp: the id integrations-cli.test.ts already exercises for `setup add`.
    const before = await snapshot(repo);

    const run = await runCli(repo, ['setup', 'add', 'figma-mcp', '--json', '--yes', '--help']);

    expect(run.code, JSON.stringify({ stdout: run.stdout, stderr: run.stderr })).not.toBe(0);
    expect(
      stdoutIsEmptyOrOneJsonObject(run.stdout),
      `stdout was neither empty nor one JSON object: ${JSON.stringify(run.stdout)}`,
    ).toBe(true);
    // Never the shape a completed, applied `add` answers with.
    if (run.stdout.trim() !== '') {
      expect(JSON.parse(run.stdout)).not.toMatchObject({ outcome: 'written' });
    }
    // Neither file `setup add figma-mcp --yes --json` (no --help) writes —
    // see integrations-cli.test.ts's "applies then removes an owned
    // integration through the built CLI" — exists here at all.
    await expect(readFile(abs('.rig/integrations.json'), 'utf8')).rejects.toThrow();
    await expect(readFile(abs('.mcp.json'), 'utf8')).rejects.toThrow();
    expect(await snapshot(repo)).toEqual(before);
  });

  it('init --json --help writes nothing into an empty directory', async () => {
    const before = await snapshot(repo);

    const run = await runCli(repo, ['init', '--json', '--help']);

    expect(run.code, JSON.stringify({ stdout: run.stdout, stderr: run.stderr })).not.toBe(0);
    // Never round 1's usage text (pinned above, in "init --help prints usage
    // to stdout" — that pin is for `--help` WITHOUT `--json`).
    expect(run.stdout).not.toContain('create-agent-rig init [--dry-run] [--layer workflow]');
    expect(await snapshot(repo)).toEqual(before);
  });

  it('upgrade --json --help on an installed rig touches nothing — the manifest is byte-identical afterward', async () => {
    await installRig();
    const manifestBefore = await readFile(abs(MANIFEST_REL), 'utf8');
    const before = await snapshot(repo);

    const run = await runCli(repo, ['upgrade', '--json', '--help']);

    expect(run.code, JSON.stringify({ stdout: run.stdout, stderr: run.stderr })).not.toBe(0);
    expect(run.stdout).not.toContain('create-agent-rig upgrade [--dry-run] [--yes]');
    expect(await readFile(abs(MANIFEST_REL), 'utf8')).toBe(manifestBefore);
    expect(await snapshot(repo)).toEqual(before);
  });

  it('doctor --json -h answers with JSON or nothing, never the usage text', async () => {
    const run = await runCli(repo, ['doctor', '--json', '-h']);

    expect(run.code, JSON.stringify({ stdout: run.stdout, stderr: run.stderr })).not.toBe(0);
    expect(
      stdoutIsEmptyOrOneJsonObject(run.stdout),
      `stdout was neither empty nor one JSON object: ${JSON.stringify(run.stdout)}`,
    ).toBe(true);
    expect(run.stdout).not.toContain('create-agent-rig doctor [--json]');
  });

  it('setup --json --help answers with JSON or nothing, never the interactive-wizard usage text', async () => {
    const run = await runCli(repo, ['setup', '--json', '--help']);

    expect(run.code, JSON.stringify({ stdout: run.stdout, stderr: run.stderr })).not.toBe(0);
    expect(
      stdoutIsEmptyOrOneJsonObject(run.stdout),
      `stdout was neither empty nor one JSON object: ${JSON.stringify(run.stdout)}`,
    ).toBe(true);
    expect(run.stdout).not.toContain('Choose a provider and harness interactively');
  });
});

// RP-239 A1, round 2 — the second HOLD blocker: `memory` checked the WHOLE
// argv for `--help`/`-h`, so it intercepted `memory load --help` too, never
// letting it reach Memory. Loop decision: only a bare `memory --help`/`-h`
// with NO verb (the help flag is the first argument after `memory`) prints
// the rig's own usage; a help flag anywhere after a verb passes through to
// Memory verbatim, exactly as it did before this PR.
describe('`memory <verb> --help` passes through to Memory, not the rig usage (RP-239 A1, round 2)', () => {
  it('memory load --help does not print the rig usage, and reaches the Memory passthrough path', async () => {
    // Isolated from whatever subsystems manifest this host actually has — the
    // same envFor(tmp) idiom memory.test.ts uses, so "no manifest installed"
    // is guaranteed by the fixture rather than incidental to this machine.
    const configHome = await mkdtemp(path.join(tmpdir(), 'caf-cli-report-memory-'));
    try {
      const run = await runCli(repo, ['memory', 'load', '--help'], {
        ...process.env,
        HOME: configHome,
        APPDATA: configHome,
      });

      // Never the rig's own subcommand usage line (pinned above, in
      // "`--help` on a subcommand (RP-239 A1)" › "memory --help …").
      expect(run.stdout).not.toContain('create-agent-rig memory <doctor|load> [args…]');
      // The exact, hermetic "no manifest on this machine" answer `runMemory`
      // gives — the same payload memory.test.ts's own "reports
      // unsupported/absent and never spawns Memory when this machine has no
      // manifest" fixture pins — reachable only if `--help` passed through
      // to Memory's own dispatch (the manifest gate, which runs before any
      // verb-specific handling) instead of being intercepted by the rig.
      expect(run.code, run.stderr).toBe(0);
      expect(run.stdout).toBe(
        `${JSON.stringify({ schemaVersion: 1, result: 'unsupported', reason: 'absent' })}\n`,
      );
    } finally {
      await removeFixture(configHome);
    }
  });
});
