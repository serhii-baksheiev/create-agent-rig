export const REQUIRED_REVALIDATION_CORPUS_STRATA = [
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

type CorpusCase = {
  caseId: string;
  locator: { run: string; seq: number; detectionId: string };
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

type CorpusError = { caseId: string; rule: string };

const emptyRate = () => ({ determinateCaught: 0, falseHolds: 0 });

export const scoreRevalidationCorpus = (cases: CorpusCase[]) => {
  const errors: CorpusError[] = [];
  const caseIds = new Set<string>();
  const accepted: CorpusCase[] = [];

  for (const corpusCase of cases) {
    let rejected = false;

    if (!corpusCase.locator.run || corpusCase.locator.seq <= 0 || !corpusCase.locator.detectionId) {
      errors.push({ caseId: corpusCase.caseId, rule: 'provenance locator' });
      rejected = true;
    }

    if (corpusCase.kind === 'caught' && !corpusCase.observation.detected) {
      errors.push({ caseId: corpusCase.caseId, rule: 'caught observation requires detected:true' });
      rejected = true;
    }

    if (corpusCase.kind === 'no-catch-control' && corpusCase.observation.detected) {
      errors.push({ caseId: corpusCase.caseId, rule: 'no-catch control requires detected:false' });
      rejected = true;
    }

    if (caseIds.has(corpusCase.caseId)) {
      errors.push({ caseId: corpusCase.caseId, rule: 'unique caseId' });
      rejected = true;
    }
    caseIds.add(corpusCase.caseId);

    if (!corpusCase.label.evidence) {
      errors.push({ caseId: corpusCase.caseId, rule: 'independent label evidence' });
      rejected = true;
    }

    if (
      corpusCase.label.groundTruth !== 'indeterminate' &&
      corpusCase.label.adjudication !== 'agreed'
    ) {
      errors.push({ caseId: corpusCase.caseId, rule: 'independent label adjudication' });
      rejected = true;
    }

    if (!rejected) {
      accepted.push(corpusCase);
    }
  }

  const labels = { material: 0, benign: 0, indeterminate: 0 };
  const observed = { actionChangingOutcomes: 0 };
  const rates = { historical: emptyRate(), synthetic: emptyRate() };
  const origins = { historical: { total: 0 }, synthetic: { total: 0 } };
  const controls = {
    materialNoCatch: {
      historical: { required: { total: 0, missed: 0 }, deferred: { total: 0 } },
      synthetic: { required: { total: 0, missed: 0 }, deferred: { total: 0 } },
    },
  };
  const strata = REQUIRED_REVALIDATION_CORPUS_STRATA.map((stratum) => ({ stratum, total: 0 }));
  const historicalStrata = REQUIRED_REVALIDATION_CORPUS_STRATA.map((stratum) => ({
    stratum,
    total: 0,
  }));

  for (const corpusCase of accepted) {
    labels[corpusCase.label.groundTruth] += 1;
    origins[corpusCase.origin].total += 1;

    const stratum = strata.find((entry) => entry.stratum === corpusCase.stratum);
    if (stratum) {
      stratum.total += 1;
    }

    if (corpusCase.origin === 'historical') {
      const historicalStratum = historicalStrata.find(
        (entry) => entry.stratum === corpusCase.stratum,
      );
      if (historicalStratum) {
        historicalStratum.total += 1;
      }
    }

    if (corpusCase.observation.actionRequired === true) {
      observed.actionChangingOutcomes += 1;
    }

    if (corpusCase.kind === 'caught' && corpusCase.label.groundTruth !== 'indeterminate') {
      rates[corpusCase.origin].determinateCaught += 1;
      if (corpusCase.label.groundTruth === 'benign') {
        rates[corpusCase.origin].falseHolds += 1;
      }
    }

    if (corpusCase.kind === 'no-catch-control' && corpusCase.label.groundTruth === 'material') {
      const obligation = corpusCase.detectionObligation ?? 'required';
      if (obligation === 'required') {
        const control = controls.materialNoCatch[corpusCase.origin].required;
        control.total += 1;
        control.missed += 1;
      } else {
        controls.materialNoCatch[corpusCase.origin].deferred.total += 1;
      }
    }
  }

  const missingStrata = strata.filter((entry) => entry.total === 0).map((entry) => entry.stratum);
  const missingHistoricalStrata = historicalStrata
    .filter((entry) => entry.total === 0)
    .map((entry) => entry.stratum);
  const missingMaterialControls =
    controls.materialNoCatch.historical.required.total +
      controls.materialNoCatch.historical.deferred.total +
      controls.materialNoCatch.synthetic.required.total +
      controls.materialNoCatch.synthetic.deferred.total ===
    0;
  const missingHistoricalMaterialControls =
    controls.materialNoCatch.historical.required.total +
      controls.materialNoCatch.historical.deferred.total ===
    0;
  const indeterminateCases = labels.indeterminate;
  const missingHistoricalDeterminateCaught = rates.historical.determinateCaught === 0;

  return {
    errors,
    manifest: {
      total: cases.length,
      accepted: accepted.length,
      rejected: cases.length - accepted.length,
    },
    totalCases: accepted.length,
    labels,
    observed,
    rates,
    origins,
    controls,
    strata,
    belowFivePercent: {
      eligible:
        errors.length === 0 &&
        missingStrata.length === 0 &&
        !missingMaterialControls &&
        missingHistoricalStrata.length === 0 &&
        !missingHistoricalMaterialControls &&
        indeterminateCases === 0 &&
        !missingHistoricalDeterminateCaught,
      missingStrata,
      missingMaterialControls,
      missingHistoricalStrata,
      missingHistoricalMaterialControls,
      indeterminateCases,
      missingHistoricalDeterminateCaught,
    },
  };
};
