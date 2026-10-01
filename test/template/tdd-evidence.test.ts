import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// RP-305 defines only a deterministic contract. Journal ingestion, claim
// writes and pr-ship enforcement are deliberately reserved for RP-306.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const helperPath = path.join(
  repoRoot,
  'templates',
  'agent-os',
  'universal',
  '.claude',
  'scripts',
  'lib',
  'tdd-evidence.mjs',
);
const load = () => import(pathToFileURL(helperPath).href);

const sha = (character: string) => character.repeat(64);
const baselineSha = 'd5eac957af3f8208d7ac06491ecf77eb7ec6a7ee';
const testIdentity = {
  file: 'test/template/tdd-evidence.test.ts',
  fullName: 'accepts a bounded portable TDD-2 chain',
  fileSha256: sha('a'),
};
const red = {
  test: testIdentity,
  source: { runId: '20261001-085300-rp-305', seq: 17 },
  observation: {
    outcome: 'fail',
    checkFingerprint: { algorithm: 'sha256', value: sha('f') },
  },
  fingerprint: { algorithm: 'sha256', value: sha('b') },
};

const portableDraft = () => ({
  schemaVersion: 1,
  ticket: 'RP-305',
  applicability: { level: 'TDD-2', authority: { kind: 'tracker', id: 'RP-305' } },
  baseline: { headSha: baselineSha },
  red: {
    test: { ...red.test },
    source: { ...red.source },
    observation: {
      outcome: red.observation.outcome,
      checkFingerprint: { ...red.observation.checkFingerprint },
    },
    fingerprint: { ...red.fingerprint },
  },
  implementationBoundary: {
    source: { runId: '20261001-085300-rp-305', seq: 18 },
    implementationDeltaFingerprint: { algorithm: 'sha256', value: sha('c') },
    fingerprint: { algorithm: 'sha256', value: sha('c') },
  },
  green: {
    test: { ...testIdentity },
    source: { runId: '20261001-085300-rp-305', seq: 19 },
    observation: {
      outcome: 'pass',
      checkFingerprint: { algorithm: 'sha256', value: sha('9') },
    },
    fingerprint: { algorithm: 'sha256', value: sha('d') },
  },
});

/**
 * The public canonicalizer creates the valid stage fingerprints; the tests
 * below then hold each fingerprint fixed while changing its material evidence.
 * This exercises correspondence in the independent validator, rather than
 * treating a fingerprint-shaped string as sufficient evidence.
 */
const portableTdd2 = async () => {
  const { fingerprintEvidence } = (await load()) as {
    fingerprintEvidence: (record: unknown) => { algorithm: string; value: string };
  };
  const record = portableDraft();
  record.red.fingerprint = fingerprintEvidence({
    stage: 'red',
    test: record.red.test,
    source: record.red.source,
    observation: record.red.observation,
  });
  record.implementationBoundary.fingerprint = fingerprintEvidence({
    stage: 'implementation-boundary',
    source: record.implementationBoundary.source,
    implementationDeltaFingerprint: record.implementationBoundary.implementationDeltaFingerprint,
  });
  record.green.fingerprint = fingerprintEvidence({
    stage: 'green',
    test: record.green.test,
    source: record.green.source,
    observation: record.green.observation,
  });
  return record;
};

describe('RP-305 authoritative applicability', () => {
  it('uses deterministic paths and attributable metadata: docs/test-only TDD-0, behavior TDD-2, declared release-critical TDD-3', async () => {
    const { resolveApplicability } = (await load()) as {
      resolveApplicability: (input: Record<string, unknown>) => {
        level: string;
        authority: string;
      };
    };

    expect(
      resolveApplicability({ changedPaths: ['docs/decisions/tdd-evidence.md'] }),
    ).toMatchObject({
      level: 'TDD-0',
      authority: 'path-contract',
    });
    expect(
      resolveApplicability({ changedPaths: ['test/template/tdd-evidence.test.ts'] }),
    ).toMatchObject({
      level: 'TDD-0',
      authority: 'path-contract',
    });
    for (const changedPath of [
      'packages/cli/test/upgrade.test.ts',
      'packages/cli/src/example.test.ts',
    ]) {
      expect(resolveApplicability({ changedPaths: [changedPath] }), changedPath).toMatchObject({
        level: 'TDD-0',
        authority: 'path-contract',
      });
    }
    expect(
      resolveApplicability({ changedPaths: ['packages/cli/src/commands/init.ts'] }),
    ).toMatchObject({
      level: 'TDD-2',
      authority: 'default-production',
    });
    expect(
      resolveApplicability({
        changedPaths: ['.claude/hooks/guard-bash.mjs'],
        authoritative: { level: 'TDD-3', id: 'RP-305' },
      }),
    ).toMatchObject({ level: 'TDD-3', authority: 'tracker' });
  });

  it('rejects controller prose and self-asserted waiver metadata, but honors a separate trusted tracker decision', async () => {
    const { resolveApplicability } = (await load()) as {
      resolveApplicability: (input: Record<string, unknown>) => {
        level: string;
        authority: string;
      };
    };
    const behavior = { changedPaths: ['packages/cli/src/commands/init.ts'] };

    expect(
      resolveApplicability({
        ...behavior,
        waiver: { level: 'TDD-0', kind: 'controller-prose', text: 'this is a refactor' },
      }),
    ).toMatchObject({ level: 'TDD-2', authority: 'default-production' });
    expect(
      resolveApplicability({
        ...behavior,
        waiver: {
          level: 'TDD-0',
          kind: 'owner',
          id: 'owner-comment-42',
          source: {
            system: 'jira',
            issue: 'RP-305',
            commentId: '21523',
            actor: 'owner',
            verified: true,
          },
        },
      }),
    ).toMatchObject({ level: 'TDD-2', authority: 'default-production' });
    expect(
      resolveApplicability({
        ...behavior,
        authoritative: { level: 'TDD-0', id: 'RP-305' },
      }),
    ).toMatchObject({ level: 'TDD-2', authority: 'default-production' });
    expect(
      resolveApplicability({
        ...behavior,
        trustedTrackerDecision: {
          level: 'TDD-0',
          source: { system: 'jira', issue: 'RP-305', commentId: '21523', actor: 'owner' },
        },
      }),
    ).toMatchObject({ level: 'TDD-0', authority: 'owner-waiver' });
  });

  it('permits a pure-refactor TDD-0 exemption only for the same structured GREEN identities and hashes before and after', async () => {
    const { validateRefactorEvidence, resolveApplicability } = (await load()) as {
      validateRefactorEvidence: (input: Record<string, unknown>) => { ok: boolean };
      resolveApplicability: (input: Record<string, unknown>) => {
        level: string;
        authority: string;
      };
    };
    const unchangedGreen = {
      before: [{ ...testIdentity, outcome: 'pass' }],
      after: [{ ...testIdentity, outcome: 'pass' }],
    };

    expect(validateRefactorEvidence(unchangedGreen)).toEqual({ ok: true });
    expect(
      resolveApplicability({
        changedPaths: ['packages/cli/src/commands/init.ts'],
        pureRefactor: unchangedGreen,
      }),
    ).toMatchObject({ level: 'TDD-0', authority: 'pure-refactor-proof' });

    expect(
      resolveApplicability({
        changedPaths: ['packages/cli/src/commands/init.ts'],
        pureRefactor: unchangedGreen,
        finalBehaviorPaths: ['packages/cli/src/commands/init.ts'],
      }),
    ).toMatchObject({ level: 'TDD-2', authority: 'final-diff' });

    const changedHash = {
      ...unchangedGreen,
      after: [{ ...testIdentity, fileSha256: sha('e'), outcome: 'pass' }],
    };
    expect(validateRefactorEvidence(changedHash)).toEqual({ ok: false });
    expect(
      resolveApplicability({
        changedPaths: ['packages/cli/src/commands/init.ts'],
        pureRefactor: changedHash,
      }),
    ).toMatchObject({ level: 'TDD-2', authority: 'default-production' });

    const changedIdentity = {
      ...unchangedGreen,
      after: [
        { ...testIdentity, fullName: 'a different test with the same count', outcome: 'pass' },
      ],
    };
    expect(validateRefactorEvidence(changedIdentity)).toEqual({ ok: false });
  });
});

describe('RP-305 portable evidence contract', () => {
  it('treats TDD-1 as observed RED only, while TDD-0 accepts no execution stages', async () => {
    const { validatePortableEvidence } = (await load()) as {
      validatePortableEvidence: (record: unknown) => { ok: boolean; problems?: string[] };
    };
    const tdd2 = await portableTdd2();
    const tdd1 = {
      schemaVersion: tdd2.schemaVersion,
      ticket: tdd2.ticket,
      applicability: { level: 'TDD-1', authority: { kind: 'tracker', id: 'RP-305' } },
      baseline: tdd2.baseline,
      red: tdd2.red,
    };
    expect(validatePortableEvidence(tdd1)).toEqual({ ok: true });

    const missingRed = { ...tdd1 } as Partial<typeof tdd1>;
    delete missingRed.red;
    expect(validatePortableEvidence(missingRed)).toMatchObject({ ok: false });
    expect(validatePortableEvidence({ ...tdd1, red: {} })).toMatchObject({ ok: false });

    const tdd1FutureStages: ReadonlyArray<readonly [string, unknown]> = [
      ['implementationBoundary', tdd2.implementationBoundary],
      ['green', tdd2.green],
      ['nonVacuity', { ...tdd2.red, source: { ...tdd2.red.source, seq: 20 } }],
    ];
    for (const [name, value] of tdd1FutureStages) {
      expect(validatePortableEvidence({ ...tdd1, [name]: value }), name).toMatchObject({
        ok: false,
      });
    }

    const tdd0 = {
      schemaVersion: tdd2.schemaVersion,
      ticket: tdd2.ticket,
      applicability: { level: 'TDD-0', authority: { kind: 'tracker', id: 'RP-305' } },
      baseline: tdd2.baseline,
    };
    expect(validatePortableEvidence(tdd0)).toEqual({ ok: true });
    const tdd0ExecutionStages: ReadonlyArray<readonly [string, unknown]> = [
      ['red', tdd2.red],
      ['implementationBoundary', tdd2.implementationBoundary],
      ['green', tdd2.green],
      ['nonVacuity', { ...tdd2.red, source: { ...tdd2.red.source, seq: 20 } }],
    ];
    for (const [name, value] of tdd0ExecutionStages) {
      expect(validatePortableEvidence({ ...tdd0, [name]: value }), name).toMatchObject({
        ok: false,
      });
    }
  });

  it('accepts a bounded portable TDD-2 chain rooted at BASELINE_CREATED with same-spec RED and GREEN evidence', async () => {
    const { validatePortableEvidence } = (await load()) as {
      validatePortableEvidence: (record: unknown) => { ok: boolean; problems?: string[] };
    };
    expect(validatePortableEvidence(await portableTdd2())).toEqual({ ok: true });
  });

  it('invalidates a RED when GREEN changes its test-file hash or material evidence, and requires non-vacuity evidence for TDD-3', async () => {
    const { validatePortableEvidence, fingerprintEvidence } = (await load()) as {
      validatePortableEvidence: (record: unknown) => { ok: boolean; problems?: string[] };
      fingerprintEvidence: (record: unknown) => { algorithm: string; value: string };
    };
    const changedTest = await portableTdd2();
    changedTest.green.test = { ...testIdentity, fileSha256: sha('e') };
    changedTest.green.fingerprint = fingerprintEvidence({
      stage: 'green',
      test: changedTest.green.test,
      source: changedTest.green.source,
    });
    expect(validatePortableEvidence(changedTest)).toMatchObject({
      ok: false,
      problems: expect.arrayContaining(['green.test.fileSha256 must equal red.test.fileSha256']),
    });

    const stale = await portableTdd2();
    stale.green.source.seq = 20;
    expect(validatePortableEvidence(stale)).toMatchObject({
      ok: false,
      problems: expect.arrayContaining(['green.fingerprint must match canonical evidence']),
    });

    const tdd3 = await portableTdd2();
    tdd3.applicability = { level: 'TDD-3', authority: { kind: 'tracker', id: 'RP-305' } };
    expect(validatePortableEvidence(tdd3)).toMatchObject({
      ok: false,
      problems: expect.arrayContaining(['nonVacuity is required for TDD-3']),
    });
  });

  it('requires independently observed check-result outcomes and fingerprints, plus a bounded implementation delta', async () => {
    const { validatePortableEvidence } = (await load()) as {
      validatePortableEvidence: (record: unknown) => { ok: boolean; problems?: string[] };
    };
    const missingObservation = await portableTdd2();
    delete (missingObservation.red as Partial<typeof missingObservation.red>).observation;
    expect(validatePortableEvidence(missingObservation)).toMatchObject({
      ok: false,
      problems: expect.arrayContaining([
        'red.observation must bind a check-result outcome and fingerprint',
      ]),
    });

    const missingDelta = await portableTdd2();
    delete (
      missingDelta.implementationBoundary as Partial<typeof missingDelta.implementationBoundary>
    ).implementationDeltaFingerprint;
    expect(validatePortableEvidence(missingDelta)).toMatchObject({
      ok: false,
      problems: expect.arrayContaining([
        'implementationBoundary.implementationDeltaFingerprint must be a SHA-256 fingerprint',
      ]),
    });
  });

  it('requires a TDD-3 non-vacuity check to be an independently observed RED', async () => {
    const { validatePortableEvidence, fingerprintEvidence } = (await load()) as {
      validatePortableEvidence: (record: unknown) => { ok: boolean; problems?: string[] };
      fingerprintEvidence: (record: unknown) => { algorithm: string; value: string };
    };
    const tdd3 = await portableTdd2();
    tdd3.applicability = { level: 'TDD-3', authority: { kind: 'tracker', id: 'RP-305' } };
    const nonVacuity = {
      test: { ...testIdentity },
      source: { runId: '20261001-085300-rp-305', seq: 20 },
      observation: {
        outcome: 'fail',
        checkFingerprint: { algorithm: 'sha256', value: sha('8') },
      },
      fingerprint: { algorithm: 'sha256', value: sha('0') },
    };
    nonVacuity.fingerprint = fingerprintEvidence({
      stage: 'non-vacuity',
      test: nonVacuity.test,
      source: nonVacuity.source,
      observation: nonVacuity.observation,
    });
    (tdd3 as Record<string, unknown>).nonVacuity = nonVacuity;
    expect(validatePortableEvidence(tdd3)).toEqual({ ok: true });

    nonVacuity.observation.outcome = 'pass';
    nonVacuity.fingerprint = fingerprintEvidence({
      stage: 'non-vacuity',
      test: nonVacuity.test,
      source: nonVacuity.source,
      observation: nonVacuity.observation,
    });
    expect(validatePortableEvidence(tdd3)).toMatchObject({
      ok: false,
      problems: expect.arrayContaining(['nonVacuity.observation.outcome must be fail']),
    });
  });

  it('refuses raw journal material and fingerprints canonical bounded evidence with explicit SHA-256', async () => {
    const { validatePortableEvidence, fingerprintEvidence } = (await load()) as {
      validatePortableEvidence: (record: unknown) => { ok: boolean; problems?: string[] };
      fingerprintEvidence: (record: unknown) => { algorithm: string; value: string };
    };
    const evidence = await portableTdd2();
    (evidence as Record<string, unknown>).rawTerminalOutput = 'unbounded raw log';
    expect(validatePortableEvidence(evidence)).toMatchObject({
      ok: false,
      problems: expect.arrayContaining(['rawTerminalOutput is not permitted in portable evidence']),
    });

    const first = fingerprintEvidence(await portableTdd2());
    const record = await portableTdd2();
    const { green, ...withoutGreen } = record;
    const reordered = fingerprintEvidence({ green, ...withoutGreen });
    const changed = await portableTdd2();
    changed.green.source.seq = 20;
    expect(first).toMatchObject({
      algorithm: 'sha256',
      value: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(reordered).toEqual(first);
    expect(fingerprintEvidence(changed)).not.toEqual(first);
  });
});
