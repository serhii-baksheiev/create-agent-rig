import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  REQUIRED_REVALIDATION_CORPUS_STRATA,
  scoreRevalidationCorpus,
} from '../helpers/revalidation-corpus.js';

type CorpusCase = {
  caseId: string;
  locator: { run: string; seq: number; detectionId: string };
  checkpoint: 'SELECT' | 'BEFORE_PR' | 'BEFORE_CLOSE';
  stratum: string;
  kind: 'caught' | 'no-catch-control';
  origin: 'historical' | 'synthetic';
  observation: { detected: boolean; actionRequired: boolean | null };
  label: {
    groundTruth: 'material' | 'benign' | 'indeterminate';
    evidence: string;
    adjudication: 'agreed' | 'disagreed';
  };
};

type HistoricalObservation = {
  caseId: string;
  locator: {
    run: string;
    seq: number;
    detectionId: string | null;
    legacyIdentity: string | null;
  };
  at: string;
  point: 'SELECT' | 'BEFORE_PR' | 'BEFORE_CLOSE';
  result: string | null;
  changed: boolean | null;
  sources: string[];
  recordedOutcome: { identity: string; actionRequired: boolean | null } | null;
};

type HistoricalFixture = {
  schemaVersion: number;
  window: { sinceInclusive: string; untilExclusive: string };
  source: {
    assessmentCommit: string;
    aggregateSha256: string;
    manifestSha256: string;
    population: string;
    original134RunMembershipVerified: boolean;
    immutableAtOriginalAssessmentVerified: boolean;
  };
  manifest: Array<{ run: string; eventsSha256: string; selectedEventCount: number }>;
  observations: HistoricalObservation[];
};

const historicalFixturePath = fileURLToPath(
  new URL('../fixtures/revalidation-corpus/historical-2026-10.json', import.meta.url),
);

const readHistoricalFixture = (): HistoricalFixture => {
  expect(existsSync(historicalFixturePath)).toBe(true);
  return JSON.parse(readFileSync(historicalFixturePath, 'utf8')) as HistoricalFixture;
};

const recordedActionRequired = (observation: HistoricalObservation): boolean | null =>
  observation.recordedOutcome?.actionRequired ?? null;

const isRecordedCatch = (observation: HistoricalObservation): boolean =>
  typeof observation.result === 'string'
    ? observation.result !== 'CURRENT' && observation.result !== 'BASELINE_CREATED'
    : observation.changed === true;

const caseOf = (overrides: Partial<CorpusCase> = {}): CorpusCase => ({
  caseId: 'historical-benign-body-change',
  locator: { run: '20261125-rp563-fixture', seq: 4, detectionId: 'detected-body-change' },
  checkpoint: 'BEFORE_PR',
  stratum: 'scope-body',
  kind: 'caught',
  origin: 'historical',
  observation: { detected: true, actionRequired: false },
  label: {
    groundTruth: 'benign',
    evidence: 'review://independent/a-and-b',
    adjudication: 'agreed',
  },
  ...overrides,
});

// This oracle is deliberately independent of the helper export. It comes from
// RP-563's accepted strata, so changing the helper cannot also change the test.
const EXPECTED_STRATA = [
  'scope-title',
  'scope-body',
  'scope-labels',
  'scope-links',
  'scope-workflow',
  'paired-facts',
  'select-commentary',
  'before-pr-commentary',
  'close-time-commentary',
  'own-squash',
  'omitted-merge',
  'forged-merge',
  'foreign-or-concurrent-merge',
  'integrity-unverifiable',
  'environment-unverifiable',
  'action-changing-candidate',
  'unresolved-catch',
  'material-no-catch-control',
] as const;

// These are synthetic unit-test inputs only. They do not assert that any
// historical observation has an independent label.
const completeFixtureCorpus = (origin: CorpusCase['origin']): CorpusCase[] =>
  EXPECTED_STRATA.map((stratum, index) =>
    caseOf({
      caseId: `fixture-${origin}-${index}`,
      locator: { run: `fixture-${origin}`, seq: index + 1, detectionId: `fixture-${index}` },
      stratum,
      kind: stratum === 'material-no-catch-control' ? 'no-catch-control' : 'caught',
      origin,
      observation: { detected: true, actionRequired: false },
      label: {
        groundTruth: 'material',
        evidence: `fixture://independent-label-${index}`,
        adjudication: 'agreed',
      },
    }),
  );

describe('independently labelled revalidation corpus scoring', () => {
  it('rejects a case that lacks a replayable provenance locator before scoring it', () => {
    const result = scoreRevalidationCorpus([
      caseOf({ locator: { run: '', seq: 0, detectionId: '' } }),
    ]);

    expect(result.errors).toContainEqual({
      caseId: 'historical-benign-body-change',
      rule: 'provenance locator',
    });
    expect(result.manifest).toEqual({ total: 1, accepted: 0, rejected: 1 });
    expect(result.totalCases).toBe(0);
  });

  it('rejects duplicate case IDs instead of silently shrinking the frozen denominator', () => {
    const first = caseOf();
    const duplicate = caseOf({
      locator: { run: 'another-run', seq: 9, detectionId: 'different-detection' },
    });

    const result = scoreRevalidationCorpus([first, duplicate]);

    expect(result.errors).toContainEqual({
      caseId: 'historical-benign-body-change',
      rule: 'unique caseId',
    });
  });

  it('rejects a label without independent evidence while retaining that record in the manifest count', () => {
    const result = scoreRevalidationCorpus([
      caseOf({
        label: { groundTruth: 'benign', evidence: '', adjudication: 'agreed' },
      }),
    ]);

    expect(result.errors).toContainEqual({
      caseId: 'historical-benign-body-change',
      rule: 'independent label evidence',
    });
    expect(result.manifest).toEqual({ total: 1, accepted: 0, rejected: 1 });
  });

  it('rejects a disputed label that pretends to be a determinate material or benign ground truth', () => {
    const result = scoreRevalidationCorpus([
      caseOf({
        label: {
          groundTruth: 'material',
          evidence: 'review://independent/disagreement',
          adjudication: 'disagreed',
        },
      }),
    ]);

    expect(result.errors).toContainEqual({
      caseId: 'historical-benign-body-change',
      rule: 'independent label adjudication',
    });
    expect(result.manifest).toEqual({ total: 1, accepted: 0, rejected: 1 });
  });

  it('keeps an indeterminate caught case visible while excluding it from the determinate false-HOLD denominator', () => {
    const result = scoreRevalidationCorpus([
      caseOf({
        label: {
          groundTruth: 'indeterminate',
          evidence: 'review://independent/disagreement',
          adjudication: 'disagreed',
        },
      }),
    ]);

    expect(result).toMatchObject({
      totalCases: 1,
      labels: { indeterminate: 1 },
      caught: { determinate: 0, falseHolds: 0 },
    });
  });

  it('reports each predeclared stratum including those with no cases', () => {
    const result = scoreRevalidationCorpus([caseOf()]);

    expect(REQUIRED_REVALIDATION_CORPUS_STRATA).toEqual(EXPECTED_STRATA);
    expect(result).toMatchObject({
      strata: expect.arrayContaining([
        ...EXPECTED_STRATA.map((stratum) => expect.objectContaining({ stratum })),
        expect.objectContaining({ stratum: 'close-time-commentary', total: 0 }),
      ]),
    });
  });

  it('reports the controller outcome separately from independently labelled benign ground truth', () => {
    const result = scoreRevalidationCorpus([
      caseOf({ observation: { detected: true, actionRequired: true } }),
    ]);

    expect(result).toMatchObject({
      observed: { actionChangingOutcomes: 1 },
      labels: { benign: 1 },
      caught: { falseHolds: 1 },
    });
  });

  it('publishes historical and synthetic false-HOLD rates in separate partitions', () => {
    const result = scoreRevalidationCorpus([
      caseOf(),
      caseOf({
        caseId: 'synthetic-benign-catch',
        origin: 'synthetic',
        locator: { run: 'fixture-run', seq: 8, detectionId: 'synthetic-detection' },
      }),
    ]);

    expect(result).toMatchObject({
      rates: {
        historical: { determinateCaught: 1, falseHolds: 1 },
        synthetic: { determinateCaught: 1, falseHolds: 1 },
      },
    });
    expect(result).not.toHaveProperty('rates.combined');
  });

  it('counts a material no-catch control as a false-negative risk and keeps synthetic controls separate', () => {
    const result = scoreRevalidationCorpus([
      caseOf({
        caseId: 'synthetic-material-no-catch',
        kind: 'no-catch-control',
        origin: 'synthetic',
        observation: { detected: false, actionRequired: null },
        label: {
          groundTruth: 'material',
          evidence: 'fixture://external-title-change',
          adjudication: 'agreed',
        },
      }),
    ]);

    expect(result).toMatchObject({
      controls: { materialNoCatch: { total: 1, missed: 1 } },
      origins: { synthetic: { total: 1 }, historical: { total: 0 } },
    });
  });

  it('refuses a below-five-percent claim when required strata are empty or material controls are absent', () => {
    const result = scoreRevalidationCorpus([caseOf()]);

    expect(result).toMatchObject({
      belowFivePercent: {
        eligible: false,
        missingStrata: expect.arrayContaining(['close-time-commentary']),
        missingMaterialControls: true,
      },
    });
  });

  it('refuses a below-five-percent claim when a fully covered corpus still has an indeterminate case', () => {
    const cases = completeFixtureCorpus('historical');
    const firstCase = cases[0];
    if (!firstCase) throw new Error('Expected a nonempty fixture corpus');
    cases[0] = {
      ...firstCase,
      label: {
        groundTruth: 'indeterminate',
        evidence: 'fixture://independent-review-disagreed',
        adjudication: 'disagreed',
      },
    };

    const result = scoreRevalidationCorpus(cases);

    expect(result).toMatchObject({
      belowFivePercent: {
        eligible: false,
        indeterminateCases: 1,
        missingStrata: [],
        missingMaterialControls: false,
      },
    });
  });

  it('refuses a historical below-five-percent claim from a synthetic-only corpus', () => {
    const result = scoreRevalidationCorpus(completeFixtureCorpus('synthetic'));

    expect(result).toMatchObject({
      belowFivePercent: {
        eligible: false,
        missingHistoricalDeterminateCaught: true,
        missingStrata: [],
        missingMaterialControls: false,
      },
    });
  });

  it('refuses a below-five-percent claim when a rejected row remains in an otherwise eligible frozen manifest', () => {
    const result = scoreRevalidationCorpus([
      ...completeFixtureCorpus('historical'),
      caseOf({
        caseId: 'rejected-provenance-row',
        locator: { run: '', seq: 0, detectionId: '' },
      }),
    ]);

    expect(result).toMatchObject({
      errors: expect.arrayContaining([
        expect.objectContaining({
          caseId: 'rejected-provenance-row',
          rule: 'provenance locator',
        }),
      ]),
      manifest: { total: 19, accepted: 18, rejected: 1 },
      belowFivePercent: {
        eligible: false,
        missingStrata: [],
        missingMaterialControls: false,
        indeterminateCases: 0,
        missingHistoricalDeterminateCaught: false,
      },
    });
  });
});

describe('frozen historical revalidation corpus fixture', () => {
  it('declares the bounded retrospective population and its original-snapshot limitations', () => {
    const fixture = readHistoricalFixture();

    expect(fixture).toMatchObject({
      schemaVersion: 1,
      window: {
        sinceInclusive: '2026-10-01T00:00:00.000Z',
        untilExclusive: '2026-11-24T00:00:00.000Z',
      },
      source: {
        assessmentCommit: '3caf2ab5e8b4815aaa9d188bbb09344a5081da7e',
        aggregateSha256: '3000b3ea6c314e42e184da9b519a6f269e916b13f4824c949e3dac9edb613af0',
        manifestSha256: '791d358cd10b3751f78659753b9a1e5e37c41b6afd3c2a24346074aea865d25d',
        population: 'new frozen retrospective available-source population',
        original134RunMembershipVerified: false,
        immutableAtOriginalAssessmentVerified: false,
      },
    });
  });

  it('freezes the 90-run source manifest with its canonical hash and selected-event count', () => {
    const fixture = readHistoricalFixture();
    const manifestLines = fixture.manifest.map(
      ({ run, eventsSha256, selectedEventCount }) =>
        `${run}/events.jsonl\t${eventsSha256}\t${selectedEventCount}\n`,
    );

    expect(fixture.manifest).toHaveLength(90);
    expect(fixture.manifest.map(({ run }) => run)).toEqual(
      [...fixture.manifest.map(({ run }) => run)].sort(),
    );
    expect(fixture.manifest).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          run: expect.any(String),
          eventsSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          selectedEventCount: expect.any(Number),
        }),
      ]),
    );
    expect(fixture.manifest.reduce((total, entry) => total + entry.selectedEventCount, 0)).toBe(
      1309,
    );
    expect(createHash('sha256').update(manifestLines.join('')).digest('hex')).toBe(
      fixture.source.manifestSha256,
    );
  });

  it('retains the 252 window-bounded observations with unique replay locators and fixed point counts', () => {
    const fixture = readHistoricalFixture();
    const pointCounts = Object.fromEntries(
      ['SELECT', 'BEFORE_PR', 'BEFORE_CLOSE'].map((point) => [
        point,
        fixture.observations.filter((observation) => observation.point === point).length,
      ]),
    );

    expect(fixture.observations).toHaveLength(252);
    expect(pointCounts).toEqual({ SELECT: 88, BEFORE_PR: 112, BEFORE_CLOSE: 52 });
    expect(new Set(fixture.observations.map(({ caseId }) => caseId)).size).toBe(252);
    for (const observation of fixture.observations) {
      expect(observation.caseId).toBe(`${observation.locator.run}:${observation.locator.seq}`);
      expect(observation.at >= fixture.window.sinceInclusive).toBe(true);
      expect(observation.at < fixture.window.untilExclusive).toBe(true);
      expect(Object.keys(observation).sort()).toEqual([
        'at',
        'caseId',
        'changed',
        'locator',
        'point',
        'recordedOutcome',
        'result',
        'sources',
      ]);
      expect(Object.keys(observation.locator).sort()).toEqual([
        'detectionId',
        'legacyIdentity',
        'run',
        'seq',
      ]);
      if (observation.locator.detectionId === null) {
        expect(observation.locator.legacyIdentity).toBe(observation.caseId);
      } else {
        expect(observation.locator.legacyIdentity).toBeNull();
      }
    }
  });

  it('retains unresolved and unverifiable observations without deriving materiality from recorded outcomes', () => {
    const fixture = readHistoricalFixture();
    const recordedCatches = fixture.observations.filter(isRecordedCatch);
    const actionRequired = recordedCatches.map(recordedActionRequired);

    expect(recordedCatches).toHaveLength(124);
    expect(
      fixture.observations.filter(
        ({ result, changed }) => result === 'UNVERIFIABLE' || changed === null,
      ),
    ).toHaveLength(8);
    expect(actionRequired.filter((value) => value === false)).toHaveLength(117);
    expect(actionRequired.filter((value) => value === true)).toHaveLength(1);
    expect(actionRequired.filter((value) => value === null)).toHaveLength(6);
    expect(fixture).not.toHaveProperty('labels');

    for (const observation of fixture.observations) {
      expect(observation).not.toHaveProperty('groundTruth');
      expect(observation).not.toHaveProperty('adjudication');
      expect(observation.sources.every((source) => typeof source === 'string')).toBe(true);
      if (observation.recordedOutcome !== null) {
        expect(Object.keys(observation.recordedOutcome).sort()).toEqual([
          'actionRequired',
          'identity',
        ]);
        expect(['boolean', 'object']).toContain(typeof observation.recordedOutcome.actionRequired);
      }
    }
  });
});
