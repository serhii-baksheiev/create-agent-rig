/**
 * The instance-axis state vocabulary, and the two pure functions RP-21 calls
 * to turn one integration's evidence into a doctor status (RP-22, plan §1.3).
 *
 * Both functions are pure: no clock, no I/O, no process spawn, no import
 * beyond this file. `classify` takes only what a caller already has in hand —
 * whether the integration is declared (or was refused, or isn't declared at
 * all), the last recorded baseline from its receipt (if any), and what a
 * probe observed just now — and returns one of the nine closed
 * {@link InstanceState} values. `toDoctorStatus` then maps that state, plus
 * whether the integration is required, onto doctor's three-value
 * {@link DoctorStatus}.
 *
 * `classify` never lets the RECEIPT decide whether something is installed —
 * only `observed` decides that axis; `receipt` supplies nothing but the drift
 * baseline compared against a *present* observation. A forged receipt
 * claiming `installed` with nothing actually observed present classifies as
 * `missing`, `unverified`, `pending-user-action` or `unsupported`, never as
 * `installed`. Pinned in `packages/cli/test/integrations-state.test.ts` ›
 * "a forged receipt claiming installed, with no observation, never
 * classifies as installed, for every non-present observation" (plan §1.4,
 * "What makes a receipt trustworthy", point 4).
 *
 * `receipt` is not attacker-controlled the way that name might suggest: it is
 * written only by `setup apply`/`setup remove` and travels through the same
 * PR review as any other committed file (plan §1.4). That is why its non-null
 * fields are treated as a baseline to CONFIRM rather than input to distrust
 * outright — and where the evidence is ambiguous, `classify` always resolves
 * toward MORE scrutiny (`unverified`/`drifted`) rather than less: a wrong
 * guess then costs one extra warning, never a missed real problem.
 *
 * This module imports nothing.
 */

const INSTANCE_STATES_LIST = [
  'installed',
  'drifted',
  'missing',
  'pending-user-action',
  'unverified',
  'unsupported',
  'not-applicable',
  'rejected',
  'orphaned',
] as const;

export type InstanceState = (typeof INSTANCE_STATES_LIST)[number];

/** The closed, lowercase instance-axis vocabulary (plan §1.3). Runtime-frozen. */
export const INSTANCE_STATES: readonly InstanceState[] = Object.freeze([...INSTANCE_STATES_LIST]);

const UNVERIFIED_REASONS_LIST = [
  'tool-absent',
  'tool-not-spawnable',
  'timeout',
  'output-unparseable',
  'no-sanctioned-probe',
] as const;

export type UnverifiedReason = (typeof UNVERIFIED_REASONS_LIST)[number];

/** Why a probe could not run at all, when `state` is `unverified` (plan §1.3). */
export const UNVERIFIED_REASONS: readonly UnverifiedReason[] = Object.freeze([
  ...UNVERIFIED_REASONS_LIST,
]);

const REJECTED_REASONS_LIST = [
  'not-in-matrix',
  'unknown-license',
  'non-official-source',
  'arbitrary-command-refused',
  'exclusive-group-conflict',
  'unpinnable-version',
] as const;

export type RejectedReason = (typeof REJECTED_REASONS_LIST)[number];

/** Why a declaration was refused, when `state` is `rejected` (plan §1.3). */
export const REJECTED_REASONS: readonly RejectedReason[] = Object.freeze([
  ...REJECTED_REASONS_LIST,
]);

/** doctor's closed status set. */
export type DoctorStatus = 'ok' | 'warn' | 'fail';

/** What the declaration side of {@link classify} knows about one integration. */
export type DeclaredInput =
  | { readonly kind: 'accepted'; readonly version?: string }
  | { readonly kind: 'rejected'; readonly reason: RejectedReason }
  | { readonly kind: 'not-declared' };

/** The last recorded baseline from a receipt, or `undefined` when none exists. */
export type ReceiptBaseline = {
  readonly version: string | null;
  readonly digest: string | null;
};

/**
 * What a live probe found just now. Never built from the receipt — that is
 * exactly the property "a forged receipt never classifies as installed"
 * depends on.
 */
export type ObservedNow =
  | { readonly present: true; readonly version: string | null; readonly digest: string | null }
  | {
      readonly present: false;
      readonly kind: 'missing' | 'unverifiable' | 'guided-pending' | 'no-route' | 'not-applicable';
      readonly reason?: UnverifiedReason;
    };

/**
 * Classify one integration into its {@link InstanceState}. Total over its
 * three inputs — every branch is reached by at least one named test in
 * `integrations-state.test.ts`.
 */
export function classify(
  declared: DeclaredInput,
  receipt: ReceiptBaseline | undefined,
  observed: ObservedNow,
): InstanceState {
  if (declared.kind === 'rejected') return 'rejected';
  if (declared.kind === 'not-declared') {
    return receipt !== undefined ? 'orphaned' : 'not-applicable';
  }

  if (!observed.present) {
    switch (observed.kind) {
      case 'no-route':
        return 'unsupported';
      case 'not-applicable':
        return 'not-applicable';
      case 'guided-pending':
        return 'pending-user-action';
      case 'unverifiable':
        return 'unverified';
      case 'missing':
        return 'missing';
      default: {
        const exhaustive: never = observed.kind;
        throw new Error(`unreachable observed.kind: ${String(exhaustive)}`);
      }
    }
  }

  // A version baseline is known (a declared pin, or a receipt that itself
  // recorded a version) but the CURRENT probe could not read one. Silently
  // reporting `installed` here would be misplaced confidence — the one thing
  // the baseline needs confirmed is unconfirmed. `unverified` (reason
  // output-unparseable, recorded by the caller alongside this state) is the
  // honest answer, and it is the same "more scrutiny, not less" direction
  // this module's header commits to.
  const hasKnownVersionBaseline =
    declared.version !== undefined || (receipt !== undefined && receipt.version !== null);
  if (observed.version === null && hasKnownVersionBaseline) return 'unverified';

  const declaredVersionDiffers =
    declared.version !== undefined &&
    observed.version !== null &&
    observed.version !== declared.version;
  const receiptDiffers =
    receipt !== undefined &&
    ((receipt.version !== null &&
      observed.version !== null &&
      receipt.version !== observed.version) ||
      (receipt.digest !== null && observed.digest !== null && receipt.digest !== observed.digest));

  return declaredVersionDiffers || receiptDiffers ? 'drifted' : 'installed';
}

/**
 * Map an {@link InstanceState} plus whether the integration is required onto
 * doctor's closed {@link DoctorStatus} (plan §1.3's table). `unverified`
 * never maps to `ok` — a probe that could not run is not evidence of health.
 */
export function toDoctorStatus(state: InstanceState, required: boolean): DoctorStatus {
  switch (state) {
    case 'installed':
    case 'not-applicable':
      return 'ok';
    case 'unverified':
    case 'orphaned':
      return 'warn';
    case 'pending-user-action':
    case 'missing':
    case 'drifted':
    case 'unsupported':
      return required ? 'fail' : 'warn';
    case 'rejected':
      return 'fail';
    default: {
      const exhaustive: never = state;
      throw new Error(`unreachable state: ${String(exhaustive)}`);
    }
  }
}
