import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDoctor } from '../src/commands/doctor.js';
import { initProject } from '../src/commands/init.js';
import { runIntegrationsCommand } from '../src/commands/integrations.js';
import { readManifest, writeManifest } from '../src/lib/manifest.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';

// Same walk `version.test.ts` uses from `test/` to the repo root — an
// independent oracle for the CLI version. The comparison under test must
// never be asked "what does packageVersion() say" and then re-asked the same
// question of itself; it is read here straight off the committed
// `package.json`.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

async function cliVersion(): Promise<{ major: number; minor: number; patch: number; raw: string }> {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
    version: string;
  };
  const [major, minor, patch] = pkg.version.split('.').map(Number);
  return { major: major!, minor: minor!, patch: patch!, raw: pkg.version };
}

/** A version strictly greater than the real CLI version, by patch alone. */
async function newerThanCli(): Promise<string> {
  const { major, minor, patch } = await cliVersion();
  return `${major}.${minor}.${patch + 1000}`;
}

/**
 * A version strictly lower than the real CLI version. `0.0.0` is lower than
 * every version this project has ever released or will release while its own
 * major stays above zero — true today (`package.json` reports `1.0.1`) — so
 * this is deliberately not derived by decrementing the real version, which
 * would need to special-case `0.0.0`/`x.0.0` itself.
 */
const OLDER_THAN_CLI = '0.0.0';

async function withManifestVersion(repo: string, version: string): Promise<void> {
  const manifest = await readManifest(repo);
  if (manifest === null) throw new Error('fixture: no manifest');
  await writeManifest(repo, { ...manifest, version });
}

type Check = {
  id: string;
  status: 'ok' | 'warn' | 'fail';
  reason?: string;
  detail?: string;
  fix?: string;
  // RP-239 A2: `rig-owned-files` alone carries this — a per-reason count that
  // lets a caller see absence and content drift at once instead of one
  // masking the other by precedence. No paths in it: that is `fix`'s job.
  counts?: { absent: number; contentDrift: number; lineDrift: number; unreadable: number };
};

type Report = {
  schemaVersion: 1;
  status: 'ok' | 'warn' | 'fail';
  checks: Check[];
};

let repo: string;
let home: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-doctor-'));
  home = await mkdtemp(path.join(tmpdir(), 'caf-doctor-home-'));
});

afterEach(async () => {
  await removeFixture(repo);
  await removeFixture(home);
});

async function doctor(args = ['--json']) {
  return runDoctor({
    cwd: repo,
    args,
    env: { HOME: home, APPDATA: home, PATH: process.env.PATH ?? '' },
  });
}

function report(stdout: string): Report {
  return JSON.parse(stdout) as Report;
}

const hasFailure = (result: Report): boolean =>
  result.checks.some((check) => check.status === 'fail');

// RP-239 A4 (onboarding-friction triage, comment 20140): a third-party pilot
// found an internal tracker id leaking into a doctor detail sentence — an
// operator outside this repository has nowhere to look "RP-26" up. The
// sentence must keep its meaning in plain words instead.
describe('doctor detail/fix text names no internal tracker id (RP-239 A4)', () => {
  it('the workflow check states the frozen-mechanism decision in plain words, not as a ticket id', async () => {
    await initProject(repo, { withWorkflow: true });

    const result = await doctor();
    expect(result.exitCode, result.stderr).toBe(0);
    const parsed = report(result.stdout);
    const workflow = parsed.checks.find((check) => check.id === 'workflow');
    expect(workflow, 'fixture: no workflow check in this report').toBeTruthy();
    // Fixture sanity: this is the exact branch the finding names
    // (doctor.ts's `reason === 'workflow-verified'` detail).
    expect(workflow?.reason).toBe('workflow-verified');
    expect(workflow?.detail).toBeTruthy();
    expect(workflow?.detail).not.toMatch(/\bRP-\d+\b/);
    expect(workflow?.detail).not.toMatch(/\bAR-\d+\b/);
  });

  it('no check in a full report names an RP- or AR- tracker id in its detail or fix text', async () => {
    await initProject(repo, { withWorkflow: true });

    const result = await doctor();
    expect(result.exitCode, result.stderr).toBe(0);
    const parsed = report(result.stdout);
    const offenders = parsed.checks.filter(
      (check) =>
        /\b(RP|AR)-\d+\b/.test(check.detail ?? '') || /\b(RP|AR)-\d+\b/.test(check.fix ?? ''),
    );
    expect(offenders, JSON.stringify(offenders)).toEqual([]);
  });
});

describe('aggregated doctor (RP-21)', () => {
  it('distinguishes owned wiring, missing launcher and unobserved runtime for both Basic Memory targets', async () => {
    await initProject(repo, {});
    expect(
      (
        await runIntegrationsCommand({
          cwd: repo,
          verb: 'add',
          args: ['basic-memory', '--harness', 'claude-code', '--harness', 'codex', '--yes'],
        })
      ).exitCode,
    ).toBe(0);
    const result = await runDoctor({
      cwd: repo,
      args: ['--json'],
      env: { HOME: home, APPDATA: home, PATH: '' },
    });
    const body = JSON.parse(result.stdout);
    expect(body.status).toBe('warn');
    for (const harness of ['claude-code', 'codex'])
      expect(body.integrations[0].harnesses[harness]).toEqual({
        wiring: 'wired',
        launcher: 'missing',
        runtime: 'unverified',
        connectivity: 'not-observed',
        trust: 'not-observed',
      });
    expect(body.checks).toContainEqual(
      expect.objectContaining({
        id: 'rig-owned-files',
        status: 'ok',
        reason: 'pristine',
      }),
    );
  });

  it('fails unreadable owned MCP configuration without exposing its contents', async () => {
    await initProject(repo, {});
    expect(
      (await runIntegrationsCommand({ cwd: repo, verb: 'add', args: ['figma-mcp', '--yes'] }))
        .exitCode,
    ).toBe(0);
    await writeFile(path.join(repo, '.mcp.json'), 'private-invalid-config');
    const result = await doctor();
    expect(result.exitCode).toBe(1);
    expect(result.stdout).not.toContain('private-invalid-config');
    expect(JSON.parse(result.stdout).integrations[0].harnesses['claude-code']).toMatchObject({
      wiring: 'unreadable',
      reason: 'invalid-config',
    });
  });
  it('reports a clean initialized Rig in the versioned check schema with no failed checks', async () => {
    await initProject(repo, {});

    const result = await doctor();
    const body = report(result.stdout);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(body).toMatchObject({ schemaVersion: 1 });
    expect(['ok', 'warn']).toContain(body.status);
    expect(Array.isArray(body.checks)).toBe(true);
    for (const check of body.checks) {
      expect(['ok', 'warn', 'fail']).toContain(check.status);
      expect(check).toMatchObject({
        id: expect.any(String),
        detail: expect.any(String),
        fix: expect.any(String),
      });
    }
    expect(hasFailure(body)).toBe(false);
  });

  it('treats an absent optional integrations declaration as non-failing', async () => {
    await initProject(repo, {});

    const result = await doctor();
    const body = report(result.stdout);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(body.status).not.toBe('fail');
    expect(hasFailure(body)).toBe(false);
  });

  it.each([
    ['an MCP provider', { id: 'figma-mcp', selected: true }],
    ['Spec Kit', { id: 'spec-kit', version: '1.0.8', selected: true }],
  ])(
    'warns when %s is selected without a harness and preserves the intent bytes',
    async (_case, entry) => {
      await initProject(repo, {});
      const declaration = path.join(repo, '.rig', 'integrations.json');
      await mkdir(path.dirname(declaration), { recursive: true });
      await writeFile(
        declaration,
        `${JSON.stringify({ schemaVersion: 1, integrations: [entry] })}\n`,
      );
      const before = await readFile(declaration, 'utf8');

      const result = await doctor();
      const body = report(result.stdout);

      expect(result.exitCode, result.stderr).toBe(0);
      expect(body.status).toBe('warn');
      expect(body.checks).toContainEqual(
        expect.objectContaining({
          id: 'integrations',
          status: 'warn',
          reason: 'harness-selection-pending',
        }),
      );
      expect(body.checks).toContainEqual(
        expect.objectContaining({
          id: `${entry.id}:harness-selection`,
          status: 'warn',
          reason: 'harness-selection-pending',
        }),
      );
      if (entry.id === 'spec-kit')
        expect(body.checks).not.toContainEqual(expect.objectContaining({ id: 'spec-kit' }));
      expect(await readFile(declaration, 'utf8')).toBe(before);
    },
  );

  it('keeps declared Spec Kit on its authoritative upstream-status lane, not an MCP ownership check', async () => {
    await initProject(repo, {});
    const declaration = path.join(repo, '.rig', 'integrations.json');
    await mkdir(path.dirname(declaration), { recursive: true });
    await writeFile(
      declaration,
      `${JSON.stringify({
        schemaVersion: 1,
        integrations: [
          {
            id: 'spec-kit',
            version: '1.0.8',
            selected: true,
            harnesses: ['claude-code', 'codex'],
          },
        ],
      })}\n`,
    );

    const result = await runDoctor({
      cwd: repo,
      args: ['--json'],
      env: { HOME: home, APPDATA: home, PATH: home },
    });
    const body = report(result.stdout);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(body.checks).toContainEqual(
      expect.objectContaining({
        id: 'spec-kit',
        status: 'warn',
        reason: 'upstream-status-unavailable',
      }),
    );
  });

  it('fails an unreadable integrations declaration without echoing its private bytes', async () => {
    await initProject(repo, {});
    const privateSentinel = ['private', 'doctor', 'sentinel'].join('-');
    const declaration = path.join(repo, '.rig', 'integrations.json');
    await mkdir(path.dirname(declaration), { recursive: true });
    await writeFile(declaration, `{ "value": "${privateSentinel}"`);

    const result = await doctor();
    const body = report(result.stdout);

    expect(result.exitCode).toBe(1);
    expect(body.status).toBe('fail');
    expect(body.checks).toContainEqual(
      expect.objectContaining({
        id: 'integrations',
        status: 'fail',
        reason: 'invalid-declaration',
      }),
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain(privateSentinel);
  });

  it('diagnoses an owned file whose bytes differ from the recorded installation', async () => {
    await initProject(repo, {});
    const owned = path.join(repo, 'AGENTS.md');
    await writeFile(owned, `${await readFile(owned, 'utf8')}\nmanual change\n`);

    const result = await doctor();
    const body = report(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(body.status).toBe('warn');
    expect(body.checks).toContainEqual(
      expect.objectContaining({ id: 'rig-owned-files', status: 'warn', reason: 'content-drift' }),
    );
  });

  it('distinguishes line-ending-only drift from pristine owned bytes', async () => {
    await initProject(repo, {});
    const owned = path.join(repo, 'AGENTS.md');
    const original = await readFile(owned, 'utf8');
    expect(original).toContain('\n');
    await writeFile(owned, original.replace(/\r?\n/g, '\r\n'));

    const result = await doctor();
    const body = report(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(body.status).toBe('warn');
    expect(body.checks).toContainEqual(
      expect.objectContaining({
        id: 'rig-owned-files',
        status: 'warn',
        reason: 'line-ending-drift',
      }),
    );
    expect(body.checks).not.toContainEqual(
      expect.objectContaining({ id: 'rig-owned-files', status: 'ok', reason: 'pristine' }),
    );
  });

  // RP-239 A2 (onboarding-friction triage, comment 20140): a real pilot's
  // `rig-owned-files` had one file missing and a different file
  // content-drifted at the same time, and the report said only
  // `absent-owned-file` — the precedence order in `rigChecks` silently threw
  // the content-drift information away, and neither reason named which paths
  // were affected. `docs/command-contract.md`'s payload rule ("no file paths
  // appear in any JSON this contract defines, except in a `fix` field")
  // settles where a path may legally go once the check does name one.
  describe('rig-owned-files distinguishes every drift reason present, and names paths only in fix (RP-239 A2)', () => {
    it('counts an absent file and a content-drifted file separately instead of one masking the other', async () => {
      await initProject(repo, {});
      const drifted = path.join(repo, 'AGENTS.md');
      await writeFile(drifted, `${await readFile(drifted, 'utf8')}\nmanual change\n`);
      const missing = path.join(repo, 'CLAUDE.md');
      await unlink(missing);

      const result = await doctor();
      const body = report(result.stdout);

      // Truthful and unchanged: a run with drift is still a warning, never a
      // failure, and never changes the exit code.
      expect(result.exitCode, result.stderr).toBe(0);
      expect(body.status).toBe('warn');

      const check = body.checks.find((c) => c.id === 'rig-owned-files');
      expect(check, 'fixture: no rig-owned-files check in this report').toBeTruthy();
      expect(check?.status).toBe('warn');
      // 🔴 Before this fix, `reason` alone could report only ONE of the two —
      // `absent-owned-file`, by precedence — leaving the content-drifted file
      // invisible to anything reading the payload. Both are counted now.
      expect(check?.counts).toEqual({ absent: 1, contentDrift: 1, lineDrift: 0, unreadable: 0 });
    });

    it('names the specific absent and drifted paths only in the fix text, never in detail or reason', async () => {
      await initProject(repo, {});
      const drifted = path.join(repo, 'AGENTS.md');
      await writeFile(drifted, `${await readFile(drifted, 'utf8')}\nmanual change\n`);
      const missing = path.join(repo, 'CLAUDE.md');
      await unlink(missing);

      const result = await doctor();
      const body = report(result.stdout);
      const check = body.checks.find((c) => c.id === 'rig-owned-files');

      // Rule (h): a file path appears in NO field of a doctor record but `fix`.
      expect(check?.reason ?? '').not.toContain('AGENTS.md');
      expect(check?.reason ?? '').not.toContain('CLAUDE.md');
      expect(check?.detail ?? '').not.toContain('AGENTS.md');
      expect(check?.detail ?? '').not.toContain('CLAUDE.md');
      expect(check?.fix ?? '').toContain('AGENTS.md');
      expect(check?.fix ?? '').toContain('CLAUDE.md');
    });

    it('counts a single absent owned file with the existing absent-owned-file reason, naming only that path in fix', async () => {
      await initProject(repo, {});
      const missing = path.join(repo, 'CLAUDE.md');
      await unlink(missing);

      const result = await doctor();
      const body = report(result.stdout);
      const check = body.checks.find((c) => c.id === 'rig-owned-files');

      expect(result.exitCode, result.stderr).toBe(0);
      expect(check).toMatchObject({ status: 'warn', reason: 'absent-owned-file' });
      expect(check?.counts).toEqual({ absent: 1, contentDrift: 0, lineDrift: 0, unreadable: 0 });
      expect(check?.detail ?? '').not.toContain('CLAUDE.md');
      expect(check?.fix ?? '').toContain('CLAUDE.md');
    });

    it("keeps a pristine install's counts all zero", async () => {
      await initProject(repo, {});

      const result = await doctor();
      const body = report(result.stdout);
      const check = body.checks.find((c) => c.id === 'rig-owned-files');

      expect(result.exitCode, result.stderr).toBe(0);
      expect(check).toMatchObject({ status: 'ok', reason: 'pristine' });
      expect(check?.counts).toEqual({ absent: 0, contentDrift: 0, lineDrift: 0, unreadable: 0 });
    });
  });

  it('rejects invalid doctor arguments with CLI usage exit 2', async () => {
    const result = await doctor(['--unexpected']);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
  });

  // RP-229 — doctor compares the local CLI version with the committed Rig
  // manifest version, so a developer running a mutating command (setup,
  // upgrade) against a repository whose manifest was written by a newer rig
  // finds out before acting on stale assumptions, not after.
  describe('rig-version check (RP-229)', () => {
    it("warns to update create-agent-rig first, naming both setup and upgrade as the operations to hold off on, and quoting the repository's recorded version, when the manifest records a newer version", async () => {
      await initProject(repo, {});
      const recordedVersion = await newerThanCli();
      await withManifestVersion(repo, recordedVersion);

      const result = await doctor();
      const body = report(result.stdout);

      // warn never changes the exit code or the overall pass/fail split.
      expect(result.exitCode, result.stderr).toBe(0);
      expect(body.status).toBe('warn');
      const check = body.checks.find((c) => c.id === 'rig-version');
      expect(check).toMatchObject({ status: 'warn', reason: 'cli-older-than-repository' });
      const fix = check?.fix ?? '';
      const fixLower = fix.toLowerCase();
      // Both mutating operations the item names are held off on, not just one.
      expect(fixLower).toContain('setup');
      expect(fixLower).toContain('upgrade');
      expect(fixLower).toContain('create-agent-rig');
      // The fix names the actual recorded version, not just "newer" in the
      // abstract — read here from the fixture that wrote it, never from the
      // production comparison the check itself performs.
      expect(fix).toContain(recordedVersion);
      // The generic `rig-` fix text ("Review the installation with
      // create-agent-rig upgrade…") is exactly the wrong advice here: running
      // `upgrade` with an older CLI cannot install what a newer CLI wrote.
      // This is narrower than forbidding the word "upgrade" outright — the
      // fix is expected to name `upgrade` as an operation to hold off on; it
      // must never fall back to the generic instruction to run it.
      expect(fix).not.toContain('Review the installation with create-agent-rig upgrade');
    });

    it('reports ok, matching versions, when the manifest version equals the CLI version', async () => {
      await initProject(repo, {});
      const { raw } = await cliVersion();
      await withManifestVersion(repo, raw);

      const result = await doctor();
      const body = report(result.stdout);

      expect(result.exitCode, result.stderr).toBe(0);
      expect(body.checks).toContainEqual(
        expect.objectContaining({ id: 'rig-version', status: 'ok', reason: 'versions-match' }),
      );
    });

    it('reports ok, not a warning, when the manifest version is older than the CLI (ordinary PR-review upgrade territory)', async () => {
      await initProject(repo, {});
      await withManifestVersion(repo, OLDER_THAN_CLI);

      const result = await doctor();
      const body = report(result.stdout);

      expect(result.exitCode, result.stderr).toBe(0);
      expect(body.checks).toContainEqual(
        expect.objectContaining({
          id: 'rig-version',
          status: 'ok',
          reason: 'repository-older-than-cli',
        }),
      );
    });

    it.each([
      ['a prerelease-shaped version', '1.0.1-rc.1'],
      ['a non-semver garbage version parseManifest still accepts', 'not-a-version'],
    ])('warns version-uncomparable, never guessing a direction, for %s', async (_case, version) => {
      await initProject(repo, {});
      await withManifestVersion(repo, version);

      const result = await doctor();
      const body = report(result.stdout);

      // Still only a warning — comparison failing is not the same as the
      // installation being broken.
      expect(result.exitCode, result.stderr).toBe(0);
      expect(body.checks).toContainEqual(
        expect.objectContaining({
          id: 'rig-version',
          status: 'warn',
          reason: 'version-uncomparable',
        }),
      );
    });

    it.each([
      ['a prerelease-shaped version', '1.0.1-rc.1'],
      ['a non-semver garbage version parseManifest still accepts', 'not-a-version'],
    ])(
      'tells the developer to compare CLI and manifest versions by hand for %s, never to update to the recorded version itself',
      async (_case, version) => {
        await initProject(repo, {});
        await withManifestVersion(repo, version);

        const result = await doctor();
        const body = report(result.stdout);

        expect(result.exitCode, result.stderr).toBe(0);
        const check = body.checks.find((c) => c.id === 'rig-version');
        expect(check).toMatchObject({ status: 'warn', reason: 'version-uncomparable' });
        const fix = check?.fix ?? '';
        expect(fix.length).toBeGreaterThan(0);
        const fixLower = fix.toLowerCase();
        // The recorded version may itself be the garbage that made the
        // comparison fail (`not-a-version`) — telling the developer to
        // "update to" it, the cli-older fix's own move, would be nonsense
        // here. The uncomparable fix instead sends them to compare by hand.
        expect(fixLower).not.toContain("repository's recorded version");
        expect(fixLower).toContain('compare');
        expect(fixLower).toContain('setup');
        expect(fixLower).toContain('upgrade');
      },
    );

    it('gives version-uncomparable a fix distinct from the cli-older-than-repository one', async () => {
      await initProject(repo, {});
      await withManifestVersion(repo, await newerThanCli());
      const olderResult = await doctor();
      const olderFix = report(olderResult.stdout).checks.find((c) => c.id === 'rig-version')?.fix;

      const uncomparableRepo = await mkdtemp(path.join(tmpdir(), 'caf-doctor-'));
      try {
        await initProject(uncomparableRepo, {});
        await withManifestVersion(uncomparableRepo, 'not-a-version');
        const uncomparableResult = await runDoctor({
          cwd: uncomparableRepo,
          args: ['--json'],
          env: { HOME: home, APPDATA: home, PATH: process.env.PATH ?? '' },
        });
        const uncomparableFix = report(uncomparableResult.stdout).checks.find(
          (c) => c.id === 'rig-version',
        )?.fix;

        expect(olderFix).toBeTruthy();
        expect(uncomparableFix).toBeTruthy();
        expect(uncomparableFix).not.toBe(olderFix);
      } finally {
        await removeFixture(uncomparableRepo);
      }
    });

    it("shows both the CLI version and the repository's recorded version on the human-readable rig-version line", async () => {
      await initProject(repo, {});
      const recordedVersion = await newerThanCli();
      await withManifestVersion(repo, recordedVersion);
      const { raw: cliRaw } = await cliVersion();

      const result = await runDoctor({
        cwd: repo,
        args: [],
        env: { HOME: home, APPDATA: home, PATH: process.env.PATH ?? '' },
      });

      expect(result.exitCode, result.stderr).toBe(0);
      const lines = result.stdout.split('\n');
      const rigVersionLine = lines.find((line) => line.includes(': rig-version: '));
      expect(rigVersionLine).toBeDefined();
      expect(rigVersionLine).toContain(cliRaw);
      expect(rigVersionLine).toContain(recordedVersion);
    });

    it('emits no rig-version check when the manifest is absent', async () => {
      // No initProject: an empty repository has no manifest at all.
      const result = await doctor();
      const body = report(result.stdout);

      expect(body.checks.find((c) => c.id === 'rig-manifest')).toMatchObject({
        status: 'warn',
        reason: 'not-installed',
      });
      expect(body.checks.find((c) => c.id === 'rig-version')).toBeUndefined();
    });

    it('emits no rig-version check when the manifest is unreadable', async () => {
      await initProject(repo, {});
      await writeFile(path.join(repo, '.claude', '.rig-manifest.json'), 'not json at all {{{');

      const result = await doctor();
      const body = report(result.stdout);

      expect(body.checks.find((c) => c.id === 'rig-manifest')).toMatchObject({
        status: 'fail',
        reason: 'unreadable-manifest',
      });
      expect(body.checks.find((c) => c.id === 'rig-version')).toBeUndefined();
    });
  });
});
