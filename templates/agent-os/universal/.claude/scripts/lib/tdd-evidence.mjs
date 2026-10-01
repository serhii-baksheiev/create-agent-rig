import { createHash } from 'node:crypto';

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

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

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
      .sort(([left], [right]) => left.localeCompare(right))
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
  if (!evidence.before.length || evidence.before.length !== evidence.after.length) return { ok: false };
  if (![...evidence.before, ...evidence.after].every(valid)) return { ok: false };
  const identity = (entry) => `${entry.file}\u0000${entry.fullName}`;
  const before = new Map(evidence.before.map((entry) => [identity(entry), entry]));
  if (before.size !== evidence.before.length) return { ok: false };
  if (new Set(evidence.after.map(identity)).size !== evidence.after.length) return { ok: false };
  return { ok: evidence.after.every((entry) => sameTest(before.get(identity(entry)), entry)) };
};

/**
 * `trustedTrackerDecision` is deliberately a separate input. The caller may
 * supply it only after authenticating and attributing tracker data; this pure
 * helper never promotes a controller-written waiver (including `verified`)
 * into authority.
 */
export const resolveApplicability = (input) => {
  const changedPaths = Array.isArray(input?.changedPaths) ? input.changedPaths : [];
  const trusted = input?.trustedTrackerDecision;
  if (isObject(trusted) && LEVELS.has(trusted.level) && isObject(trusted.source)) {
    return {
      level: trusted.level,
      authority: trusted.level === 'TDD-0' ? 'owner-waiver' : 'tracker',
    };
  }
  if (isObject(input?.authoritative) && ['TDD-2', 'TDD-3'].includes(input.authoritative.level)) {
    return { level: input.authoritative.level, authority: 'tracker' };
  }
  if (Array.isArray(input?.finalBehaviorPaths) && input.finalBehaviorPaths.length > 0) {
    return { level: 'TDD-2', authority: 'final-diff' };
  }
  if (validateRefactorEvidence(input?.pureRefactor).ok) {
    return { level: 'TDD-0', authority: 'pure-refactor-proof' };
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
    if (!keys.has(key)) problems.push(`${label ? `${label}.` : ''}${key} is not permitted in portable evidence`);
  }
  return true;
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

const validateFingerprint = (value, expected, label, problems) => {
  allowed(value, new Set(['algorithm', 'value']), label, problems);
  if (value?.algorithm !== 'sha256' || !SHA256.test(value?.value ?? '')) {
    problems.push(`${label} must be a SHA-256 fingerprint`);
    return;
  }
  try {
    if (value.value !== fingerprintEvidence(expected).value) problems.push(`${label} must match canonical evidence`);
  } catch {
    problems.push(`${label} must match canonical evidence`);
  }
};

const validateObservation = (observation, label, outcome, problems) => {
  const object = allowed(observation, new Set(['outcome', 'checkFingerprint']), label, problems);
  const fingerprint = observation?.checkFingerprint;
  const validFingerprint =
    isObject(fingerprint) &&
    Object.keys(fingerprint).every((key) => key === 'algorithm' || key === 'value') &&
    fingerprint.algorithm === 'sha256' &&
    SHA256.test(fingerprint.value ?? '');
  if (!object || observation?.outcome !== outcome || !validFingerprint) {
    problems.push(`${label} must bind a check-result outcome and fingerprint`);
  }
  if (object && observation?.outcome !== outcome) problems.push(`${label}.outcome must be ${outcome}`);
};

const validateStage = (stage, name, { test = false } = {}, problems) => {
  const implementation = name === 'implementationBoundary';
  const permitted = new Set(['source', 'fingerprint']);
  if (test) permitted.add('test');
  if (implementation) permitted.add('implementationDeltaFingerprint');
  else permitted.add('observation');
  allowed(stage, permitted, name, problems);
  if (test) validateTest(stage?.test, `${name}.test`, problems);
  validateSource(stage?.source, `${name}.source`, problems);
  if (implementation) {
    const delta = stage?.implementationDeltaFingerprint;
    if (delta?.algorithm !== 'sha256' || !SHA256.test(delta?.value ?? '')) {
      problems.push('implementationBoundary.implementationDeltaFingerprint must be a SHA-256 fingerprint');
    }
  } else {
    validateObservation(stage?.observation, `${name}.observation`, name === 'green' ? 'pass' : 'fail', problems);
  }
  const canonicalStage = {
    stage:
      name === 'implementationBoundary'
        ? 'implementation-boundary'
        : name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
  };
  if (test) canonicalStage.test = stage?.test;
  canonicalStage.source = stage?.source;
  if (implementation) canonicalStage.implementationDeltaFingerprint = stage?.implementationDeltaFingerprint;
  else canonicalStage.observation = stage?.observation;
  validateFingerprint(stage?.fingerprint, canonicalStage, `${name}.fingerprint`, problems);
};

const stageOrder = (left, right, leftName, rightName, problems) => {
  if (left?.source?.runId === right?.source?.runId && left?.source?.seq >= right?.source?.seq) {
    problems.push(`${rightName}.source.seq must follow ${leftName}.source.seq in the same run`);
  }
};

export const validatePortableEvidence = (record) => {
  const problems = [];
  const rootAllowed = new Set(['schemaVersion', 'ticket', 'applicability', 'baseline', 'red', 'implementationBoundary', 'green', 'nonVacuity']);
  allowed(record, rootAllowed, '', problems);
  if (record?.schemaVersion !== TDD_EVIDENCE_SCHEMA_VERSION) problems.push('schemaVersion is unsupported');
  if (!TICKET.test(record?.ticket ?? '')) problems.push('ticket must be a bounded item identity');
  allowed(record?.applicability, new Set(['level', 'authority']), 'applicability', problems);
  if (!['TDD-0', 'TDD-1', 'TDD-2', 'TDD-3'].includes(record?.applicability?.level)) {
    problems.push('applicability.level is unsupported');
  }
  allowed(record?.applicability?.authority, new Set(['kind', 'id']), 'applicability.authority', problems);
  if (typeof record?.applicability?.authority?.kind !== 'string' || record.applicability.authority.kind.length > 64) {
    problems.push('applicability.authority.kind must be bounded');
  }
  if (typeof record?.applicability?.authority?.id !== 'string' || record.applicability.authority.id.length > 128) {
    problems.push('applicability.authority.id must be bounded');
  }
  allowed(record?.baseline, new Set(['headSha']), 'baseline', problems);
  if (!GIT_SHA.test(record?.baseline?.headSha ?? '')) problems.push('baseline.headSha must be a Git object id');

  const level = record?.applicability?.level;
  const forbid = (names) => {
    for (const name of names) {
      if (record?.[name] !== undefined) problems.push(`${name} is not permitted for ${level}`);
    }
  };
  if (level === 'TDD-0') {
    forbid(['red', 'implementationBoundary', 'green', 'nonVacuity']);
  } else if (level === 'TDD-1') {
    validateStage(record?.red, 'red', { test: true }, problems);
    forbid(['implementationBoundary', 'green', 'nonVacuity']);
  } else if (level === 'TDD-2' || level === 'TDD-3') {
    validateStage(record?.red, 'red', { test: true }, problems);
    validateStage(record?.implementationBoundary, 'implementationBoundary', {}, problems);
    validateStage(record?.green, 'green', { test: true }, problems);
    if (record?.red?.test && record?.green?.test) {
      if (record.green.test.file !== record.red.test.file) problems.push('green.test.file must equal red.test.file');
      if (record.green.test.fullName !== record.red.test.fullName) problems.push('green.test.fullName must equal red.test.fullName');
      if (record.green.test.fileSha256 !== record.red.test.fileSha256) {
        problems.push('green.test.fileSha256 must equal red.test.fileSha256');
      }
    }
    stageOrder(record?.red, record?.implementationBoundary, 'red', 'implementationBoundary', problems);
    stageOrder(record?.implementationBoundary, record?.green, 'implementationBoundary', 'green', problems);
  }
  if (level === 'TDD-3') {
    if (!record?.nonVacuity) {
      problems.push('nonVacuity is required for TDD-3');
    } else {
      validateStage(record.nonVacuity, 'nonVacuity', { test: true }, problems);
      if (record?.green?.test && record.nonVacuity?.test && !sameTest(record.green.test, record.nonVacuity.test)) {
        problems.push('nonVacuity.test must equal green.test');
      }
      stageOrder(record?.green, record?.nonVacuity, 'green', 'nonVacuity', problems);
    }
  } else if ((level === 'TDD-2' || level === 'TDD-1') && record?.nonVacuity !== undefined) {
    problems.push('nonVacuity is permitted only for TDD-3');
  }
  return problems.length ? { ok: false, problems } : { ok: true };
};
