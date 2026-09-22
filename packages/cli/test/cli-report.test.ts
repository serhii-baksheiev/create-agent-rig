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
