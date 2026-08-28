import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { withoutGitLocation } from '../git-env.mjs';

export const CLAIM_SCHEMA_VERSION = 1;
export const RESULTS = Object.freeze([
  'BASELINE_CREATED',
  'CURRENT',
  'CHANGED',
  'CONFLICT',
  'UNVERIFIABLE',
]);

const TICKET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CONTRACT_PATH = '.rig/revalidation.json';
const MAX_CONTRACT_BYTES = 256 * 1024;
const MAX_CLAIM_BYTES = 256 * 1024;
const MAX_PAIRED_FACT_BYTES = 16 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stable(entry)]),
    );
  }
  return value;
};

const digest = (value) =>
  createHash('sha256')
    .update(Buffer.isBuffer(value) ? value : JSON.stringify(stable(value)))
    .digest('hex');

const safeRelativePath = (value) => {
  if (
    typeof value !== 'string' ||
    value === '' ||
    isAbsolute(value) ||
    value.split(/[\\/]/).some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`paired fact path ${JSON.stringify(value)} is not a safe repository-relative path`);
  }
  return value.replaceAll('\\', '/');
};

export const readRevalidationContract = (projectRoot) => {
  const path = join(projectRoot, CONTRACT_PATH);
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`no-detection-contract: ${CONTRACT_PATH} is missing or unreadable`);
  }
  if (Buffer.byteLength(raw) > MAX_CONTRACT_BYTES) {
    throw new Error(`no-detection-contract: ${CONTRACT_PATH} exceeds ${MAX_CONTRACT_BYTES} bytes`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`no-detection-contract: ${CONTRACT_PATH} is not valid JSON`);
  }
  const detection = parsed?.detection;
  const sources = detection?.sources;
  const pairedFacts = parsed?.pairedFacts;
  if (
    parsed?.schemaVersion !== CLAIM_SCHEMA_VERSION ||
    detection?.mode !== 'pull' ||
    !Array.isArray(sources) ||
    !sources.includes('run-state') ||
    !sources.includes('journal') ||
    detection?.acceptedLatency !== '24h' ||
    detection?.push !== false ||
    !Array.isArray(pairedFacts)
  ) {
    throw new Error(
      `no-detection-contract: ${CONTRACT_PATH} must declare schemaVersion 1, pull via ` +
        'run-state and journal, acceptedLatency 24h, push false, and pairedFacts',
    );
  }
  const ids = new Set();
  const normalisedPairs = pairedFacts.map((pair) => {
    if (
      !pair ||
      typeof pair !== 'object' ||
      typeof pair.id !== 'string' ||
      pair.id === '' ||
      ids.has(pair.id) ||
      !Array.isArray(pair.paths) ||
      pair.paths.length !== 2
    ) {
      throw new Error(
        `no-detection-contract: every pairedFacts entry in ${CONTRACT_PATH} needs ` +
          'a unique id and exactly two paths',
      );
    }
    ids.add(pair.id);
    const paths = pair.paths.map(safeRelativePath);
    if (paths[0] === paths[1]) {
      throw new Error(`no-detection-contract: paired fact ${pair.id} names the same path twice`);
    }
    return { id: pair.id, paths };
  });
  return {
    schemaVersion: CLAIM_SCHEMA_VERSION,
    detection: {
      mode: 'pull',
      sources: ['run-state', 'journal'],
      acceptedLatency: '24h',
      push: false,
    },
    pairedFacts: normalisedPairs,
  };
};

const pairedFingerprintsOf = (projectRoot, pairs) =>
  pairs.map(({ id, paths }) => ({
    id,
    paths: paths.map((path) => {
      const file = join(projectRoot, path);
      const stat = lstatSync(file);
      if (!stat.isFile()) throw new Error(`paired fact ${path} is not a regular file`);
      if (stat.size > MAX_PAIRED_FACT_BYTES) {
        throw new Error(`paired fact ${path} exceeds ${MAX_PAIRED_FACT_BYTES} bytes`);
      }
      return { path, value: digest(readFileSync(file)) };
    }),
  }));

const ticketIdOf = (ticket) => {
  const id = String(ticket?.id ?? '');
  if (!TICKET_ID.test(id) || id === '.' || id === '..') {
    throw new Error(`claim record: unusable ticket id ${JSON.stringify(id)}`);
  }
  return id;
};

export const claimPathFor = (projectRoot, ticket) =>
  join(projectRoot, '.rig', 'claims', `${ticketIdOf(ticket)}.json`);

const pointerFor = (projectRoot, ticket) =>
  relative(projectRoot, claimPathFor(projectRoot, ticket)).replaceAll('\\', '/');

const normaliseLinks = (ticket) => ({
  blockedBy: (ticket?.blockedBy ?? [])
    .map(({ id, resolved }) => ({ id: String(id), resolved: Boolean(resolved) }))
    .sort((left, right) => left.id.localeCompare(right.id)),
  blocks: (ticket?.blocks ?? []).map(String).sort(),
});

const fingerprintsOf = ({ ticket, targetSha, pairedFacts = [] }) => {
  const commentaryIds = (ticket?.commentary?.ids ?? []).map(String).sort();
  const commentaryCount = Number.isInteger(ticket?.commentary?.count)
    ? ticket.commentary.count
    : commentaryIds.length;
  const scopeInput = {
    title: ticket?.title ?? null,
    body: ticket?.body ?? null,
    labels: (ticket?.labels ?? [])
      .map(String)
      .filter((label) => !['ready', 'blocked', 'in-progress', 'escalated'].includes(label))
      .sort(),
    links: normaliseLinks(ticket),
    pairedFacts,
  };
  return {
    scope: {
      algorithm: 'sha256',
      value: digest(scopeInput),
      targetSha,
    },
    commentary: {
      algorithm: 'sha256',
      value: digest({ count: commentaryCount, ids: commentaryIds }),
      count: commentaryCount,
    },
  };
};

const fingerprintIdentity = (fingerprints) => ({
  scope: fingerprints.scope.value,
  commentary: fingerprints.commentary.value,
});

/** Add an existing checkpoint's non-fingerprint drift without creating another engine. */
export const withAdditionalDrift = (detection, sources = []) => {
  if (sources.length === 0) return detection;
  for (const source of sources) {
    if (
      source !== 'task:state' &&
      !(typeof source === 'string' && /^main:[^\0\r\n]+$/.test(source))
    ) {
      throw new Error(`unsupported additional revalidation source ${JSON.stringify(source)}`);
    }
  }
  const next =
    detection.action === 'continue'
      ? { ...detection, result: 'CHANGED', changed: true, action: 'hold' }
      : detection;
  const combined = { ...next, source: [...new Set([...next.source, ...sources])] };
  return {
    ...combined,
    id: digest({
      ticket: combined.ticket,
      checkpoint: combined.checkpoint,
      result: combined.result,
      movedFingerprintSet: combined.movedFingerprintSet,
      source: combined.source,
      sourcePointer: combined.sourcePointer,
    }),
  };
};

const trackedByGit = (projectRoot, path) => {
  try {
    execFileSync('git', ['-C', projectRoot, 'ls-files', '--error-unmatch', '--', path], {
      encoding: 'utf8',
      env: withoutGitLocation(),
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
};

const readClaim = (path) => {
  if (!lstatSync(path).isFile()) throw new Error('claim record is not a regular file');
  const raw = readFileSync(path);
  if (raw.byteLength > MAX_CLAIM_BYTES) throw new Error(`claim record exceeds ${MAX_CLAIM_BYTES} bytes`);
  const parsed = JSON.parse(raw.toString('utf8'));
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    parsed.schemaVersion !== CLAIM_SCHEMA_VERSION ||
    typeof parsed.ticket !== 'string' ||
    parsed.fingerprints?.scope?.algorithm !== 'sha256' ||
    !SHA256.test(parsed.fingerprints?.scope?.value ?? '') ||
    (parsed.fingerprints.scope.targetSha !== null &&
      !/^[0-9a-f]{40}$/.test(parsed.fingerprints.scope.targetSha ?? '')) ||
    parsed.fingerprints?.commentary?.algorithm !== 'sha256' ||
    !SHA256.test(parsed.fingerprints?.commentary?.value ?? '') ||
    !Number.isInteger(parsed.fingerprints?.commentary?.count) ||
    parsed.fingerprints.commentary.count < 0
  ) {
    throw new Error('claim record has an unsupported shape');
  }
  return parsed;
};

const resultOf = ({
  ticket,
  point,
  result,
  action,
  movedFingerprintSet = [],
  pointer,
  evidence,
  identity = null,
}) => {
  const id = ticketIdOf(ticket);
  return {
    schemaVersion: CLAIM_SCHEMA_VERSION,
    id: digest({ id, point, result, movedFingerprintSet, pointer, identity }),
    ticket: id,
    point,
    checkpoint: point,
    result,
    changed:
      result === 'CHANGED' || result === 'CONFLICT'
        ? true
        : result === 'UNVERIFIABLE'
          ? null
          : false,
    source: movedFingerprintSet.map((set) => `claim:${set}`),
    action,
    movedFingerprintSet,
    sourcePointer: pointer,
    evidence,
  };
};

export const revalidateClaim = ({
  projectRoot,
  ticket,
  point,
  targetSha,
  allowCreate = false,
  isResume = false,
}) => {
  const path = claimPathFor(projectRoot, ticket);
  const pointer = pointerFor(projectRoot, ticket);
  let pairedFacts;
  try {
    const contract = readRevalidationContract(projectRoot);
    pairedFacts = pairedFingerprintsOf(projectRoot, contract.pairedFacts);
  } catch (error) {
    return resultOf({
      ticket,
      point,
      result: 'UNVERIFIABLE',
      action: 'unverifiable',
      pointer,
      evidence: { error: error.message },
      identity: error.message,
    });
  }
  const current = fingerprintsOf({ ticket, targetSha, pairedFacts });

  const tracked = trackedByGit(projectRoot, pointer);
  if (!existsSync(path)) {
    if (tracked) {
      return resultOf({
        ticket,
        point,
        result: 'UNVERIFIABLE',
        action: 'unverifiable',
        pointer,
        evidence: { error: `missing tracked claim record ${pointer}` },
        identity: 'missing-tracked',
      });
    }
    if (point === 'SELECT' && allowCreate && !isResume) {
      mkdirSync(dirname(path), { recursive: true });
      const claim = {
        schemaVersion: CLAIM_SCHEMA_VERSION,
        ticket: ticketIdOf(ticket),
        fingerprints: current,
      };
      writeFileSync(path, `${JSON.stringify(claim, null, 2)}\n`, { flag: 'wx' });
      return resultOf({
        ticket,
        point,
        result: 'BASELINE_CREATED',
        action: 'continue',
        pointer,
        evidence: { claim: pointer },
        identity: fingerprintIdentity(current),
      });
    }
    return resultOf({
      ticket,
      point,
      result: 'UNVERIFIABLE',
      action: 'unverifiable',
      pointer,
      evidence: { error: `missing claim record ${pointer}` },
      identity: 'missing',
    });
  }

  if (!tracked) {
    return resultOf({
      ticket,
      point,
      result: 'UNVERIFIABLE',
      action: 'unverifiable',
      pointer,
      evidence: { error: `untracked claim record ${pointer}` },
      identity: 'untracked',
    });
  }

  let claim;
  try {
    claim = readClaim(path);
  } catch (error) {
    return resultOf({
      ticket,
      point,
      result: 'UNVERIFIABLE',
      action: 'unverifiable',
      pointer,
      evidence: { error: `unreadable claim record ${pointer}: ${error.message}` },
      identity: error.message,
    });
  }
  if (claim.ticket !== ticketIdOf(ticket)) {
    return resultOf({
      ticket,
      point,
      result: 'CONFLICT',
      action: 'hold',
      movedFingerprintSet: ['scope'],
      pointer,
      evidence: { error: `claim ticket conflicts with ${ticketIdOf(ticket)}` },
      identity: claim.ticket,
    });
  }

  const scopeMoved =
    claim.fingerprints.scope.value !== current.scope.value ||
    claim.fingerprints.scope.targetSha !== current.scope.targetSha;
  const commentaryMoved = claim.fingerprints.commentary.value !== current.commentary.value;
  const movedFingerprintSet = [
    ...(scopeMoved ? ['scope'] : []),
    ...(point === 'BEFORE_CLOSE' && commentaryMoved ? ['commentary'] : []),
  ];
  return resultOf({
    ticket,
    point,
    result: movedFingerprintSet.length > 0 ? 'CHANGED' : 'CURRENT',
    action: movedFingerprintSet.length > 0 ? 'hold' : 'continue',
    movedFingerprintSet,
    pointer,
    evidence: {
      claim: pointer,
      ...(commentaryMoved && point !== 'BEFORE_CLOSE' ? { observedFingerprintSet: ['commentary'] } : {}),
    },
    identity: fingerprintIdentity(current),
  });
};

const gitText = (projectRoot, args) =>
  execFileSync('git', ['-C', projectRoot, ...args], {
    encoding: 'utf8',
    env: withoutGitLocation(),
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

export const targetShaOf = (projectRoot, ref = null) => {
  const candidates = ref
    ? [ref]
    : [
        (() => {
          try {
            return gitText(projectRoot, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
          } catch {
            return null;
          }
        })(),
        'master',
        'main',
      ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return gitText(projectRoot, ['rev-parse', '--verify', candidate]);
    } catch {
      // Try the next conventional target name.
    }
  }
  return null;
};
