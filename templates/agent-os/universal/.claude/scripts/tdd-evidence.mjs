#!/usr/bin/env node
// RP-306 — turn a structured, check-run-bound Vitest failure into the bounded
// portable RED record that a later controller can verify without this run's
// terminal output. This records evidence; it does not decide applicability or
// make an implementation-order claim (RP-305 and RP-307 own those contracts).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { claimPathFor, targetShaOf } from './lib/claim-records.mjs';
import { findSecretValues } from './lib/secrets.mjs';
import { withoutGitLocation } from './git-env.mjs';
import { loadConfig, optionsWithPlanPath, resolveAdapter } from './queue/index.mjs';
import { readRun, recordEvent } from './run-journal.mjs';
import {
  fingerprintEvidence,
  resolveApplicability,
  validatePortableEvidence,
  validateTddEvidenceHistory,
} from './lib/tdd-evidence.mjs';

const MAX_JSON_BYTES = 5 * 1024 * 1024;
const MAX_IMPLEMENTATION_DELTA_BYTES = 5 * 1024 * 1024;
const MAX_TRACKER_BODY_BYTES = 64 * 1024;
const MAX_PRE_RED_PREDECESSORS = 8;
const MAX_PRE_RED_JOURNAL_RECORDS = 1024;
const MAX_PRE_RED_JOURNAL_LINE_BYTES = 64 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const TICKET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TDD_SPEC_PREFIX = 'rig:tdd-spec/v1 ';

class HoldError extends Error {}

const fail = (message) => {
  process.stderr.write(`tdd-evidence: ${message}\n`);
  return 1;
};

const hold = (message) => {
  process.stderr.write(`tdd-evidence: HOLD — ${message}\n`);
  return 2;
};

const safeName = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 255 &&
  !value.includes('/') &&
  !value.includes('\\') &&
  value !== '.' &&
  value !== '..';

const safeRelativePath = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 512 &&
  !isAbsolute(value) &&
  !value.split(/[\\/]/).some((part) => part === '' || part === '.' || part === '..');

// Vitest on macOS may print /var while Node gave this process the equivalent
// /private/var path. Both candidates derive only from the trusted project root;
// runner-controlled output is compared as text and never resolved on disk.
export const projectRelativePath = (projectRoot, value) => {
  const normalizedValue = value.replaceAll('\\', '/');
  const windowsAbsolute = /^[A-Za-z]:\//.test(normalizedValue);
  if (!isAbsolute(value) && !windowsAbsolute) return normalizedValue;
  const candidates = [projectRoot.replaceAll('\\', '/')];
  if (process.platform === 'darwin' && projectRoot.startsWith('/private/')) {
    candidates.push(projectRoot.slice('/private'.length).replaceAll('\\', '/'));
  }
  for (const root of candidates) {
    const prefix = root.endsWith('/') ? root : `${root}/`;
    const comparableValue = windowsAbsolute ? normalizedValue.toLowerCase() : normalizedValue;
    const comparablePrefix = windowsAbsolute ? prefix.toLowerCase() : prefix;
    if (comparableValue.startsWith(comparablePrefix)) return normalizedValue.slice(prefix.length);
  }
  return null;
};

const readRegularFile = (file, label, maxBytes = MAX_JSON_BYTES) => {
  const declared = lstatSync(file);
  if (declared.isSymbolicLink() || !declared.isFile()) throw new Error(`${label} is not a regular file`);
  if (declared.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== declared.dev || opened.ino !== declared.ino) {
      throw new Error(`${label} changed during validation`);
    }
    const chunks = [];
    let total = 0;
    while (true) {
      const remaining = maxBytes + 1 - total;
      if (remaining <= 0) throw new Error(`${label} exceeds ${maxBytes} bytes`);
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      total += read;
      if (total > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
      chunks.push(chunk.subarray(0, read));
    }
    const finished = lstatSync(file);
    const finishedOpen = fstatSync(fd);
    if (
      finished.isSymbolicLink() ||
      !finished.isFile() ||
      finished.dev !== declared.dev ||
      finished.ino !== declared.ino ||
      finished.size !== declared.size ||
      finishedOpen.size !== declared.size
    ) {
      throw new Error(`${label} changed during validation`);
    }
    return Buffer.concat(chunks, total);
  } finally {
    closeSync(fd);
  }
};

const repositoryTestFile = ({ projectRoot, testFile, label, maxBytes = MAX_JSON_BYTES }) => {
  if (!safeRelativePath(testFile)) throw new Error(`${label} path is unsafe`);
  const root = lstatSync(projectRoot);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('project root is unsafe');
  const rootResolved = realpathSync(projectRoot);
  const components = testFile.split('/');
  const directories = [{ path: projectRoot, dev: root.dev, ino: root.ino }];
  let current = projectRoot;
  for (const component of components.slice(0, -1)) {
    current = join(current, component);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} has a symlink ancestor`);
    directories.push({ path: current, dev: stat.dev, ino: stat.ino });
  }
  const file = join(projectRoot, testFile);
  const bytes = readRegularFile(file, label, maxBytes);
  const resolved = realpathSync(file);
  const fromRoot = relative(rootResolved, resolved);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`${label} escapes the project root`);
  }
  for (const directory of directories) {
    const stat = lstatSync(directory.path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== directory.dev || stat.ino !== directory.ino) {
      throw new Error(`${label} ancestor changed during validation`);
    }
  }
  return bytes;
};

const claimHierarchy = (projectRoot, file) => {
  const rig = join(projectRoot, '.rig');
  const claims = join(rig, 'claims');
  if (dirname(file) !== claims) throw new Error('claim path is unsafe');
  const directories = [
    ['project root', projectRoot],
    ['.rig directory', rig],
    ['claim directory', claims],
  ].map(([label, directory]) => {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} is unsafe`);
    return { label, directory, dev: stat.dev, ino: stat.ino };
  });
  const root = realpathSync(projectRoot);
  const claimsResolved = realpathSync(claims);
  const fromRoot = relative(root, claimsResolved);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error('claim directory .rig/claims escapes the repository');
  }
  return { directories, root, claimsResolved };
};

const assertStableClaimHierarchy = (hierarchy) => {
  for (const expected of hierarchy.directories) {
    const current = lstatSync(expected.directory);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== expected.dev ||
      current.ino !== expected.ino
    ) {
      throw new Error(`${expected.label} changed during claim validation`);
    }
  }
};

const parseArgs = (argv) => {
  if (!['record-red', 'record-green', 'verify-ship'].includes(argv[0])) {
    return { error: 'usage: tdd-evidence.mjs <record-red|record-green|verify-ship> --ticket <item> [--check <check>|--base <ref>] [--predecessor-run <run-id>]' };
  }
  const action = argv[0];
  let ticket = null;
  let check = null;
  let base = null;
  const predecessorRuns = [];
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--ticket') ticket = argv[(index += 1)] ?? null;
    else if (flag === '--check') check = argv[(index += 1)] ?? null;
    else if (flag === '--base') base = argv[(index += 1)] ?? null;
    else if (flag === '--predecessor-run') {
      const runId = argv[(index += 1)] ?? null;
      if (predecessorRuns.length >= MAX_PRE_RED_PREDECESSORS || !safeName(runId)) {
        return { error: 'bounded unique --predecessor-run values are permitted only for record-red' };
      }
      predecessorRuns.push(runId);
    }
    else return { error: `unknown flag ${flag}` };
  }
  if (!TICKET.test(ticket ?? '')) return { error: 'a bounded --ticket is required' };
  if (action !== 'verify-ship' && (typeof check !== 'string' || check.length === 0 || check.length > 128)) {
    return { error: 'a bounded --check is required' };
  }
  if (action === 'verify-ship' && (typeof base !== 'string' || base.length === 0 || base.length > 256)) {
    return { error: 'a bounded --base is required' };
  }
  if (
    (action !== 'record-red' && predecessorRuns.length > 0) ||
    predecessorRuns.length > MAX_PRE_RED_PREDECESSORS ||
    new Set(predecessorRuns).size !== predecessorRuns.length ||
    predecessorRuns.some((runId) => !safeName(runId))
  ) {
    return { error: 'bounded unique --predecessor-run values are permitted only for record-red' };
  }
  return { action, ticket, check, base, predecessorRuns };
};

const checkFingerprint = (data) =>
  fingerprintEvidence({
    schema: data.schema,
    name: data.name,
    outcome: data.outcome,
    exitCode: data.exitCode ?? null,
    signal: data.signal ?? null,
    timedOut: Boolean(data.timedOut),
    gitHead: data.gitHead ?? null,
    workingTreeDiff: data.workingTreeDiff ?? null,
    structuredResult: data.structuredResult,
  });

const testIdentity = ({ projectRoot, vitest, outcome }) => {
  const matches = [];
  for (const result of vitest?.testResults ?? []) {
    if (!Array.isArray(result?.assertionResults) || typeof result?.name !== 'string') continue;
    const relativeName = projectRelativePath(projectRoot, result.name);
    if (relativeName === null) continue;
    const file = relativeName.replaceAll('\\', '/');
    if (!safeRelativePath(file)) continue;
    for (const assertion of result.assertionResults) {
      if (assertion?.status !== outcome) continue;
      const fullName = assertion.fullName ?? assertion.title;
      if (typeof fullName !== 'string' || fullName.length === 0 || fullName.length > 1024) continue;
      matches.push({ file, fullName });
    }
  }
  if (matches.length !== 1) throw new Error(`the Vitest result must contain exactly one bounded ${outcome} test identity`);
  const test = matches[0];
  const bytes = repositoryTestFile({ projectRoot, testFile: test.file, label: 'test file' });
  return { ...test, fileSha256: createHash('sha256').update(bytes).digest('hex') };
};

const sameTest = (left, right) =>
  left?.file === right?.file && left?.fullName === right?.fullName && left?.fileSha256 === right?.fileSha256;

const sameTestScope = (left, right) => left?.file === right?.file && left?.fullName === right?.fullName;

const sameScopeFingerprint = (left, right) =>
  left?.algorithm === 'sha256' &&
  right?.algorithm === 'sha256' &&
  SHA256.test(left?.value ?? '') &&
  left.value === right.value &&
  left.targetSha === right.targetSha;

const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const hasOnlyKeys = (value, keys) =>
  plainObject(value) && Object.keys(value).every((key) => keys.includes(key)) && Object.keys(value).length === keys.length;

const tddScopeHasSecret = (scope) =>
  [
    scope?.test?.file,
    scope?.test?.fullName,
    scope?.selectedScopeFingerprint?.algorithm,
    scope?.selectedScopeFingerprint?.value,
    scope?.selectedScopeFingerprint?.targetSha,
    scope?.fingerprint?.algorithm,
    scope?.fingerprint?.value,
  ].some((value) => typeof value === 'string' && findSecretValues(value).length > 0);

const parseTrackerTddSpec = (body) => {
  if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_TRACKER_BODY_BYTES) {
    throw new Error('tracker item has no bounded relevant-spec marker');
  }
  const markers = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith(TDD_SPEC_PREFIX));
  if (markers.length !== 1) throw new Error('tracker item must carry exactly one relevant-spec marker');
  const encoded = markers[0].slice(TDD_SPEC_PREFIX.length);
  if (Buffer.byteLength(encoded) === 0 || Buffer.byteLength(encoded) > 2048) {
    throw new Error('tracker relevant-spec marker exceeds bounds');
  }
  let marker;
  try {
    marker = JSON.parse(encoded);
  } catch {
    throw new Error('tracker relevant-spec marker is not valid JSON');
  }
  if (
    !marker ||
    typeof marker !== 'object' ||
    Array.isArray(marker) ||
    Object.keys(marker).length !== 2 ||
    !Object.hasOwn(marker, 'file') ||
    !Object.hasOwn(marker, 'fullName') ||
    !safeRelativePath(marker.file) ||
    typeof marker.fullName !== 'string' ||
    marker.fullName.length === 0 ||
    marker.fullName.length > 1024
  ) {
    throw new Error('tracker relevant-spec marker has an invalid test identity');
  }
  return { file: marker.file, fullName: marker.fullName };
};

const trackerTddScope = async ({ projectRoot, ticket, observedAt, selectedScopeFingerprint }) => {
  const configPath = join(projectRoot, '.claude', 'queue.json');
  const config = loadConfig(configPath, { strictRead: true });
  const adapter = await resolveAdapter(config.adapter ?? 'plan-md');
  if (typeof adapter.find !== 'function') throw new Error('configured tracker adapter cannot read the selected item');
  const trackerTicket = await adapter.find(ticket, optionsWithPlanPath(config.options ?? {}, configPath));
  if (!trackerTicket) throw new Error('selected tracker item could not be read');
  const test = parseTrackerTddSpec(trackerTicket.body);
  if (observedAt !== undefined) {
    const updatedAt = Date.parse(trackerTicket.updatedAt ?? '');
    const observed = Date.parse(observedAt ?? '');
    if (!Number.isFinite(updatedAt) || !Number.isFinite(observed) || updatedAt > observed) {
      throw new Error('tracker relevant-spec marker was updated after the failed check');
    }
  }
  return {
    test,
    selectedScopeFingerprint,
    fingerprint: fingerprintEvidence({ ticket, test, selectedScopeFingerprint }),
  };
};

const validTddScope = ({ claim, scope, ticket }) =>
  hasOnlyKeys(scope, ['test', 'selectedScopeFingerprint', 'fingerprint']) &&
  hasOnlyKeys(scope.test, ['file', 'fullName']) &&
  hasOnlyKeys(scope.selectedScopeFingerprint, ['algorithm', 'value', 'targetSha']) &&
  hasOnlyKeys(scope.fingerprint, ['algorithm', 'value']) &&
  !tddScopeHasSecret(scope) &&
  safeRelativePath(scope.test?.file) &&
  typeof scope.test?.fullName === 'string' &&
  scope.test.fullName.length > 0 &&
  scope.test.fullName.length <= 1024 &&
  sameScopeFingerprint(scope.selectedScopeFingerprint, claim.fingerprints.scope) &&
  scope.fingerprint?.algorithm === 'sha256' &&
  scope.fingerprint.value ===
    fingerprintEvidence({ ticket, test: scope.test, selectedScopeFingerprint: scope.selectedScopeFingerprint }).value;

const currentTestFileHash = ({ projectRoot, test }) => {
  const bytes = repositoryTestFile({ projectRoot, testFile: test?.file, label: 'relevant test file' });
  return createHash('sha256').update(bytes).digest('hex');
};

const checkEvent = ({ projectRoot, runDir, check, outcome }) => {
  const run = readRun({ runDir });
  const event = [...run.events]
    .reverse()
    .find((entry) => entry.kind === 'check-result' && entry?.data?.name === check);
  if (!event || event?.data?.outcome !== outcome) throw new Error(`no ${outcome} check-run result for ${check}`);
  const structured = event.data.structuredResult;
  if (
    structured?.format !== 'vitest-json' ||
    !safeName(structured.path) ||
    !SHA256.test(structured.sha256 ?? '') ||
    structured.runner?.schema !== 1 ||
    structured.runner?.kind !== 'vitest' ||
    !SHA256.test(structured.runner?.modulePathSha256 ?? '') ||
    !SHA256.test(structured.runner?.commandSha256 ?? '')
  ) {
    throw new Error(`the ${outcome} check has no safe structured Vitest result`);
  }
  const resultBytes = readRegularFile(join(runDir, structured.path), 'structured Vitest result');
  if (createHash('sha256').update(resultBytes).digest('hex') !== structured.sha256) {
    throw new Error('structured Vitest result bytes no longer match the check-run record');
  }
  let vitest;
  try {
    vitest = JSON.parse(resultBytes.toString('utf8'));
  } catch {
    throw new Error('structured Vitest result is not valid JSON');
  }
  const testOutcome = outcome === 'fail' ? 'failed' : 'passed';
  return { run, event, test: testIdentity({ projectRoot, vitest, outcome: testOutcome }) };
};

const changedPaths = ({ projectRoot, baselineHeadSha, headSha = null }) => {
  let names;
  try {
    names = execFileSync('git', ['-C', projectRoot, 'diff', '--name-only', '-z', baselineHeadSha, ...(headSha ? [headSha] : []), '--'], {
      encoding: 'buffer',
      env: withoutGitLocation(),
      maxBuffer: MAX_IMPLEMENTATION_DELTA_BYTES,
    });
  } catch {
    throw new Error('final Git diff could not be read from the selected-work baseline');
  }
  return names
    .toString('utf8')
    .split('\0')
    .filter((file) => safeRelativePath(file));
};

const tddApplicabilityPaths = (paths, ticket = null) =>
  paths.filter(
    (file) => file !== `.rig/claims/${ticket}.json` && file !== 'AGENTS.md' && file !== 'CLAUDE.md',
  );

const finalApplicability = (paths, ticket) => {
  const changed = tddApplicabilityPaths(paths, ticket);
  return changed.length === 0 ? { level: 'TDD-0' } : resolveApplicability({ changedPaths: changed });
};

const productionPaths = ({ projectRoot, baselineHeadSha, headSha = null, ticket = null }) => {
  const paths = tddApplicabilityPaths(changedPaths({ projectRoot, baselineHeadSha, headSha }), ticket);
  return paths.filter((file) => resolveApplicability({ changedPaths: [file] }).level !== 'TDD-0');
};

const outputPaths = ({ projectRoot, args, label }) => {
  let names;
  try {
    names = execFileSync('git', ['-C', projectRoot, ...args], {
      encoding: 'buffer',
      env: withoutGitLocation(),
      maxBuffer: MAX_IMPLEMENTATION_DELTA_BYTES,
    });
  } catch {
    throw new Error(`${label} could not be read`);
  }
  const paths = [];
  let offset = 0;
  while (offset < names.length) {
    const terminator = names.indexOf(0x00, offset);
    if (terminator === -1 || terminator === offset || terminator - offset > 512) {
      throw new Error(`${label} is not a bounded NUL-delimited path list`);
    }
    if (paths.length >= MAX_PRE_RED_JOURNAL_RECORDS) throw new Error(`${label} path count exceeds bounds`);
    const file = names.subarray(offset, terminator).toString('utf8');
    if (!safeRelativePath(file)) throw new Error(`${label} contains an unsafe path`);
    paths.push(file);
    offset = terminator + 1;
  }
  return paths;
};

const indexEntries = ({ projectRoot, paths }) => {
  if (paths.length > MAX_PRE_RED_JOURNAL_RECORDS) throw new Error('staged pre-RED index path count exceeds bounds');
  let bytes;
  try {
    bytes = execFileSync('git', ['-C', projectRoot, '--literal-pathspecs', 'ls-files', '--stage', '-z', '--', ...paths], {
      encoding: 'buffer',
      env: withoutGitLocation(),
      maxBuffer: MAX_IMPLEMENTATION_DELTA_BYTES,
    });
  } catch {
    throw new Error('staged pre-RED index could not be read');
  }
  const requested = new Set(paths);
  const entries = new Map();
  let offset = 0;
  while (offset < bytes.length) {
    const terminator = bytes.indexOf(0x00, offset);
    if (terminator === -1 || terminator === offset || terminator - offset > 1024) {
      throw new Error('staged pre-RED index is not a bounded NUL-delimited entry list');
    }
    if (entries.size >= MAX_PRE_RED_JOURNAL_RECORDS) throw new Error('staged pre-RED index entry count exceeds bounds');
    const tab = bytes.indexOf(0x09, offset);
    if (tab === -1 || tab >= terminator) throw new Error('staged pre-RED index entry is invalid');
    const header = bytes.subarray(offset, tab).toString('ascii');
    const match = /^([0-7]{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([0-3])$/.exec(header);
    const file = bytes.subarray(tab + 1, terminator).toString('utf8');
    if (!match || match[3] !== '0' || !safeRelativePath(file) || !requested.has(file) || entries.has(file)) {
      throw new Error('staged pre-RED index entry is unsafe');
    }
    entries.set(file, { mode: match[1], blob: match[2] });
    offset = terminator + 1;
  }
  return entries;
};

const stableDirectories = ({ projectRoot, file, label }) => {
  if (!safeRelativePath(file)) throw new Error(`${label} path is unsafe`);
  const root = lstatSync(projectRoot);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('project root is unsafe');
  const rootResolved = realpathSync(projectRoot);
  const directories = [{ path: projectRoot, dev: root.dev, ino: root.ino }];
  let current = projectRoot;
  for (const component of file.split('/').slice(0, -1)) {
    current = join(current, component);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} has a symlink ancestor`);
    directories.push({ path: current, dev: stat.dev, ino: stat.ino });
  }
  return { rootResolved, directories };
};

const assertStableDirectories = ({ rootResolved, directories, label }) => {
  for (const directory of directories) {
    const stat = lstatSync(directory.path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== directory.dev || stat.ino !== directory.ino) {
      throw new Error(`${label} ancestor changed during validation`);
    }
  }
  const resolvedRoot = realpathSync(directories[0].path);
  if (resolvedRoot !== rootResolved) throw new Error(`${label} project root changed during validation`);
};

const productionState = ({ projectRoot, file, index }) => {
  const label = 'pre-RED production file';
  const containment = stableDirectories({ projectRoot, file, label });
  const target = join(projectRoot, file);
  let stat;
  try {
    stat = lstatSync(target);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error('pre-RED production state could not be read', { cause: error });
    assertStableDirectories({ ...containment, label });
    return fingerprintEvidence({ path: file, state: 'missing', ...(index ? { index } : {}) });
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('pre-RED production state is unsafe');
  const content = readRegularFile(target, label);
  const resolved = realpathSync(target);
  const fromRoot = relative(containment.rootResolved, resolved);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error('pre-RED production file escapes the project root');
  }
  const after = lstatSync(target);
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.dev !== stat.dev ||
    after.ino !== stat.ino ||
    after.mode !== stat.mode
  ) {
    throw new Error('pre-RED production state changed during read');
  }
  assertStableDirectories({ ...containment, label });
  return fingerprintEvidence({
    path: file,
    contentSha256: createHash('sha256').update(content).digest('hex'),
    mode: after.mode & 0o777,
    ...(index ? { index } : {}),
  });
};

const preRedProduction = ({ projectRoot, baselineHeadSha, ticket }) => {
  const committed = outputPaths({
    projectRoot,
    args: ['diff', '--name-only', '-z', baselineHeadSha, 'HEAD', '--'],
    label: 'committed pre-RED production paths',
  });
  const staged = outputPaths({
    projectRoot,
    args: ['diff', '--cached', '--name-only', '-z', '--'],
    label: 'staged pre-RED production paths',
  });
  const unstaged = outputPaths({
    projectRoot,
    args: ['diff', '--name-only', '-z', '--'],
    label: 'unstaged pre-RED production paths',
  });
  const untracked = outputPaths({
    projectRoot,
    args: ['ls-files', '--others', '--exclude-standard', '-z', '--'],
    label: 'untracked pre-RED production paths',
  });
  const paths = [];
  for (const group of [committed, staged, unstaged, untracked]) {
    for (const file of group) {
      if (!paths.includes(file)) {
        if (paths.length >= MAX_PRE_RED_JOURNAL_RECORDS) throw new Error('pre-RED production path count exceeds bounds');
        paths.push(file);
      }
    }
  }
  const stagedIndex = indexEntries({ projectRoot, paths: staged });
  const stagedPaths = new Set(staged);
  const productionPaths = paths
    .filter((file) => tddApplicabilityPaths([file], ticket).length === 1)
    .filter(
      (file) =>
        !file.startsWith('.claude/runs/') &&
        !file.startsWith('.rig/claims/') &&
        !file.startsWith('node_modules/'),
    )
    .filter((file) => resolveApplicability({ changedPaths: [file] }).level !== 'TDD-0')
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const states = productionPaths.map((file) =>
    productionState({
      projectRoot,
      file,
      index: stagedPaths.has(file) ? (stagedIndex.get(file) ?? { state: 'missing' }) : undefined,
    }),
  );
  return {
    pathCount: productionPaths.length,
    fingerprint: fingerprintEvidence({ baselineHeadSha, states }),
  };
};

const stablePredecessorRun = ({ projectRoot, runId }) => {
  if (!safeName(runId)) throw new Error('pre-RED predecessor run id is unsafe');
  const project = realpathSync(projectRoot);
  const runs = join(projectRoot, '.claude', 'runs');
  const runsStat = lstatSync(runs);
  if (!runsStat.isDirectory() || runsStat.isSymbolicLink()) throw new Error('pre-RED journal root is unsafe');
  const resolvedRuns = realpathSync(runs);
  const fromProject = relative(project, resolvedRuns);
  if (fromProject === '..' || fromProject.startsWith(`..${sep}`) || isAbsolute(fromProject)) {
    throw new Error('pre-RED journal root escapes the project');
  }
  const runDir = join(runs, runId);
  const runStat = lstatSync(runDir);
  if (!runStat.isDirectory() || runStat.isSymbolicLink()) throw new Error('pre-RED predecessor run is unsafe');
  return {
    project,
    runs,
    runsIdentity: { dev: runsStat.dev, ino: runsStat.ino },
    resolvedRuns,
    runDir,
    runIdentity: { dev: runStat.dev, ino: runStat.ino },
  };
};

const assertStablePredecessorRun = (run) => {
  const runsStat = lstatSync(run.runs);
  if (
    !runsStat.isDirectory() ||
    runsStat.isSymbolicLink() ||
    runsStat.dev !== run.runsIdentity.dev ||
    runsStat.ino !== run.runsIdentity.ino ||
    realpathSync(run.runs) !== run.resolvedRuns
  ) {
    throw new Error('pre-RED journal root changed during validation');
  }
  const runStat = lstatSync(run.runDir);
  if (
    !runStat.isDirectory() ||
    runStat.isSymbolicLink() ||
    runStat.dev !== run.runIdentity.dev ||
    runStat.ino !== run.runIdentity.ino
  ) {
    throw new Error('pre-RED predecessor run changed during validation');
  }
  const resolvedRun = realpathSync(run.runDir);
  const fromRuns = relative(run.resolvedRuns, resolvedRun);
  if (fromRuns === '..' || fromRuns.startsWith(`..${sep}`) || isAbsolute(fromRuns)) {
    throw new Error('pre-RED predecessor run escapes the journal root');
  }
  const fromProject = relative(run.project, resolvedRun);
  if (fromProject === '..' || fromProject.startsWith(`..${sep}`) || isAbsolute(fromProject)) {
    throw new Error('pre-RED predecessor run escapes the project');
  }
};

const preRedJournalRecords = ({ projectRoot, runId }) => {
  const run = stablePredecessorRun({ projectRoot, runId });
  const records = [];
  const hasOwn = (record, field) => Object.prototype.hasOwnProperty.call(record, field);
  const nonBlankString = (value) => typeof value === 'string' && value.trim() !== '';
  const validEnvelope = (record) =>
    Number.isSafeInteger(record.seq) && record.seq > 0 && nonBlankString(record.at);
  const validDecision = (record) => {
    const allowed = new Set(['seq', 'at', 'gate', 'verdict', 'why', 'headSha', 'reviewers', 'blockers']);
    return (
      validEnvelope(record) &&
      nonBlankString(record.gate) &&
      nonBlankString(record.verdict) &&
      (record.why === null || typeof record.why === 'string') &&
      (!hasOwn(record, 'headSha') || nonBlankString(record.headSha)) &&
      (!hasOwn(record, 'reviewers') || (Array.isArray(record.reviewers) && record.reviewers.every((reviewer) => typeof reviewer === 'string'))) &&
      (!hasOwn(record, 'blockers') || Array.isArray(record.blockers)) &&
      Object.keys(record).every((field) => allowed.has(field))
    );
  };
  const validEvent = (record) => {
    const allowed = record.kind === 'run-end' ? new Set(['seq', 'at', 'kind', 'stop']) : new Set(['seq', 'at', 'kind', 'data']);
    return (
      validEnvelope(record) &&
      nonBlankString(record.kind) &&
      (record.kind === 'run-end' ? nonBlankString(record.stop) : hasOwn(record, 'data')) &&
      Object.keys(record).every((field) => allowed.has(field))
    );
  };
  for (const [file, source] of [
    ['decisions.jsonl', 'decisions'],
    ['events.jsonl', 'events'],
  ]) {
    assertStablePredecessorRun(run);
    const journal = join(run.runDir, file);
    const bytes = readRegularFile(journal, `pre-RED predecessor ${file}`);
    assertStablePredecessorRun(run);
    let offset = 0;
    let lastSeq = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(0x0a, offset);
      const end = newline === -1 ? bytes.length : newline;
      if (end - offset > MAX_PRE_RED_JOURNAL_LINE_BYTES) throw new Error('pre-RED journal line exceeds bounds');
      if (end === offset) throw new Error('pre-RED journal record is empty');
      if (records.length >= MAX_PRE_RED_JOURNAL_RECORDS) throw new Error('pre-RED journal record count exceeds bounds');
      let record;
      try {
        record = JSON.parse(bytes.subarray(offset, end).toString('utf8'));
      } catch {
        throw new Error('pre-RED journal record is not valid JSON');
      }
      if (
        !record ||
        typeof record !== 'object' ||
        Array.isArray(record) ||
        (source === 'decisions' ? !validDecision(record) : !validEvent(record))
      ) {
        throw new Error('pre-RED journal record is invalid');
      }
      if (record.seq <= lastSeq) {
        throw new Error('pre-RED predecessor journal sequence is invalid');
      }
      lastSeq = record.seq;
      records.push({ source, record });
      offset = newline === -1 ? bytes.length : newline + 1;
    }
  }
  const sequence = records.map(({ record }) => record.seq).sort((left, right) => left - right);
  if (!sequence.length || sequence.some((seq, index) => !Number.isSafeInteger(seq) || seq !== index + 1)) {
    throw new Error('pre-RED predecessor journal sequence is invalid');
  }
  return records.sort((left, right) => left.record.seq - right.record.seq);
};

const preRedDispatch = ({ projectRoot, ticket, predecessors }) => {
  if (!Array.isArray(predecessors) || predecessors.length === 0 || predecessors.length > MAX_PRE_RED_PREDECESSORS) {
    throw new Error('pre-RED predecessor references are missing or exceed bounds');
  }
  if (new Set(predecessors).size !== predecessors.length) throw new Error('pre-RED predecessor references are duplicated');
  const dispatches = [];
  for (const runId of predecessors) {
    const records = preRedJournalRecords({ projectRoot, runId });
    let selectedTicket = null;
    for (const { source, record } of records) {
      if (source === 'decisions' && record.gate === 'item-selection') {
        const selected = /^taken ([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(record.verdict);
        if (!selected) throw new Error('pre-RED predecessor item selection is invalid');
        selectedTicket = selected[1];
        continue;
      }
      const data = record?.data;
      if (source === 'events' && record.kind === 'dispatch-start') {
        if (
          !data ||
          typeof data !== 'object' ||
          Array.isArray(data) ||
          data.schema !== 1 ||
          (data.agentType !== undefined &&
            (typeof data.agentType !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(data.agentType))) ||
          typeof data.agentRef !== 'string' ||
          data.agentRef.length === 0 ||
          data.agentRef.length > 256
        ) {
          throw new Error('pre-RED predecessor dispatch is invalid');
        }
      }
      if (
        selectedTicket === ticket &&
        source === 'events' &&
        record.kind === 'dispatch-start' &&
        data?.schema === 1 &&
        data.agentType === 'implementation-agent' &&
        typeof data?.agentRef === 'string' &&
        data.agentRef.length > 0 &&
        data.agentRef.length <= 256 &&
        Number.isSafeInteger(record.seq) &&
        record.seq > 0
      ) {
        if (dispatches.length >= MAX_PRE_RED_JOURNAL_RECORDS) {
          throw new Error('pre-RED dispatch count exceeds bounds');
        }
        dispatches.push({ runId, seq: record.seq });
      }
    }
  }
  dispatches.sort((left, right) => (left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : left.seq - right.seq));
  return { count: dispatches.length, fingerprint: fingerprintEvidence({ ticket, dispatches }) };
};

const implementationDeltaFingerprint = ({
  projectRoot,
  baselineHeadSha,
  bindingBaselineHeadSha = baselineHeadSha,
  headSha = null,
  ticket = null,
}) => {
  const paths = productionPaths({ projectRoot, baselineHeadSha, headSha, ticket });
  if (paths.length === 0) throw new Error('implementation delta is empty');
  let delta;
  try {
    delta = execFileSync(
      'git',
      ['-C', projectRoot, '--literal-pathspecs', 'diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', baselineHeadSha, ...(headSha ? [headSha] : []), '--', ...paths],
      { encoding: 'buffer', env: withoutGitLocation(), maxBuffer: MAX_IMPLEMENTATION_DELTA_BYTES },
    );
  } catch {
    throw new Error('implementation delta could not be read from the selected-work baseline');
  }
  if (delta.length === 0) throw new Error('implementation delta is empty');
  return fingerprintEvidence({
    baselineHeadSha: bindingBaselineHeadSha,
    diffSha256: createHash('sha256').update(delta).digest('hex'),
  });
};

const workingTreeDiffFingerprint = ({ projectRoot, gitHead }) => {
  if (!/^[a-f0-9]{40}$/.test(gitHead ?? '')) throw new Error('GREEN check has no valid implementation commit boundary');
  let diff;
  try {
    diff = execFileSync(
      'git',
      ['-C', projectRoot, 'diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', gitHead, '--'],
      { encoding: 'buffer', env: withoutGitLocation(), maxBuffer: MAX_IMPLEMENTATION_DELTA_BYTES },
    );
  } catch {
    throw new Error('current implementation working-tree delta could not be read');
  }
  return { algorithm: 'sha256', value: createHash('sha256').update(diff).digest('hex') };
};

const sameFingerprint = (left, right) =>
  left?.algorithm === 'sha256' && right?.algorithm === 'sha256' && SHA256.test(left?.value ?? '') && left.value === right.value;

const claimRecord = (projectRoot, ticket) => {
  const file = claimPathFor(projectRoot, { id: ticket });
  const hierarchy = claimHierarchy(projectRoot, file);
  const raw = readRegularFile(file, 'claim record');
  assertStableClaimHierarchy(hierarchy);
  let claim;
  try {
    claim = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('claim record is not valid JSON');
  }
  if (
    !claim ||
    typeof claim !== 'object' ||
    Array.isArray(claim) ||
    claim.ticket !== ticket ||
    !SHA256.test(claim?.fingerprints?.scope?.value ?? '') ||
    !/^[a-f0-9]{40}$/.test(claim?.fingerprints?.scope?.targetSha ?? '')
  ) {
    throw new Error('claim record does not carry a valid selected-work baseline');
  }
  return { file, claim, raw };
};

const replaceClaim = ({ projectRoot, file, content }) => {
  const directory = dirname(file);
  const hierarchy = claimHierarchy(projectRoot, file);
  const temporary = `.${basename(file)}.${process.pid}.tmp`;
  const expectedDirectory = hierarchy.directories.at(-1);
  const writer = String.raw`
    const { closeSync, constants, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } = require('node:fs');
    const { isAbsolute, relative, sep } = require('node:path');
    const [name, temporary, repository, expectedPath, expectedDev, expectedIno] = process.argv.slice(1);
    const root = realpathSync(repository);
    const cwd = realpathSync('.');
    const fromRoot = relative(root, cwd);
    if (fromRoot === '..' || fromRoot.startsWith('..' + sep) || isAbsolute(fromRoot)) throw new Error('claim directory .rig/claims escapes the repository');
    const stat = statSync('.');
    if (cwd !== expectedPath || String(stat.dev) !== expectedDev || String(stat.ino) !== expectedIno) throw new Error('claim directory .rig/claims changed during validation');
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    try { writeFileSync(fd, readFileSync(0)); } finally { closeSync(fd); }
    try { renameSync(temporary, name); } catch (error) { try { unlinkSync(temporary); } catch {} throw error; }
  `;
  execFileSync(
    process.execPath,
    [
      '-e',
      writer,
      basename(file),
      temporary,
      hierarchy.root,
      hierarchy.claimsResolved,
      String(expectedDirectory.dev),
      String(expectedDirectory.ino),
    ],
    {
      cwd: directory,
      env: withoutGitLocation(),
      input: content,
      stdio: ['pipe', 'ignore', 'pipe'],
      maxBuffer: 1024 * 1024,
    },
  );
  if (!readRegularFile(file, 'claim record').equals(Buffer.from(content))) {
    throw new Error('claim record postcondition failed');
  }
  assertStableClaimHierarchy(hierarchy);
};

const recordRed = async ({ projectRoot, runDir, ticket, check, predecessorRuns = [] }) => {
  const { event, test } = checkEvent({ projectRoot, runDir, check, outcome: 'fail' });
  const { file, claim } = claimRecord(projectRoot, ticket);
  const previousEvidence = claim.tddEvidence;
  if (previousEvidence !== undefined) {
    const priorValidation = validatePortableEvidence(previousEvidence);
    const historyValidation = validateTddEvidenceHistory({
      ticket,
      baselineHeadSha: claim.fingerprints.scope.targetSha,
      activeEvidence: previousEvidence,
      history: claim.tddEvidenceHistory,
    });
    if (!priorValidation.ok || !historyValidation.ok) {
      throw new HoldError('claim record does not carry valid portable predecessor evidence');
    }
    if (
      !['TDD-1', 'TDD-2', 'TDD-3'].includes(previousEvidence.applicability?.level) ||
      !sameTestScope(previousEvidence.red?.test, test) ||
      previousEvidence.red?.test?.fileSha256 === test.fileSha256
    ) {
      throw new Error('claim record does not carry replaceable stale TDD evidence');
    }
  }
  const tddScope = await trackerTddScope({
    projectRoot,
    ticket,
    observedAt: event.at,
    selectedScopeFingerprint: claim.fingerprints.scope,
  });
  if (!sameTestScope(tddScope.test, test)) {
    throw new Error('tracker relevant-spec marker does not match the structured failed test identity');
  }
  const baselineHeadSha = claim.fingerprints.scope.targetSha;
  const source = { runId: basename(runDir), seq: event.seq };
  const observation = { outcome: 'fail', checkFingerprint: checkFingerprint(event.data) };
  const red = {
    test,
    source,
    observation,
    fingerprint: fingerprintEvidence({
      ticket,
      baselineHeadSha,
      stage: 'red',
      test,
      source,
      observation,
    }),
  };
  let preRed = previousEvidence?.preRed;
  if (predecessorRuns.length > 0) {
    try {
      const production = preRedProduction({ projectRoot, baselineHeadSha, ticket });
      const implementationAgentDispatch = preRedDispatch({
        projectRoot,
        ticket,
        predecessors: predecessorRuns,
      });
      const origin = { ticket, baselineHeadSha, redFingerprint: red.fingerprint };
      preRed = {
        baseline: { headSha: baselineHeadSha },
        origin,
        production,
        implementationAgentDispatch,
        fingerprint: fingerprintEvidence({
          baseline: { headSha: baselineHeadSha },
          origin,
          production,
          implementationAgentDispatch,
        }),
      };
    } catch (error) {
      throw new HoldError(error.message);
    }
  }
  const evidence = {
    schemaVersion: 1,
    ticket,
    applicability: { level: 'TDD-1', authority: { kind: 'check-run', id: check } },
    baseline: { headSha: baselineHeadSha },
    red,
    ...(preRed ? { preRed } : {}),
  };
  const validation = validatePortableEvidence(evidence);
  if (!validation.ok) throw new Error(`portable RED evidence is invalid: ${validation.problems[0]}`);
  let tddEvidenceHistory = claim.tddEvidenceHistory;
  if (previousEvidence !== undefined) {
    const transition = {
      priorRedFingerprint: previousEvidence.red.fingerprint,
      replacementRedFingerprint: evidence.red.fingerprint,
      fingerprint: fingerprintEvidence({
        ticket,
        baselineHeadSha: claim.fingerprints.scope.targetSha,
        stage: 'stale-red-replacement',
        priorRedFingerprint: previousEvidence.red.fingerprint,
        replacementRedFingerprint: evidence.red.fingerprint,
      }),
    };
    tddEvidenceHistory = [...(claim.tddEvidenceHistory ?? []), { evidence: previousEvidence, transition }];
    const historyValidation = validateTddEvidenceHistory({
      ticket,
      baselineHeadSha: claim.fingerprints.scope.targetSha,
      activeEvidence: evidence,
      history: tddEvidenceHistory,
    });
    if (!historyValidation.ok) throw new Error(`portable stale RED history is invalid: ${historyValidation.problems[0]}`);
  }
  const next = { ...claim, tddScope, tddEvidence: evidence, ...(tddEvidenceHistory ? { tddEvidenceHistory } : {}) };
  replaceClaim({ projectRoot, file, content: `${JSON.stringify(next, null, 2)}\n` });
};

const recordGreen = ({ projectRoot, runDir, ticket, check }) => {
  const { run, event, test } = checkEvent({ projectRoot, runDir, check, outcome: 'pass' });
  const { file, claim } = claimRecord(projectRoot, ticket);
  const priorEvidence = claim.tddEvidence;
  const historyValidation = validateTddEvidenceHistory({
    ticket,
    baselineHeadSha: claim.fingerprints.scope.targetSha,
    activeEvidence: priorEvidence,
    history: claim.tddEvidenceHistory,
  });
  if (
    !priorEvidence ||
    !['TDD-1', 'TDD-2'].includes(priorEvidence.applicability?.level) ||
    priorEvidence.ticket !== ticket ||
    priorEvidence.baseline?.headSha !== claim.fingerprints.scope.targetSha ||
    !validatePortableEvidence(priorEvidence).ok ||
    !historyValidation.ok
  ) {
    throw new Error('claim record does not carry valid TDD evidence for this selected-work baseline');
  }
  if (!validTddScope({ claim, scope: claim.tddScope, ticket }) || !sameTestScope(claim.tddScope.test, priorEvidence.red?.test)) {
    throw new Error('claim record does not carry a valid tracker-derived relevant test scope');
  }
  if (!sameTest(test, priorEvidence.red?.test)) throw new Error('GREEN test identity or file hash changed after RED');
  const observedHead = event.data.gitHead;
  const currentHead = resolveCommit(projectRoot, 'HEAD');
  if (!/^[a-f0-9]{40}$/.test(observedHead ?? '') || observedHead !== currentHead) {
    throw new Error('GREEN check does not match the current implementation commit boundary');
  }
  const observedWorkingTreeDiff = event.data.workingTreeDiff;
  const currentWorkingTreeDiff = workingTreeDiffFingerprint({ projectRoot, gitHead: observedHead });
  if (!sameFingerprint(observedWorkingTreeDiff, currentWorkingTreeDiff)) {
    throw new Error('GREEN check does not match the current implementation working-tree delta');
  }
  const boundaryEvent = run.events.find(
    (entry) =>
      entry.kind === 'check-boundary' &&
      entry.seq < event.seq &&
      entry?.data?.name === check &&
      entry?.data?.gitHead === observedHead &&
      sameFingerprint(entry?.data?.workingTreeDiff, observedWorkingTreeDiff),
  );
  if (!boundaryEvent) throw new Error('GREEN check has no preceding implementation boundary provenance');
  const refresh =
    priorEvidence.applicability.level === 'TDD-2'
      ? mergedDefaultRefresh({ projectRoot, ticket, priorEvidence, history: claim.tddEvidenceHistory, currentHead })
      : null;
  const delta = implementationDeltaFingerprint({
    projectRoot,
    baselineHeadSha: refresh?.defaultHead ?? priorEvidence.baseline.headSha,
    bindingBaselineHeadSha: priorEvidence.baseline.headSha,
    ticket,
  });
  if (refresh && !sameFingerprint(delta, priorEvidence.implementationBoundary?.implementationDeltaFingerprint)) {
    throw new Error('GREEN refresh working-tree delta does not reproduce the prior implementation boundary');
  }
  const runId = basename(runDir);
  const boundarySource = { runId, seq: boundaryEvent.seq };
  const implementationBoundary = {
    source: boundarySource,
    implementationDeltaFingerprint: delta,
    predecessorFingerprint: priorEvidence.red.fingerprint,
    fingerprint: fingerprintEvidence({
      ticket,
      baselineHeadSha: priorEvidence.baseline.headSha,
      stage: 'implementation-boundary',
      source: boundarySource,
      implementationDeltaFingerprint: delta,
      predecessorFingerprint: priorEvidence.red.fingerprint,
    }),
  };
  const source = { runId, seq: event.seq };
  const observation = { outcome: 'pass', checkFingerprint: checkFingerprint(event.data) };
  const green = {
    test,
    source,
    observation,
    predecessorFingerprint: implementationBoundary.fingerprint,
    fingerprint: fingerprintEvidence({
      ticket,
      baselineHeadSha: priorEvidence.baseline.headSha,
      stage: 'green',
      test,
      source,
      observation,
      predecessorFingerprint: implementationBoundary.fingerprint,
    }),
  };
  const evidence = {
    ...priorEvidence,
    applicability: { level: 'TDD-2', authority: { kind: 'check-run', id: check } },
    implementationBoundary,
    green,
  };
  const validation = validatePortableEvidence(evidence);
  if (!validation.ok) throw new Error(`portable GREEN evidence is invalid: ${validation.problems[0]}`);
  let tddEvidenceHistory = claim.tddEvidenceHistory;
  if (refresh) {
    const transition = {
      priorGreenFingerprint: priorEvidence.green.fingerprint,
      replacementGreenFingerprint: evidence.green.fingerprint,
      priorImplementationBoundaryFingerprint: priorEvidence.implementationBoundary.fingerprint,
      replacementImplementationBoundaryFingerprint: evidence.implementationBoundary.fingerprint,
      mergedDefaultSha: refresh.defaultHead,
      fingerprint: fingerprintEvidence({
        ticket,
        baselineHeadSha: priorEvidence.baseline.headSha,
        stage: 'merged-default-green-refresh',
        priorGreenFingerprint: priorEvidence.green.fingerprint,
        replacementGreenFingerprint: evidence.green.fingerprint,
        priorImplementationBoundaryFingerprint: priorEvidence.implementationBoundary.fingerprint,
        replacementImplementationBoundaryFingerprint: evidence.implementationBoundary.fingerprint,
        mergedDefaultSha: refresh.defaultHead,
      }),
    };
    tddEvidenceHistory = [...(claim.tddEvidenceHistory ?? []), { evidence: priorEvidence, transition }];
    const refreshedHistory = validateTddEvidenceHistory({
      ticket,
      baselineHeadSha: claim.fingerprints.scope.targetSha,
      activeEvidence: evidence,
      history: tddEvidenceHistory,
    });
    if (!refreshedHistory.ok) throw new Error(`portable GREEN refresh history is invalid: ${refreshedHistory.problems[0]}`);
  }
  const next = { ...claim, tddEvidence: evidence, ...(tddEvidenceHistory ? { tddEvidenceHistory } : {}) };
  replaceClaim({ projectRoot, file, content: `${JSON.stringify(next, null, 2)}\n` });
};

const gitText = (projectRoot, args) =>
  execFileSync('git', ['-C', projectRoot, ...args], {
    encoding: 'utf8',
    env: withoutGitLocation(),
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

const resolveCommit = (projectRoot, ref) => {
  if (!/^[A-Za-z0-9._/@^-]{1,256}$/.test(ref)) throw new Error('base ref is unsafe');
  try {
    return gitText(projectRoot, ['rev-parse', '--verify', `${ref}^{commit}`]);
  } catch {
    throw new Error(`base ref ${ref} is not a resolvable commit`);
  }
};

const isAncestor = (projectRoot, ancestor, descendant) => {
  try {
    execFileSync('git', ['-C', projectRoot, 'merge-base', '--is-ancestor', ancestor, descendant], {
      env: withoutGitLocation(),
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
};

const defaultTargetSha = (projectRoot) => {
  const targetSha = targetShaOf(projectRoot);
  if (targetSha) return targetSha;
  throw new Error('merged default branch cannot be resolved');
};

const mergeParents = (projectRoot, head) => {
  let fields;
  try {
    fields = gitText(projectRoot, ['rev-list', '--parents', '-n', '1', head]).split(/\s+/);
  } catch {
    throw new Error('merged default branch cannot be inspected');
  }
  if (fields[0] !== head || fields.length !== 3 || !fields.slice(1).every((value) => /^[a-f0-9]{40}$/.test(value))) {
    throw new Error('GREEN refresh requires one direct merge of the current default branch');
  }
  return { priorHead: fields[1], defaultHead: fields[2] };
};

const priorRefreshDefault = ({ projectRoot, priorEvidence, history, priorHead }) => {
  if (history === undefined) return priorEvidence.baseline.headSha;
  const terminalTransition = history.at(-1)?.transition;
  if (terminalTransition?.priorRedFingerprint !== undefined || terminalTransition?.replacementRedFingerprint !== undefined) {
    return priorEvidence.baseline.headSha;
  }
  const defaultHead = terminalTransition?.mergedDefaultSha;
  if (!/^[a-f0-9]{40}$/.test(defaultHead ?? '') || !isAncestor(projectRoot, defaultHead, priorHead)) {
    throw new Error('GREEN refresh parent does not descend from the prior validated default transition');
  }
  return defaultHead;
};

const mergedDefaultRefresh = ({ projectRoot, ticket, priorEvidence, history, currentHead }) => {
  const defaultHead = defaultTargetSha(projectRoot);
  const { priorHead, defaultHead: mergedParent } = mergeParents(projectRoot, currentHead);
  if (mergedParent !== defaultHead) {
    throw new Error('GREEN refresh did not merge the current default branch tip');
  }
  if (defaultHead === priorEvidence.baseline.headSha || !isAncestor(projectRoot, priorEvidence.baseline.headSha, defaultHead)) {
    throw new Error('GREEN refresh requires an advanced default branch descended from the selected baseline');
  }
  const priorDefault = priorRefreshDefault({ projectRoot, priorEvidence, history, priorHead });
  if (defaultHead === priorDefault || !isAncestor(projectRoot, priorDefault, defaultHead)) {
    throw new Error('GREEN refresh requires the current default branch to advance from the prior validated default transition');
  }
  const priorDelta = implementationDeltaFingerprint({
    projectRoot,
    baselineHeadSha: priorDefault,
    bindingBaselineHeadSha: priorEvidence.baseline.headSha,
    headSha: priorHead,
    ticket,
  });
  if (!sameFingerprint(priorDelta, priorEvidence.implementationBoundary?.implementationDeltaFingerprint)) {
    throw new Error('GREEN refresh parent does not reproduce the prior implementation boundary');
  }
  return { defaultHead };
};

const normalizeCrLf = (value) => Buffer.from(value.toString('latin1').replaceAll('\r\n', '\n'), 'latin1');

const trackedClaimMatchesHead = ({ projectRoot, ticket, raw }) => {
  try {
    const tracked = execFileSync(
      'git',
      ['-C', projectRoot, 'show', `HEAD:.rig/claims/${ticket}.json`],
      { encoding: 'buffer', env: withoutGitLocation(), maxBuffer: MAX_JSON_BYTES },
    );
    return tracked.equals(raw) || tracked.equals(normalizeCrLf(raw));
  } catch {
    return false;
  }
};

const verifyShip = async ({ projectRoot, runDir, ticket, base }) => {
  const { claim, raw } = claimRecord(projectRoot, ticket);
  if (!trackedClaimMatchesHead({ projectRoot, ticket, raw })) {
    return { ok: false, reason: 'portable claim is not the tracked HEAD content' };
  }
  const verificationBaseSha = resolveCommit(projectRoot, base);
  try {
    execFileSync('git', ['-C', projectRoot, 'merge-base', '--is-ancestor', verificationBaseSha, 'HEAD'], {
      env: withoutGitLocation(),
      stdio: 'ignore',
    });
  } catch {
    return { ok: false, reason: 'selected base is not an ancestor of HEAD' };
  }
  let finalChangedPaths;
  try {
    finalChangedPaths = changedPaths({ projectRoot, baselineHeadSha: verificationBaseSha });
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  if (finalApplicability(finalChangedPaths, ticket).level === 'TDD-0') {
    try {
      recordEvent({
        runDir,
        kind: 'tdd-ship-verification',
        data: { ticket, baselineHeadSha: verificationBaseSha, level: 'TDD-0', authority: 'final-diff' },
        now: new Date().toISOString(),
      });
    } catch (error) {
      return { ok: false, reason: `shipping verdict could not be recorded: ${error.message}` };
    }
    return { ok: true, level: 'TDD-0' };
  }
  const evidence = claim.tddEvidence;
  const validation = validatePortableEvidence(evidence);
  if (validation.ok && evidence?.applicability?.level === 'TDD-0') {
    return { ok: false, reason: 'final production diff requires TDD-2 evidence' };
  }
  if (!validation.ok || !['TDD-2', 'TDD-3'].includes(evidence?.applicability?.level)) {
    return { ok: false, reason: 'portable TDD-2 evidence is missing or invalid' };
  }
  const historyValidation = validateTddEvidenceHistory({
    ticket,
    baselineHeadSha: claim.fingerprints.scope.targetSha,
    activeEvidence: evidence,
    history: claim.tddEvidenceHistory,
  });
  if (!historyValidation.ok) {
    return { ok: false, reason: 'portable stale RED history is missing or invalid' };
  }
  if (
    !validTddScope({ claim, scope: claim.tddScope, ticket }) ||
    !sameTestScope(claim.tddScope.test, evidence.red?.test) ||
    !sameTestScope(claim.tddScope.test, evidence.green?.test)
  ) {
    return { ok: false, reason: 'portable tracker-derived relevant test scope is missing or does not match RED/GREEN evidence' };
  }
  let currentTddScope;
  try {
    currentTddScope = await trackerTddScope({
      projectRoot,
      ticket,
      selectedScopeFingerprint: claim.fingerprints.scope,
    });
  } catch (error) {
    return { ok: false, reason: `tracker relevant test scope could not be read back: ${error.message}` };
  }
  if (currentTddScope.fingerprint.value !== claim.tddScope.fingerprint.value) {
    return { ok: false, reason: 'tracker relevant test scope no longer matches the selected scope' };
  }
  try {
    const redTestHash = currentTestFileHash({ projectRoot, test: evidence.red.test });
    const greenTestHash = currentTestFileHash({ projectRoot, test: evidence.green.test });
    if (redTestHash !== evidence.red.test.fileSha256 || greenTestHash !== evidence.green.test.fileSha256) {
      return { ok: false, reason: 'relevant test file hash changed after the observed GREEN' };
    }
  } catch (error) {
    return { ok: false, reason: `relevant test file could not be verified: ${error.message}` };
  }
  if (
    evidence.ticket !== ticket ||
    evidence.baseline.headSha !== claim.fingerprints.scope.targetSha ||
    evidence.applicability?.authority?.kind !== 'check-run'
  ) {
    return { ok: false, reason: 'portable TDD evidence does not bind this ticket and selected baseline' };
  }
  try {
    execFileSync(
      'git',
      ['-C', projectRoot, 'merge-base', '--is-ancestor', evidence.baseline.headSha, verificationBaseSha],
      { env: withoutGitLocation(), stdio: 'ignore' },
    );
  } catch {
    return { ok: false, reason: 'shipping base does not descend from the selected-work baseline' };
  }
  let delta;
  try {
    delta = implementationDeltaFingerprint({
      projectRoot,
      baselineHeadSha: verificationBaseSha,
      bindingBaselineHeadSha: evidence.baseline.headSha,
      ticket,
    });
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  const recorded = evidence.implementationBoundary?.implementationDeltaFingerprint;
  if (recorded?.algorithm !== delta.algorithm || recorded?.value !== delta.value) {
    return { ok: false, reason: 'portable implementation boundary does not match the final production diff' };
  }
  const evidenceFingerprints = {
    red: evidence.red.fingerprint,
    implementationBoundary: evidence.implementationBoundary.fingerprint,
    green: evidence.green.fingerprint,
    ...(evidence.applicability.level === 'TDD-3' ? { nonVacuity: evidence.nonVacuity.fingerprint } : {}),
  };
  try {
    recordEvent({
      runDir,
      kind: 'tdd-ship-verification',
      data: {
        ticket,
        baselineHeadSha: evidence.baseline.headSha,
        verificationBaseSha,
        level: evidence.applicability.level,
        implementationDeltaFingerprint: delta,
        evidenceFingerprints,
      },
      now: new Date().toISOString(),
    });
  } catch (error) {
    return { ok: false, reason: `shipping verdict could not be recorded: ${error.message}` };
  }
  return { ok: true, level: evidence.applicability.level, evidenceFingerprints };
};

const invokedDirectly = () => fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly()) {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) process.exitCode = fail(args.error);
  else {
    const runDir = process.env.RIG_RUN_DIR;
    if (!runDir) process.exitCode = fail('RIG_RUN_DIR is required');
    else {
      try {
        if (args.action === 'verify-ship') {
          const verdict = await verifyShip({ projectRoot: process.cwd(), runDir, ...args });
          if (!verdict.ok) process.exitCode = hold(verdict.reason);
          else {
            const fingerprints = verdict.evidenceFingerprints
              ? ` red=${verdict.evidenceFingerprints.red.value} implementationBoundary=${verdict.evidenceFingerprints.implementationBoundary.value} green=${verdict.evidenceFingerprints.green.value}${verdict.evidenceFingerprints.nonVacuity ? ` nonVacuity=${verdict.evidenceFingerprints.nonVacuity.value}` : ''}`
              : '';
            process.stdout.write(
              `tdd-evidence: PASS — portable ${verdict.level} evidence matches the final production diff${fingerprints}\n`,
            );
          }
        } else {
          const record = args.action === 'record-red' ? recordRed : recordGreen;
          await record({ projectRoot: process.cwd(), runDir, ...args });
        }
      } catch (error) {
        process.exitCode = error instanceof HoldError ? hold(error.message) : fail(error.message);
      }
    }
  }
}
