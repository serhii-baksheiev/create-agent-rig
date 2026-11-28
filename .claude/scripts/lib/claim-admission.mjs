import { execFileSync, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { withoutGitLocation } from '../git-env.mjs';
import { readUnattended } from '../unattended-flag.mjs';
import * as claimRecords from './claim-records.mjs';
import { unresolvedBlockingDetectionOf } from './revalidation-evidence.mjs';
import * as runJournal from '../run-journal.mjs';

const duplicateWorkScript = fileURLToPath(new URL('../duplicate-work.mjs', import.meta.url));
const CHECKOUT_ROOT_TIMEOUT_MS = 10_000;
const MAX_NATIVE_DIAGNOSTIC_BYTES = 64 * 1024;
const NATIVE_SOURCES = ['branch', 'pr'];
const NATIVE_SOURCE_STATUSES = new Set(['read', 'unavailable', 'not-applicable']);
const { readRun } = runJournal;

const refusal = (admission, detail) => ({
  ok: false,
  claimed: false,
  reason: 'claim-unverifiable',
  admission,
  detail,
});

const nativeInvocationFailure = () => ({
  ...refusal('unverifiable', 'native duplicate-work could not be verified'),
  diagnostic: 'native-invocation-failed',
});

const nativeProtocolFailure = () => ({
  ...refusal('unverifiable', 'native duplicate-work response could not be verified'),
  diagnostic: 'native-protocol-invalid',
});

const unavailableSourcesOf = (stdout, ticket) => {
  if (!Buffer.isBuffer(stdout) && typeof stdout !== 'string') return null;
  if (Buffer.byteLength(stdout) > MAX_NATIVE_DIAGNOSTIC_BYTES) return null;
  let result;
  try {
    result = JSON.parse(Buffer.isBuffer(stdout) ? stdout.toString('utf8') : stdout);
  } catch {
    return null;
  }
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    Object.getPrototypeOf(result) !== Object.prototype ||
    Object.keys(result).length !== 4 ||
    !['ticket', 'verdict', 'matches', 'sources'].every((key) => Object.hasOwn(result, key)) ||
    result.ticket !== String(ticket.id) ||
    result.verdict !== 'unverifiable' ||
    !Array.isArray(result.matches) ||
    result.matches.length !== 0 ||
    !Array.isArray(result.sources) ||
    result.sources.length !== NATIVE_SOURCES.length
  ) {
    return null;
  }
  const byName = new Map();
  for (const source of result.sources) {
    if (
      !source ||
      typeof source !== 'object' ||
      Array.isArray(source) ||
      Object.getPrototypeOf(source) !== Object.prototype ||
      Object.keys(source).length !== 2 ||
      !Object.hasOwn(source, 'name') ||
      !Object.hasOwn(source, 'status') ||
      !NATIVE_SOURCES.includes(source.name) ||
      !NATIVE_SOURCE_STATUSES.has(source.status) ||
      byName.has(source.name)
    ) {
      return null;
    }
    byName.set(source.name, source.status);
  }
  if (!NATIVE_SOURCES.every((name) => byName.has(name))) return null;
  const unavailableSources = NATIVE_SOURCES.filter((name) => byName.get(name) === 'unavailable');
  return unavailableSources.length > 0 ? unavailableSources : null;
};

const nativeSelectAdmission = (ticket, decisions, events) => {
  const selection = [...decisions].reverse().find((decision) => decision.gate === 'item-selection');
  if (selection?.verdict !== `taken ${ticket.id}`) return null;
  return events.find(
    (event) =>
      event.seq > selection.seq &&
      event.kind === 'revalidation' &&
      event.data?.point === 'SELECT' &&
      String(event.data?.ticket) === String(ticket.id) &&
      ['BASELINE_CREATED', 'CURRENT'].includes(event.data?.result),
  );
};

const matchesSelectedSnapshot = (ticket, selection) => {
  const taskSnapshot = selection?.data?.task?.to;
  if (typeof taskSnapshot !== 'string') return false;
  const callerSnapshot = new Date(ticket?.updatedAt).getTime();
  const selectedSnapshot = new Date(taskSnapshot).getTime();
  return Number.isFinite(callerSnapshot) && callerSnapshot === selectedSnapshot;
};

const checkoutRootOf = (dir, env) =>
  realpathSync.native(
    execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      env: withoutGitLocation(env),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CHECKOUT_ROOT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    }).trim(),
  );

const sameCheckout = (left, right) =>
  process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

const matchesUnattendedScope = (ticket, runDir, checkoutRoot, env) => {
  const unattended = readUnattended({ ...env, CLAUDE_PROJECT_DIR: checkoutRoot });
  return (
    !unattended.on ||
    (!unattended.unreadable &&
      unattended.item === String(ticket.id) &&
      typeof unattended.runDir === 'string' &&
      sameCheckout(realpathSync.native(unattended.runDir), realpathSync.native(runDir)))
  );
};

const admitNativeClaim = ({ ticket, projectRoot, env = process.env } = {}) => {
  if (!env?.RIG_RUN_DIR) {
    return refusal('admission-unverifiable', 'declared run is required for admission');
  }
  let checkoutRoot;
  try {
    checkoutRoot = checkoutRootOf(projectRoot, env);
    if (!sameCheckout(checkoutRoot, checkoutRootOf(env.RIG_RUN_DIR, env))) {
      return refusal('checkout-unverifiable', 'checkout identity could not be verified');
    }
  } catch {
    return refusal('checkout-unverifiable', 'checkout identity could not be verified');
  }
  try {
    if (!matchesUnattendedScope(ticket, env.RIG_RUN_DIR, checkoutRoot, env)) {
      return refusal('admission-unverifiable', 'unattended scope could not be verified');
    }
  } catch {
    return refusal('admission-unverifiable', 'unattended scope could not be verified');
  }
  let initialRun;
  try {
    if (typeof readRun !== 'function') throw new Error('native journal reader unavailable');
    initialRun = readRun({ runDir: env.RIG_RUN_DIR });
  } catch {
    return refusal('journal-unreadable', 'native run journal could not be read');
  }
  const { decisions, events } = initialRun;
  const selection = nativeSelectAdmission(ticket, decisions, events);
  if (!selection) {
    return refusal('unverifiable', 'native admission evidence could not be verified');
  }
  if (!matchesSelectedSnapshot(ticket, selection)) {
    return refusal('unverifiable', 'native admission evidence could not be verified');
  }
  const unresolved = unresolvedBlockingDetectionOf(events);
  if (unresolved) {
    return refusal('unverifiable', 'native admission evidence could not be verified');
  }
  const beforeDuplicateWork = Math.max(0, ...events.map((event) => event.seq));
  let duplicateWork;
  try {
    duplicateWork = spawnSync(process.execPath, [duplicateWorkScript, '--ticket', ticket.id, '--json'], {
      cwd: projectRoot,
      env,
    });
  } catch {
    return nativeInvocationFailure();
  }
  if (duplicateWork.error || duplicateWork.signal || !Number.isInteger(duplicateWork.status)) {
    return nativeInvocationFailure();
  }
  if (duplicateWork.status === 2) {
    return refusal('duplicate-work', 'native duplicate-work found existing work');
  }
  if (duplicateWork.status === 3) {
    const unavailableSources = unavailableSourcesOf(duplicateWork.stdout, ticket);
    if (unavailableSources === null) return nativeProtocolFailure();
    return {
      ...refusal('unverifiable', 'native duplicate-work sources were unavailable'),
      diagnostic: 'native-source-unavailable',
      unavailableSources,
    };
  }
  if (duplicateWork.status !== 0) {
    return nativeInvocationFailure();
  }
  try {
    if (!matchesUnattendedScope(ticket, env.RIG_RUN_DIR, checkoutRoot, env)) {
      return refusal('admission-unverifiable', 'unattended scope could not be verified');
    }
  } catch {
    return refusal('admission-unverifiable', 'unattended scope could not be verified');
  }
  let afterDuplicateWork;
  try {
    if (typeof readRun !== 'function') throw new Error('native journal reader unavailable');
    afterDuplicateWork = readRun({ runDir: env.RIG_RUN_DIR });
  } catch {
    return refusal('journal-unreadable', 'native run journal could not be read');
  }
  const freshReceipt = afterDuplicateWork.events.some(
    (event) =>
      event.seq > beforeDuplicateWork &&
      event.seq > selection.seq &&
      event.kind === 'duplicate-work' &&
      String(event.data?.ticket) === String(ticket.id) &&
      event.data?.verdict === 'clean',
  );
  if (!freshReceipt) {
    return refusal('unverifiable', 'native duplicate-work receipt could not be verified');
  }
  const currentSelection = nativeSelectAdmission(ticket, afterDuplicateWork.decisions, afterDuplicateWork.events);
  if (currentSelection?.seq !== selection.seq) {
    return refusal('unverifiable', 'native admission evidence could not be verified');
  }
  const unresolvedAfterDuplicateWork = unresolvedBlockingDetectionOf(afterDuplicateWork.events);
  if (unresolvedAfterDuplicateWork) {
    return refusal('unverifiable', 'native admission evidence could not be verified');
  }
  try {
    const expectedObject = currentSelection.data?.selectionBaseline?.claimObject;
    if (
      typeof claimRecords.readSelectedClaimBaseline !== 'function' ||
      claimRecords.readSelectedClaimBaseline({ projectRoot, ticket, expectedObject }) === null
    ) {
      return refusal('claim-baseline-unverifiable', 'selected claim baseline could not be verified');
    }
  } catch {
    return refusal('claim-baseline-unverifiable', 'selected claim baseline could not be verified');
  }
  return { ok: true };
};

export const admitClaim = (options = {}) => {
  try {
    return admitNativeClaim(options);
  } catch {
    return refusal('admission-unverifiable', 'admission could not be verified');
  }
};
