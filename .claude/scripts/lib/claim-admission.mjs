import { execFileSync, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { withoutGitLocation } from '../git-env.mjs';
import { readUnattended } from '../unattended-flag.mjs';
import { readClaimForTicket } from './claim-records.mjs';
import { unresolvedBlockingDetectionOf } from './revalidation-evidence.mjs';
import * as runJournal from '../run-journal.mjs';

const duplicateWorkScript = fileURLToPath(new URL('../duplicate-work.mjs', import.meta.url));
const CHECKOUT_ROOT_TIMEOUT_MS = 10_000;
const { readRun } = runJournal;

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
    return { ok: false, claimed: false, reason: 'claim-unverifiable', detail: 'no declared RIG_RUN_DIR' };
  }
  const checkoutRoot = checkoutRootOf(projectRoot, env);
  if (!sameCheckout(checkoutRoot, checkoutRootOf(env.RIG_RUN_DIR, env))) {
    return {
      ok: false,
      claimed: false,
      reason: 'claim-unverifiable',
      detail: 'RIG_RUN_DIR belongs to a different checkout',
    };
  }
  if (!matchesUnattendedScope(ticket, env.RIG_RUN_DIR, checkoutRoot, env)) {
    return {
      ok: false,
      claimed: false,
      reason: 'claim-unverifiable',
      detail: 'armed unattended scope cannot verify this ticket and run',
    };
  }
  const { decisions, events } = readRun({ runDir: env.RIG_RUN_DIR });
  const selection = nativeSelectAdmission(ticket, decisions, events);
  if (!selection) {
    return {
      ok: false,
      claimed: false,
      reason: 'claim-unverifiable',
      detail: `no native SELECT admission exists for ${ticket.id} in this run`,
    };
  }
  if (!matchesSelectedSnapshot(ticket, selection)) {
    return {
      ok: false,
      claimed: false,
      reason: 'claim-unverifiable',
      detail: 'caller snapshot does not match native SELECT task snapshot',
    };
  }
  const unresolved = unresolvedBlockingDetectionOf(events);
  if (unresolved) {
    return {
      ok: false,
      claimed: false,
      reason: 'claim-unverifiable',
      detail: `unresolved ${unresolved.result} revalidation at ${unresolved.checkpoint}`,
    };
  }
  const beforeDuplicateWork = Math.max(0, ...events.map((event) => event.seq));
  const duplicateWork = spawnSync(process.execPath, [duplicateWorkScript, '--ticket', ticket.id, '--json'], {
    cwd: projectRoot,
    env,
  });
  if (duplicateWork.status !== 0) {
    return { ok: false, claimed: false, reason: 'claim-unverifiable', detail: 'native duplicate-work did not exit 0' };
  }
  if (!matchesUnattendedScope(ticket, env.RIG_RUN_DIR, checkoutRoot, env)) {
    return {
      ok: false,
      claimed: false,
      reason: 'claim-unverifiable',
      detail: 'armed unattended scope cannot verify this ticket and run',
    };
  }
  const afterDuplicateWork = readRun({ runDir: env.RIG_RUN_DIR });
  const freshReceipt = afterDuplicateWork.events.some(
    (event) =>
      event.seq > beforeDuplicateWork &&
      event.seq > selection.seq &&
      event.kind === 'duplicate-work' &&
      String(event.data?.ticket) === String(ticket.id) &&
      event.data?.verdict === 'clean',
  );
  if (!freshReceipt) {
    return {
      ok: false,
      claimed: false,
      reason: 'claim-unverifiable',
      detail: `native duplicate-work left no fresh durable receipt for ${ticket.id}`,
    };
  }
  const currentSelection = nativeSelectAdmission(ticket, afterDuplicateWork.decisions, afterDuplicateWork.events);
  if (currentSelection?.seq !== selection.seq) {
    return {
      ok: false,
      claimed: false,
      reason: 'claim-unverifiable',
      detail: `native SELECT admission changed for ${ticket.id} during duplicate-work`,
    };
  }
  const unresolvedAfterDuplicateWork = unresolvedBlockingDetectionOf(afterDuplicateWork.events);
  if (unresolvedAfterDuplicateWork) {
    return {
      ok: false,
      claimed: false,
      reason: 'claim-unverifiable',
      detail: `unresolved ${unresolvedAfterDuplicateWork.result} revalidation at ${unresolvedAfterDuplicateWork.checkpoint}`,
    };
  }
  if (readClaimForTicket({ projectRoot, ticket }) === null) {
    return {
      ok: false,
      claimed: false,
      reason: 'claim-unverifiable',
      detail: 'selected claim baseline is no longer available',
    };
  }
  return { ok: true };
};

export const admitClaim = (options = {}) => {
  try {
    return admitNativeClaim(options);
  } catch {
    return {
      ok: false,
      claimed: false,
      reason: 'claim-unverifiable',
      detail: 'native run or journal admission evidence could not be read',
    };
  }
};
