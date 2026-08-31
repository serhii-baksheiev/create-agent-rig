import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
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
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

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

const pathExists = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

const assertInsideRepository = (projectRoot, path, label) => {
  const root = realpathSync(projectRoot);
  const resolved = realpathSync(path);
  const fromRoot = relative(root, resolved);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`${label} escapes the repository`);
  }
  return { root, resolved };
};

const readRepositoryFile = (projectRoot, path, { label, maxBytes }) => {
  let declared;
  try {
    declared = lstatSync(path);
  } catch (error) {
    throw new Error(
      error?.code === 'ENOENT' ? `${label} is missing` : `${label} is unreadable`,
      { cause: error },
    );
  }
  if (declared.isSymbolicLink()) throw new Error(`${label} is a symlink`);
  if (!declared.isFile()) throw new Error(`${label} is not a regular file`);
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    let symlink = false;
    try {
      symlink = lstatSync(path).isSymbolicLink();
    } catch {
      // Preserve the open failure when the pathname itself cannot be classified.
    }
    if (symlink) throw new Error(`${label} is a symlink`, { cause: error });
    throw new Error(
      error?.code === 'ENOENT' ? `${label} is missing` : `${label} is unreadable`,
      { cause: error },
    );
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error(`${label} is not a regular file`);
    if (opened.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
    const openedPath = lstatSync(path);
    if (openedPath.isSymbolicLink()) throw new Error(`${label} is a symlink`);
    if (!openedPath.isFile()) throw new Error(`${label} is not a regular file`);
    assertInsideRepository(projectRoot, path, label);
    const current = lstatSync(path);
    if (current.isSymbolicLink()) throw new Error(`${label} is a symlink`);
    if (!current.isFile()) throw new Error(`${label} is not a regular file`);
    if (current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new Error(`${label} changed during validation`);
    }
    return readFileSync(fd);
  } catch (error) {
    if (String(error?.message ?? error).startsWith(`${label} `)) throw error;
    throw new Error(`${label} is unreadable`, { cause: error });
  } finally {
    closeSync(fd);
  }
};

const assertRepositoryDirectory = (projectRoot, path, label) => {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`${label} is a symlink`);
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory`);
  const { resolved } = assertInsideRepository(projectRoot, path, label);
  return { resolved, dev: stat.dev, ino: stat.ino };
};

const ensureClaimDirectory = (projectRoot, path) => {
  const rigDir = dirname(path);
  assertRepositoryDirectory(projectRoot, rigDir, 'claim root .rig');
  try {
    mkdirSync(path);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  return assertRepositoryDirectory(projectRoot, path, 'claim directory .rig/claims');
};

// Node has no public `openat(2)` binding. A child with the validated claim
// directory as its cwd gives the relative create the same stable directory
// handle: renaming or replacing the pathname after spawn cannot redirect that
// cwd. If the path was already redirected before spawn, the child resolves its
// own cwd outside the repository and refuses before creating anything.
const writeClaimExclusive = (projectRoot, path, content, expectedDirectory) => {
  const script = String.raw`
    const { constants, openSync, readFileSync, realpathSync, writeFileSync, closeSync, statSync } = require('node:fs');
    const { isAbsolute, relative, sep } = require('node:path');
    const [name, repository, expectedPath, expectedDev, expectedIno] = process.argv.slice(1);
    const root = realpathSync(repository);
    const cwd = realpathSync('.');
    const fromRoot = relative(root, cwd);
    if (fromRoot === '..' || fromRoot.startsWith('..' + sep) || isAbsolute(fromRoot)) {
      throw new Error('claim directory .rig/claims escapes the repository');
    }
    const cwdStat = statSync('.');
    if (cwd !== expectedPath || String(cwdStat.dev) !== expectedDev || String(cwdStat.ino) !== expectedIno) {
      throw new Error('claim directory .rig/claims changed during validation');
    }
    const fd = openSync(name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    try { writeFileSync(fd, readFileSync(0)); } finally { closeSync(fd); }
  `;
  execFileSync(
    process.execPath,
    [
      '-e',
      script,
      basename(path),
      realpathSync(projectRoot),
      expectedDirectory.resolved,
      String(expectedDirectory.dev),
      String(expectedDirectory.ino),
    ],
    {
      cwd: dirname(path),
      env: withoutGitLocation(),
      input: content,
      stdio: ['pipe', 'ignore', 'pipe'],
      maxBuffer: 1024 * 1024,
    },
  );
};

const replaceClaim = (projectRoot, path, content, expectedDirectory) => {
  const script = String.raw`
    const { constants, openSync, readFileSync, realpathSync, writeFileSync, closeSync, renameSync, unlinkSync, statSync } = require('node:fs');
    const { isAbsolute, relative, sep } = require('node:path');
    const [name, temporary, repository, expectedPath, expectedDev, expectedIno] = process.argv.slice(1);
    const root = realpathSync(repository);
    const cwd = realpathSync('.');
    const fromRoot = relative(root, cwd);
    if (fromRoot === '..' || fromRoot.startsWith('..' + sep) || isAbsolute(fromRoot)) {
      throw new Error('claim directory .rig/claims escapes the repository');
    }
    const cwdStat = statSync('.');
    if (cwd !== expectedPath || String(cwdStat.dev) !== expectedDev || String(cwdStat.ino) !== expectedIno) {
      throw new Error('claim directory .rig/claims changed during validation');
    }
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    try { writeFileSync(fd, readFileSync(0)); } finally { closeSync(fd); }
    try { renameSync(temporary, name); } catch (error) {
      try { unlinkSync(temporary); } catch {}
      throw error;
    }
  `;
  const temporary = `.${basename(path)}.${process.pid}.tmp`;
  execFileSync(
    process.execPath,
    [
      '-e',
      script,
      basename(path),
      temporary,
      realpathSync(projectRoot),
      expectedDirectory.resolved,
      String(expectedDirectory.dev),
      String(expectedDirectory.ino),
    ],
    {
      cwd: dirname(path),
      env: withoutGitLocation(),
      input: content,
      stdio: ['pipe', 'ignore', 'pipe'],
      maxBuffer: 1024 * 1024,
    },
  );
};

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
    raw = readRepositoryFile(projectRoot, path, {
      label: `detection contract ${CONTRACT_PATH}`,
      maxBytes: MAX_CONTRACT_BYTES,
    }).toString('utf8');
  } catch (error) {
    throw new Error(`no-detection-contract: ${error.message}`, { cause: error });
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
      const raw = readRepositoryFile(projectRoot, file, {
        label: `paired fact ${path}`,
        maxBytes: MAX_PAIRED_FACT_BYTES,
      });
      return { path, value: digest(raw) };
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

const WORKFLOW_STATES = new Set(['open', 'in-progress', 'closed']);

const workflowPositionOf = ({ ticket, point, claimedState, workflowClaim = null }) => {
  const ownClaim = workflowClaim?.claimedState === claimedState;
  const expected = point === 'SELECT' && !ownClaim ? 'open' : claimedState;
  if (!WORKFLOW_STATES.has(expected)) {
    throw new Error(`claim record: unsupported claimed workflow state ${JSON.stringify(expected)}`);
  }
  const actual = ticket?.state ?? null;
  const acknowledged = expected === 'open' || ownClaim;
  return actual === expected && acknowledged
    ? { position: 'expected' }
    : { position: 'unexpected', value: actual };
};

const fingerprintsOf = ({
  ticket,
  point,
  claimedState,
  workflowClaim = null,
  targetSha,
  pairedFacts = [],
}) => {
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
    workflow: workflowPositionOf({ ticket, point, claimedState, workflowClaim }),
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

const committedObjectOf = (projectRoot, path) => {
  try {
    return execFileSync('git', ['-C', projectRoot, 'rev-parse', '--verify', `HEAD:${path}`], {
      encoding: 'utf8',
      env: withoutGitLocation(),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
};

const objectOf = (projectRoot, raw) =>
  execFileSync('git', ['-C', projectRoot, 'hash-object', '--stdin'], {
    encoding: 'utf8',
    env: withoutGitLocation(),
    input: raw,
    stdio: ['pipe', 'pipe', 'ignore'],
  }).trim();

const readClaim = (projectRoot, path) => {
  const raw = readRepositoryFile(projectRoot, path, {
    label: 'claim record',
    maxBytes: MAX_CLAIM_BYTES,
  });
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('claim record is not valid JSON');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    parsed.schemaVersion !== CLAIM_SCHEMA_VERSION ||
    typeof parsed.ticket !== 'string' ||
    parsed.fingerprints?.scope?.algorithm !== 'sha256' ||
    !SHA256.test(parsed.fingerprints?.scope?.value ?? '') ||
    (parsed.fingerprints.scope.targetSha !== null &&
      !GIT_OBJECT_ID.test(parsed.fingerprints.scope.targetSha ?? '')) ||
    parsed.fingerprints?.commentary?.algorithm !== 'sha256' ||
    !SHA256.test(parsed.fingerprints?.commentary?.value ?? '') ||
    !Number.isInteger(parsed.fingerprints?.commentary?.count) ||
    parsed.fingerprints.commentary.count < 0 ||
    (parsed.workflowClaim !== undefined &&
      (!parsed.workflowClaim ||
        typeof parsed.workflowClaim !== 'object' ||
        Array.isArray(parsed.workflowClaim) ||
        !WORKFLOW_STATES.has(parsed.workflowClaim.claimedState)))
  ) {
    throw new Error('claim record has an unsupported shape');
  }
  return { parsed, raw };
};

export const recordClaimTransition = ({ projectRoot = process.cwd(), ticket, claimedState }) => {
  if (!WORKFLOW_STATES.has(claimedState)) {
    throw new Error(`claim record: unsupported claimed workflow state ${JSON.stringify(claimedState)}`);
  }
  const path = claimPathFor(projectRoot, ticket);
  if (!pathExists(path)) return null;
  const claim = readClaim(projectRoot, path).parsed;
  if (claim.ticket !== ticketIdOf(ticket)) {
    throw new Error(`claim ticket conflicts with ${ticketIdOf(ticket)}`);
  }
  if (claim.workflowClaim?.claimedState === claimedState) return claim.workflowClaim;

  const expectedDirectory = assertRepositoryDirectory(
    projectRoot,
    dirname(path),
    'claim directory .rig/claims',
  );
  const next = { ...claim, workflowClaim: { claimedState } };
  const content = `${JSON.stringify(next, null, 2)}\n`;
  replaceClaim(projectRoot, path, content, expectedDirectory);
  const persistedDirectory = assertRepositoryDirectory(
    projectRoot,
    dirname(path),
    'claim directory .rig/claims',
  );
  if (
    persistedDirectory.resolved !== expectedDirectory.resolved ||
    persistedDirectory.dev !== expectedDirectory.dev ||
    persistedDirectory.ino !== expectedDirectory.ino
  ) {
    throw new Error('claim directory .rig/claims changed during claim transition recording');
  }
  const persisted = readRepositoryFile(projectRoot, path, {
    label: 'claim record',
    maxBytes: MAX_CLAIM_BYTES,
  });
  if (!persisted.equals(Buffer.from(content))) {
    throw new Error('claim transition postcondition failed');
  }
  return next.workflowClaim;
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

/**
 * An UNVERIFIABLE result for a failure OUTSIDE the claim comparison — the
 * tracker could not be read at all, so nothing about the claim was observed.
 *
 * Distinct from the UNVERIFIABLE results `revalidateClaim` itself returns:
 * those mean the claim RECORD is missing, untracked or unreadable. This one
 * means the question was never put to the tracker. Both carry `changed: null`
 * and both hold, which is the property that matters — "could not check" is
 * never "checked and fine".
 */
export const unverifiableResult = ({ ticket, point, reason, identity }) =>
  resultOf({
    ticket,
    point,
    result: 'UNVERIFIABLE',
    action: 'unverifiable',
    pointer: null,
    evidence: { error: reason },
    identity,
  });

export const revalidateClaim = ({
  projectRoot,
  ticket,
  point,
  claimedState = 'in-progress',
  targetSha,
  allowCreate = false,
  isResume = false,
}) => {
  const path = claimPathFor(projectRoot, ticket);
  const pointer = pointerFor(projectRoot, ticket);
  let pairedFacts;
  let current;
  try {
    const contract = readRevalidationContract(projectRoot);
    pairedFacts = pairedFingerprintsOf(projectRoot, contract.pairedFacts);
    current = fingerprintsOf({ ticket, point, claimedState, targetSha, pairedFacts });
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
  if (ticket?.commentary?.complete === false) {
    return resultOf({
      ticket,
      point,
      result: 'UNVERIFIABLE',
      action: 'unverifiable',
      pointer,
      evidence: { error: 'commentary evidence is incomplete: total does not match unique ids' },
      identity: 'commentary-incomplete',
    });
  }
  const committedObject = committedObjectOf(projectRoot, pointer);
  if (!pathExists(path)) {
    if (committedObject !== null) {
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
      try {
        const expectedDirectory = ensureClaimDirectory(projectRoot, dirname(path));
        const claim = {
          schemaVersion: CLAIM_SCHEMA_VERSION,
          ticket: ticketIdOf(ticket),
          fingerprints: current,
        };
        const content = `${JSON.stringify(claim, null, 2)}\n`;
        writeClaimExclusive(projectRoot, path, content, expectedDirectory);
        const persistedDirectory = assertRepositoryDirectory(
          projectRoot,
          dirname(path),
          'claim directory .rig/claims',
        );
        if (
          persistedDirectory.resolved !== expectedDirectory.resolved ||
          persistedDirectory.dev !== expectedDirectory.dev ||
          persistedDirectory.ino !== expectedDirectory.ino
        ) {
          throw new Error('claim directory .rig/claims changed during baseline creation');
        }
        const persisted = readRepositoryFile(projectRoot, path, {
          label: 'claim record',
          maxBytes: MAX_CLAIM_BYTES,
        });
        if (!persisted.equals(Buffer.from(content))) {
          throw new Error('claim baseline postcondition failed');
        }
      } catch (error) {
        return resultOf({
          ticket,
          point,
          result: 'UNVERIFIABLE',
          action: 'unverifiable',
          pointer,
          evidence: { error: `claim baseline could not be created: ${error.message}` },
          identity: 'create-refused',
        });
      }
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

  if (committedObject === null) {
    return resultOf({
      ticket,
      point,
      result: 'UNVERIFIABLE',
      action: 'unverifiable',
      pointer,
      evidence: { error: `untracked or unversioned claim record ${pointer}` },
      identity: 'unversioned',
    });
  }

  let claim;
  try {
    const read = readClaim(projectRoot, path);
    if (objectOf(projectRoot, read.raw) !== committedObject) {
      throw new Error('tracked claim worktree content diverges from its committed Git version');
    }
    claim = read.parsed;
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

  current = fingerprintsOf({
    ticket,
    point,
    claimedState,
    workflowClaim: claim.workflowClaim,
    targetSha,
    pairedFacts,
  });

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
