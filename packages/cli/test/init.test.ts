import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import {
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InitError,
  initManifest,
  initProject,
  planInit,
  projectNameFor,
} from '../src/commands/init.js';
import { applyUpgrade, planUpgrade } from '../src/commands/upgrade.js';
import type { HashHistory } from '../src/lib/history.js';
import { readManifest, sha256, writeManifest } from '../src/lib/manifest.js';
import { fifosAvailable, skipUnless, symlinksAvailable } from '../../../test/helpers/env.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';
import { REGION_BEGIN } from '../../../test/helpers/agents-md-region.js';

const emptyHistory: HashHistory = { versions: [], files: {} };

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-init-'));
});

afterEach(async () => {
  await removeFixture(repo);
});

describe('planInit — the dry-run plan (never writes)', () => {
  it('lists only the PROCESS layer, never architecture rules', async () => {
    const plan = await planInit(repo);
    const files = plan.files.map((f) => f.path);
    expect(files).toContain('.claude/rules/workflow.md');
    expect(files).toContain('.claude/rules/autonomy.md');
    // architecture assumes packages/core etc. — must NOT be installed into an
    // arbitrary existing repo
    expect(files).not.toContain('.claude/rules/architecture.md');
    expect(files.some((f) => f.includes('guard-core-purity'))).toBe(false);
    expect(files.some((f) => f.includes('guard-web-boundary'))).toBe(false);
    // process hooks travel fine
    expect(files.some((f) => f.includes('gate-stop-dod'))).toBe(true);
  });

  it('writes nothing', async () => {
    await planInit(repo);
    await expect(readFile(path.join(repo, '.claude', 'rules', 'workflow.md'))).rejects.toThrow();
  });

  it('flags an existing CLAUDE.md as a conflict, not a silent overwrite', async () => {
    await writeFile(path.join(repo, 'CLAUDE.md'), '# my rules');
    const plan = await planInit(repo);
    expect(plan.conflicts).toContain('CLAUDE.md');
  });
});

describe('initProject — the install', () => {
  it('installs the process layer into an existing repo', async () => {
    await writeFile(path.join(repo, 'package.json'), '{"name":"existing"}');
    const result = await initProject(repo, {});
    expect(result.written.length).toBeGreaterThan(0);
    expect(await readFile(path.join(repo, '.claude', 'rules', 'workflow.md'), 'utf8')).toContain(
      'TDD',
    );
    // RP-186: AGENTS.md is the canonical rulebook, CLAUDE.md a short shim
    // that imports it — they are no longer byte-identical.
    const agentsMdInstalled = await readFile(path.join(repo, 'AGENTS.md'), 'utf8');
    const claudeMdInstalled = await readFile(path.join(repo, 'CLAUDE.md'), 'utf8');
    expect(agentsMdInstalled).toContain('## One operating system, two harnesses');
    expect(claudeMdInstalled.trimStart().startsWith('@AGENTS.md')).toBe(true);
    expect(claudeMdInstalled).not.toContain('## One operating system, two harnesses');
    await expect(
      readFile(path.join(repo, '.agents', 'skills', 'check-premises', 'SKILL.md'), 'utf8'),
    ).resolves.toBeTruthy();
    await expect(
      readFile(path.join(repo, '.codex', 'agents', 'code-reviewer.toml'), 'utf8'),
    ).resolves.toBeTruthy();
    // it never brought architecture rules
    await expect(
      readFile(path.join(repo, '.claude', 'rules', 'architecture.md')),
    ).rejects.toThrow();
    // and, by default, never the opt-in workflow layer (RP-180) — see
    // "the workflow layer is opt-in (RP-180)" below for the dedicated coverage
    await expect(
      readFile(path.join(repo, '.agents', 'skills', 'pr-ship', 'SKILL.md')),
    ).rejects.toThrow();
  });

  // RP-256 slice 2 (owner decision, superseding slice 1's blanket AGENTS.md
  // refusal — see the coordinator's ruling: "an existing AGENTS.md no longer
  // prevents install" is now the mandated acceptance criterion, not merely a
  // proposal). Split in two, mirroring the two things the old single test
  // used to pin: a plain pre-existing AGENTS.md is no longer clobbered — its
  // bytes survive byte-for-byte as the managed region's prefix, and install
  // succeeds — while the one refusal that remains is markers already in the
  // file that init cannot safely merge with (foreign or malformed). The
  // fuller region contract (CRLF, no-trailing-newline, the manifest's
  // `regions` hash, the 32 KiB warning, every malformed-marker shape) lives
  // in `agents-md-region-init.test.ts`; this pins the same contract in place
  // of the test it replaces, next to the refusal it is now paired with.
  it('a plain existing AGENTS.md is not clobbered — its bytes survive as the region prefix, and install succeeds', async () => {
    await writeFile(path.join(repo, 'AGENTS.md'), '# mine');

    const result = await initProject(repo, {});

    const onDisk = await readFile(path.join(repo, 'AGENTS.md'), 'utf8');
    expect(onDisk.startsWith('# mine')).toBe(true);
    expect(onDisk).toContain(REGION_BEGIN);
    expect(result.written).toContain('AGENTS.md');
    await expect(readManifest(repo)).resolves.not.toBeNull();
  });

  // The original test's "without looping into the upgrade refusal" pin
  // survives here unchanged in spirit: the one refusal left over an
  // AGENTS.md that was never installed by this rig must still never suggest
  // `upgrade`, which would loop straight into upgrade's own "no rig found,
  // run init" refusal.
  it('an AGENTS.md with malformed or foreign markers is still refused, writing nothing, without looping into the upgrade refusal', async () => {
    const hostile = `# mine\n${REGION_BEGIN}\nunterminated\n`;
    await writeFile(path.join(repo, 'AGENTS.md'), hostile);

    let caught: unknown;
    try {
      await initProject(repo, {});
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InitError);
    const message = (caught as Error).message;
    expect(message).not.toMatch(/create-agent-rig upgrade/);
    expect(await readFile(path.join(repo, 'AGENTS.md'), 'utf8')).toBe(hostile);
    await expect(readManifest(repo)).resolves.toBeNull();
  });

  // RP-256 slice 2 (owner decision): with both a user CLAUDE.md and a user
  // AGENTS.md already present, install now succeeds on both — CLAUDE.md is
  // kept exactly as slice 1 already does when it is the only pre-existing
  // file (see "initProject — CLAUDE.md coexistence" below), and AGENTS.md
  // gets its managed region exactly as it does when it is the only
  // pre-existing file (the test above).
  it('when both CLAUDE.md and AGENTS.md already exist, both coexist: CLAUDE.md is kept, the nested shim installs, and AGENTS.md gets its region', async () => {
    const userClaude = '# host rules\n';
    await writeFile(path.join(repo, 'CLAUDE.md'), userClaude);
    await writeFile(path.join(repo, 'AGENTS.md'), '# host agents doc\n');

    const result = await initProject(repo, {});

    expect(result.written).toContain('.claude/CLAUDE.md');
    expect(result.written).toContain('AGENTS.md');
    expect(await readFile(path.join(repo, 'CLAUDE.md'), 'utf8')).toBe(userClaude);
    const shim = await readFile(path.join(repo, '.claude', 'CLAUDE.md'), 'utf8');
    expect(shim.split(/\r?\n/, 1)[0]).toBe('@../AGENTS.md');
    const onDisk = await readFile(path.join(repo, 'AGENTS.md'), 'utf8');
    expect(onDisk.startsWith('# host agents doc\n')).toBe(true);
    expect(onDisk).toContain(REGION_BEGIN);

    const manifest = await readManifest(repo);
    expect(manifest?.kept?.['CLAUDE.md']).toBe(sha256(userClaude));
  });

  // The original test's "blames AGENTS.md, not CLAUDE.md" intent survives on
  // the one refusal that remains: a malformed AGENTS.md marker, with a
  // coexisting CLAUDE.md present too. The MAPS loop used to check CLAUDE.md
  // before AGENTS.md and throw on the first hit — the message must still
  // name the file that actually blocks the run, not the coexisting CLAUDE.md
  // slice 1 already lets through.
  it('when both exist and AGENTS.md carries a malformed marker, the refusal names AGENTS.md — not the coexisting CLAUDE.md', async () => {
    const userClaude = '# host rules\n';
    await writeFile(path.join(repo, 'CLAUDE.md'), userClaude);
    const hostile = `# host agents doc\n${REGION_BEGIN}\nunterminated\n`;
    await writeFile(path.join(repo, 'AGENTS.md'), hostile);

    let caught: unknown;
    try {
      await initProject(repo, {});
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InitError);
    const message = (caught as Error).message;
    expect(message).toMatch(/AGENTS\.md/);
    expect(message).not.toMatch(/already has a CLAUDE\.md/);
    expect(await readFile(path.join(repo, 'CLAUDE.md'), 'utf8')).toBe(userClaude);
    expect(await readFile(path.join(repo, 'AGENTS.md'), 'utf8')).toBe(hostile);
    await expect(readFile(path.join(repo, '.claude', 'CLAUDE.md'))).rejects.toThrow();
    await expect(readManifest(repo)).resolves.toBeNull();
  });

  it('never overwrites a pre-existing process file it did not write', async () => {
    await mkdir(path.join(repo, '.claude', 'rules'), { recursive: true });
    await writeFile(path.join(repo, '.claude', 'rules', 'workflow.md'), 'CUSTOM');
    const result = await initProject(repo, {});
    expect(await readFile(path.join(repo, '.claude', 'rules', 'workflow.md'), 'utf8')).toBe(
      'CUSTOM',
    );
    expect(result.skipped).toContain('.claude/rules/workflow.md');
  });

  it('a dry run writes nothing but reports the plan', async () => {
    const result = await initProject(repo, { dryRun: true });
    expect(result.written).toEqual([]);
    await expect(readFile(path.join(repo, '.claude', 'rules', 'workflow.md'))).rejects.toThrow();
    expect(result.plannedCount).toBeGreaterThan(0);
  });
});

// RP-256 slice 1: a repo that already has its own root CLAUDE.md no longer
// refuses outright. Both `./CLAUDE.md` and `./.claude/CLAUDE.md` are loaded
// by Claude Code, with imports resolved relative to the importing file —
// measured, not assumed: see `docs/decisions/agents-md-canonical.md`,
// "CLAUDE.md coexistence — measured (RP-256 slice 1)" — so `init` leaves
// the user's CLAUDE.md byte-for-byte untouched and installs the Rig shim
// nested at `.claude/CLAUDE.md` instead, importing the canonical rulebook
// as `@../AGENTS.md`. The user's file is recorded in the manifest's `kept`
// (evidence, not ownership); `.claude/CLAUDE.md` is an ordinary `files`
// entry like any other rig-owned path.
describe('initProject — CLAUDE.md coexistence (RP-256 slice 1)', () => {
  const USER_CLAUDE = '# host rules — do not touch\n';

  it('installs the nested shim beside a user CLAUDE.md, leaving it byte-identical', async () => {
    await writeFile(path.join(repo, 'CLAUDE.md'), USER_CLAUDE);

    const result = await initProject(repo, {});

    expect(result.written).toContain('.claude/CLAUDE.md');
    expect(result.written).toContain('AGENTS.md');
    expect(result.written).not.toContain('CLAUDE.md');
    expect(await readFile(path.join(repo, 'CLAUDE.md'), 'utf8')).toBe(USER_CLAUDE);
    const shim = await readFile(path.join(repo, '.claude', 'CLAUDE.md'), 'utf8');
    // Imports resolve relative to the IMPORTING file — `.claude/CLAUDE.md` is
    // one directory below the repo root, so it climbs back up to AGENTS.md,
    // unlike the root shim's plain `@AGENTS.md`.
    expect(shim.split(/\r?\n/, 1)[0]).toBe('@../AGENTS.md');
  });

  it('records the user CLAUDE.md under `kept`, never `files`, and the nested shim under `files`', async () => {
    await writeFile(path.join(repo, 'CLAUDE.md'), USER_CLAUDE);

    await initProject(repo, {});

    const manifest = await readManifest(repo);
    expect(manifest?.kept?.['CLAUDE.md']).toBe(sha256(USER_CLAUDE));
    expect(manifest?.files['CLAUDE.md']).toBeUndefined();
    expect(manifest?.files['.claude/CLAUDE.md']).toBeTruthy();
    expect(manifest?.files['AGENTS.md']).toBeTruthy();
  });

  it('is idempotent: a second init leaves the user CLAUDE.md and the nested shim untouched', async () => {
    await writeFile(path.join(repo, 'CLAUDE.md'), USER_CLAUDE);
    await initProject(repo, {});

    const second = await initProject(repo, {});

    expect(second.written).toEqual([]);
    expect(second.skipped).toContain('.claude/CLAUDE.md');
    expect(second.skipped).toContain('AGENTS.md');
    expect(await readFile(path.join(repo, 'CLAUDE.md'), 'utf8')).toBe(USER_CLAUDE);
  });

  it('a dry run writes nothing when a user CLAUDE.md is present', async () => {
    await writeFile(path.join(repo, 'CLAUDE.md'), USER_CLAUDE);

    const result = await initProject(repo, { dryRun: true });

    expect(result.written).toEqual([]);
    await expect(readFile(path.join(repo, '.claude', 'CLAUDE.md'))).rejects.toThrow();
    expect(await readFile(path.join(repo, 'CLAUDE.md'), 'utf8')).toBe(USER_CLAUDE);
    await expect(readManifest(repo)).resolves.toBeNull();
  });

  // Explicit regression pin: nothing about a CLEAN repo's install may change
  // because a DIFFERENT repo now takes the nested path — no `.claude/CLAUDE.md`
  // appears, and the manifest gets no `kept` entry at all, exactly as before.
  it('a clean repo (no pre-existing CLAUDE.md) is installed exactly as before: no nested shim, no CLAUDE.md `kept`', async () => {
    const result = await initProject(repo, {});

    expect(result.written).toContain('CLAUDE.md');
    expect(result.written).not.toContain('.claude/CLAUDE.md');
    await expect(readFile(path.join(repo, '.claude', 'CLAUDE.md'))).rejects.toThrow();

    const manifest = await readManifest(repo);
    expect(manifest?.files['CLAUDE.md']).toBeTruthy();
    expect(manifest?.files['.claude/CLAUDE.md']).toBeUndefined();
    expect(manifest?.kept?.['CLAUDE.md']).toBeUndefined();
    expect(manifest?.kept?.['.claude/CLAUDE.md']).toBeUndefined();
    // RP-257: `PLAN.md` is a seed-once path — it ships with Core, so it is
    // always `kept` from the first `init`, independently of the nested-shim
    // `kept` entries this test is actually about.
    expect(Object.keys(manifest?.kept ?? {})).toEqual(['PLAN.md']);
  });

  // The one case still refused in this slice: a pre-existing `.claude/CLAUDE.md`
  // that this rig never wrote (no manifest entry vouches for it) means the
  // nested slot is already occupied by something unknown — `init` must not
  // guess whether it is safe to overwrite, so it refuses exactly like the
  // AGENTS.md case above, and it must name the file actually in its way.
  it('refuses when the nested slot is already occupied by an unrecorded `.claude/CLAUDE.md`, and writes nothing', async () => {
    await writeFile(path.join(repo, 'CLAUDE.md'), USER_CLAUDE);
    await mkdir(path.join(repo, '.claude'), { recursive: true });
    await writeFile(path.join(repo, '.claude', 'CLAUDE.md'), '# something already living here\n');

    let caught: unknown;
    try {
      await initProject(repo, {});
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InitError);
    expect((caught as Error).message).toMatch(/\.claude[/\\]CLAUDE\.md/);
    expect(await readFile(path.join(repo, 'CLAUDE.md'), 'utf8')).toBe(USER_CLAUDE);
    expect(await readFile(path.join(repo, '.claude', 'CLAUDE.md'), 'utf8')).toBe(
      '# something already living here\n',
    );
    await expect(readFile(path.join(repo, 'AGENTS.md'))).rejects.toThrow();
    await expect(readManifest(repo)).resolves.toBeNull();
  });
});

// code-reviewer round 1, blocker B1 (PR #324): a symlink sitting at root
// `CLAUDE.md` is the user's own file — it points at their content, exactly
// like a regular file would — so it must not block installation any more
// than a regular file does. Nested placement never writes root `CLAUDE.md`
// at all, so the link itself is never touched; what changes is that
// `claudeMdPlacementForInstall` must recognise a symlink as "the user already
// has a CLAUDE.md" the same way it recognises a regular file, instead of
// falling through to `root` and having the later symlink-confinement check
// refuse the write.
//
// security-scanner round 2 advisory A1 (PR #324, decided in scope): `kept`
// is evidence about THIS repository, committed into a manifest the user
// pushes — so it records the target's bytes only when the target resolves
// INSIDE the repo. A target outside the repo gets no `kept` entry at all:
// install still goes nested exactly as before, but nothing about a file the
// rig never touched, and that may not even be the user's to disclose (an
// outside symlink can point anywhere readable, including outside this
// project entirely), goes into a document this project commits.
//
// security-scanner round 2 blocker B1 (PR #324): reading that in-repo target
// to hash it must also be BOUNDED — a repository-controlled symlink can point
// at a FIFO, a device, or a huge file, and a plain `readFile` through the
// link has no defence against any of the three. See the two tests below this
// describe block for the bound itself; this block covers only which targets
// get a `kept` entry at all.
describe('initProject — a symlinked root CLAUDE.md (RP-256 slice 1, code-review B1; security-scanner round 2 B1/A1)', () => {
  it('installs nested beside a symlink to a file OUTSIDE the repo, leaving the link untouched and recording NO kept entry for it', async (context) => {
    const outside = await mkdtemp(path.join(tmpdir(), 'caf-init-outside-'));
    try {
      const target = path.join(outside, 'host.md');
      const targetContent = '# host rules, reached through a symlink\n';
      await writeFile(target, targetContent);
      try {
        await symlink(target, path.join(repo, 'CLAUDE.md'), 'file');
      } catch {
        // Windows without the symlink privilege refuses file links.
        context.skip();
        return;
      }

      const result = await initProject(repo, {});

      expect(result.written).toContain('.claude/CLAUDE.md');
      expect(result.written).toContain('AGENTS.md');
      expect(result.written).not.toContain('CLAUDE.md');
      // the link itself survives, unreplaced and unfollowed-through-to-write
      const linkStat = await lstat(path.join(repo, 'CLAUDE.md'));
      expect(linkStat.isSymbolicLink()).toBe(true);
      expect(await readFile(target, 'utf8')).toBe(targetContent);

      const manifest = await readManifest(repo);
      expect(manifest?.files['CLAUDE.md']).toBeUndefined();
      expect(manifest?.files['.claude/CLAUDE.md']).toBeTruthy();
      // security-scanner round 2 advisory A1: the target resolves OUTSIDE
      // repoDir, so its hash must never enter the committed manifest.
      expect(manifest?.kept?.['CLAUDE.md']).toBeUndefined();
    } finally {
      await removeFixture(outside);
    }
  });

  it('installs nested beside a symlink to a file INSIDE the repo, recording the target bytes under kept', async (context) => {
    try {
      const targetContent = '# host rules, reached through an in-repo symlink\n';
      await writeFile(path.join(repo, 'host.md'), targetContent);
      try {
        await symlink(path.join(repo, 'host.md'), path.join(repo, 'CLAUDE.md'), 'file');
      } catch {
        // Windows without the symlink privilege refuses file links.
        context.skip();
        return;
      }

      const result = await initProject(repo, {});

      expect(result.written).toContain('.claude/CLAUDE.md');
      const manifest = await readManifest(repo);
      expect(manifest?.files['CLAUDE.md']).toBeUndefined();
      // in-repo target: today's behaviour is unchanged — the sha256 of the
      // bytes a reader following the link would see.
      expect(manifest?.kept?.['CLAUDE.md']).toBe(sha256(targetContent));
    } finally {
      // nothing outside the repo to clean up
    }
  });

  it('a dry run does not refuse a symlinked root CLAUDE.md either, and writes nothing', async (context) => {
    const outside = await mkdtemp(path.join(tmpdir(), 'caf-init-outside-'));
    try {
      const target = path.join(outside, 'host.md');
      await writeFile(target, '# host rules, reached through a symlink\n');
      try {
        await symlink(target, path.join(repo, 'CLAUDE.md'), 'file');
      } catch {
        // Windows without the symlink privilege refuses file links.
        context.skip();
        return;
      }

      const result = await initProject(repo, { dryRun: true });

      expect(result.written).toEqual([]);
      const linkStat = await lstat(path.join(repo, 'CLAUDE.md'));
      expect(linkStat.isSymbolicLink()).toBe(true);
      await expect(readFile(path.join(repo, '.claude', 'CLAUDE.md'))).rejects.toThrow();
      await expect(readManifest(repo)).resolves.toBeNull();
    } finally {
      await removeFixture(outside);
    }
  });

  // security-scanner round 2, blocker B1 (PR #324): `readKeptRootClaudeMd`
  // follows the symlink with a plain `readFile`, which has no defence
  // against what a repository-controlled target actually is. Reproduced
  // against the built CLI: a FIFO target hangs `init` in `open()` after
  // every other file has already been written, and no manifest is ever
  // written — a half-installed repo `init` cannot repair on its own re-run.
  // The fix this pins: open the path itself (bounded, non-blocking), require
  // a REGULAR file before reading through it, and read from that same
  // handle — never the two-step `lstat` + `readFile` that leaves a window
  // for the target to be anything at all.
  it('does not block on a root CLAUDE.md symlinked to a FIFO, and records no kept entry for it', async (context) => {
    skipUnless(context, symlinksAvailable().ok, symlinksAvailable().reason);
    skipUnless(context, fifosAvailable().ok, fifosAvailable().reason);
    const outside = await mkdtemp(path.join(tmpdir(), 'caf-init-fifo-'));
    const target = path.join(outside, 'host-fifo');
    try {
      execFileSync('mkfifo', [target]);
      await symlink(target, path.join(repo, 'CLAUDE.md'), 'file');

      // The case budget is generous on purpose: the bound this pins is
      // "does not block on the read", not a tight performance figure. A
      // plain `readFile` through the link would hang here indefinitely —
      // there is no writer and never will be one — so any bound this small
      // is already well past what a correct, non-blocking open needs.
      const BOUND_MS = 4_000;
      const TIMED_OUT = Symbol('initProject did not settle within the bound');
      const start = Date.now();
      const outcome = await Promise.race([
        initProject(repo, {}),
        new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), BOUND_MS)),
      ]);
      const elapsed = Date.now() - start;

      expect(
        outcome,
        'initProject did not settle before the bound — it likely blocked reading the FIFO target through the symlink',
      ).not.toBe(TIMED_OUT);
      expect(elapsed).toBeLessThan(BOUND_MS);
      const result = outcome as Awaited<ReturnType<typeof initProject>>;
      expect(result.written).toContain('.claude/CLAUDE.md');
      const manifest = await readManifest(repo);
      // a non-regular target is not hashed — there is no "bytes" a reader
      // opening a FIFO even means
      expect(manifest?.kept?.['CLAUDE.md']).toBeUndefined();
    } finally {
      // Best-effort, itself non-blocking: if the implementation under test
      // is still the unbounded `readFile`, a reader is left mid-`open()` on
      // the FIFO with no writer ever coming. Opening the write end with
      // O_NONBLOCK either completes that rendezvous (reader present) or
      // fails immediately with ENXIO (no reader) — it never blocks on its
      // own, so this cannot turn a red test into a hung process.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          const fh = await open(target, constants.O_WRONLY | constants.O_NONBLOCK);
          await fh.close();
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      await removeFixture(outside);
    }
  }, 10_000);

  it('records no kept entry for a root CLAUDE.md symlinked to a regular file over the size cap', async (context) => {
    skipUnless(context, symlinksAvailable().ok, symlinksAvailable().reason);
    const outside = await mkdtemp(path.join(tmpdir(), 'caf-init-big-'));
    try {
      const target = path.join(outside, 'big.md');
      // ~1.1 MiB — comfortably over a 1 MiB cap without ever approaching a
      // size that stresses the host.
      const OVER_CAP_BYTES = 1024 * 1024 + 100 * 1024;
      await writeFile(target, Buffer.alloc(OVER_CAP_BYTES, 'x'));
      await symlink(target, path.join(repo, 'CLAUDE.md'), 'file');

      const result = await initProject(repo, {});

      expect(result.written).toContain('.claude/CLAUDE.md');
      const manifest = await readManifest(repo);
      expect(manifest?.kept?.['CLAUDE.md']).toBeUndefined();
    } finally {
      await removeFixture(outside);
    }
  });

  // code-reviewer round 3 blocker: every case above builds its target
  // OUTSIDE the repo, so `readKeptRootClaudeMd`'s containment check
  // (`targetReal` outside `repoReal`) already returns `null` on its own,
  // before the FIFO/`isFile()` check or the size-cap check is ever reached.
  // A mutation that deletes either of those checks leaves every test above
  // green, because the containment check alone still produces the same
  // `kept === undefined` outcome. The cases below place the target INSIDE
  // the repo, so containment passes and the isFile()/size-cap checks are the
  // only thing left deciding the outcome.

  it('does not block on a root CLAUDE.md symlinked to an IN-REPO FIFO, and records no kept entry for it', async (context) => {
    skipUnless(context, symlinksAvailable().ok, symlinksAvailable().reason);
    skipUnless(context, fifosAvailable().ok, fifosAvailable().reason);
    const target = path.join(repo, 'fifo');
    try {
      execFileSync('mkfifo', [target]);
      await symlink(target, path.join(repo, 'CLAUDE.md'), 'file');

      // Same generous bound as the outside-repo FIFO case above: the
      // property this pins is "does not block", not a tight timing figure.
      const BOUND_MS = 4_000;
      const TIMED_OUT = Symbol('initProject did not settle within the bound');
      const start = Date.now();
      const outcome = await Promise.race([
        initProject(repo, {}),
        new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), BOUND_MS)),
      ]);
      const elapsed = Date.now() - start;

      expect(
        outcome,
        'initProject did not settle before the bound — it likely blocked reading the FIFO target through the symlink',
      ).not.toBe(TIMED_OUT);
      expect(elapsed).toBeLessThan(BOUND_MS);
      const result = outcome as Awaited<ReturnType<typeof initProject>>;
      expect(result.written).toContain('.claude/CLAUDE.md');
      const manifest = await readManifest(repo);
      expect(manifest?.kept?.['CLAUDE.md']).toBeUndefined();
    } finally {
      // Best-effort, itself non-blocking — see the outside-repo FIFO case
      // above for why this cannot turn a red test into a hung process.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          const fh = await open(target, constants.O_WRONLY | constants.O_NONBLOCK);
          await fh.close();
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
    }
  }, 10_000);

  it('records no kept entry for a root CLAUDE.md symlinked to an IN-REPO regular file over the size cap', async (context) => {
    skipUnless(context, symlinksAvailable().ok, symlinksAvailable().reason);
    await mkdir(path.join(repo, 'docs'), { recursive: true });
    const target = path.join(repo, 'docs', 'big.md');
    // ~1.1 MiB — comfortably over a 1 MiB cap without ever approaching a
    // size that stresses the host.
    const OVER_CAP_BYTES = 1024 * 1024 + 100 * 1024;
    await writeFile(target, Buffer.alloc(OVER_CAP_BYTES, 'x'));
    await symlink(target, path.join(repo, 'CLAUDE.md'), 'file');

    const result = await initProject(repo, {});

    expect(result.written).toContain('.claude/CLAUDE.md');
    const manifest = await readManifest(repo);
    expect(manifest?.kept?.['CLAUDE.md']).toBeUndefined();
  });

  it('records a kept entry (the exact bytes, hashed) for an IN-REPO regular target of EXACTLY the 1 MiB cap', async (context) => {
    skipUnless(context, symlinksAvailable().ok, symlinksAvailable().reason);
    await mkdir(path.join(repo, 'docs'), { recursive: true });
    const target = path.join(repo, 'docs', 'exact-cap.md');
    const AT_CAP_BYTES = 1024 * 1024;
    const content = Buffer.alloc(AT_CAP_BYTES, 'x');
    await writeFile(target, content);
    await symlink(target, path.join(repo, 'CLAUDE.md'), 'file');

    const result = await initProject(repo, {});

    expect(result.written).toContain('.claude/CLAUDE.md');
    const manifest = await readManifest(repo);
    expect(manifest?.kept?.['CLAUDE.md']).toBe(sha256(content));
  });

  it('records no kept entry for an IN-REPO regular target exactly ONE BYTE over the 1 MiB cap', async (context) => {
    skipUnless(context, symlinksAvailable().ok, symlinksAvailable().reason);
    await mkdir(path.join(repo, 'docs'), { recursive: true });
    const target = path.join(repo, 'docs', 'one-over-cap.md');
    const ONE_OVER_CAP_BYTES = 1024 * 1024 + 1;
    await writeFile(target, Buffer.alloc(ONE_OVER_CAP_BYTES, 'x'));
    await symlink(target, path.join(repo, 'CLAUDE.md'), 'file');

    const result = await initProject(repo, {});

    expect(result.written).toContain('.claude/CLAUDE.md');
    const manifest = await readManifest(repo);
    expect(manifest?.kept?.['CLAUDE.md']).toBeUndefined();
  });

  // code-reviewer round 3, item 3: the containment check is
  // `targetReal !== repoReal && !targetReal.startsWith(repoReal + path.sep)`
  // — separator-aware on purpose. A plain `targetReal.startsWith(repoReal)`
  // (no trailing separator) would treat a SIBLING directory whose name
  // merely starts with the repo dir's own name as "inside" it — e.g. repo
  // `.../caf-init-XXXX` and sibling `.../caf-init-XXXX-evil` — even though
  // the sibling is a different directory entirely.
  it('records no kept entry for a root CLAUDE.md symlinked into a sibling directory whose name merely starts with the repo directory name', async (context) => {
    skipUnless(context, symlinksAvailable().ok, symlinksAvailable().reason);
    const evilSibling = `${repo}-evil`;
    await mkdir(evilSibling, { recursive: true });
    try {
      const targetContent = '# a sibling directory, not the repo itself\n';
      const target = path.join(evilSibling, 'host.md');
      await writeFile(target, targetContent);
      await symlink(target, path.join(repo, 'CLAUDE.md'), 'file');

      const result = await initProject(repo, {});

      expect(result.written).toContain('.claude/CLAUDE.md');
      const manifest = await readManifest(repo);
      expect(manifest?.kept?.['CLAUDE.md']).toBeUndefined();
    } finally {
      await removeFixture(evilSibling);
    }
  });
});

// code-reviewer round 1 advisory A8, folded into this round's fix for B1: a
// DIRECTORY at root `CLAUDE.md` is not the user's file to leave in place the
// way a regular file or a symlink is — there is no content to import, byte
// for byte or through a link — so it stays refused. What must change is the
// message: the generic MAPS refusal ends with "Merge the agent-os map in by
// hand", advice that assumes a text file whose content can be merged, and
// does not fit a directory at all.
describe('initProject — a directory at root CLAUDE.md (RP-256 slice 1, code-review B1/A8)', () => {
  it('refuses a directory at CLAUDE.md with a message that fits a directory, not the generic "merge the map in by hand" advice, and writes nothing', async () => {
    await mkdir(path.join(repo, 'CLAUDE.md'), { recursive: true });

    let caught: unknown;
    try {
      await initProject(repo, {});
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InitError);
    const message = (caught as Error).message;
    expect(message).toMatch(/CLAUDE\.md/);
    expect(message.toLowerCase()).toContain('directory');
    expect(message).not.toMatch(/Merge the agent-os map in by hand/);
    await expect(readFile(path.join(repo, 'AGENTS.md'))).rejects.toThrow();
    await expect(readManifest(repo)).resolves.toBeNull();
  });
});

// code-reviewer round 1, blocker B2 (PR #324): the one situation that reaches
// `claudeMdPlacementForInstall`'s manifest-first branch (line 172) without the
// filesystem rule on the next line also firing — a nested rig whose user
// later deletes their OWN root `CLAUDE.md`, then runs `init` again. Nothing in
// the existing suite builds that state; deleting the manifest-first branch
// would leave this suite green and would make `init` write a second, root
// `@AGENTS.md` shim next to the nested one. Folded in with it (code-review
// advisory A2): `recordInstall` only ever drops a stale `kept` entry for a
// path that reaches its `written`/`skipped` loops, and root `CLAUDE.md` on a
// `nested` placement never does — it is not in `files` at all — so the
// `kept['CLAUDE.md']` entry the first install wrote goes stale and is never
// cleared once the file it vouches for is gone.
describe('initProject — a nested rig whose user deletes their root CLAUDE.md (RP-256 slice 1, code-review B2/A2)', () => {
  it('stays nested on re-run (manifest-first placement), and drops the stale kept CLAUDE.md entry now that the file is gone', async () => {
    const userClaude = '# host rules — do not touch\n';
    await writeFile(path.join(repo, 'CLAUDE.md'), userClaude);
    await initProject(repo, {});
    await rm(path.join(repo, 'CLAUDE.md'));

    const second = await initProject(repo, {});

    // B2: manifest-first placement — no root shim appears next to the nested one
    expect(second.written).not.toContain('CLAUDE.md');
    await expect(readFile(path.join(repo, 'CLAUDE.md'))).rejects.toThrow();
    const manifest = await readManifest(repo);
    expect(manifest?.files['.claude/CLAUDE.md']).toBeTruthy();
    expect(manifest?.files['CLAUDE.md']).toBeUndefined();

    // A2: the file this entry vouched for is gone — the manifest must not
    // keep claiming it saw and left something that is no longer there
    expect(manifest?.kept?.['CLAUDE.md']).toBeUndefined();
  });
});

// A hook nothing calls is not enforcement. `init` used to lay the hook files
// down and stop there: no settings.json meant guard-bash, block-no-verify,
// gate-stop-dod and inject-rules were never invoked, while CLAUDE.md claimed
// they were.
describe('initProject — the hooks are actually wired', () => {
  it('writes a settings.json naming every process hook it installed', async () => {
    await initProject(repo, {});
    const settings = await readFile(path.join(repo, '.claude', 'settings.json'), 'utf8');
    for (const hook of [
      'block-no-verify.mjs',
      'guard-bash.mjs',
      'gate-stop-dod.mjs',
      'inject-rules.mjs',
    ]) {
      expect(settings, hook).toContain(hook);
    }
    expect(JSON.parse(settings)).toBeTypeOf('object');
  });

  it('names no hook it did not install — a wired-but-absent hook errors on every call', async () => {
    await initProject(repo, {});
    const settings = await readFile(path.join(repo, '.claude', 'settings.json'), 'utf8');
    expect(settings).not.toContain('guard-core-purity');
    expect(settings).not.toContain('guard-web-boundary');
    const codexHooks = await readFile(path.join(repo, '.codex', 'hooks.json'), 'utf8');
    expect(codexHooks).toContain('guard-bash');
    expect(codexHooks).not.toContain('guard-core-purity');
  });

  it('keeps a settings.json the repo already had, and reports it as kept', async () => {
    await mkdir(path.join(repo, '.claude'), { recursive: true });
    await writeFile(path.join(repo, '.claude', 'settings.json'), '{"mine":true}');
    const result = await initProject(repo, {});
    expect(await readFile(path.join(repo, '.claude', 'settings.json'), 'utf8')).toBe(
      '{"mine":true}',
    );
    expect(result.skipped).toContain('.claude/settings.json');
  });

  it('keeps Codex hook wiring the repo already had, and reports it as kept', async () => {
    await mkdir(path.join(repo, '.codex'), { recursive: true });
    await writeFile(path.join(repo, '.codex', 'hooks.json'), '{"mine":true}');
    const result = await initProject(repo, {});
    expect(await readFile(path.join(repo, '.codex', 'hooks.json'), 'utf8')).toBe('{"mine":true}');
    expect(result.skipped).toContain('.codex/hooks.json');
  });

  it('lists the wiring in the plan, so a dry run shows it too', async () => {
    const plan = await planInit(repo);
    expect(plan.files.map((f) => f.path)).toContain('.claude/settings.json');
  });
});

// The kill switch is a filename. An unsubstituted token means the operator
// creates `~/.claude/<repo>-loop-STOP` and the brake looks for
// `~/.claude/__PROJECT_NAME__-loop-STOP` — silently, with no error.
describe('initProject — token substitution', () => {
  it('leaves no __PROJECT_NAME__ token in any installed file', async () => {
    const result = await initProject(repo, {});
    for (const rel of result.written) {
      const content = await readFile(path.join(repo, rel), 'utf8');
      expect(content, rel).not.toContain('__PROJECT_NAME__');
    }
  });

  it('points the kill switch at this repo', async () => {
    await initProject(repo, {});
    const stopFlag = await readFile(path.join(repo, '.claude', 'scripts', 'stop-flag.mjs'), 'utf8');
    expect(stopFlag).toContain(`${projectNameFor(repo)}-loop-STOP`);
    expect(projectNameFor(repo)).toMatch(/^caf-init-/); // and that name is the directory's
  });

  it('derives a filename-safe project name from the directory', () => {
    expect(projectNameFor('/tmp/lambda-puppeteer')).toBe('lambda-puppeteer');
    expect(projectNameFor('/tmp/My Repo!')).toBe('my-repo');
    expect(projectNameFor('/')).toBe('project');
  });
});

// The installed CLAUDE.md is the map an agent reads first. Shipping the
// generated monorepo's map into an arbitrary repo describes directories that
// do not exist and links to rules that were deliberately not installed.
describe('initProject — the map describes THIS repo, not the generated shape', () => {
  // RP-186: AGENTS.md carries the rulebook text these assertions are about;
  // CLAUDE.md is a short shim and never contains any of it.
  it('claims no monorepo layout', async () => {
    await initProject(repo, {});
    const agentsMd = await readFile(path.join(repo, 'AGENTS.md'), 'utf8');
    for (const ghost of ['packages/core/', 'packages/db/', 'apps/web/']) {
      expect(agentsMd, ghost).not.toContain(ghost);
    }
  });

  it('links to no rule or hook that init does not install', async () => {
    await initProject(repo, {});
    const agentsMd = await readFile(path.join(repo, 'AGENTS.md'), 'utf8');
    expect(agentsMd).not.toContain('architecture.md');
    expect(agentsMd).not.toContain('guard-core-purity');
    expect(agentsMd).not.toContain('guard-web-boundary');
  });

  it('declares elevated paths that exist here, not in the generated shape', async () => {
    await initProject(repo, {});
    const agentsMd = await readFile(path.join(repo, 'AGENTS.md'), 'utf8');
    const block = /```elevated-paths\n([\s\S]*?)```/.exec(agentsMd);
    expect(block, 'AGENTS.md must still declare an elevated-paths block').not.toBeNull();
    const paths = (block?.[1] ?? '').trim().split('\n');
    expect(paths).toContain('.claude/');
    expect(paths.some((p) => p.startsWith('packages/'))).toBe(false);

    const claudeMd = await readFile(path.join(repo, 'CLAUDE.md'), 'utf8');
    expect(claudeMd, 'the shim must not carry its own elevated-paths block').not.toContain(
      '```elevated-paths',
    );
  });

  it('says the DoD stop gate is inert until the repo supplies its checks', async () => {
    await initProject(repo, {});
    const agentsMd = await readFile(path.join(repo, 'AGENTS.md'), 'utf8');
    expect(agentsMd).toContain('dod-checks.json');
  });

  it('does not claim runtime ignore entries remain after the project has added them', async () => {
    await writeFile(
      path.join(repo, '.gitignore'),
      [
        '.claude/queue.state.json',
        '.claude/queue.board',
        '.claude/gate-rounds.json',
        '.claude/worktrees/',
        '.claude/runs/',
        '',
      ].join('\n'),
    );
    await initProject(repo, {});

    // RP-186: only AGENTS.md (canonical) carries this section now; the
    // CLAUDE.md shim imports it rather than repeating it.
    const content = await readFile(path.join(repo, 'AGENTS.md'), 'utf8');
    const finishList = content.split('## Four things this install left for you to finish')[1] ?? '';
    const ignoreSection = /\n3\. \*\*[\s\S]*?(?=\n4\. \*\*)/.exec(finishList)?.[0] ?? '';
    expect(ignoreSection, 'AGENTS.md must still explain the runtime ignore entries').toBeTruthy();
    expect(ignoreSection).toMatch(/if[^\n]{0,100}missing|add only[^\n]{0,80}missing/i);
    expect(ignoreSection).not.toMatch(/Add all five/i);

    const claudeMd = await readFile(path.join(repo, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).not.toContain('## Four things this install left for you to finish');
  });
});

// `--force` never meant what it read as. It replaced `CLAUDE.md` and nothing
// else — every other pre-existing file was kept regardless of the flag — so a
// run that looked like "re-install the rig over this repo" refreshed one
// document and left the rules, the hooks and the wiring at whatever version
// they were. `upgrade` is the command that refreshes a rig, and this release
// says so instead. (Removing the flag is a later release; refusing it is this
// one.)
//
// Refusal is an `InitError`, which is what makes the two halves of the ruling
// the CLI is responsible for true: `index.ts` prints an `InitError`'s message
// as-is and exits 1.
describe('initProject — `--force` is deprecated, not a smaller upgrade', () => {
  const DEPRECATION =
    'deprecated — init --force replaced only CLAUDE.md; run create-agent-rig upgrade instead';

  it('refuses the run before it installs anything', async () => {
    await expect(initProject(repo, { force: true })).rejects.toThrow(InitError);
    expect(await readdir(repo)).toEqual([]);
  });

  it('leaves alone the CLAUDE.md it used to be the only way to replace', async () => {
    await writeFile(path.join(repo, 'CLAUDE.md'), '# mine');
    await expect(initProject(repo, { force: true })).rejects.toThrow(InitError);
    expect(await readFile(path.join(repo, 'CLAUDE.md'), 'utf8')).toBe('# mine');
    // nothing else appeared either — not the rules, not the wiring, not the manifest
    expect(await readdir(repo)).toEqual(['CLAUDE.md']);
  });

  it('names the command that does refresh a rig', async () => {
    await expect(initProject(repo, { force: true })).rejects.toThrow(DEPRECATION);
  });
});

describe('initManifest — one list, used by the plan and the install alike', () => {
  it('carries the process layer, the map and the wiring', async () => {
    const rels = (await initManifest()).map((f) => f.rel);
    expect(rels).toContain('.claude/rules/workflow.md');
    expect(rels).toContain('CLAUDE.md');
    expect(rels).toContain('AGENTS.md');
    expect(rels).toContain('.claude/settings.json');
    expect(rels).toContain('.codex/hooks.json');
    expect(rels).not.toContain('.claude/rules/architecture.md');
  });
});

// RP-180: the workflow layer (queue/loop/pr-ship/run-state/journal/
// revalidation/claim-records/PR-lifecycle helpers) is an experimental
// opt-in, never part of the default install.
describe('the workflow layer is opt-in (RP-180)', () => {
  it('a default init installs no workflow-layer file', async () => {
    const result = await initProject(repo, {});
    const workflowPaths = [
      '.claude/queue.json',
      '.claude/skills/loop/SKILL.md',
      '.claude/skills/pr-ship/SKILL.md',
      '.claude/scripts/queue/index.mjs',
      '.claude/scripts/decision-router.mjs',
      '.claude/scripts/lib/claim-records.mjs',
      '.rig/revalidation.json',
    ];
    for (const rel of workflowPaths) {
      expect(result.written, rel).not.toContain(rel);
      await expect(readFile(path.join(repo, ...rel.split('/')))).rejects.toThrow();
    }
    const manifest = await readManifest(repo);
    expect(manifest?.layers).toEqual(['process']);
  });

  it('`{ withWorkflow: true }` installs the workflow layer and records both layers', async () => {
    const result = await initProject(repo, { withWorkflow: true });
    expect(result.written).toContain('.claude/queue.json');
    expect(result.written).toContain('.claude/skills/loop/SKILL.md');
    expect(await readFile(path.join(repo, '.claude', 'queue.json'), 'utf8')).toContain('adapter');

    const manifest = await readManifest(repo);
    expect(manifest?.layers).toEqual(['process', 'workflow']);
  });

  it('planInit without the flag lists no workflow-layer file; with it, it does', async () => {
    const core = await planInit(repo);
    expect(core.files.map((f) => f.path)).not.toContain('.claude/queue.json');

    const withWorkflow = await planInit(repo, { withWorkflow: true });
    expect(withWorkflow.files.map((f) => f.path)).toContain('.claude/queue.json');
    expect(withWorkflow.files.map((f) => f.path)).toContain('.claude/skills/loop/SKILL.md');
  });

  it('re-running plain init on a rig that already opted in keeps the workflow layer installed', async () => {
    await initProject(repo, { withWorkflow: true });
    const result = await initProject(repo, {});
    // nothing new to write on a no-op re-run, and the layer stays recorded
    expect(result.written).toEqual([]);
    const manifest = await readManifest(repo);
    expect(manifest?.layers).toEqual(['process', 'workflow']);
  });
});

// RP-182: a pre-existing file `init` keeps used to fall out of the manifest
// entirely; it is now classified under `kept`.
describe('initProject — every skipped path gets a manifest classification (RP-182)', () => {
  it('records what it kept, with the sha256 of the bytes actually on disk — never in `files`', async () => {
    await mkdir(path.join(repo, '.claude', 'rules'), { recursive: true });
    await writeFile(path.join(repo, '.claude', 'rules', 'workflow.md'), 'CUSTOM');

    const result = await initProject(repo, {});
    expect(result.skipped).toContain('.claude/rules/workflow.md');

    const manifest = await readManifest(repo);
    expect(manifest?.kept?.['.claude/rules/workflow.md']).toBe(sha256('CUSTOM'));
    // never claimed as Rig-written bytes
    expect(manifest?.files['.claude/rules/workflow.md']).toBeUndefined();
    // and a path it actually wrote never shows up as "kept"
    expect(manifest?.kept?.['CLAUDE.md']).toBeUndefined();
    expect(manifest?.files['CLAUDE.md']).toBeTruthy();
  });

  it('records a kept file by its exact raw bytes, even when those bytes are not valid UTF-8', async () => {
    const rel = '.claude/rules/workflow.md';
    const raw = Buffer.from([0xc3, 0x28, 0x0a]);
    await mkdir(path.join(repo, '.claude', 'rules'), { recursive: true });
    await writeFile(path.join(repo, ...rel.split('/')), raw);

    await initProject(repo, {});

    const manifest = await readManifest(repo);
    expect(sha256(raw)).not.toBe(sha256(raw.toString('utf8')));
    expect(manifest?.kept?.[rel]).toBe(sha256(raw));
    expect(manifest?.files[rel]).toBeUndefined();
  });

  it('re-running init refreshes the hash of a path it skips again, and keeps recording it in `kept`', async () => {
    await mkdir(path.join(repo, '.claude', 'rules'), { recursive: true });
    await writeFile(path.join(repo, '.claude', 'rules', 'workflow.md'), 'CUSTOM V1');
    await initProject(repo, {});

    // lift init's CLAUDE.md refusal, the only thing standing between this and
    // a second run over the same repo (mirrors the fixtures in upgrade.test.ts)
    await rm(path.join(repo, 'CLAUDE.md'));
    await writeFile(path.join(repo, '.claude', 'rules', 'workflow.md'), 'CUSTOM V2');
    const second = await initProject(repo, {});
    expect(second.skipped).toContain('.claude/rules/workflow.md');

    const manifest = await readManifest(repo);
    expect(manifest?.kept?.['.claude/rules/workflow.md']).toBe(sha256('CUSTOM V2'));
    expect(manifest?.files['.claude/rules/workflow.md']).toBeUndefined();
  });

  it('never moves a path already recorded in `files` into `kept`, even when a later run skips it', async () => {
    await initProject(repo, {});
    const autonomyBefore = await readFile(
      path.join(repo, '.claude', 'rules', 'autonomy.md'),
      'utf8',
    );

    // lift init's CLAUDE.md refusal; leave every other installed file exactly
    // as the first run wrote it, so the second run skips them all
    await rm(path.join(repo, 'CLAUDE.md'));
    const second = await initProject(repo, {});
    expect(second.skipped).toContain('.claude/rules/autonomy.md');

    const manifest = await readManifest(repo);
    // it was written by the rig, twice over — it is not the user's file
    expect(manifest?.kept?.['.claude/rules/autonomy.md']).toBeUndefined();
    expect(manifest?.files['.claude/rules/autonomy.md']).toBe(sha256(autonomyBefore));
  });

  it('drops a path from `kept` once a later run writes it', async () => {
    await mkdir(path.join(repo, '.claude', 'rules'), { recursive: true });
    await writeFile(path.join(repo, '.claude', 'rules', 'workflow.md'), 'CUSTOM');
    await initProject(repo, {});

    // the user deletes the kept file; the next run finds the path free and writes it
    await rm(path.join(repo, 'CLAUDE.md'));
    await rm(path.join(repo, '.claude', 'rules', 'workflow.md'));
    const second = await initProject(repo, {});
    expect(second.written).toContain('.claude/rules/workflow.md');

    const manifest = await readManifest(repo);
    expect(manifest?.files['.claude/rules/workflow.md']).toBeTruthy();
    expect(manifest?.kept?.['.claude/rules/workflow.md']).toBeUndefined();
  });

  it('refuses a symlink at a payload path and does not hash or change its target', async (context) => {
    const outside = await mkdtemp(path.join(tmpdir(), 'caf-init-outside-'));
    try {
      const target = path.join(outside, 'secret.txt');
      await writeFile(target, 'OUTSIDE THE REPO');
      await mkdir(path.join(repo, '.claude', 'rules'), { recursive: true });
      try {
        await symlink(target, path.join(repo, '.claude', 'rules', 'workflow.md'), 'file');
      } catch {
        // Windows without the symlink privilege refuses file links.
        context.skip();
        return;
      }

      await expect(initProject(repo, {})).rejects.toThrow(InitError);
      expect(await readFile(target, 'utf8')).toBe('OUTSIDE THE REPO');
      expect(await readManifest(repo)).toBeNull();
    } finally {
      await removeFixture(outside);
    }
  });

  it('completes, and records nothing under `kept`, when a payload path is occupied by a directory', async () => {
    await mkdir(path.join(repo, '.claude', 'rules', 'workflow.md'), { recursive: true });

    const result = await initProject(repo, {});
    expect(result.skipped).toContain('.claude/rules/workflow.md');

    const manifest = await readManifest(repo);
    expect(manifest).not.toBeNull();
    expect(manifest?.kept?.['.claude/rules/workflow.md']).toBeUndefined();
    expect(manifest?.files['.claude/rules/workflow.md']).toBeUndefined();
  });
});

// A payload path is not merely a name: a symlink at the leaf or in a parent
// component can make that name resolve outside the repository. `init` is an
// adoption command and must refuse before any such destination can be opened.
describe('initProject — symlink confinement', () => {
  it('refuses a final payload symlink without creating its dangling target outside the repo', async (context) => {
    const outside = await mkdtemp(path.join(tmpdir(), 'caf-init-outside-'));
    try {
      const danglingTarget = path.join(outside, 'must-not-exist.md');
      await mkdir(path.join(repo, '.claude', 'rules'), { recursive: true });
      try {
        await symlink(danglingTarget, path.join(repo, '.claude', 'rules', 'workflow.md'), 'file');
      } catch {
        // Windows hosts without the symlink privilege cannot exercise this;
        // Linux CI and WSL must run it.
        context.skip();
        return;
      }

      await expect(initProject(repo, {})).rejects.toThrow(InitError);
      await expect(readFile(danglingTarget, 'utf8')).rejects.toThrow();
    } finally {
      await removeFixture(outside);
    }
  });

  it('refuses a symlinked parent component without writing the payload outside the repo', async (context) => {
    const outside = await mkdtemp(path.join(tmpdir(), 'caf-init-outside-'));
    try {
      await mkdir(path.join(repo, '.claude'), { recursive: true });
      try {
        await symlink(outside, path.join(repo, '.claude', 'rules'), 'dir');
      } catch {
        // Windows hosts without the symlink privilege cannot exercise this;
        // Linux CI and WSL must run it.
        context.skip();
        return;
      }

      await expect(initProject(repo, {})).rejects.toThrow(InitError);
      await expect(readFile(path.join(outside, 'workflow.md'), 'utf8')).rejects.toThrow();
    } finally {
      await removeFixture(outside);
    }
  });
});

describe('initProject — a rig it already owns', () => {
  it('is idempotent: a second init skips an unchanged rig-owned CLAUDE.md', async () => {
    await initProject(repo, {});

    const second = await initProject(repo, {});

    expect(second.skipped).toContain('CLAUDE.md');
    expect(second.skipped).toContain('AGENTS.md');
  });
});

// RP-257: PLAN.md is the live Agent/Operator queue — the template header says
// so ("Keep entries one line each ... Delete done items"), and it is the one
// payload path a rig is designed to have edited by hand from the moment it is
// installed. It ships once, from a plain `init` (it ships with the
// process/Core layer, `layers.json`, not the opt-in workflow layer), exactly
// like every other payload file — but unlike every other payload file it must
// never be healed back onto disk once the user has removed it: a missing
// PLAN.md is a deliberate deletion of the user's own queue, not a rig file
// that fell out of place. Doctor's and upgrade's halves of this same contract
// are pinned in doctor.test.ts and upgrade.test.ts respectively.
describe('initProject / planUpgrade — PLAN.md is seed-once, not byte-owned (RP-257)', () => {
  it('seeds PLAN.md with the template content on a clean install, and never recreates it once the user deletes it — not via upgrade, not via a plain init re-run', async () => {
    await initProject(repo, { withWorkflow: true });
    const seeded = await readFile(path.join(repo, 'PLAN.md'), 'utf8');
    expect(seeded).toContain('## Agent queue');

    await rm(path.join(repo, 'PLAN.md'));

    // upgrade must not restore a queue the user deliberately deleted
    const plan = await planUpgrade(repo, { history: emptyHistory });
    await applyUpgrade(repo, plan);
    await expect(readFile(path.join(repo, 'PLAN.md'))).rejects.toThrow();

    // neither must a plain `init` re-run over the same rig — it heals a
    // missing RIG file, and PLAN.md stopped being one the moment it shipped
    await initProject(repo, {});
    await expect(readFile(path.join(repo, 'PLAN.md'))).rejects.toThrow();
  });
});

// code-reviewer round 1 (PR #332) blocker 3: `initProject` reports a
// `seed-gone` path (already seeded, since deleted by the user — see
// `initProject`'s own `seed-gone` verdict) by folding it into the SAME
// `skipped` array a present, kept-not-overwritten file goes into. The one
// caller of this array (`index.ts`) reads its length as "kept N existing"
// and lists it under "Already present (kept, not overwritten)" — both claims
// that are simply false of a file that is not on disk at all. This pins the
// public surface (`InitResult.skipped`) rather than the private split
// (`skippedExisting`/`seedGone` inside `initProject`), and computes its
// expected count from the fixture's own file-system state — deleting one
// file that would otherwise be "kept" must shrink `skipped` by exactly one —
// rather than importing production's own tally.
describe('initProject — a seed-gone PLAN.md is not reported as "kept" (RP-257 round 2, blocker 3)', () => {
  it('excludes a deleted PLAN.md from `InitResult.skipped` — it does not exist, so it cannot have been kept', async () => {
    await initProject(repo, { withWorkflow: true });
    // baseline: a second, ordinary init over an untouched rig — PLAN.md is
    // still on disk, so it genuinely is "kept, not overwritten" here.
    const baseline = await initProject(repo, {});
    expect(baseline.skipped).toContain('PLAN.md');

    await rm(path.join(repo, 'PLAN.md'));
    const afterDeletion = await initProject(repo, {});

    expect(afterDeletion.skipped).not.toContain('PLAN.md');
    // the ONLY thing that changed between the two runs is PLAN.md's absence
    expect(afterDeletion.skipped.length).toBe(baseline.skipped.length - 1);
  });

  // Advisory in the same review: `planInit` (the `--dry-run` preview) lists
  // every process-layer path unconditionally, so a deleted, already-seeded
  // PLAN.md still prints `+ PLAN.md` — the dry-run promises work `init`
  // would never actually do (a plain, non-dry-run `init` never re-plants a
  // seed-gone path — see the describe block above).
  it('a dry run does not list a seed-gone PLAN.md as something it would plant', async () => {
    await initProject(repo, { withWorkflow: true });
    await rm(path.join(repo, 'PLAN.md'));

    const plan = await planInit(repo, { withWorkflow: true });
    expect(plan.files.map((f) => f.path)).not.toContain('PLAN.md');
  });

  // Same advisory, the OTHER number a dry run prints: "N files planned"
  // (`InitResult.plannedCount`, `initProject`'s own dry-run branch) is
  // `files.length` — every process-layer path, computed before the per-file
  // loop even runs — so it does not shrink when one of those paths is
  // seed-gone either. Computed from the fixture (one dry run before the
  // deletion, one after) rather than a literal, so this does not restate
  // whatever number production happens to produce today.
  it('a dry run does not count a seed-gone PLAN.md among the files planned', async () => {
    await initProject(repo, { withWorkflow: true });
    const baselineDry = await initProject(repo, { dryRun: true, withWorkflow: true });

    await rm(path.join(repo, 'PLAN.md'));
    const afterDeletionDry = await initProject(repo, { dryRun: true, withWorkflow: true });

    expect(afterDeletionDry.plannedCount).toBe(baselineDry.plannedCount - 1);
  });
});

// code-reviewer round 1 (PR #332) blocker 5: no test built a genuine
// pre-RP-257 manifest (PLAN.md recorded as an ordinary, byte-owned `files`
// entry, no `kept` bucket) and asserted `init`'s own half of the migration
// the CHANGELOG promises — `upgrade.test.ts` pins the sibling `upgrade` half
// with the same fixture idiom.
describe('initProject — migrating a pre-RP-257 manifest (PLAN.md still in `files`, no `kept` entry) (RP-257 round 2, blocker 5)', () => {
  /** Rewrites the freshly-seeded manifest into the pre-RP-257 shape, and returns the bytes on disk. */
  async function buildPreRp257Manifest(): Promise<string> {
    await initProject(repo, { withWorkflow: true });
    const bytes = await readFile(path.join(repo, 'PLAN.md'), 'utf8');
    const manifest = await readManifest(repo);
    if (manifest === null) throw new Error('fixture: no manifest');
    const priorHash = manifest.kept?.['PLAN.md'];
    if (priorHash === undefined) throw new Error('fixture: PLAN.md was not seeded into `kept`');
    manifest.files['PLAN.md'] = priorHash;
    delete manifest.kept!['PLAN.md'];
    await writeManifest(repo, manifest);
    return bytes;
  }

  it('a pristine PLAN.md migrates from `files` to `kept` on the next plain init, bytes untouched', async () => {
    const pristine = await buildPreRp257Manifest();

    await initProject(repo, {});

    const after = await readManifest(repo);
    expect(after?.files['PLAN.md']).toBeUndefined();
    expect(after?.kept?.['PLAN.md']).toBe(sha256(pristine));
    expect(await readFile(path.join(repo, 'PLAN.md'), 'utf8')).toBe(pristine);
  });

  it('an edited PLAN.md migrates from `files` to `kept` on the next plain init, bytes untouched', async () => {
    const pristine = await buildPreRp257Manifest();
    const edited = `${pristine}\n- add a GET /notes/:id route through every layer (TDD)\n`;
    await writeFile(path.join(repo, 'PLAN.md'), edited);

    await initProject(repo, {});

    const after = await readManifest(repo);
    expect(after?.files['PLAN.md']).toBeUndefined();
    expect(after?.kept?.['PLAN.md']).toBe(sha256(edited));
    expect(await readFile(path.join(repo, 'PLAN.md'), 'utf8')).toBe(edited);
  });
});
