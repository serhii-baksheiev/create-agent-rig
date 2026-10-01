import { createHash } from 'node:crypto';
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
    predecessorFingerprint: { algorithm: 'sha256', value: sha('0') },
    fingerprint: { algorithm: 'sha256', value: sha('c') },
  },
  green: {
    test: { ...testIdentity },
    source: { runId: '20261001-085300-rp-305', seq: 19 },
    observation: {
      outcome: 'pass',
      checkFingerprint: { algorithm: 'sha256', value: sha('9') },
    },
    predecessorFingerprint: { algorithm: 'sha256', value: sha('0') },
    fingerprint: { algorithm: 'sha256', value: sha('d') },
  },
});

/**
 * The public canonicalizer creates the valid stage fingerprints; the tests
 * below then hold each fingerprint fixed while changing its material evidence.
 * This exercises correspondence in the independent validator, rather than
 * treating a fingerprint-shaped string as sufficient evidence.
 */
const linkPortableTdd2 = async (record: ReturnType<typeof portableDraft>) => {
  const { fingerprintEvidence } = (await load()) as {
    fingerprintEvidence: (record: unknown) => { algorithm: string; value: string };
  };
  record.red.fingerprint = fingerprintEvidence({
    ticket: record.ticket,
    baselineHeadSha: record.baseline.headSha,
    stage: 'red',
    test: record.red.test,
    source: record.red.source,
    observation: record.red.observation,
  });
  record.implementationBoundary.predecessorFingerprint = { ...record.red.fingerprint };
  record.implementationBoundary.fingerprint = fingerprintEvidence({
    ticket: record.ticket,
    baselineHeadSha: record.baseline.headSha,
    stage: 'implementation-boundary',
    source: record.implementationBoundary.source,
    implementationDeltaFingerprint: record.implementationBoundary.implementationDeltaFingerprint,
    predecessorFingerprint: record.implementationBoundary.predecessorFingerprint,
  });
  record.green.predecessorFingerprint = { ...record.implementationBoundary.fingerprint };
  record.green.fingerprint = fingerprintEvidence({
    ticket: record.ticket,
    baselineHeadSha: record.baseline.headSha,
    stage: 'green',
    test: record.green.test,
    source: record.green.source,
    observation: record.green.observation,
    predecessorFingerprint: record.green.predecessorFingerprint,
  });
  return record;
};

const portableTdd2 = () => linkPortableTdd2(portableDraft());

describe('RP-305 authoritative applicability', () => {
  it('uses deterministic paths and attributable metadata: docs/test-only TDD-0, behavior TDD-2, declared release-critical TDD-3', async () => {
    const { resolveApplicability } = (await load()) as {
      resolveApplicability: (
        input: Record<string, unknown>,
        trusted?: Record<string, unknown>,
      ) => {
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
    const safetyWork = { ticket: 'RP-305', changedPaths: ['.claude/hooks/guard-bash.mjs'] };
    expect(
      resolveApplicability({ ...safetyWork, authoritative: { level: 'TDD-3', id: 'RP-305' } }),
    ).toMatchObject({ level: 'TDD-2', authority: 'default-production' });
    expect(
      resolveApplicability(safetyWork, {
        trackerDecision: {
          level: 'TDD-3',
          source: { system: 'jira', issue: 'RP-305', commentId: '21523', actor: 'owner' },
        },
      }),
    ).toMatchObject({ level: 'TDD-3', authority: 'tracker' });
  });

  it('rejects self-asserted waiver metadata and accepts only an attributable second-argument tracker decision', async () => {
    const { resolveApplicability } = (await load()) as {
      resolveApplicability: (
        input: Record<string, unknown>,
        trusted?: Record<string, unknown>,
      ) => {
        level: string;
        authority: string;
      };
    };
    const behavior = { ticket: 'RP-305', changedPaths: ['packages/cli/src/commands/init.ts'] };

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
    ).toMatchObject({ level: 'TDD-2', authority: 'default-production' });
    expect(
      resolveApplicability(behavior, { trackerDecision: { level: 'TDD-0', source: {} } }),
    ).toMatchObject({ level: 'TDD-2', authority: 'default-production' });
    expect(
      resolveApplicability(behavior, {
        trackerDecision: {
          level: 'TDD-0',
          source: { system: 'jira', issue: 'RP-999', commentId: '21523', actor: 'owner' },
        },
      }),
    ).toMatchObject({ level: 'TDD-2', authority: 'default-production' });
    expect(
      resolveApplicability(behavior, {
        trackerDecision: {
          level: 'TDD-0',
          source: { system: 'jira', issue: 'RP-305', commentId: '21523', actor: 'owner' },
        },
      }),
    ).toMatchObject({ level: 'TDD-2', authority: 'default-production' });
    expect(
      resolveApplicability(behavior, {
        trackerDecision: {
          level: 'TDD-0',
          source: {
            system: 'jira',
            issue: 'RP-305',
            commentId: '21523',
            actor: 'owner',
            decisionContentFingerprint: { algorithm: 'sha256', value: sha('7') },
          },
        },
      }),
    ).toMatchObject({ level: 'TDD-0', authority: 'owner-waiver' });
  });

  it('requires tracker-produced complete evidence for a pure-refactor TDD-0 exemption', async () => {
    const { fingerprintEvidence, validateRefactorEvidence, resolveApplicability } =
      (await load()) as {
        fingerprintEvidence: (record: unknown) => { algorithm: string; value: string };
        validateRefactorEvidence: (input: Record<string, unknown>) => { ok: boolean };
        resolveApplicability: (
          input: Record<string, unknown>,
          trusted?: Record<string, unknown>,
        ) => {
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
    ).toMatchObject({ level: 'TDD-2', authority: 'default-production' });

    const ticket = 'RP-305';
    const baselineHeadSha = baselineSha;
    const testSet = { count: 2, fingerprint: { algorithm: 'sha256', value: sha('6') } };
    const before = {
      source: { runId: 'controller-a', seq: 17 },
      outcome: 'pass',
      checkFingerprint: { algorithm: 'sha256', value: sha('5') },
      testSetFingerprint: { ...testSet.fingerprint },
    };
    const after = {
      source: { runId: 'controller-a', seq: 18 },
      outcome: 'pass',
      checkFingerprint: { algorithm: 'sha256', value: sha('4') },
      testSetFingerprint: { ...testSet.fingerprint },
    };
    const trustedRefactorEvidence = {
      ticket,
      baselineHeadSha,
      testSet,
      before,
      after,
      fingerprint: fingerprintEvidence({ ticket, baselineHeadSha, testSet, before, after }),
    };
    expect(
      resolveApplicability({
        ticket,
        baselineHeadSha,
        changedPaths: ['packages/cli/src/commands/init.ts'],
        trustedRefactorEvidence,
      }),
    ).toMatchObject({ level: 'TDD-2', authority: 'default-production' });
    expect(
      resolveApplicability(
        { ticket, baselineHeadSha, changedPaths: ['packages/cli/src/commands/init.ts'] },
        { refactorEvidence: trustedRefactorEvidence },
      ),
    ).toMatchObject({ level: 'TDD-0', authority: 'trusted-refactor-evidence' });
    const trustedMaterial = { ticket, baselineHeadSha, testSet, before, after };
    const failedTrustedRefactorEvidence = {
      ...trustedMaterial,
      after: { ...after, outcome: 'fail' },
    };
    const failedTrustedWithFingerprint = {
      ...failedTrustedRefactorEvidence,
      fingerprint: fingerprintEvidence(failedTrustedRefactorEvidence),
    };
    expect(
      resolveApplicability(
        { ticket, baselineHeadSha, changedPaths: ['packages/cli/src/commands/init.ts'] },
        { refactorEvidence: failedTrustedWithFingerprint },
      ),
    ).toMatchObject({ level: 'TDD-2', authority: 'default-production' });

    expect(
      resolveApplicability(
        {
          changedPaths: ['packages/cli/src/commands/init.ts'],
          ticket,
          baselineHeadSha,
          trustedRefactorEvidence,
          finalBehaviorPaths: ['packages/cli/src/commands/init.ts'],
        },
        { refactorEvidence: trustedRefactorEvidence },
      ),
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
    const oversized = {
      before: Array.from({ length: 513 }, () => ({ ...testIdentity, outcome: 'pass' })),
      after: Array.from({ length: 513 }, () => ({ ...testIdentity, outcome: 'pass' })),
    };
    expect(validateRefactorEvidence(oversized)).toEqual({ ok: false });
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
      applicability: { level: 'TDD-0', authority: { kind: 'path-contract', id: 'RP-305' } },
      baseline: tdd2.baseline,
    };
    expect(validatePortableEvidence(tdd0)).toEqual({ ok: true });
    for (const kind of ['controller', 'tracker', 'unrecognised']) {
      expect(
        validatePortableEvidence({
          ...tdd0,
          applicability: { level: 'TDD-0', authority: { kind, id: 'RP-305' } },
        }),
        kind,
      ).toMatchObject({ ok: false });
    }
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

  it('binds portable TDD-0 owner and refactor exemptions to the item, baseline, and compact fingerprints', async () => {
    const { fingerprintEvidence, validatePortableEvidence } = (await load()) as {
      fingerprintEvidence: (record: unknown) => { algorithm: string; value: string };
      validatePortableEvidence: (record: unknown) => { ok: boolean; problems?: string[] };
    };
    const ticket = 'RP-305';
    const base = {
      schemaVersion: 1,
      ticket,
      baseline: { headSha: baselineSha },
    };
    const ownerSource = {
      system: 'jira',
      issue: ticket,
      commentId: '21523',
      actor: 'owner',
      decisionContentFingerprint: { algorithm: 'sha256', value: sha('7') },
    };
    const ownerAuthority = {
      kind: 'owner-waiver',
      id: 'owner-comment-21523',
      source: ownerSource,
      decisionFingerprint: fingerprintEvidence({ level: 'TDD-0', ticket, source: ownerSource }),
    };
    const ownerWaiver = {
      ...base,
      applicability: { level: 'TDD-0', authority: ownerAuthority },
    };
    expect(validatePortableEvidence(ownerWaiver)).toEqual({ ok: true });
    expect(
      validatePortableEvidence({
        ...ownerWaiver,
        applicability: {
          level: 'TDD-0',
          authority: { kind: 'owner-waiver', id: 'owner-comment-21523' },
        },
      }),
    ).toMatchObject({ ok: false });
    expect(
      validatePortableEvidence({
        ...ownerWaiver,
        applicability: {
          level: 'TDD-0',
          authority: {
            ...ownerAuthority,
            source: { system: 'jira', issue: ticket, commentId: '21523', actor: 'owner' },
          },
        },
      }),
    ).toMatchObject({ ok: false });
    expect(
      validatePortableEvidence({
        ...ownerWaiver,
        applicability: {
          level: 'TDD-0',
          authority: { ...ownerAuthority, source: { ...ownerSource, issue: 'RP-999' } },
        },
      }),
    ).toMatchObject({ ok: false });
    expect(
      validatePortableEvidence({
        ...ownerWaiver,
        applicability: {
          level: 'TDD-0',
          authority: {
            ...ownerAuthority,
            source: {
              ...ownerSource,
              decisionContentFingerprint: { algorithm: 'sha256', value: sha('8') },
            },
          },
        },
      }),
    ).toMatchObject({ ok: false });
    expect(
      validatePortableEvidence({
        ...ownerWaiver,
        applicability: {
          level: 'TDD-0',
          authority: { ...ownerAuthority, source: { ...ownerSource, commentId: 'changed' } },
        },
      }),
    ).toMatchObject({ ok: false });

    const testSet = { count: 2, fingerprint: { algorithm: 'sha256', value: sha('5') } };
    const before = {
      source: { runId: 'controller-a', seq: 17 },
      outcome: 'pass',
      checkFingerprint: { algorithm: 'sha256', value: sha('4') },
      testSetFingerprint: { ...testSet.fingerprint },
    };
    const after = {
      source: { runId: 'controller-a', seq: 18 },
      outcome: 'pass',
      checkFingerprint: { algorithm: 'sha256', value: sha('3') },
      testSetFingerprint: { ...testSet.fingerprint },
    };
    const proof = {
      ticket,
      baselineHeadSha: baselineSha,
      testSet,
      before,
      after,
      fingerprint: fingerprintEvidence({
        ticket,
        baselineHeadSha: baselineSha,
        testSet,
        before,
        after,
      }),
    };
    const proofMaterial = { ticket, baselineHeadSha: baselineSha, testSet, before, after };
    const withProofFingerprint = (candidate: Record<string, unknown>) => ({
      ...candidate,
      fingerprint: fingerprintEvidence(candidate),
    });
    const refactorRecord = {
      ...base,
      applicability: {
        level: 'TDD-0',
        authority: { kind: 'trusted-refactor-evidence', id: 'RP-305-refactor', proof },
      },
    };
    expect(validatePortableEvidence(refactorRecord)).toEqual({ ok: true });
    const beforeWithoutOutcome = {
      source: before.source,
      checkFingerprint: before.checkFingerprint,
      testSetFingerprint: before.testSetFingerprint,
    };
    const missingOutcomeProof = withProofFingerprint({
      ...proofMaterial,
      before: beforeWithoutOutcome,
    });
    expect(
      validatePortableEvidence({
        ...refactorRecord,
        applicability: {
          level: 'TDD-0',
          authority: { ...refactorRecord.applicability.authority, proof: missingOutcomeProof },
        },
      }),
    ).toMatchObject({ ok: false });
    const failedOutcomeProof = withProofFingerprint({
      ...proofMaterial,
      after: { ...after, outcome: 'fail' },
    });
    expect(
      validatePortableEvidence({
        ...refactorRecord,
        applicability: {
          level: 'TDD-0',
          authority: { ...refactorRecord.applicability.authority, proof: failedOutcomeProof },
        },
      }),
    ).toMatchObject({ ok: false });
    const nestedUnexpectedField = ['raw', 'Secret'].join('');
    const rawNestedFingerprintProof = withProofFingerprint({
      ...proofMaterial,
      before: {
        ...before,
        checkFingerprint: { ...before.checkFingerprint, [nestedUnexpectedField]: 'x' },
      },
    });
    expect(
      validatePortableEvidence({
        ...refactorRecord,
        applicability: {
          level: 'TDD-0',
          authority: {
            ...refactorRecord.applicability.authority,
            proof: rawNestedFingerprintProof,
          },
        },
      }),
    ).toMatchObject({ ok: false });
    expect(
      validatePortableEvidence({
        ...refactorRecord,
        applicability: {
          level: 'TDD-0',
          authority: { kind: 'trusted-refactor-evidence', id: 'RP-305-refactor' },
        },
      }),
    ).toMatchObject({ ok: false });
    expect(
      validatePortableEvidence({
        ...refactorRecord,
        applicability: {
          level: 'TDD-0',
          authority: {
            ...refactorRecord.applicability.authority,
            proof: { ...proof, before: { ...before, source: { ...before.source, seq: 19 } } },
          },
        },
      }),
    ).toMatchObject({ ok: false });
    expect(
      validatePortableEvidence({
        ...refactorRecord,
        applicability: {
          level: 'TDD-0',
          authority: {
            ...refactorRecord.applicability.authority,
            proof: {
              ...proof,
              after: { ...after, testSetFingerprint: { algorithm: 'sha256', value: sha('2') } },
            },
          },
        },
      }),
    ).toMatchObject({ ok: false });
  });

  it('rejects local Windows test paths in portable test identity', async () => {
    const { validatePortableEvidence } = (await load()) as {
      validatePortableEvidence: (record: unknown) => { ok: boolean; problems?: string[] };
    };
    for (const file of ['C:\\agent\\test.test.ts', '\\\\server\\share\\test.test.ts']) {
      const record = await portableTdd2();
      record.red.test.file = file;
      await linkPortableTdd2(record);
      expect(validatePortableEvidence(record), file).toMatchObject({
        ok: false,
        problems: expect.arrayContaining(['red.test.file must be a safe repository-relative path']),
      });
    }
  });

  it('rejects extra material in a bounded implementation delta fingerprint', async () => {
    const { validatePortableEvidence } = (await load()) as {
      validatePortableEvidence: (record: unknown) => { ok: boolean; problems?: string[] };
    };
    const rawDelta = await portableTdd2();
    const unboundedField = ['raw', 'Secret'].join('');
    (rawDelta.implementationBoundary.implementationDeltaFingerprint as Record<string, string>)[
      unboundedField
    ] = 'must-not-enter-portable-evidence';
    await linkPortableTdd2(rawDelta);
    expect(validatePortableEvidence(rawDelta)).toMatchObject({
      ok: false,
      problems: expect.arrayContaining([
        'implementationBoundary.implementationDeltaFingerprint.[unknown-key] is not permitted in portable evidence',
      ]),
    });
  });

  it('requires a predecessor fingerprint chain across runs and rejects time reversal even through a handoff', async () => {
    const { validatePortableEvidence } = (await load()) as {
      validatePortableEvidence: (record: unknown) => { ok: boolean; problems?: string[] };
    };
    const linkedCrossRun = await portableTdd2();
    linkedCrossRun.implementationBoundary.source = { runId: 'controller-b', seq: 1 };
    linkedCrossRun.green.source = { runId: 'controller-c', seq: 1 };
    await linkPortableTdd2(linkedCrossRun);
    expect(validatePortableEvidence(linkedCrossRun)).toEqual({ ok: true });

    const unlinkedCrossRun = await portableTdd2();
    unlinkedCrossRun.implementationBoundary.source = { runId: 'controller-b', seq: 1 };
    unlinkedCrossRun.green.source = { runId: 'controller-c', seq: 1 };
    await linkPortableTdd2(unlinkedCrossRun);
    delete (
      unlinkedCrossRun.implementationBoundary as Partial<
        typeof unlinkedCrossRun.implementationBoundary
      >
    ).predecessorFingerprint;
    expect(validatePortableEvidence(unlinkedCrossRun)).toMatchObject({ ok: false });

    const reversed = await portableTdd2();
    reversed.red.source = { runId: 'controller-a', seq: 9 };
    reversed.implementationBoundary.source = { runId: 'controller-b', seq: 1 };
    reversed.green.source = { runId: 'controller-a', seq: 1 };
    await linkPortableTdd2(reversed);
    expect(validatePortableEvidence(reversed)).toMatchObject({ ok: false });
  });

  it('accepts a bounded portable TDD-2 chain rooted at BASELINE_CREATED with same-spec RED and GREEN evidence', async () => {
    const { validatePortableEvidence } = (await load()) as {
      validatePortableEvidence: (record: unknown) => { ok: boolean; problems?: string[] };
    };
    expect(validatePortableEvidence(await portableTdd2())).toEqual({ ok: true });
  });

  it('returns fail-closed diagnostics instead of throwing for incomplete TDD-2 and TDD-3 records', async () => {
    const { validatePortableEvidence } = (await load()) as {
      validatePortableEvidence: (record: unknown) => { ok: boolean; problems?: string[] };
    };
    for (const level of ['TDD-2', 'TDD-3']) {
      const malformed = {
        schemaVersion: 1,
        ticket: 'RP-305',
        applicability: { level, authority: { kind: 'tracker', id: 'RP-305' } },
        baseline: { headSha: baselineSha },
      };
      expect(() => validatePortableEvidence(malformed), level).not.toThrow();
      expect(validatePortableEvidence(malformed), level).toMatchObject({
        ok: false,
        problems: expect.any(Array),
      });
    }
  });

  it('binds every portable stage fingerprint to its ticket and BASELINE_CREATED head', async () => {
    const { validatePortableEvidence } = (await load()) as {
      validatePortableEvidence: (record: unknown) => { ok: boolean; problems?: string[] };
    };
    const wrongTicket = await portableTdd2();
    wrongTicket.ticket = 'RP-999';
    expect(validatePortableEvidence(wrongTicket)).toMatchObject({ ok: false });

    const wrongBaseline = await portableTdd2();
    wrongBaseline.baseline.headSha = 'f'.repeat(40);
    expect(validatePortableEvidence(wrongBaseline)).toMatchObject({ ok: false });
  });

  it('invalidates a RED when GREEN changes its test-file hash or material evidence, and requires non-vacuity evidence for TDD-3', async () => {
    const { validatePortableEvidence, fingerprintEvidence } = (await load()) as {
      validatePortableEvidence: (record: unknown) => { ok: boolean; problems?: string[] };
      fingerprintEvidence: (record: unknown) => { algorithm: string; value: string };
    };
    const changedTest = await portableTdd2();
    changedTest.green.test = { ...testIdentity, fileSha256: sha('e') };
    changedTest.green.fingerprint = fingerprintEvidence({
      ticket: changedTest.ticket,
      baselineHeadSha: changedTest.baseline.headSha,
      stage: 'green',
      test: changedTest.green.test,
      source: changedTest.green.source,
      observation: changedTest.green.observation,
      predecessorFingerprint: changedTest.green.predecessorFingerprint,
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
      predecessorFingerprint: { ...tdd3.green.fingerprint },
      fingerprint: { algorithm: 'sha256', value: sha('0') },
    };
    nonVacuity.fingerprint = fingerprintEvidence({
      ticket: tdd3.ticket,
      baselineHeadSha: tdd3.baseline.headSha,
      stage: 'non-vacuity',
      test: nonVacuity.test,
      source: nonVacuity.source,
      observation: nonVacuity.observation,
      predecessorFingerprint: nonVacuity.predecessorFingerprint,
    });
    (tdd3 as Record<string, unknown>).nonVacuity = nonVacuity;
    expect(validatePortableEvidence(tdd3)).toEqual({ ok: true });

    nonVacuity.observation.outcome = 'pass';
    nonVacuity.fingerprint = fingerprintEvidence({
      ticket: tdd3.ticket,
      baselineHeadSha: tdd3.baseline.headSha,
      stage: 'non-vacuity',
      test: nonVacuity.test,
      source: nonVacuity.source,
      observation: nonVacuity.observation,
      predecessorFingerprint: nonVacuity.predecessorFingerprint,
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
      problems: expect.arrayContaining(['[unknown-key] is not permitted in portable evidence']),
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

  it('bounds diagnostics for an oversized unknown portable-evidence key', async () => {
    const { validatePortableEvidence } = (await load()) as {
      validatePortableEvidence: (record: unknown) => { ok: boolean; problems?: string[] };
    };
    const evidence = await portableTdd2();
    (evidence as Record<string, unknown>)['x'.repeat(1024 * 1024)] = true;

    const result = validatePortableEvidence(evidence);
    expect(result).toMatchObject({ ok: false });
    expect(result.problems?.every((problem) => problem.length <= 512)).toBe(true);
  });

  it('rejects credential-shaped portable strings without disclosing their values', async () => {
    const { fingerprintEvidence, validatePortableEvidence } = (await load()) as {
      fingerprintEvidence: (record: unknown) => { algorithm: string; value: string };
      validatePortableEvidence: (record: unknown) => { ok: boolean; problems?: string[] };
    };
    const secretsPath = path.join(
      repoRoot,
      'templates',
      'agent-os',
      'universal',
      '.claude',
      'scripts',
      'lib',
      'secrets.mjs',
    );
    const { findSecretValues } = (await import(pathToFileURL(secretsPath).href)) as {
      findSecretValues: (text: string) => Array<{ id: string }>;
    };
    const credentialShape = ['token', '=', 'a1'.repeat(8)].join('');
    expect(findSecretValues(credentialShape)).not.toEqual([]);

    const stageRecord = await portableTdd2();
    stageRecord.red.test.fullName = credentialShape;
    stageRecord.green.test.fullName = credentialShape;
    await linkPortableTdd2(stageRecord);
    const stageResult = validatePortableEvidence(stageRecord);
    expect(stageResult).toMatchObject({ ok: false });
    expect(stageResult.problems).toEqual(
      expect.arrayContaining([expect.stringMatching(/^red\.test\.fullName.*credential/i)]),
    );
    expect(stageResult.problems?.join('\n')).not.toContain(credentialShape);

    const ticket = 'RP-305';
    const source = {
      system: 'jira',
      issue: ticket,
      commentId: '21523',
      actor: credentialShape,
      decisionContentFingerprint: { algorithm: 'sha256', value: sha('7') },
    };
    const ownerRecord = {
      schemaVersion: 1,
      ticket,
      baseline: { headSha: baselineSha },
      applicability: {
        level: 'TDD-0',
        authority: {
          kind: 'owner-waiver',
          id: 'owner-comment-21523',
          source,
          decisionFingerprint: fingerprintEvidence({ level: 'TDD-0', ticket, source }),
        },
      },
    };
    const ownerResult = validatePortableEvidence(ownerRecord);
    expect(ownerResult).toMatchObject({ ok: false });
    expect(ownerResult.problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^applicability\.authority\.source\.actor.*credential/i),
      ]),
    );
    expect(ownerResult.problems?.join('\n')).not.toContain(credentialShape);
  });

  it('redacts credential-shaped unknown portable-evidence keys at every depth', async () => {
    const { validatePortableEvidence } = (await load()) as {
      validatePortableEvidence: (record: unknown) => { ok: boolean; problems?: string[] };
    };
    const secretsPath = path.join(
      repoRoot,
      'templates',
      'agent-os',
      'universal',
      '.claude',
      'scripts',
      'lib',
      'secrets.mjs',
    );
    const { findSecretValues } = (await import(pathToFileURL(secretsPath).href)) as {
      findSecretValues: (text: string) => Array<{ id: string }>;
    };
    const credentialKey = ['token', '=', 'a1'.repeat(8)].join('');
    expect(findSecretValues(credentialKey)).not.toEqual([]);

    const rootUnknown = await portableTdd2();
    (rootUnknown as Record<string, unknown>)[credentialKey] = true;
    const nestedUnknown = await portableTdd2();
    (nestedUnknown.red.test as Record<string, unknown>)[credentialKey] = true;
    await linkPortableTdd2(nestedUnknown);

    for (const evidence of [rootUnknown, nestedUnknown]) {
      const result = validatePortableEvidence(evidence);
      const serializedProblems = JSON.stringify(result.problems);
      expect(result).toMatchObject({ ok: false });
      expect(serializedProblems.includes(credentialKey)).toBe(false);
      expect(result.problems).toEqual(
        expect.arrayContaining([expect.stringMatching(/\[unknown-key\] is not permitted/i)]),
      );
    }
  });

  it('uses code-unit key ordering for SHA-256 fingerprints on every machine', async () => {
    const { fingerprintEvidence } = (await load()) as {
      fingerprintEvidence: (record: unknown) => { algorithm: string; value: string };
    };
    const expected = createHash('sha256')
      .update(JSON.stringify({ z: 2, ä: 1 }))
      .digest('hex');

    expect(fingerprintEvidence({ z: 2, ä: 1 })).toEqual({
      algorithm: 'sha256',
      value: expected,
    });
  });
});
