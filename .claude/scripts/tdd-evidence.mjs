#!/usr/bin/env node
// RP-306 — turn a structured, check-run-bound Vitest failure into the bounded
// portable RED record that a later controller can verify without this run's
// terminal output. This records evidence; it does not decide applicability or
// make an implementation-order claim (RP-305 and RP-307 own those contracts).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readlinkSync, readSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { claimPathFor } from './lib/claim-records.mjs';
import { findSecretValues } from './lib/secrets.mjs';
import { withoutGitLocation } from './git-env.mjs';
import { workingTreeStateFingerprint } from './lib/git-working-tree-state.mjs';
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
const SHA256 = /^[a-f0-9]{64}$/;
const TICKET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TDD_SPEC_PREFIX = 'rig:tdd-spec/v1 ';

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
    if (
      finished.isSymbolicLink() ||
      !finished.isFile() ||
      finished.dev !== declared.dev ||
      finished.ino !== declared.ino
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
    return { error: 'usage: tdd-evidence.mjs <record-red|record-green|verify-ship> --ticket <item> [--check <check>|--base <ref>]' };
  }
  const action = argv[0];
  let ticket = null;
  let check = null;
  let base = null;
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--ticket') ticket = argv[(index += 1)] ?? null;
    else if (flag === '--check') check = argv[(index += 1)] ?? null;
    else if (flag === '--base') base = argv[(index += 1)] ?? null;
    else return { error: `unknown flag ${flag}` };
  }
  if (!TICKET.test(ticket ?? '')) return { error: 'a bounded --ticket is required' };
  if (action !== 'verify-ship' && (typeof check !== 'string' || check.length === 0 || check.length > 128)) {
    return { error: 'a bounded --check is required' };
  }
  if (action === 'verify-ship' && (typeof base !== 'string' || base.length === 0 || base.length > 256)) {
    return { error: 'a bounded --base is required' };
  }
  return { action, ticket, check, base };
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

const changedPaths = ({ projectRoot, baselineHeadSha }) => {
  let names;
  try {
    names = execFileSync('git', ['-C', projectRoot, 'diff', '--name-only', '-z', baselineHeadSha, '--'], {
      encoding: 'buffer',
      env: withoutGitLocation(),
      maxBuffer: MAX_IMPLEMENTATION_DELTA_BYTES,
    });
  } catch {
    throw new Error('final Git diff could not be read from the selected-work baseline');
  }
  return decodeGitPathList(names, 'final Git diff paths');
};

const tddApplicabilityPaths = (paths, ticket = null) =>
  paths.filter(
    (file) => file !== `.rig/claims/${ticket}.json` && file !== 'AGENTS.md' && file !== 'CLAUDE.md',
  );

const finalApplicability = (paths, ticket) => {
  const changed = tddApplicabilityPaths(paths, ticket);
  return changed.length === 0 ? { level: 'TDD-0' } : resolveApplicability({ changedPaths: changed });
};

const productionPaths = ({ projectRoot, baselineHeadSha, ticket = null }) => {
  const paths = tddApplicabilityPaths(changedPaths({ projectRoot, baselineHeadSha }), ticket);
  return paths.filter((file) => resolveApplicability({ changedPaths: [file] }).level !== 'TDD-0');
};

const gitPathList = ({ projectRoot, args, label }) => {
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
  return decodeGitPathList(names, label);
};

const isTestInfrastructurePath = (file) => /^vitest\.config\.(?:[cm]?[jt]s|json)$/.test(file);

const isPreRedRuntimePath = (file) => file.startsWith('node_modules/');

const decodeGitPathList = (bytes, label) => {
  if (bytes.length > 0 && bytes.at(-1) !== 0) throw new Error(`${label} is not NUL terminated`);
  const paths = [];
  for (const encoded of bytes.toString('binary').split('\0').slice(0, -1)) {
    let file;
    try {
      file = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(encoded, 'binary'));
    } catch {
      throw new Error(`${label} contains an undecodable Git path`);
    }
    if (!safeRelativePath(file)) throw new Error(`${label} contains an unsafe or over-bound Git path`);
    paths.push(file);
  }
  return paths;
};

const preRedProductionPaths = ({ projectRoot, baselineHeadSha, ticket = null }) => {
  const workingTree = gitPathList({
    projectRoot,
    args: ['diff', '--name-only', '-z', baselineHeadSha, '--'],
    label: 'working-tree Git paths',
  });
  const index = gitPathList({
    projectRoot,
    args: ['diff', '--cached', '--name-only', '-z', baselineHeadSha, '--'],
    label: 'index Git paths',
  });
  const untracked = gitPathList({
    projectRoot,
    args: ['ls-files', '--others', '--exclude-standard', '-z'],
    label: 'untracked Git paths',
  });
  const candidates = [...new Set([...workingTree, ...index, ...untracked])].sort();
  return tddApplicabilityPaths(candidates, ticket).filter(
    (file) =>
      !isPreRedRuntimePath(file) &&
      !isTestInfrastructurePath(file) &&
      resolveApplicability({ changedPaths: [file] }).level !== 'TDD-0',
  );
};

const pathStateFingerprint = ({ projectRoot, paths }) => {
  if (paths.length > 256) throw new Error('pre-RED production state exceeds 256 paths');
  const entries = paths.map((file) => {
    const pathFingerprint = createHash('sha256').update(file).digest('hex');
    try {
      const stat = lstatSync(join(projectRoot, file));
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(join(projectRoot, file), { encoding: 'buffer' });
        const finished = lstatSync(join(projectRoot, file));
        if (!finished.isSymbolicLink() || finished.dev !== stat.dev || finished.ino !== stat.ino) {
          throw new Error('pre-RED production symlink changed during validation');
        }
        return {
          pathFingerprint,
          state: 'symlink',
          targetFingerprint: createHash('sha256').update(target).digest('hex'),
        };
      }
      if (!stat.isFile()) throw new Error('pre-RED production path is not a regular file');
      const bytes = repositoryTestFile({ projectRoot, testFile: file, label: 'pre-RED production file' });
      return {
        pathFingerprint,
        state: 'present',
        contentFingerprint: createHash('sha256').update(bytes).digest('hex'),
      };
    } catch (error) {
      if (error?.code === 'ENOENT') return { pathFingerprint, state: 'deleted' };
      throw error;
    }
  });
  return fingerprintEvidence({ stage: 'pre-red-production-state', entries });
};

const implementationDeltaFingerprint = ({ projectRoot, baselineHeadSha, bindingBaselineHeadSha = baselineHeadSha, ticket = null }) => {
  const paths = productionPaths({ projectRoot, baselineHeadSha, ticket });
  if (paths.length === 0) throw new Error('implementation delta is empty');
  let delta;
  try {
    delta = execFileSync(
      'git',
      ['-C', projectRoot, 'diff', '--binary', '--no-ext-diff', '--no-textconv', baselineHeadSha, '--', ...paths],
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
  try {
    return workingTreeStateFingerprint({ projectRoot, gitHead, maxBytes: MAX_IMPLEMENTATION_DELTA_BYTES });
  } catch (error) {
    throw new Error(`current implementation working-tree state could not be read: ${error.message}`, { cause: error });
  }
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

const recordRed = async ({ projectRoot, runDir, ticket, check }) => {
  const { run, event, test } = checkEvent({ projectRoot, runDir, check, outcome: 'fail' });
  const { file, claim } = claimRecord(projectRoot, ticket);
  const observedHead = event.data.gitHead;
  const observedWorkingTreeDiff = event.data.workingTreeDiff;
  if (!/^[a-f0-9]{40}$/.test(observedHead ?? '') || !sameFingerprint(observedWorkingTreeDiff, observedWorkingTreeDiff)) {
    throw new Error('RED check has no valid pre-RED production boundary');
  }
  const boundaryEvent = run.events.find(
    (entry) =>
      entry.kind === 'check-boundary' &&
      entry.seq < event.seq &&
      entry?.data?.name === check &&
      entry?.data?.gitHead === observedHead &&
      sameFingerprint(entry?.data?.workingTreeDiff, observedWorkingTreeDiff),
  );
  if (!boundaryEvent) throw new Error('RED check has no preceding pre-RED production boundary');
  if (resolveCommit(projectRoot, 'HEAD') !== observedHead) {
    throw new Error('pre-RED production boundary changed after the RED check');
  }
  const currentWorkingTreeDiff = workingTreeDiffFingerprint({ projectRoot, gitHead: observedHead });
  if (!sameFingerprint(observedWorkingTreeDiff, currentWorkingTreeDiff)) {
    throw new Error('pre-RED production boundary changed after the RED check');
  }
  const previousEvidence = claim.tddEvidence;
  if (previousEvidence !== undefined) {
    const priorValidation = validatePortableEvidence(previousEvidence);
    const historyValidation = validateTddEvidenceHistory({
      ticket,
      baselineHeadSha: claim.fingerprints.scope.targetSha,
      activeEvidence: previousEvidence,
      history: claim.tddEvidenceHistory,
    });
    if (
      !priorValidation.ok ||
      !historyValidation.ok ||
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
  const source = { runId: basename(runDir), seq: event.seq };
  const observation = { outcome: 'fail', checkFingerprint: checkFingerprint(event.data) };
  const red = {
    test,
    source,
    observation,
    fingerprint: fingerprintEvidence({
      ticket,
      baselineHeadSha: claim.fingerprints.scope.targetSha,
      stage: 'red',
      test,
      source,
      observation,
    }),
  };
  const paths = preRedProductionPaths({
    projectRoot,
    baselineHeadSha: claim.fingerprints.scope.targetSha,
    ticket,
  });
  const production = {
    pathCount: paths.length,
    stateFingerprint: pathStateFingerprint({ projectRoot, paths }),
  };
  production.fingerprint = fingerprintEvidence({
    ticket,
    baselineHeadSha: claim.fingerprints.scope.targetSha,
    stage: 'pre-red-production',
    pathCount: production.pathCount,
    stateFingerprint: production.stateFingerprint,
  });
  const dispatchSources = run.events
    .filter(
      (entry) =>
        entry.kind === 'dispatch-start' &&
        entry.seq < event.seq &&
        entry?.data?.agentType === 'implementation-agent',
    )
    .map((entry) => ({ runId: basename(runDir), seq: entry.seq }));
  if (dispatchSources.length > 256) throw new Error('pre-RED implementation-agent dispatches exceed 256 events');
  const implementationAgentDispatch = {
    count: dispatchSources.length,
    sourcesFingerprint: fingerprintEvidence({
      stage: 'pre-red-implementation-agent-dispatch-sources',
      sources: dispatchSources,
    }),
  };
  implementationAgentDispatch.fingerprint = fingerprintEvidence({
    ticket,
    baselineHeadSha: claim.fingerprints.scope.targetSha,
    stage: 'pre-red-implementation-agent-dispatch',
    count: implementationAgentDispatch.count,
    sourcesFingerprint: implementationAgentDispatch.sourcesFingerprint,
  });
  const preRed = {
    baseline: { headSha: claim.fingerprints.scope.targetSha },
    red: { check, fingerprint: red.fingerprint },
    production,
    implementationAgentDispatch,
  };
  preRed.fingerprint = fingerprintEvidence({
    ticket,
    baseline: preRed.baseline,
    red: preRed.red,
    production: preRed.production,
    implementationAgentDispatch: preRed.implementationAgentDispatch,
  });
  const evidence = {
    schemaVersion: 1,
    ticket,
    applicability: { level: 'TDD-1', authority: { kind: 'check-run', id: check } },
    baseline: { headSha: claim.fingerprints.scope.targetSha },
    preRed,
    red,
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
  const red = claim.tddEvidence;
  const historyValidation = validateTddEvidenceHistory({
    ticket,
    baselineHeadSha: claim.fingerprints.scope.targetSha,
    activeEvidence: red,
    history: claim.tddEvidenceHistory,
  });
  if (
    !red ||
    red.applicability?.level !== 'TDD-1' ||
    red.ticket !== ticket ||
    red.baseline?.headSha !== claim.fingerprints.scope.targetSha ||
    !validatePortableEvidence(red).ok ||
    !historyValidation.ok
  ) {
    throw new Error('claim record does not carry a valid TDD-1 RED for this selected-work baseline');
  }
  if (!validTddScope({ claim, scope: claim.tddScope, ticket }) || !sameTestScope(claim.tddScope.test, red.red?.test)) {
    throw new Error('claim record does not carry a valid tracker-derived relevant test scope');
  }
  if (!sameTest(test, red.red?.test)) throw new Error('GREEN test identity or file hash changed after RED');
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
  const delta = implementationDeltaFingerprint({
    projectRoot,
    baselineHeadSha: red.baseline.headSha,
    ticket,
  });
  const runId = basename(runDir);
  const boundarySource = { runId, seq: boundaryEvent.seq };
  const implementationBoundary = {
    source: boundarySource,
    implementationDeltaFingerprint: delta,
    predecessorFingerprint: red.red.fingerprint,
    fingerprint: fingerprintEvidence({
      ticket,
      baselineHeadSha: red.baseline.headSha,
      stage: 'implementation-boundary',
      source: boundarySource,
      implementationDeltaFingerprint: delta,
      predecessorFingerprint: red.red.fingerprint,
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
      baselineHeadSha: red.baseline.headSha,
      stage: 'green',
      test,
      source,
      observation,
      predecessorFingerprint: implementationBoundary.fingerprint,
    }),
  };
  const evidence = {
    ...red,
    applicability: { level: 'TDD-2', authority: { kind: 'check-run', id: check } },
    implementationBoundary,
    green,
  };
  const validation = validatePortableEvidence(evidence);
  if (!validation.ok) throw new Error(`portable GREEN evidence is invalid: ${validation.problems[0]}`);
  const next = { ...claim, tddEvidence: evidence };
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

const trackedClaimMatchesHead = ({ projectRoot, ticket, raw }) => {
  try {
    const tracked = execFileSync(
      'git',
      ['-C', projectRoot, 'show', `HEAD:.rig/claims/${ticket}.json`],
      { encoding: 'buffer', env: withoutGitLocation(), maxBuffer: MAX_JSON_BYTES },
    );
    return tracked.equals(raw);
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
        process.exitCode = fail(error.message);
      }
    }
  }
}
