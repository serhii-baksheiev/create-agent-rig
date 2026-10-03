import { createHash } from 'node:crypto';
import { findSecretValues } from './secrets.mjs';

export const TDD_EVIDENCE_SCHEMA_VERSION = 1;

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const TICKET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LEVELS = new Set(['TDD-0', 'TDD-1', 'TDD-2', 'TDD-3']);
const MAX_CANONICAL_DEPTH = 16;
const MAX_CANONICAL_NODES = 512;
const MAX_CANONICAL_STRING_BYTES = 4096;
const MAX_CANONICAL_BYTES = 64 * 1024;
const MAX_SECRET_SCAN_DEPTH = 16;
const MAX_SECRET_SCAN_NODES = 512;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const compareCodeUnits = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

const canonical = (value, state = { depth: 0, nodes: 0 }) => {
  if (state.depth > MAX_CANONICAL_DEPTH || ++state.nodes > MAX_CANONICAL_NODES) {
    throw new RangeError('evidence exceeds canonical structure bounds');
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > MAX_CANONICAL_STRING_BYTES) throw new RangeError('evidence string exceeds bounds');
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    state.depth += 1;
    const entries = value.map((entry) => canonical(entry, state));
    state.depth -= 1;
    return entries;
  }
  if (isObject(value)) {
    state.depth += 1;
    const entries = Object.entries(value)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, entry]) => [key, canonical(entry, state)]);
    state.depth -= 1;
    return Object.fromEntries(
      entries,
    );
  }
  throw new TypeError('evidence must contain only JSON values');
};

export const fingerprintEvidence = (record) => {
  const encoded = JSON.stringify(canonical(record));
  if (Buffer.byteLength(encoded) > MAX_CANONICAL_BYTES) throw new RangeError('evidence exceeds canonical byte bounds');
  return { algorithm: 'sha256', value: createHash('sha256').update(encoded).digest('hex') };
};

const safeRelativePath = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 512 &&
  !value.startsWith('/') &&
  !value.startsWith('\\') &&
  !/^[A-Za-z]:/.test(value) &&
  !value.split(/[\\/]/).some((part) => part === '' || part === '.' || part === '..');

const sameTest = (left, right) =>
  left !== undefined &&
  right !== undefined &&
  left.file === right.file &&
  left.fullName === right.fullName &&
  left.fileSha256 === right.fileSha256;

export const validateRefactorEvidence = (evidence) => {
  if (!isObject(evidence) || !Array.isArray(evidence.before) || !Array.isArray(evidence.after)) {
    return { ok: false };
  }
  const valid = (entry) =>
    isObject(entry) &&
    safeRelativePath(entry.file) &&
    typeof entry.fullName === 'string' &&
    entry.fullName.length > 0 &&
    entry.fullName.length <= 1024 &&
    SHA256.test(entry.fileSha256) &&
    entry.outcome === 'pass';
  if (
    !evidence.before.length ||
    evidence.before.length > 512 ||
    evidence.after.length > 512 ||
    evidence.before.length !== evidence.after.length
  ) {
    return { ok: false };
  }
  if (![...evidence.before, ...evidence.after].every(valid)) return { ok: false };
  const identity = (entry) => `${entry.file}\u0000${entry.fullName}`;
  const before = new Map(evidence.before.map((entry) => [identity(entry), entry]));
  if (before.size !== evidence.before.length) return { ok: false };
  if (new Set(evidence.after.map(identity)).size !== evidence.after.length) return { ok: false };
  return { ok: evidence.after.every((entry) => sameTest(before.get(identity(entry)), entry)) };
};

/**
 * The second argument is reserved for a verified consumer such as RP-306.
 * This pure helper checks structure and binding, not who invoked it. The first
 * argument is controller-provided work state and cannot claim tracker authority.
 */
export const resolveApplicability = (input, trusted = {}) => {
  const changedPaths = Array.isArray(input?.changedPaths) ? input.changedPaths : [];
  const trackerDecision = trusted?.trackerDecision;
  if (validTrustedTrackerDecision(trackerDecision, input?.ticket)) {
    return {
      level: trackerDecision.level,
      authority: trackerDecision.level === 'TDD-0' ? 'owner-waiver' : 'tracker',
    };
  }
  if (Array.isArray(input?.finalBehaviorPaths) && input.finalBehaviorPaths.length > 0) {
    return { level: 'TDD-2', authority: 'final-diff' };
  }
  if (validateTrustedRefactorEvidence(trusted?.refactorEvidence, input)) {
    return { level: 'TDD-0', authority: 'trusted-refactor-evidence' };
  }
  const nonProductionPath = (path) =>
    typeof path === 'string' &&
    (/^docs\//.test(path) || /(?:^|\/)test\//.test(path) || /(?:^|\/)[^/]+\.test\.[^/]+$/.test(path));
  if (changedPaths.length > 0 && changedPaths.every(nonProductionPath)) {
    return { level: 'TDD-0', authority: 'path-contract' };
  }
  return { level: 'TDD-2', authority: 'default-production' };
};

const allowed = (value, keys, label, problems) => {
  if (!isObject(value)) {
    problems.push(`${label} must be an object`);
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) {
      const message = `${label ? `${label}.` : ''}[unknown-key] is not permitted in portable evidence`;
      problems.push(message.slice(0, 512));
    }
  }
  return true;
};

const scanPortableStrings = (value, label, problems, state = { depth: 0, nodes: 0, exhausted: false }) => {
  if (state.depth > MAX_SECRET_SCAN_DEPTH || ++state.nodes > MAX_SECRET_SCAN_NODES) {
    if (!state.exhausted) problems.push('portable evidence credential scan exceeded bounds');
    state.exhausted = true;
    return;
  }
  if (typeof value === 'string') {
    if (findSecretValues(value).length > 0) problems.push(`${label} contains credential-shaped content`);
    return;
  }
  if (!isObject(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    state.depth += 1;
    scanPortableStrings(entry, label ? `${label}.${key}` : key, problems, state);
    state.depth -= 1;
  }
};

const validateSource = (source, label, problems) => {
  allowed(source, new Set(['runId', 'seq']), label, problems);
  if (!RUN_ID.test(source?.runId ?? '')) problems.push(`${label}.runId must be a bounded run id`);
  if (!Number.isSafeInteger(source?.seq) || source.seq < 0) problems.push(`${label}.seq must be a non-negative integer`);
};

const validateTest = (test, label, problems) => {
  allowed(test, new Set(['file', 'fullName', 'fileSha256']), label, problems);
  if (!safeRelativePath(test?.file)) problems.push(`${label}.file must be a safe repository-relative path`);
  if (typeof test?.fullName !== 'string' || test.fullName.length === 0 || test.fullName.length > 1024) {
    problems.push(`${label}.fullName must be a bounded test name`);
  }
  if (!SHA256.test(test?.fileSha256 ?? '')) problems.push(`${label}.fileSha256 must be a SHA-256 digest`);
};

const isFingerprint = (value) =>
  isObject(value) && value.algorithm === 'sha256' && SHA256.test(value.value ?? '');

const hasFingerprintShape = (value) =>
  isFingerprint(value) && Object.keys(value).every((key) => key === 'algorithm' || key === 'value');

const validateFingerprintShape = (value, label, problems) => {
  allowed(value, new Set(['algorithm', 'value']), label, problems);
  if (!hasFingerprintShape(value)) {
    problems.push(`${label} must be a SHA-256 fingerprint`);
    return false;
  }
  return true;
};

const fingerprintsEqual = (left, right) =>
  isFingerprint(left) && isFingerprint(right) && left.algorithm === right.algorithm && left.value === right.value;

const validateFingerprint = (value, expected, label, problems) => {
  if (!validateFingerprintShape(value, label, problems)) return;
  try {
    if (value.value !== fingerprintEvidence(expected).value) problems.push(`${label} must match canonical evidence`);
  } catch {
    problems.push(`${label} must match canonical evidence`);
  }
};

const validateObservation = (observation, label, outcome, problems) => {
  const object = allowed(observation, new Set(['outcome', 'checkFingerprint']), label, problems);
  const fingerprint = observation?.checkFingerprint;
  const validFingerprint = isFingerprint(fingerprint);
  if (isObject(observation)) validateFingerprintShape(fingerprint, `${label}.checkFingerprint`, problems);
  if (!object || observation?.outcome !== outcome || !validFingerprint) {
    problems.push(`${label} must bind a check-result outcome and fingerprint`);
  }
  if (object && observation?.outcome !== outcome) problems.push(`${label}.outcome must be ${outcome}`);
};

const validJiraSource = (source, ticket, { decisionContent = false } = {}) =>
  isObject(source) &&
  Object.keys(source).every((key) =>
    ['system', 'issue', 'commentId', 'actor', ...(decisionContent ? ['decisionContentFingerprint'] : [])].includes(key),
  ) &&
  source.system === 'jira' &&
  source.issue === ticket &&
  TICKET.test(source.issue ?? '') &&
  typeof source.commentId === 'string' &&
  source.commentId.length > 0 &&
  source.commentId.length <= 128 &&
  typeof source.actor === 'string' &&
  source.actor.length > 0 &&
  source.actor.length <= 256 &&
  (!decisionContent || hasFingerprintShape(source.decisionContentFingerprint));

const validTrustedTrackerDecision = (decision, ticket) => {
  const source = decision?.source;
  return (
    isObject(decision) &&
    LEVELS.has(decision.level) &&
    TICKET.test(ticket ?? '') &&
    validJiraSource(source, ticket, { decisionContent: decision.level === 'TDD-0' })
  );
};

const validProofCheckpoint = (checkpoint) =>
  isObject(checkpoint) &&
  Object.keys(checkpoint).every((key) => ['source', 'outcome', 'checkFingerprint', 'testSetFingerprint'].includes(key)) &&
  isObject(checkpoint.source) &&
  Object.keys(checkpoint.source).every((key) => ['runId', 'seq'].includes(key)) &&
  RUN_ID.test(checkpoint.source.runId ?? '') &&
  Number.isSafeInteger(checkpoint.source.seq) &&
  checkpoint.source.seq >= 0 &&
  checkpoint.outcome === 'pass' &&
  hasFingerprintShape(checkpoint.checkFingerprint) &&
  hasFingerprintShape(checkpoint.testSetFingerprint);

const validateTrustedRefactorEvidence = (evidence, input) => {
  if (
    !isObject(evidence) ||
    !Object.keys(evidence).every((key) => ['ticket', 'baselineHeadSha', 'testSet', 'before', 'after', 'fingerprint'].includes(key)) ||
    !TICKET.test(input?.ticket ?? '') ||
    !GIT_SHA.test(input?.baselineHeadSha ?? '')
  ) {
    return false;
  }
  if (
    evidence.ticket !== input.ticket ||
    evidence.baselineHeadSha !== input.baselineHeadSha ||
    !isObject(evidence.testSet) ||
    !Object.keys(evidence.testSet).every((key) => ['count', 'fingerprint'].includes(key)) ||
    !Number.isSafeInteger(evidence.testSet.count) ||
    evidence.testSet.count <= 0 ||
    !hasFingerprintShape(evidence.testSet.fingerprint) ||
    !validProofCheckpoint(evidence.before) ||
    !validProofCheckpoint(evidence.after) ||
    !hasFingerprintShape(evidence.fingerprint) ||
    !fingerprintsEqual(evidence.before.testSetFingerprint, evidence.testSet.fingerprint) ||
    !fingerprintsEqual(evidence.after.testSetFingerprint, evidence.testSet.fingerprint)
  ) {
    return false;
  }
  if (
    evidence.before.source.runId === evidence.after.source.runId &&
    evidence.before.source.seq >= evidence.after.source.seq
  ) {
    return false;
  }
  try {
    return fingerprintsEqual(
      evidence.fingerprint,
      fingerprintEvidence({
        ticket: evidence.ticket,
        baselineHeadSha: evidence.baselineHeadSha,
        testSet: evidence.testSet,
        before: evidence.before,
        after: evidence.after,
      }),
    );
  } catch {
    return false;
  }
};

const validateTdd0Authority = (authority, record, problems) => {
  const kind = authority?.kind;
  if (kind === 'path-contract') {
    allowed(authority, new Set(['kind', 'id']), 'applicability.authority', problems);
    return;
  }
  if (kind === 'owner-waiver') {
    allowed(authority, new Set(['kind', 'id', 'source', 'decisionFingerprint']), 'applicability.authority', problems);
    allowed(
      authority?.source,
      new Set(['system', 'issue', 'commentId', 'actor', 'decisionContentFingerprint']),
      'applicability.authority.source',
      problems,
    );
    if (!validJiraSource(authority?.source, record?.ticket, { decisionContent: true })) {
      problems.push('applicability.authority.source must identify this Jira item');
    }
    validateFingerprintShape(
      authority?.source?.decisionContentFingerprint,
      'applicability.authority.source.decisionContentFingerprint',
      problems,
    );
    const label = 'applicability.authority.decisionFingerprint';
    validateFingerprintShape(authority?.decisionFingerprint, label, problems);
    try {
      if (
        isFingerprint(authority?.decisionFingerprint) &&
        !fingerprintsEqual(
          authority.decisionFingerprint,
          fingerprintEvidence({ level: 'TDD-0', ticket: record?.ticket, source: authority.source }),
        )
      ) {
        problems.push(`${label} must match canonical owner-waiver evidence`);
      }
    } catch {
      problems.push(`${label} must match canonical owner-waiver evidence`);
    }
    return;
  }
  if (kind === 'trusted-refactor-evidence') {
    allowed(authority, new Set(['kind', 'id', 'proof']), 'applicability.authority', problems);
    if (
      !validateTrustedRefactorEvidence(authority?.proof, {
        ticket: record?.ticket,
        baselineHeadSha: record?.baseline?.headSha,
      })
    ) {
      problems.push('applicability.authority.proof must be a bound compact refactor proof');
    }
    return;
  }
  allowed(authority, new Set(['kind', 'id']), 'applicability.authority', problems);
  problems.push('applicability.authority.kind is not permitted for TDD-0');
};

const validateStage = (stage, name, { test = false, predecessor = false } = {}, problems, binding) => {
  const implementation = name === 'implementationBoundary';
  const permitted = new Set(['source', 'fingerprint']);
  if (test) permitted.add('test');
  if (implementation) permitted.add('implementationDeltaFingerprint');
  else permitted.add('observation');
  if (predecessor) permitted.add('predecessorFingerprint');
  allowed(stage, permitted, name, problems);
  if (test) validateTest(stage?.test, `${name}.test`, problems);
  validateSource(stage?.source, `${name}.source`, problems);
  if (implementation) {
    const delta = stage?.implementationDeltaFingerprint;
    validateFingerprintShape(delta, 'implementationBoundary.implementationDeltaFingerprint', problems);
  } else {
    validateObservation(stage?.observation, `${name}.observation`, name === 'green' ? 'pass' : 'fail', problems);
  }
  const canonicalStage = {
    ticket: binding?.ticket,
    baselineHeadSha: binding?.baseline?.headSha,
    stage:
      name === 'implementationBoundary'
        ? 'implementation-boundary'
        : name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
  };
  if (test) canonicalStage.test = stage?.test;
  canonicalStage.source = stage?.source;
  if (implementation) canonicalStage.implementationDeltaFingerprint = stage?.implementationDeltaFingerprint;
  else canonicalStage.observation = stage?.observation;
  if (predecessor) canonicalStage.predecessorFingerprint = stage?.predecessorFingerprint;
  validateFingerprint(stage?.fingerprint, canonicalStage, `${name}.fingerprint`, problems);
};

const validatePreRed = (preRed, record, problems) => {
  allowed(preRed, new Set(['baseline', 'origin', 'production', 'implementationAgentDispatch', 'fingerprint']), 'preRed', problems);
  allowed(preRed?.baseline, new Set(['headSha']), 'preRed.baseline', problems);
  if (preRed?.baseline?.headSha !== record?.baseline?.headSha) {
    problems.push('preRed.baseline.headSha must equal baseline.headSha');
  }
  const origin = preRed?.origin;
  if (!isObject(origin)) {
    problems.push('preRed.origin is required');
  } else {
    allowed(origin, new Set(['ticket', 'baselineHeadSha', 'redFingerprint']), 'preRed.origin', problems);
    if (origin.ticket !== record?.ticket) problems.push('preRed.origin.ticket must equal ticket');
    if (origin.baselineHeadSha !== record?.baseline?.headSha) {
      problems.push('preRed.origin.baselineHeadSha must equal baseline.headSha');
    }
    validateFingerprintShape(origin.redFingerprint, 'preRed.origin.redFingerprint', problems);
  }
  const production = preRed?.production;
  allowed(production, new Set(['pathCount', 'fingerprint']), 'preRed.production', problems);
  if (!Number.isSafeInteger(production?.pathCount) || production.pathCount < 0 || production.pathCount > 1024) {
    problems.push('preRed.production.pathCount must be a bounded non-negative integer');
  }
  validateFingerprintShape(production?.fingerprint, 'preRed.production.fingerprint', problems);
  const dispatch = preRed?.implementationAgentDispatch;
  allowed(dispatch, new Set(['count', 'fingerprint']), 'preRed.implementationAgentDispatch', problems);
  if (!Number.isSafeInteger(dispatch?.count) || dispatch.count < 0 || dispatch.count > 1024) {
    problems.push('preRed.implementationAgentDispatch.count must be a bounded non-negative integer');
  }
  validateFingerprintShape(dispatch?.fingerprint, 'preRed.implementationAgentDispatch.fingerprint', problems);
  validateFingerprint(
    preRed?.fingerprint,
    {
      baseline: preRed?.baseline,
      origin,
      production,
      implementationAgentDispatch: dispatch,
    },
    'preRed.fingerprint',
    problems,
  );
};

const validatePredecessor = (stage, previous, name, problems) => {
  const label = `${name}.predecessorFingerprint`;
  if (!validateFingerprintShape(stage?.predecessorFingerprint, label, problems)) return;
  if (!fingerprintsEqual(stage.predecessorFingerprint, previous?.fingerprint)) {
    problems.push(`${label} must equal the previous stage fingerprint`);
  }
};

const validateStageOrder = (stages, problems) => {
  for (let left = 0; left < stages.length; left += 1) {
    for (let right = left + 1; right < stages.length; right += 1) {
      const earlier = stages[left];
      const later = stages[right];
      const earlierSource = earlier.value?.source;
      const laterSource = later.value?.source;
      if (
        earlierSource?.runId !== undefined &&
        laterSource?.runId !== undefined &&
        earlierSource.runId === laterSource.runId &&
        earlierSource.seq >= laterSource.seq
      ) {
        problems.push(`${later.name}.source.seq must follow ${earlier.name}.source.seq in the same run`);
      }
    }
  }
};

export const validatePortableEvidence = (record) => {
  const problems = [];
  const rootAllowed = new Set(['schemaVersion', 'ticket', 'applicability', 'baseline', 'preRed', 'red', 'implementationBoundary', 'green', 'nonVacuity']);
  allowed(record, rootAllowed, '', problems);
  if (record?.schemaVersion !== TDD_EVIDENCE_SCHEMA_VERSION) problems.push('schemaVersion is unsupported');
  if (!TICKET.test(record?.ticket ?? '')) problems.push('ticket must be a bounded item identity');
  allowed(record?.applicability, new Set(['level', 'authority']), 'applicability', problems);
  if (!['TDD-0', 'TDD-1', 'TDD-2', 'TDD-3'].includes(record?.applicability?.level)) {
    problems.push('applicability.level is unsupported');
  }
  if (!isObject(record?.applicability?.authority)) {
    problems.push('applicability.authority must be an object');
  }
  if (typeof record?.applicability?.authority?.kind !== 'string' || record.applicability.authority.kind.length > 64) {
    problems.push('applicability.authority.kind must be bounded');
  }
  if (typeof record?.applicability?.authority?.id !== 'string' || record.applicability.authority.id.length > 128) {
    problems.push('applicability.authority.id must be bounded');
  }
  allowed(record?.baseline, new Set(['headSha']), 'baseline', problems);
  if (!GIT_SHA.test(record?.baseline?.headSha ?? '')) problems.push('baseline.headSha must be a Git object id');
  if (record?.preRed !== undefined) validatePreRed(record.preRed, record, problems);

  const level = record?.applicability?.level;
  const forbid = (names) => {
    for (const name of names) {
      if (record?.[name] !== undefined) problems.push(`${name} is not permitted for ${level}`);
    }
  };
  if (level === 'TDD-0') {
    validateTdd0Authority(record?.applicability?.authority, record, problems);
    forbid(['red', 'implementationBoundary', 'green', 'nonVacuity', 'preRed']);
  } else if (level === 'TDD-1') {
    allowed(record?.applicability?.authority, new Set(['kind', 'id']), 'applicability.authority', problems);
    validateStage(record?.red, 'red', { test: true }, problems, record);
    forbid(['implementationBoundary', 'green', 'nonVacuity']);
  } else if (level === 'TDD-2' || level === 'TDD-3') {
    allowed(record?.applicability?.authority, new Set(['kind', 'id']), 'applicability.authority', problems);
    validateStage(record?.red, 'red', { test: true }, problems, record);
    validateStage(record?.implementationBoundary, 'implementationBoundary', { predecessor: true }, problems, record);
    validateStage(record?.green, 'green', { test: true, predecessor: true }, problems, record);
    validatePredecessor(record?.implementationBoundary, record?.red, 'implementationBoundary', problems);
    validatePredecessor(record?.green, record?.implementationBoundary, 'green', problems);
    if (record?.red?.test && record?.green?.test) {
      if (record.green.test.file !== record.red.test.file) problems.push('green.test.file must equal red.test.file');
      if (record.green.test.fullName !== record.red.test.fullName) problems.push('green.test.fullName must equal red.test.fullName');
      if (record.green.test.fileSha256 !== record.red.test.fileSha256) {
        problems.push('green.test.fileSha256 must equal red.test.fileSha256');
      }
    }
    validateStageOrder(
      [
        { name: 'red', value: record?.red },
        { name: 'implementationBoundary', value: record?.implementationBoundary },
        { name: 'green', value: record?.green },
      ],
      problems,
    );
  }
  if (level === 'TDD-3') {
    if (!record?.nonVacuity) {
      problems.push('nonVacuity is required for TDD-3');
    } else {
      validateStage(record.nonVacuity, 'nonVacuity', { test: true, predecessor: true }, problems, record);
      validatePredecessor(record.nonVacuity, record?.green, 'nonVacuity', problems);
      if (record?.green?.test && record.nonVacuity?.test && !sameTest(record.green.test, record.nonVacuity.test)) {
        problems.push('nonVacuity.test must equal green.test');
      }
      validateStageOrder(
        [
          { name: 'red', value: record?.red },
          { name: 'implementationBoundary', value: record?.implementationBoundary },
          { name: 'green', value: record?.green },
          { name: 'nonVacuity', value: record?.nonVacuity },
        ],
        problems,
      );
    }
  } else if ((level === 'TDD-2' || level === 'TDD-1') && record?.nonVacuity !== undefined) {
    problems.push('nonVacuity is permitted only for TDD-3');
  }
  if (problems.length === 0) scanPortableStrings(record, '', problems);
  return problems.length ? { ok: false, problems } : { ok: true };
};

export const validateTddEvidenceHistory = ({ ticket, baselineHeadSha, activeEvidence, history }) => {
  const problems = [];
  const origin = activeEvidence?.preRed?.origin;
  if (history === undefined) {
    if (
      origin !== undefined &&
      (origin.ticket !== activeEvidence?.ticket ||
        origin.baselineHeadSha !== activeEvidence?.baseline?.headSha ||
        !fingerprintsEqual(origin.redFingerprint, activeEvidence?.red?.fingerprint))
    ) {
      return { ok: false, problems: ['preRed.origin must match the active RED without history'] };
    }
    return { ok: true };
  }
  if (!Array.isArray(history) || history.length === 0 || history.length > 8) {
    return { ok: false, problems: ['tddEvidenceHistory must contain 1..8 entries'] };
  }
  let replacement = activeEvidence;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (!isObject(entry) || !allowed(entry, new Set(['evidence', 'transition']), `tddEvidenceHistory[${index}]`, problems)) {
      continue;
    }
    const evidence = entry.evidence;
    const validation = validatePortableEvidence(evidence);
    if (!validation.ok) problems.push(`tddEvidenceHistory[${index}].evidence is invalid`);
    if (
      !['TDD-1', 'TDD-2', 'TDD-3'].includes(evidence?.applicability?.level) ||
      evidence?.ticket !== ticket ||
      evidence?.baseline?.headSha !== baselineHeadSha
    ) {
      problems.push(`tddEvidenceHistory[${index}].evidence does not bind the active ticket and baseline`);
    }
    const transition = entry.transition;
    const label = `tddEvidenceHistory[${index}].transition`;
    if (transition?.priorRedFingerprint !== undefined || transition?.replacementRedFingerprint !== undefined) {
      allowed(transition, new Set(['priorRedFingerprint', 'replacementRedFingerprint', 'fingerprint']), label, problems);
      validateFingerprintShape(transition?.priorRedFingerprint, `${label}.priorRedFingerprint`, problems);
      validateFingerprintShape(transition?.replacementRedFingerprint, `${label}.replacementRedFingerprint`, problems);
      validateFingerprintShape(transition?.fingerprint, `${label}.fingerprint`, problems);
      if (!fingerprintsEqual(transition?.priorRedFingerprint, evidence?.red?.fingerprint)) {
        problems.push(`${label}.priorRedFingerprint must match history RED`);
      }
      if (!fingerprintsEqual(transition?.replacementRedFingerprint, replacement?.red?.fingerprint)) {
        problems.push(`${label}.replacementRedFingerprint must match replacement RED`);
      }
      const priorTest = evidence?.red?.test;
      const replacementTest = replacement?.red?.test;
      if (
        !priorTest ||
        !replacementTest ||
        priorTest.file !== replacementTest.file ||
        priorTest.fullName !== replacementTest.fullName ||
        priorTest.fileSha256 === replacementTest.fileSha256
      ) {
        problems.push(`${label} must replace one test identity with a different test-file hash`);
      }
      validateFingerprint(
        transition?.fingerprint,
        {
          ticket,
          baselineHeadSha,
          stage: 'stale-red-replacement',
          priorRedFingerprint: transition?.priorRedFingerprint,
          replacementRedFingerprint: transition?.replacementRedFingerprint,
        },
        `${label}.fingerprint`,
        problems,
      );
    } else {
      allowed(
        transition,
        new Set([
          'priorGreenFingerprint',
          'replacementGreenFingerprint',
          'priorImplementationBoundaryFingerprint',
          'replacementImplementationBoundaryFingerprint',
          'mergedDefaultSha',
          'fingerprint',
        ]),
        label,
        problems,
      );
      validateFingerprintShape(transition?.priorGreenFingerprint, `${label}.priorGreenFingerprint`, problems);
      validateFingerprintShape(transition?.replacementGreenFingerprint, `${label}.replacementGreenFingerprint`, problems);
      validateFingerprintShape(
        transition?.priorImplementationBoundaryFingerprint,
        `${label}.priorImplementationBoundaryFingerprint`,
        problems,
      );
      validateFingerprintShape(
        transition?.replacementImplementationBoundaryFingerprint,
        `${label}.replacementImplementationBoundaryFingerprint`,
        problems,
      );
      validateFingerprintShape(transition?.fingerprint, `${label}.fingerprint`, problems);
      if (!GIT_SHA.test(transition?.mergedDefaultSha ?? '')) problems.push(`${label}.mergedDefaultSha must be a Git object id`);
      if (!fingerprintsEqual(transition?.priorGreenFingerprint, evidence?.green?.fingerprint)) {
        problems.push(`${label}.priorGreenFingerprint must match history GREEN`);
      }
      if (!fingerprintsEqual(transition?.replacementGreenFingerprint, replacement?.green?.fingerprint)) {
        problems.push(`${label}.replacementGreenFingerprint must match replacement GREEN`);
      }
      if (
        !fingerprintsEqual(
          transition?.priorImplementationBoundaryFingerprint,
          evidence?.implementationBoundary?.fingerprint,
        )
      ) {
        problems.push(`${label}.priorImplementationBoundaryFingerprint must match history implementation boundary`);
      }
      if (
        !fingerprintsEqual(
          transition?.replacementImplementationBoundaryFingerprint,
          replacement?.implementationBoundary?.fingerprint,
        )
      ) {
        problems.push(`${label}.replacementImplementationBoundaryFingerprint must match replacement implementation boundary`);
      }
      if (
        evidence?.applicability?.level !== 'TDD-2' ||
        replacement?.applicability?.level !== 'TDD-2' ||
        !sameTest(evidence?.red?.test, replacement?.red?.test) ||
        !fingerprintsEqual(evidence?.red?.fingerprint, replacement?.red?.fingerprint)
      ) {
        problems.push(`${label} must preserve one TDD-2 RED and relevant specification`);
      }
      validateFingerprint(
        transition?.fingerprint,
        {
          ticket,
          baselineHeadSha,
          stage: 'merged-default-green-refresh',
          priorGreenFingerprint: transition?.priorGreenFingerprint,
          replacementGreenFingerprint: transition?.replacementGreenFingerprint,
          priorImplementationBoundaryFingerprint: transition?.priorImplementationBoundaryFingerprint,
          replacementImplementationBoundaryFingerprint: transition?.replacementImplementationBoundaryFingerprint,
          mergedDefaultSha: transition?.mergedDefaultSha,
        },
        `${label}.fingerprint`,
        problems,
      );
    }
    replacement = evidence;
  }
  if (origin !== undefined) {
    const candidates = [activeEvidence, ...history.map((entry) => entry?.evidence)];
    if (
      !candidates.some(
        (evidence) =>
          evidence?.ticket === origin.ticket &&
          evidence?.baseline?.headSha === origin.baselineHeadSha &&
          fingerprintsEqual(evidence?.red?.fingerprint, origin.redFingerprint),
      )
    ) {
      problems.push('preRed.origin must match a bound RED evidence record');
    }
  }
  if (problems.length === 0) scanPortableStrings(history, 'tddEvidenceHistory', problems);
  return problems.length ? { ok: false, problems } : { ok: true };
};
