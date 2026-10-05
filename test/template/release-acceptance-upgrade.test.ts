/**
 * RP-374 — predecessor upgrade acceptance.
 *
 * Round 1 landed `scripts/release-acceptance.mjs`'s `acquirePredecessor`,
 * `acceptPredecessorUpgrade`, `assertUserMutationsPreserved`,
 * `latestReleasedLedgerVersion`, `assertVersionAdvances` and `parseSemver` —
 * those functions exist today and the describe blocks below that exercise
 * them unchanged are GREEN. This file now pins round 2's review blockers,
 * none of which production implements yet:
 *
 *   - integrity bound to the repo, not the registry: `acquirePredecessor`
 *     must take a new `expectedIntegrity` option (a `sha512-…` base64
 *     digest) and refuse a mismatch BEFORE calling `install`, exactly like
 *     the existing `expectedShasum`/`expectedGitHead` checks
 *     ('predecessor-integrity-mismatch'). Production will also add
 *     `scripts/release-predecessor-integrity.json` (released version ->
 *     `{ integrity, shasum }`) as the in-repo source of that expectation —
 *     this file pins that the record exists and is shaped correctly for the
 *     ledger's latest released version.
 *   - `changedFiles(beforeSnapshot, afterSnapshot)`: a small pure helper,
 *     not yet exported, mirroring the module's existing internal
 *     `changedPaths` — the diff `acceptPredecessorUpgrade` is expected to
 *     report for both the first and the second upgrade.
 *   - `assertPackFilename(name)`: not yet exported — refuses a pack-report
 *     filename that is not a plain basename ending in `.tgz` before it is
 *     ever joined onto a directory and used as a path.
 *   - `parseSemver`'s regex is anchored only at the start
 *     (`/^(\d+)\.(\d+)\.(\d+)/`), so a version string carrying extra range
 *     syntax after a valid-looking prefix is accepted rather than refused.
 *   - `assertUserMutationsPreserved`'s deletion check treats ANY `access()`
 *     failure, not only `ENOENT`, as "the deletion held" — a different I/O
 *     failure on that path is misreported as success.
 *
 * The heavy, real-tarball case ("accepts an immutable published predecessor
 * upgrade with an exact packed candidate") moved to
 * `test/e2e/release-acceptance-upgrade.test.ts`: it used to run `npm pack`
 * at the repo root directly, which also runs the `prepare` lifecycle and
 * rebuilds `packages/cli/dist` mid-suite — exactly the race
 * `test/e2e/pack-once.ts` exists to remove. The e2e copy reuses that
 * project's single packed candidate tarball and the repo's win32-safe
 * `runPackageManager` helper instead.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeFixture } from '../helpers/remove-fixture.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = path.join(repoRoot, 'scripts', 'release-acceptance.mjs');

// Real, published values for 1.1.1 (journal/ledger evidence) — used only as
// realistic fixture data; the identity checks below verify them against
// injected registry metadata and a locally built stand-in tarball, never
// against the real npm registry.
const REAL_1_1_1_GIT_HEAD = 'd5eac957af3f8208d7ac06491ecf77eb7ec6a7ee';

// ENOTDIR on an access() over a path whose parent segment is a plain file is
// reliably portable on POSIX, but Windows path resolution does not
// distinguish that case from ENOENT the same way — so the access-errno case
// below is constructible only where this holds. Computed once, by name,
// rather than written inline into a `skipIf(...)` call — see
// platform-skips.test.ts, which refuses a bare `process.platform` check
// inside `skipIf`/`runIf` and is satisfied by the same shape
// `gh-child-timeout-classification.test.ts`'s `canSendRealSignals` already
// uses.
const accessErrnoIsDistinguishable = process.platform !== 'win32';

type Module = {
  latestReleasedLedgerVersion?: (ledger: Record<string, string | null>) => string;
  assertVersionAdvances?: (predecessor: string, candidate: string) => void;
  acquirePredecessor?: <T>(options: {
    expectedGitHead: string;
    expectedShasum: string;
    expectedIntegrity: string;
    registryView: { gitHead?: string };
    tarballPath: string;
    install: (tarballPath: string) => Promise<T>;
  }) => Promise<T>;
  assertUserMutationsPreserved?: (options: {
    root: string;
    editedPath: string;
    editedContent: string;
    deletedPath: string;
    addedPath: string;
    addedContent: string;
  }) => Promise<void>;
  acceptPredecessorUpgrade?: (options: {
    scratch: string;
    env: NodeJS.ProcessEnv;
    predecessorCli: string;
    candidateCli: string;
    candidateVersion: string;
  }) => Promise<{
    manifestVersion: string;
    firstUpgradeChangedFiles: string[];
    secondUpgradeChangedFiles: string[];
  }>;
  changedFiles?: (before: Map<string, string>, after: Map<string, string>) => string[];
  assertPackFilename?: (name: string) => void;
};

async function importScript(): Promise<Module> {
  return (await import(pathToFileURL(script).href)) as Module;
}

async function sha1File(file: string): Promise<string> {
  return createHash('sha1')
    .update(await readFile(file))
    .digest('hex');
}

async function sha512IntegrityOf(file: string): Promise<string> {
  return `sha512-${createHash('sha512')
    .update(await readFile(file))
    .digest('base64')}`;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: string }).code
    : undefined;
}

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'caf-predecessor-upgrade-'));
});

afterEach(async () => {
  await removeFixture(scratch);
});

describe('release acceptance predecessor ledger lookup', () => {
  it('resolves the highest ledger version that already has a recorded gitHead', async () => {
    const module = await importScript();
    expect(module.latestReleasedLedgerVersion).toBeTypeOf('function');

    const ledger = {
      '0.1.0': null,
      '1.1.0': 'a'.repeat(40),
      '1.1.1': REAL_1_1_1_GIT_HEAD,
    };

    expect(module.latestReleasedLedgerVersion!(ledger)).toBe('1.1.1');
  });

  it('refuses a ledger with no recorded gitHead at all', async () => {
    const module = await importScript();
    expect(module.latestReleasedLedgerVersion).toBeTypeOf('function');

    let caught: unknown;
    try {
      module.latestReleasedLedgerVersion!({ '0.1.0': null });
    } catch (error) {
      caught = error;
    }

    expect(errorCode(caught)).toBe('ledger-empty');
  });
});

describe('release acceptance candidate version advance', () => {
  it('accepts a candidate strictly greater than the predecessor', async () => {
    const module = await importScript();
    expect(module.assertVersionAdvances).toBeTypeOf('function');

    expect(() => module.assertVersionAdvances!('1.1.1', '1.2.0')).not.toThrow();
  });

  it.each([
    ['equal to the predecessor', '1.1.1', '1.1.1'],
    ['lower than the predecessor', '1.1.1', '1.1.0'],
  ])('refuses a candidate version %s', async (_label, predecessor, candidate) => {
    const module = await importScript();
    expect(module.assertVersionAdvances).toBeTypeOf('function');

    let caught: unknown;
    try {
      module.assertVersionAdvances!(predecessor, candidate);
    } catch (error) {
      caught = error;
    }

    expect(errorCode(caught)).toBe('candidate-version-not-advancing');
  });
});

describe('release acceptance predecessor identity', () => {
  async function stubTarball(bytes: string): Promise<string> {
    const file = path.join(scratch, 'stand-in-predecessor.tgz');
    await writeFile(file, bytes);
    return file;
  }

  it('shasum mismatch is refused before the predecessor runs', async () => {
    const module = await importScript();
    expect(module.acquirePredecessor).toBeTypeOf('function');

    const tarballPath = await stubTarball('predecessor bytes that do not match\n');
    const expectedIntegrity = await sha512IntegrityOf(tarballPath);
    let installCalls = 0;

    let caught: unknown;
    try {
      await module.acquirePredecessor!({
        expectedGitHead: REAL_1_1_1_GIT_HEAD,
        expectedShasum: 'f'.repeat(40), // deliberately not this tarball's real sha1
        expectedIntegrity,
        registryView: { gitHead: REAL_1_1_1_GIT_HEAD },
        tarballPath,
        install: async () => {
          installCalls += 1;
          return 'should never run';
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(errorCode(caught)).toBe('predecessor-shasum-mismatch');
    expect(installCalls).toBe(0);
  });

  it('gitHead mismatch is refused before the predecessor runs', async () => {
    const module = await importScript();
    expect(module.acquirePredecessor).toBeTypeOf('function');

    const tarballPath = await stubTarball('predecessor bytes with a correct shasum\n');
    const expectedShasum = await sha1File(tarballPath);
    const expectedIntegrity = await sha512IntegrityOf(tarballPath);
    let installCalls = 0;

    let caught: unknown;
    try {
      await module.acquirePredecessor!({
        expectedGitHead: REAL_1_1_1_GIT_HEAD,
        expectedShasum,
        expectedIntegrity,
        registryView: { gitHead: '0'.repeat(40) }, // does not match expectedGitHead
        tarballPath,
        install: async () => {
          installCalls += 1;
          return 'should never run';
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(errorCode(caught)).toBe('predecessor-githead-mismatch');
    expect(installCalls).toBe(0);
  });

  it('integrity mismatch is refused before the predecessor runs, even when the shasum and gitHead are correct', async () => {
    const module = await importScript();
    expect(module.acquirePredecessor).toBeTypeOf('function');

    const tarballPath = await stubTarball('predecessor bytes for the integrity check\n');
    const expectedShasum = await sha1File(tarballPath);
    // A well-formed but wrong sha512 digest — computed independently of this
    // tarball's real bytes, never derived from the production mechanism under
    // test (`.claude/rules/invariants.md`, "independent-oracle invariant").
    const expectedIntegrity = `sha512-${createHash('sha512').update('not the real bytes').digest('base64')}`;
    let installCalls = 0;

    let caught: unknown;
    try {
      await module.acquirePredecessor!({
        expectedGitHead: REAL_1_1_1_GIT_HEAD,
        expectedShasum,
        expectedIntegrity,
        registryView: { gitHead: REAL_1_1_1_GIT_HEAD },
        tarballPath,
        install: async () => {
          installCalls += 1;
          return 'should never run';
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(errorCode(caught)).toBe('predecessor-integrity-mismatch');
    expect(installCalls).toBe(0);
  });

  it('accepts a tarball whose hash, integrity and gitHead all match, and only then runs it', async () => {
    const module = await importScript();
    expect(module.acquirePredecessor).toBeTypeOf('function');

    const tarballPath = await stubTarball('predecessor bytes, verified\n');
    const expectedShasum = await sha1File(tarballPath);
    const expectedIntegrity = await sha512IntegrityOf(tarballPath);
    let installedWith: string | undefined;

    const result = await module.acquirePredecessor!({
      expectedGitHead: REAL_1_1_1_GIT_HEAD,
      expectedShasum,
      expectedIntegrity,
      registryView: { gitHead: REAL_1_1_1_GIT_HEAD },
      tarballPath,
      install: async (installTarballPath) => {
        installedWith = installTarballPath;
        return 'installed';
      },
    });

    expect(installedWith).toBe(tarballPath);
    expect(result).toBe('installed');
  });
});

describe('release acceptance predecessor integrity record', () => {
  it('records a sha512 integrity and a 40-hex shasum for the ledger’s latest released version', async () => {
    const ledger = JSON.parse(
      await readFile(path.join(repoRoot, 'templates', 'release-ledger.json'), 'utf8'),
    ) as Record<string, string | null>;

    // Computed independently of `latestReleasedLedgerVersion` — this test
    // must not derive its expectation from the same production mechanism it
    // is implicitly checking (`.claude/rules/invariants.md`,
    // "independent-oracle invariant").
    const released = Object.entries(ledger)
      .filter(([, gitHead]) => typeof gitHead === 'string' && gitHead.length > 0)
      .map(([version]) => version)
      .sort((a, b) => {
        const av = a.split('.').map(Number);
        const bv = b.split('.').map(Number);
        return av[0]! - bv[0]! || av[1]! - bv[1]! || av[2]! - bv[2]!;
      });
    const latest = released[released.length - 1];
    expect(latest, 'the ledger has no released version to look up').toBeTruthy();

    const record = JSON.parse(
      await readFile(path.join(repoRoot, 'scripts', 'release-predecessor-integrity.json'), 'utf8'),
    ) as Record<string, { integrity?: string; shasum?: string } | undefined>;

    expect(record[latest!]?.integrity).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/);
    expect(record[latest!]?.shasum).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('release acceptance user-mutation preservation', () => {
  it('detects a lost user edit (mutation-style: the upgrade restored upstream content)', async () => {
    const module = await importScript();
    expect(module.assertUserMutationsPreserved).toBeTypeOf('function');

    const root = scratch;
    await mkdir(path.join(root, '.claude', 'rules'), { recursive: true });
    // Simulates the regression this check exists to catch: upstream content
    // sits where the user's edit should still be.
    await writeFile(path.join(root, '.claude', 'rules', 'workflow.md'), 'upstream content\n');
    await writeFile(path.join(root, 'user-notes.md'), 'kept across upgrade\n');
    // deletedPath intentionally absent — that half is correctly preserved.

    let caught: unknown;
    try {
      await module.assertUserMutationsPreserved!({
        root,
        editedPath: '.claude/rules/workflow.md',
        editedContent: 'upstream content\nuser edit marker\n',
        deletedPath: '.claude/rules/autonomy.md',
        addedPath: 'user-notes.md',
        addedContent: 'kept across upgrade\n',
      });
    } catch (error) {
      caught = error;
    }

    expect(errorCode(caught)).toBe('user-edit-lost');
  });

  it('passes when the edit, the deletion and the addition are all exactly as recorded', async () => {
    const module = await importScript();
    expect(module.assertUserMutationsPreserved).toBeTypeOf('function');

    const root = scratch;
    await mkdir(path.join(root, '.claude', 'rules'), { recursive: true });
    await writeFile(
      path.join(root, '.claude', 'rules', 'workflow.md'),
      'upstream content\nuser edit marker\n',
    );
    await writeFile(path.join(root, 'user-notes.md'), 'kept across upgrade\n');

    await expect(
      module.assertUserMutationsPreserved!({
        root,
        editedPath: '.claude/rules/workflow.md',
        editedContent: 'upstream content\nuser edit marker\n',
        deletedPath: '.claude/rules/autonomy.md',
        addedPath: 'user-notes.md',
        addedContent: 'kept across upgrade\n',
      }),
    ).resolves.toBeUndefined();
  });

  // ENOTDIR is reliably portable on POSIX — measured directly: `fs.access`
  // over a path whose parent segment is a plain file (not a directory) yields
  // `ENOTDIR`, never `ENOENT`. See `accessErrnoIsDistinguishable` above for
  // why that makes this case about the behaviour under test only where it
  // holds.
  it.skipIf(!accessErrnoIsDistinguishable)(
    'does not read a non-ENOENT access failure on the deleted path as the deletion holding',
    async () => {
      const module = await importScript();
      expect(module.assertUserMutationsPreserved).toBeTypeOf('function');

      const root = scratch;
      await mkdir(path.join(root, '.claude', 'rules'), { recursive: true });
      await writeFile(
        path.join(root, '.claude', 'rules', 'workflow.md'),
        'upstream content\nuser edit marker\n',
      );
      await writeFile(path.join(root, 'user-notes.md'), 'kept across upgrade\n');
      // deletedPath's PARENT segment is a plain file, not a directory — access()
      // on the full path fails with ENOTDIR, never ENOENT.
      await writeFile(path.join(root, 'not-a-directory'), 'x\n');

      let caught: unknown;
      try {
        await module.assertUserMutationsPreserved!({
          root,
          editedPath: '.claude/rules/workflow.md',
          editedContent: 'upstream content\nuser edit marker\n',
          deletedPath: 'not-a-directory/child.md',
          addedPath: 'user-notes.md',
          addedContent: 'kept across upgrade\n',
        });
      } catch (error) {
        caught = error;
      }

      expect(errorCode(caught)).toBe('user-delete-check-failed');
    },
  );
});

describe('release acceptance changed-files diff', () => {
  it('returns the changed and added paths between two differing snapshots', async () => {
    const module = await importScript();
    expect(module.changedFiles).toBeTypeOf('function');

    const before = new Map([
      ['a', 'hash-a'],
      ['b', 'hash-b'],
    ]);
    const after = new Map([
      ['a', 'hash-a'],
      ['b', 'hash-b-changed'],
      ['c', 'hash-c'],
    ]);

    expect(module.changedFiles!(before, after)).toEqual(['b', 'c']);
  });

  it('returns no paths when the two snapshots are equal', async () => {
    const module = await importScript();
    expect(module.changedFiles).toBeTypeOf('function');

    const snapshot = new Map([['a', 'hash-a']]);

    expect(module.changedFiles!(snapshot, new Map(snapshot))).toEqual([]);
  });
});

describe('release acceptance pack filename hardening', () => {
  it.each([
    ['a parent-escaping relative path', '../evil.tgz'],
    ['an absolute path', path.join(path.sep, 'etc', 'evil.tgz')],
    ['a non-.tgz extension', 'create-agent-rig-1.2.0.zip'],
    ['no extension at all', 'create-agent-rig-1.2.0'],
  ])('refuses a pack report filename that is %s', async (_label, filename) => {
    const module = await importScript();
    expect(module.assertPackFilename).toBeTypeOf('function');

    let caught: unknown;
    try {
      module.assertPackFilename!(filename);
    } catch (error) {
      caught = error;
    }

    expect(errorCode(caught)).toBe('pack-report-invalid');
  });

  it('accepts a plain basename ending in .tgz', async () => {
    const module = await importScript();
    expect(module.assertPackFilename).toBeTypeOf('function');

    expect(() => module.assertPackFilename!('create-agent-rig-1.2.0.tgz')).not.toThrow();
  });
});

describe('release acceptance semver parsing hardening', () => {
  it('refuses a ledger version string that smuggles range syntax after a valid-looking prefix', async () => {
    const module = await importScript();
    expect(module.latestReleasedLedgerVersion).toBeTypeOf('function');

    // Two entries, so the sort this function performs actually invokes the
    // comparator (and therefore `parseSemver`) on the malicious string — a
    // single-entry ledger never calls the comparator at all.
    const ledger = {
      '1.0.0': 'a'.repeat(40),
      '1.1.1 || >=0': REAL_1_1_1_GIT_HEAD,
    };

    let caught: unknown;
    try {
      module.latestReleasedLedgerVersion!(ledger);
    } catch (error) {
      caught = error;
    }

    expect(errorCode(caught)).toBe('invalid-semver');
  });
});
