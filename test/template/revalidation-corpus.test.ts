import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
  detectionObligation?: 'required' | 'deferred';
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

type LabelAssessment = {
  reviewer: string;
  groundTruth: 'material' | 'benign' | 'indeterminate';
  evidence: string;
};

type HistoricalLabelFixture = {
  schemaVersion: number;
  sourceFixtureSha256: string;
  adjudicationPolicy: string;
  reviewers: Array<{
    id: string;
    outputSha256: string;
    sourceFixtureSha256: string;
    blinding: string;
    limitations: string[];
    blindedInputSha256?: string;
    supersedesOutputSha256?: string;
  }>;
  cases: Array<{
    caseId: string;
    assessments: LabelAssessment[];
    adjudication: {
      groundTruth: 'material' | 'benign' | 'indeterminate';
      status: 'agreed-determinate' | 'agreed-indeterminate' | 'disagreed' | 'incomplete';
    };
  }>;
};

type ConstructedControl = {
  id: string;
  strata: string[];
  checkpoint: 'SELECT' | 'BEFORE_PR' | 'BEFORE_CLOSE';
  pair: {
    baseline: string;
    mutation: string;
  };
  checkpointQuestion: string;
  expectedNative: {
    result: 'CURRENT' | 'CHANGED' | 'UNVERIFIABLE';
    source: string[];
  };
  replay: {
    suite: 'content-blind-revalidation' | 'revalidate';
    test: string;
  };
  independentLabel: { status: 'pending' };
};

type ConstructedControlsFixture = {
  schemaVersion: number;
  population: 'synthetic-constructed-v1';
  controls: ConstructedControl[];
  audit: { replayReceipt: string };
  scorerCalibration: {
    id: string;
    kind: 'material-no-catch-calibration';
    observation: { detected: false };
    materiality: 'material';
    separateFromNativeReplay: true;
  };
};

type PressureControl = {
  id: 'B02' | 'B03' | 'P01';
  checkpoint: 'BEFORE_PR' | 'BEFORE_CLOSE';
  pair: { before: string; after: string };
  expectedNative: { result: 'CHANGED'; source: 'claim:scope' | 'claim:commentary' };
  replay: { suite: 'content-blind-revalidation'; test: string };
  independentLabel: { status: 'pending' };
};

type PressureControlsFixture = {
  schemaVersion: number;
  population: 'synthetic-pressure-controls-v1';
  baseFixtureSha256: string;
  controls: PressureControl[];
};

type SyntheticLabelCase = {
  caseId?: string;
  blindedCaseId?: string;
  assessments: LabelAssessment[];
  adjudication: {
    groundTruth: 'material' | 'benign' | 'indeterminate';
    status: 'agreed-determinate' | 'agreed-indeterminate' | 'disagreed' | 'incomplete';
  };
};

type SyntheticLabelsFixture = {
  schemaVersion: number;
  population: string;
  sourceFixtureSha256: string;
  blindedInputSha256: string;
  adjudicationPolicy: string;
  reviewers: Array<{
    id: string;
    outputSha256: string;
    sourceFixtureSha256: string;
    blindedInputSha256: string;
    limitations: string[];
  }>;
  cases: SyntheticLabelCase[];
};

type PressureNativeObservation = {
  caseId: 'B02' | 'B03' | 'P01';
  locator: { checkoutPathSha256: string; run: string; seq: number; detectionId: string };
  point: 'BEFORE_PR' | 'BEFORE_CLOSE';
  result: 'CHANGED';
  source: string[];
};

type PressureNativeFixture = {
  schemaVersion: number;
  sourceFixtureSha256: string;
  metadata: {
    command: string;
    sourceHead: string;
    workingTree: Record<string, string>;
  };
  observations: PressureNativeObservation[];
};

type VersionedPressureControl = {
  id: 'B02' | 'B03' | 'N01' | 'P01';
  checkpoint: 'BEFORE_PR' | 'BEFORE_CLOSE';
  pair: { before: string; after: string };
  expectedNative: {
    result: 'CURRENT' | 'CHANGED' | 'UNVERIFIABLE';
    source: string[];
  };
  detectionObligation: 'required' | 'deferred';
  replay: { suite: 'content-blind-revalidation'; test: string };
};

type VersionedPressureFixture = {
  schemaVersion: 2;
  population: 'synthetic-pressure-controls-v2';
  supersedes: { fixtureSha256: string; labelsSha256: string };
  controls: VersionedPressureControl[];
};

type VersionedConstructedFixture = {
  schemaVersion: 2;
  population: 'synthetic-constructed-v2';
  supersedes: { fixtureSha256: string; labelsSha256: string };
  controls: ConstructedControl[];
};

type VersionedSyntheticLabelsFixture = {
  schemaVersion: 2;
  population: 'synthetic-constructed-labels-v2' | 'synthetic-pressure-labels-v2';
  sourceFixtureSha256: string;
  supersedes: { labelsSha256: string };
};

type VersionedPressureNativeFixture = {
  schemaVersion: 2;
  sourceFixtureSha256: string;
  metadata: {
    command: string;
    sourceHead: string;
    workingTree: Record<string, string>;
  };
  observations: Array<{
    caseId: 'B02' | 'B03' | 'N01' | 'P01';
    locator: { checkoutPathSha256: string; run: string; seq: number; detectionId: string };
    point: 'BEFORE_PR' | 'BEFORE_CLOSE';
    result: 'CURRENT' | 'CHANGED' | 'UNVERIFIABLE';
    source: string[];
  }>;
};

const historicalFixturePath = fileURLToPath(
  new URL('../fixtures/revalidation-corpus/historical-2026-10.json', import.meta.url),
);
const historicalLabelsPath = fileURLToPath(
  new URL('../fixtures/revalidation-corpus/historical-labels-v1.json', import.meta.url),
);
const constructedControlsPath = fileURLToPath(
  new URL('../fixtures/revalidation-controls/constructed-v1.json', import.meta.url),
);
const pressureControlsPath = fileURLToPath(
  new URL('../fixtures/revalidation-controls/pressure-v1.json', import.meta.url),
);
const constructedLabelsPath = fileURLToPath(
  new URL('../fixtures/revalidation-controls/constructed-labels-v1.json', import.meta.url),
);
const pressureLabelsPath = fileURLToPath(
  new URL('../fixtures/revalidation-controls/pressure-labels-v1.json', import.meta.url),
);
const pressureNativePath = fileURLToPath(
  new URL('../fixtures/revalidation-controls/pressure-native-v1.json', import.meta.url),
);
const constructedControlsV2Path = fileURLToPath(
  new URL('../fixtures/revalidation-controls/constructed-v2.json', import.meta.url),
);
const pressureControlsV2Path = fileURLToPath(
  new URL('../fixtures/revalidation-controls/pressure-v2.json', import.meta.url),
);
const constructedLabelsV2Path = fileURLToPath(
  new URL('../fixtures/revalidation-controls/constructed-labels-v2.json', import.meta.url),
);
const pressureNativeV2Path = fileURLToPath(
  new URL('../fixtures/revalidation-controls/pressure-native-v2.json', import.meta.url),
);
const readHistoricalFixture = (): HistoricalFixture => {
  expect(existsSync(historicalFixturePath)).toBe(true);
  return JSON.parse(readFileSync(historicalFixturePath, 'utf8')) as HistoricalFixture;
};

const readHistoricalLabels = (): HistoricalLabelFixture => {
  expect(existsSync(historicalLabelsPath)).toBe(true);
  return JSON.parse(readFileSync(historicalLabelsPath, 'utf8')) as HistoricalLabelFixture;
};

const readConstructedControls = (): ConstructedControlsFixture => {
  expect(existsSync(constructedControlsPath)).toBe(true);
  return JSON.parse(readFileSync(constructedControlsPath, 'utf8')) as ConstructedControlsFixture;
};

const readPressureControls = (): PressureControlsFixture => {
  expect(existsSync(pressureControlsPath)).toBe(true);
  return JSON.parse(readFileSync(pressureControlsPath, 'utf8')) as PressureControlsFixture;
};

const readConstructedLabels = (): SyntheticLabelsFixture => {
  expect(existsSync(constructedLabelsPath)).toBe(true);
  return JSON.parse(readFileSync(constructedLabelsPath, 'utf8')) as SyntheticLabelsFixture;
};

const readPressureLabels = (): SyntheticLabelsFixture => {
  expect(existsSync(pressureLabelsPath)).toBe(true);
  return JSON.parse(readFileSync(pressureLabelsPath, 'utf8')) as SyntheticLabelsFixture;
};

const readPressureNative = (): PressureNativeFixture => {
  expect(existsSync(pressureNativePath)).toBe(true);
  return JSON.parse(readFileSync(pressureNativePath, 'utf8')) as PressureNativeFixture;
};

const readConstructedControlsV2 = (): VersionedConstructedFixture => {
  expect(existsSync(constructedControlsV2Path)).toBe(true);
  return JSON.parse(readFileSync(constructedControlsV2Path, 'utf8')) as VersionedConstructedFixture;
};

const readPressureControlsV2 = (): VersionedPressureFixture => {
  expect(existsSync(pressureControlsV2Path)).toBe(true);
  return JSON.parse(readFileSync(pressureControlsV2Path, 'utf8')) as VersionedPressureFixture;
};

const readConstructedLabelsV2 = (): VersionedSyntheticLabelsFixture => {
  expect(existsSync(constructedLabelsV2Path)).toBe(true);
  return JSON.parse(
    readFileSync(constructedLabelsV2Path, 'utf8'),
  ) as VersionedSyntheticLabelsFixture;
};

const readPressureNativeV2 = (): VersionedPressureNativeFixture => {
  expect(existsSync(pressureNativeV2Path)).toBe(true);
  return JSON.parse(readFileSync(pressureNativeV2Path, 'utf8')) as VersionedPressureNativeFixture;
};

const recordedActionRequired = (observation: HistoricalObservation): boolean | null =>
  observation.recordedOutcome?.actionRequired ?? null;

const isRecordedCatch = (observation: HistoricalObservation): boolean =>
  typeof observation.result === 'string'
    ? observation.result !== 'CURRENT' && observation.result !== 'BASELINE_CREATED'
    : observation.changed === true;

const expectDeterministicSyntheticAdjudication = (cases: SyntheticLabelCase[]) => {
  for (const labelledCase of cases) {
    const [first, second] = labelledCase.assessments;
    if (!first || !second) throw new Error('expected exactly two independent assessments');
    const sameGroundTruth = first.groundTruth === second.groundTruth;
    const expected = sameGroundTruth
      ? first.groundTruth === 'indeterminate'
        ? { groundTruth: 'indeterminate', status: 'agreed-indeterminate' }
        : { groundTruth: first.groundTruth, status: 'agreed-determinate' }
      : { groundTruth: 'indeterminate', status: 'disagreed' };
    expect(labelledCase.adjudication).toEqual(expected);
  }
};

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
      detectionObligation: stratum === 'material-no-catch-control' ? 'deferred' : undefined,
      observation: {
        detected: stratum !== 'material-no-catch-control',
        actionRequired: false,
      },
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

  it('rejects a caught observation that contradicts its own detected:false evidence before it can inflate a denominator', () => {
    const result = scoreRevalidationCorpus([
      caseOf({
        caseId: 'contradictory-caught-observation',
        observation: { detected: false, actionRequired: null },
      }),
    ]);

    expect(result).toMatchObject({
      errors: expect.arrayContaining([
        {
          caseId: 'contradictory-caught-observation',
          rule: 'caught observation requires detected:true',
        },
      ]),
      manifest: { total: 1, accepted: 0, rejected: 1 },
      rates: { historical: { determinateCaught: 0, falseHolds: 0 } },
      belowFivePercent: { eligible: false },
    });
  });

  it('rejects a no-catch control that contradicts its own detected:true evidence before it can qualify coverage', () => {
    const result = scoreRevalidationCorpus([
      caseOf({
        caseId: 'contradictory-no-catch-control',
        kind: 'no-catch-control',
        origin: 'synthetic',
        detectionObligation: 'deferred',
        observation: { detected: true, actionRequired: null },
        label: {
          groundTruth: 'material',
          evidence: 'fixture://deferred-commentary-control',
          adjudication: 'agreed',
        },
      }),
    ]);

    expect(result).toMatchObject({
      errors: expect.arrayContaining([
        {
          caseId: 'contradictory-no-catch-control',
          rule: 'no-catch control requires detected:false',
        },
      ]),
      manifest: { total: 1, accepted: 0, rejected: 1 },
      belowFivePercent: { eligible: false },
    });
  });

  it('reports a historical material no-catch at a required checkpoint as an actual miss in its own population', () => {
    const result = scoreRevalidationCorpus([
      caseOf({
        caseId: 'historical-required-material-miss',
        kind: 'no-catch-control',
        origin: 'historical',
        detectionObligation: 'required',
        observation: { detected: false, actionRequired: null },
        label: {
          groundTruth: 'material',
          evidence: 'review://independent/historical-required-miss',
          adjudication: 'agreed',
        },
      }),
    ]);

    expect(result).toMatchObject({
      controls: {
        materialNoCatch: {
          historical: { required: { total: 1, missed: 1 }, deferred: { total: 0 } },
          synthetic: { required: { total: 0, missed: 0 }, deferred: { total: 0 } },
        },
      },
    });
    expect(result).not.toHaveProperty('caught');
  });

  it('keeps a deferred material commentary no-catch distinct from a required false-negative', () => {
    const result = scoreRevalidationCorpus([
      caseOf({
        caseId: 'synthetic-deferred-material-commentary',
        kind: 'no-catch-control',
        origin: 'synthetic',
        detectionObligation: 'deferred',
        observation: { detected: false, actionRequired: null },
        label: {
          groundTruth: 'material',
          evidence: 'review://independent/deferred-commentary',
          adjudication: 'agreed',
        },
      }),
    ]);

    expect(result).toMatchObject({
      controls: {
        materialNoCatch: {
          historical: { required: { total: 0, missed: 0 }, deferred: { total: 0 } },
          synthetic: { required: { total: 0, missed: 0 }, deferred: { total: 1 } },
        },
      },
    });
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
      rates: { historical: { determinateCaught: 0, falseHolds: 0 } },
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
      rates: { historical: { falseHolds: 1 } },
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

  it('partitions material no-catch controls by population instead of reporting a mixed metric', () => {
    const result = scoreRevalidationCorpus([
      caseOf({
        caseId: 'synthetic-material-no-catch',
        kind: 'no-catch-control',
        origin: 'synthetic',
        detectionObligation: 'required',
        observation: { detected: false, actionRequired: null },
        label: {
          groundTruth: 'material',
          evidence: 'fixture://external-title-change',
          adjudication: 'agreed',
        },
      }),
    ]);

    expect(result).toMatchObject({
      controls: {
        materialNoCatch: {
          historical: { required: { total: 0, missed: 0 }, deferred: { total: 0 } },
          synthetic: { required: { total: 1, missed: 1 }, deferred: { total: 0 } },
        },
      },
      origins: { synthetic: { total: 1 }, historical: { total: 0 } },
    });
    expect(result).not.toHaveProperty('caught');
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

  it('refuses a target claim when synthetic strata and controls pad a single historical catch', () => {
    const result = scoreRevalidationCorpus([
      ...completeFixtureCorpus('synthetic'),
      caseOf({
        caseId: 'one-historical-catch-among-synthetic-padding',
        locator: { run: 'historical-run', seq: 1, detectionId: 'historical-catch' },
      }),
    ]);

    expect(result).toMatchObject({
      belowFivePercent: { eligible: false },
      rates: {
        historical: { determinateCaught: 1 },
        synthetic: { determinateCaught: EXPECTED_STRATA.length - 1 },
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

describe('versioned independent historical adjudication fixture', () => {
  it('binds two distinct reviewer outputs to the unchanged frozen source fixture', () => {
    const labels = readHistoricalLabels();

    expect(labels).toMatchObject({
      schemaVersion: 1,
      sourceFixtureSha256: '9fec66526223db94383b1dbf6003f4dd164b173ec65fe8496f8d5bbddb1cdb9f',
      adjudicationPolicy:
        'matching determinate only; any unknown/missing/disagreement stays indeterminate',
    });
    expect(labels.reviewers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'independent-a',
          outputSha256: 'ac04a4763ba5ab8a81b1f9632f30242e6dcb47adc9b69770a9110e7548107464',
          sourceFixtureSha256: labels.sourceFixtureSha256,
          blinding: expect.any(String),
          limitations: expect.any(Array),
        }),
        expect.objectContaining({
          id: 'independent-b',
          outputSha256: 'f6b65efd8aac31b5ed971b1cccdb1c4366f86579f501f3880d95b4a98fb62457',
          sourceFixtureSha256: labels.sourceFixtureSha256,
          blindedInputSha256: 'e04f77f3fd235b74d025de37c436df4dba480aabaf9052ff7754e09ddc03f2f4',
          supersedesOutputSha256:
            'bcac181e50cb74f93328a5d57cd704262c45786846e300396ded5ce56091234a',
          blinding: expect.any(String),
          limitations: expect.any(Array),
        }),
      ]),
    );
    expect(new Set(labels.reviewers.map(({ id }) => id)).size).toBe(2);
  });

  it('retains every frozen source case exactly once with nonempty evidence from both reviewers', () => {
    const labels = readHistoricalLabels();
    const source = readHistoricalFixture();
    const sourceIds = source.observations.map(({ caseId }) => caseId).sort();
    const labelledIds = labels.cases.map(({ caseId }) => caseId).sort();
    const reviewerIds = labels.reviewers.map(({ id }) => id).sort();

    expect(labels.cases).toHaveLength(252);
    expect(new Set(labelledIds).size).toBe(252);
    expect(labelledIds).toEqual(sourceIds);
    for (const labelledCase of labels.cases) {
      expect(labelledCase.assessments).toHaveLength(2);
      expect(labelledCase.assessments.map(({ reviewer }) => reviewer).sort()).toEqual(reviewerIds);
      expect(labelledCase.assessments.every(({ evidence }) => evidence.trim().length > 0)).toBe(
        true,
      );
    }
  });

  it('keeps every unknown or reviewer disagreement indeterminate instead of selecting a reviewer label', () => {
    const labels = readHistoricalLabels();

    for (const labelledCase of labels.cases) {
      const [first, second] = labelledCase.assessments;
      if (!first || !second) throw new Error(`Expected two assessments for ${labelledCase.caseId}`);
      const sameGroundTruth = first.groundTruth === second.groundTruth;
      const expectedAdjudication = sameGroundTruth
        ? first.groundTruth === 'indeterminate'
          ? { groundTruth: 'indeterminate', status: 'agreed-indeterminate' }
          : { groundTruth: first.groundTruth, status: 'agreed-determinate' }
        : { groundTruth: 'indeterminate', status: 'disagreed' };

      expect(labelledCase.adjudication).toEqual(expectedAdjudication);
    }

    expect(
      labels.cases.filter(({ adjudication }) => adjudication.status === 'agreed-indeterminate'),
    ).toHaveLength(242);
    expect(
      labels.cases.filter(({ adjudication }) => adjudication.status === 'disagreed'),
    ).toHaveLength(10);
    expect(
      labels.cases.filter(({ adjudication }) => adjudication.groundTruth === 'indeterminate'),
    ).toHaveLength(252);
  });

  it('publishes adjudications without manufacturing a rate or a reduced denominator', () => {
    const labels = readHistoricalLabels();

    expect(Object.keys(labels).sort()).toEqual([
      'adjudicationPolicy',
      'cases',
      'reviewers',
      'schemaVersion',
      'sourceFixtureSha256',
    ]);
    expect(labels).not.toHaveProperty('rates');
    expect(labels).not.toHaveProperty('falseHoldRate');
    expect(labels).not.toHaveProperty('falseNegativeRate');
    expect(labels).not.toHaveProperty('denominator');
    expect(labels.cases).toHaveLength(252);
  });
});

describe('constructed revalidation controls fixture', () => {
  it('freezes a separate versioned population rather than relabelling or combining historical observations', () => {
    const fixture = readConstructedControls();

    expect(Object.keys(fixture).sort()).toEqual([
      'audit',
      'controls',
      'population',
      'schemaVersion',
      'scorerCalibration',
    ]);
    expect(fixture).toMatchObject({ schemaVersion: 1, population: 'synthetic-constructed-v1' });
    expect(fixture).not.toHaveProperty('historical');
    expect(fixture).not.toHaveProperty('rates');
    expect(fixture).not.toHaveProperty('falseHoldRate');
    expect(fixture).not.toHaveProperty('falseNegativeRate');
  });

  it('covers every native stratum with replayable pairs and no producer-supplied materiality label', () => {
    const fixture = readConstructedControls();
    const controlIds = fixture.controls.map(({ id }) => id);
    const coveredStrata = new Set(fixture.controls.flatMap(({ strata }) => strata));

    expect(fixture.controls.length).toBeGreaterThanOrEqual(19);
    expect(fixture.controls.length).toBeLessThanOrEqual(22);
    expect(new Set(controlIds).size).toBe(fixture.controls.length);
    expect([...coveredStrata].sort()).toEqual(
      EXPECTED_STRATA.filter((stratum) => stratum !== 'material-no-catch-control').sort(),
    );

    for (const control of fixture.controls) {
      expect(control.id).toMatch(/^[A-Z]\d{2}$/);
      expect(control.strata.length).toBeGreaterThan(0);
      expect(control.pair.baseline.trim()).not.toBe('');
      expect(control.pair.mutation.trim()).not.toBe('');
      expect(control.checkpointQuestion.trim()).not.toBe('');
      expect(['SELECT', 'BEFORE_PR', 'BEFORE_CLOSE']).toContain(control.checkpoint);
      expect(['CURRENT', 'CHANGED', 'UNVERIFIABLE']).toContain(control.expectedNative.result);
      expect(control.independentLabel).toEqual({ status: 'pending' });
      expect(control).not.toHaveProperty('groundTruth');
      expect(control).not.toHaveProperty('materiality');
      expect(control).not.toHaveProperty('actionRequired');
      expect(control).not.toHaveProperty('falseHold');
    }
  });

  it('binds every declared replay to an existing offline native test and a later audit receipt', () => {
    const fixture = readConstructedControls();
    const sources = {
      'content-blind-revalidation': readFileSync(
        fileURLToPath(new URL('./content-blind-revalidation.test.ts', import.meta.url)),
        'utf8',
      ),
      revalidate: readFileSync(
        fileURLToPath(new URL('./revalidate.test.ts', import.meta.url)),
        'utf8',
      ),
    };

    for (const control of fixture.controls) {
      expect(sources[control.replay.suite]).toContain(control.replay.test);
    }
    expect(fixture.audit.replayReceipt).toMatch(/^docs\/audits\/.+\.md$/);
    expect(
      existsSync(
        resolve(fileURLToPath(new URL('../..', import.meta.url)), fixture.audit.replayReceipt),
      ),
    ).toBe(true);
  });

  it('keeps the known material miss as a scorer-only calibration sample, separate from native replay evidence', () => {
    const fixture = readConstructedControls();

    expect(fixture.scorerCalibration).toEqual({
      id: 'CAL01',
      kind: 'material-no-catch-calibration',
      observation: { detected: false },
      materiality: 'material',
      separateFromNativeReplay: true,
    });
    expect(fixture.controls.some(({ id }) => id === fixture.scorerCalibration.id)).toBe(false);
    expect(
      [
        ...new Set([
          ...fixture.controls.flatMap(({ strata }) => strata),
          'material-no-catch-control',
        ]),
      ].sort(),
    ).toEqual([...EXPECTED_STRATA].sort());
  });
});

describe('superseding constructed-v2 replay fixture', () => {
  it('binds corrected S01 and S03 checkpoint contracts to their actual native replays without mutating v1 evidence', () => {
    const fixture = readConstructedControlsV2();
    const labels = readConstructedLabelsV2();
    const source = readFileSync(
      fileURLToPath(new URL('./content-blind-revalidation.test.ts', import.meta.url)),
      'utf8',
    );

    expect(fixture).toMatchObject({
      schemaVersion: 2,
      population: 'synthetic-constructed-v2',
      supersedes: {
        fixtureSha256: '2e70ee231b0fa1ad0de1e436a7bf3d674808aded162eae182c757470b2978e86',
        labelsSha256: '1328c281b8febba0482ea37ed845b9700daa30a4397faecbd1d93fae58c1bfd1',
      },
    });
    expect(labels).toMatchObject({
      schemaVersion: 2,
      population: 'synthetic-constructed-labels-v2',
      sourceFixtureSha256: createHash('sha256')
        .update(readFileSync(constructedControlsV2Path))
        .digest('hex'),
      supersedes: {
        labelsSha256: '1328c281b8febba0482ea37ed845b9700daa30a4397faecbd1d93fae58c1bfd1',
      },
    });

    expect(fixture.controls.filter(({ id }) => id === 'S01' || id === 'S03')).toEqual([
      expect.objectContaining({
        id: 'S01',
        strata: ['scope-title'],
        checkpoint: 'BEFORE_CLOSE',
        pair: {
          baseline: 'Tracked linked blocker claim after take-up.',
          mutation: 'Retitle the tracked blocker before close.',
        },
        replay: {
          suite: 'content-blind-revalidation',
          test: 'a real scope edit between take-up and close still holds on claim:scope',
        },
      }),
      expect.objectContaining({
        id: 'S03',
        strata: ['scope-labels'],
        checkpoint: 'BEFORE_PR',
        pair: {
          baseline:
            'Jira item after native SELECT and a committed claim with its original label set.',
          mutation:
            'Add a label while retaining the original summary, description and workflow state.',
        },
        replay: {
          suite: 'content-blind-revalidation',
          test: 'native replay: labels-only mutation after SELECT and a tracked claim holds claim:scope at BEFORE_PR',
        },
      }),
    ]);
    expect(source).toContain("title: 'the blocker, retitled'");
    expect(source).toContain("labels: ['keep-core', 'requires-review']");
  });
});

describe('synthetic pressure controls fixture', () => {
  it('freezes three concrete pending-label pairs against the immutable constructed-v1 source', () => {
    const fixture = readPressureControls();
    const source = readFileSync(
      fileURLToPath(new URL('./content-blind-revalidation.test.ts', import.meta.url)),
      'utf8',
    );

    expect(Object.keys(fixture).sort()).toEqual([
      'baseFixtureSha256',
      'controls',
      'population',
      'schemaVersion',
    ]);
    expect(fixture).toMatchObject({
      schemaVersion: 1,
      population: 'synthetic-pressure-controls-v1',
      baseFixtureSha256: '2e70ee231b0fa1ad0de1e436a7bf3d674808aded162eae182c757470b2978e86',
    });
    expect(fixture.controls).toEqual([
      expect.objectContaining({
        id: 'B02',
        checkpoint: 'BEFORE_PR',
        pair: {
          before: 'Publish  the daily report as CSV.',
          after: 'Publish the daily report as CSV.',
        },
        expectedNative: { result: 'CHANGED', source: 'claim:scope' },
        replay: {
          suite: 'content-blind-revalidation',
          test: 'native pressure replay B02: a prose-only double-space body change holds claim:scope at BEFORE_PR',
        },
        independentLabel: { status: 'pending' },
      }),
      expect.objectContaining({
        id: 'B03',
        checkpoint: 'BEFORE_CLOSE',
        pair: {
          before: 'Original requirement: target output must be CSV.',
          after:
            'Original requirement: target output must be CSV.\nThanks; requirements and approval are unchanged.',
        },
        expectedNative: { result: 'CHANGED', source: 'claim:commentary' },
        replay: {
          suite: 'content-blind-revalidation',
          test: 'native pressure replay B03: benign close-time commentary still holds claim:commentary',
        },
        independentLabel: { status: 'pending' },
      }),
      expect.objectContaining({
        id: 'P01',
        checkpoint: 'BEFORE_CLOSE',
        pair: {
          before: 'Original requirement: target output must be CSV.',
          after:
            'Original requirement: target output must be CSV.\nRequirement changed: target output must be JSON instead of CSV.',
        },
        expectedNative: { result: 'CHANGED', source: 'claim:commentary' },
        replay: {
          suite: 'content-blind-revalidation',
          test: 'native pressure replay P01: changed output requirement in close-time commentary holds claim:commentary',
        },
        independentLabel: { status: 'pending' },
      }),
    ]);
    for (const control of fixture.controls) {
      expect(source).toContain(control.replay.test);
      expect(control).not.toHaveProperty('groundTruth');
      expect(control).not.toHaveProperty('materiality');
      expect(control).not.toHaveProperty('actionRequired');
    }
    expect(fixture).not.toHaveProperty('rates');
    expect(fixture).not.toHaveProperty('falseHoldRate');
    expect(fixture).not.toHaveProperty('falseNegativeRate');
  });
});

describe('superseding pressure-v2 replay fixture', () => {
  it('keeps P01 required at close while N01 replays the exact pair as deferred CURRENT at before-pr', () => {
    const fixture = readPressureControlsV2();
    const source = readFileSync(
      fileURLToPath(new URL('./content-blind-revalidation.test.ts', import.meta.url)),
      'utf8',
    );

    expect(fixture).toMatchObject({
      schemaVersion: 2,
      population: 'synthetic-pressure-controls-v2',
      supersedes: {
        fixtureSha256: '7a1d4ffcc13aa0342586eafea77ac4cd5144b5e4cc07e41ea85ed03d8974037c',
        labelsSha256: '2588a1dcc96b1f48d7a803bf576308deb24e330da0a34763efbb1f81b6261ae5',
      },
    });
    expect(fixture.controls.map(({ id }) => id).sort()).toEqual(['B02', 'B03', 'N01', 'P01']);

    const n01 = fixture.controls.find(({ id }) => id === 'N01');
    const p01 = fixture.controls.find(({ id }) => id === 'P01');
    expect(n01).toEqual(
      expect.objectContaining({
        checkpoint: 'BEFORE_PR',
        pair: {
          before: 'Original requirement: target output must be CSV.',
          after:
            'Original requirement: target output must be CSV.\nRequirement changed: target output must be JSON instead of CSV.',
        },
        expectedNative: { result: 'CURRENT', source: [] },
        detectionObligation: 'deferred',
        replay: {
          suite: 'content-blind-revalidation',
          test: 'native pressure replay N01: changed output requirement in commentary is deferred as CURRENT at BEFORE_PR',
        },
      }),
    );
    expect(p01).toEqual(
      expect.objectContaining({
        checkpoint: 'BEFORE_CLOSE',
        pair: n01?.pair,
        expectedNative: { result: 'CHANGED', source: ['claim:commentary'] },
        detectionObligation: 'required',
        replay: {
          suite: 'content-blind-revalidation',
          test: 'native pressure replay P01: changed output requirement in close-time commentary holds claim:commentary',
        },
      }),
    );
    expect(source).toContain(n01?.replay.test);
    expect(source).toContain(p01?.replay.test);
  });
});

describe('independent constructed-v1 labels fixture', () => {
  it('binds both reviewer outputs to the frozen nineteen-control source and blinded input', () => {
    const labels = readConstructedLabels();

    expect(labels).toMatchObject({
      schemaVersion: 1,
      population: 'synthetic-constructed-labels-v1',
      sourceFixtureSha256: '2e70ee231b0fa1ad0de1e436a7bf3d674808aded162eae182c757470b2978e86',
      blindedInputSha256: 'ab0968f802e5389e8e39d9048f78fc4317da0836b498a83f396211ff8d55c044',
      adjudicationPolicy:
        'matching determinate only; any unknown/missing/disagreement stays indeterminate',
    });
    expect(labels.reviewers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'independent-a',
          outputSha256: 'ea1aaafe88145d73934cf285a356621607e4dc1a34ad59bc75b8d2c5752bed43',
          sourceFixtureSha256: labels.sourceFixtureSha256,
          blindedInputSha256: labels.blindedInputSha256,
          limitations: expect.any(Array),
        }),
        expect.objectContaining({
          id: 'independent-b',
          outputSha256: '6e90cbe47321e821b9ce39479c9f1dd466f161103fe6d6b429cf120f83576caa',
          sourceFixtureSha256: labels.sourceFixtureSha256,
          blindedInputSha256: labels.blindedInputSha256,
          limitations: expect.any(Array),
        }),
      ]),
    );
    expect(new Set(labels.reviewers.map(({ id }) => id)).size).toBe(2);
    expect(labels).not.toHaveProperty('rates');
    expect(labels).not.toHaveProperty('falseHoldRate');
    expect(labels).not.toHaveProperty('falseNegativeRate');
  });

  it('retains all nineteen source ids and turns every disagreement into an indeterminate adjudication', () => {
    const labels = readConstructedLabels();
    const controls = readConstructedControls();
    const sourceIds = controls.controls.map(({ id }) => id).sort();
    const labelIds = labels.cases.map(({ caseId }) => caseId).sort();
    const reviewerIds = labels.reviewers.map(({ id }) => id).sort();

    expect(labels.cases).toHaveLength(19);
    expect(new Set(labelIds).size).toBe(19);
    expect(labelIds).toEqual(sourceIds);
    for (const labelledCase of labels.cases) {
      expect(labelledCase.assessments).toHaveLength(2);
      expect(labelledCase.assessments.map(({ reviewer }) => reviewer).sort()).toEqual(reviewerIds);
      expect(labelledCase.assessments.every(({ evidence }) => evidence.trim().length > 0)).toBe(
        true,
      );
      expect(labelledCase).not.toHaveProperty('blindedCaseId');
    }
    expectDeterministicSyntheticAdjudication(labels.cases);
    expect(
      labels.cases.filter(({ adjudication }) => adjudication.groundTruth === 'material'),
    ).toHaveLength(11);
    expect(
      labels.cases.filter(({ adjudication }) => adjudication.groundTruth === 'benign'),
    ).toHaveLength(2);
    expect(
      labels.cases.filter(({ adjudication }) => adjudication.groundTruth === 'indeterminate'),
    ).toHaveLength(6);
    expect(
      labels.cases.filter(({ adjudication }) => adjudication.status === 'disagreed'),
    ).toHaveLength(6);
    expect(
      labels.cases.filter(({ adjudication }) => adjudication.status === 'agreed-indeterminate'),
    ).toHaveLength(0);
  });
});

describe('independent pressure-v1 labels fixture', () => {
  it('binds both reviewer outputs to the three-case pressure source and blinded input', () => {
    const labels = readPressureLabels();

    expect(labels).toMatchObject({
      schemaVersion: 1,
      population: 'synthetic-pressure-labels-v1',
      sourceFixtureSha256: '7a1d4ffcc13aa0342586eafea77ac4cd5144b5e4cc07e41ea85ed03d8974037c',
      blindedInputSha256: '93f19fb7761e02d6e8c524a251fbc66040f375292b226df78ff8d87f8777810f',
      adjudicationPolicy:
        'matching determinate only; any unknown/missing/disagreement stays indeterminate',
    });
    expect(labels.reviewers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'independent-a',
          outputSha256: '9ee50bbc89cf58bf16360fb211ba9cbc96d1cc660a4bdea7d3edfc337fe03b57',
          sourceFixtureSha256: labels.sourceFixtureSha256,
          blindedInputSha256: labels.blindedInputSha256,
          limitations: expect.any(Array),
        }),
        expect.objectContaining({
          id: 'independent-b',
          outputSha256: '21d9a39f1a2f0138458039278fbcfbdaf10b8801e1b55e7bbcc11c3513436122',
          sourceFixtureSha256: labels.sourceFixtureSha256,
          blindedInputSha256: labels.blindedInputSha256,
          limitations: expect.any(Array),
        }),
      ]),
    );
    expect(new Set(labels.reviewers.map(({ id }) => id)).size).toBe(2);
    expect(labels).not.toHaveProperty('rates');
    expect(labels).not.toHaveProperty('falseHoldRate');
    expect(labels).not.toHaveProperty('falseNegativeRate');
  });

  it('joins each source case id to its separately preserved blinded case id and determinate assessments', () => {
    const labels = readPressureLabels();
    const controls = readPressureControls();
    const reviewerIds = labels.reviewers.map(({ id }) => id).sort();

    expect(controls.controls.map(({ id }) => id).sort()).toEqual(['B02', 'B03', 'P01']);
    expect(labels.cases).toHaveLength(3);
    expect(labels.cases.map(({ caseId }) => caseId).sort()).toEqual(['B02', 'B03', 'P01']);
    expect(
      Object.fromEntries(labels.cases.map(({ caseId, blindedCaseId }) => [caseId, blindedCaseId])),
    ).toEqual({ B02: 'case-482', B03: 'case-175', P01: 'case-936' });
    for (const labelledCase of labels.cases) {
      expect(labelledCase.assessments).toHaveLength(2);
      expect(labelledCase.assessments.map(({ reviewer }) => reviewer).sort()).toEqual(reviewerIds);
      expect(labelledCase.assessments.every(({ evidence }) => evidence.trim().length > 0)).toBe(
        true,
      );
    }
    expectDeterministicSyntheticAdjudication(labels.cases);
    expect(
      labels.cases.filter(({ adjudication }) => adjudication.groundTruth === 'material'),
    ).toHaveLength(1);
    expect(
      labels.cases.filter(({ adjudication }) => adjudication.groundTruth === 'benign'),
    ).toHaveLength(2);
    expect(
      labels.cases.filter(({ adjudication }) => adjudication.groundTruth === 'indeterminate'),
    ).toHaveLength(0);
    expect(
      labels.cases.filter(({ adjudication }) => adjudication.status === 'disagreed'),
    ).toHaveLength(0);
  });
});

describe('evidence-bound superseding pressure-v2 capture', () => {
  it('records N01 and the three retained replays as real, source-bound native observations', () => {
    const fixture = readPressureControlsV2();
    const native = readPressureNativeV2();

    expect(native).toMatchObject({
      schemaVersion: 2,
      sourceFixtureSha256: createHash('sha256')
        .update(readFileSync(pressureControlsV2Path))
        .digest('hex'),
    });
    expect(native.metadata.command).toContain('native pressure replay');
    expect(native.metadata.sourceHead).toMatch(/^[a-f0-9]{40}$/);
    expect(native.metadata.workingTree).toEqual(
      expect.objectContaining({
        'test/template/content-blind-revalidation.test.ts': expect.stringMatching(/^[a-f0-9]{64}$/),
        'test/template/revalidation-corpus.test.ts': expect.stringMatching(/^[a-f0-9]{64}$/),
        'test/fixtures/revalidation-controls/pressure-v2.json':
          expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(native.observations.map(({ caseId }) => caseId).sort()).toEqual([
      'B02',
      'B03',
      'N01',
      'P01',
    ]);
    for (const observation of native.observations) {
      const control = fixture.controls.find(({ id }) => id === observation.caseId);
      expect(control).toBeDefined();
      expect(observation.point).toBe(control?.checkpoint);
      expect(observation.result).toBe(control?.expectedNative.result);
      expect(observation.source).toEqual(control?.expectedNative.source);
      expect(observation.locator).toMatchObject({
        checkoutPathSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        run: expect.stringMatching(/^\d{8}-\d{6}$/),
        seq: expect.any(Number),
        detectionId: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(observation.locator.seq).toBeGreaterThan(0);
    }
  });
});

describe('evidence-bound synthetic pressure measurement', () => {
  it('joins captured native locators to independent pressure labels without treating the synthetic sample as representative', () => {
    const native = readPressureNative();
    const labels = readPressureLabels();
    const strata = {
      B02: 'scope-body',
      B03: 'close-time-commentary',
      P01: 'close-time-commentary',
    };

    expect(native).toMatchObject({
      schemaVersion: 1,
      sourceFixtureSha256: '7a1d4ffcc13aa0342586eafea77ac4cd5144b5e4cc07e41ea85ed03d8974037c',
    });
    expect(native.metadata.command.trim()).not.toBe('');
    expect(native.metadata.sourceHead).toMatch(/^[a-f0-9]{40}$/);
    expect(native.metadata.workingTree).toEqual(
      expect.objectContaining({
        'test/template/content-blind-revalidation.test.ts': expect.stringMatching(/^[a-f0-9]{64}$/),
        'test/template/revalidation-corpus.test.ts': expect.stringMatching(/^[a-f0-9]{64}$/),
        'test/fixtures/revalidation-controls/pressure-v1.json':
          expect.stringMatching(/^[a-f0-9]{64}$/),
        'test/fixtures/revalidation-controls/pressure-labels-v1.json':
          expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(native.observations.map(({ caseId }) => caseId).sort()).toEqual(['B02', 'B03', 'P01']);
    for (const observation of native.observations) {
      expect(observation.locator.checkoutPathSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(observation.locator.run).toMatch(/^\d{8}-\d{6}$/);
      expect(observation.locator.seq).toBeGreaterThan(0);
      expect(observation.locator.detectionId).toMatch(/^[a-f0-9]{64}$/);
      expect(observation.source.length).toBeGreaterThan(0);
    }
    expect(
      new Set(
        native.observations.map(
          ({ locator }) => `${locator.checkoutPathSha256}:${locator.run}:${locator.seq}`,
        ),
      ).size,
    ).toBe(3);

    const labelsByCase = new Map(
      labels.cases.map((labelledCase) => {
        if (!labelledCase.caseId)
          throw new Error('pressure labels require source case ids for native join');
        return [labelledCase.caseId, labelledCase];
      }),
    );
    const measurement = scoreRevalidationCorpus(
      native.observations.map((observation) => {
        const label = labelsByCase.get(observation.caseId);
        if (!label) throw new Error(`missing independent label for ${observation.caseId}`);
        return {
          caseId: observation.caseId,
          locator: observation.locator,
          stratum: strata[observation.caseId],
          kind: 'caught' as const,
          origin: 'synthetic' as const,
          observation: { detected: observation.result === 'CHANGED', actionRequired: null },
          label: {
            groundTruth: label.adjudication.groundTruth,
            evidence: label.assessments.map(({ evidence }) => evidence).join('; '),
            adjudication:
              label.adjudication.status === 'agreed-determinate'
                ? ('agreed' as const)
                : ('disagreed' as const),
          },
        };
      }),
    );

    expect(measurement).toMatchObject({
      errors: [],
      totalCases: 3,
      labels: { material: 1, benign: 2, indeterminate: 0 },
      rates: { synthetic: { determinateCaught: 3, falseHolds: 2 } },
      origins: { synthetic: { total: 3 } },
      belowFivePercent: {
        eligible: false,
        missingHistoricalDeterminateCaught: true,
      },
    });
    expect(native.observations.some(({ caseId }) => String(caseId) === 'CAL01')).toBe(false);
  });
});
