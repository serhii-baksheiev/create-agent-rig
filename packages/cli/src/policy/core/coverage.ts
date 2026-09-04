/**
 * The capability & degradation contract (RP-36): what each declared policy is
 * worth on one harness surface, how that answer is established, and how it is
 * maintained afterwards.
 *
 * ⚠ A LIBRARY, not a running contract. Nothing in this rig calls any of it
 * yet: `doctor` rendering the coverage report is its own task, and so is the
 * caller that would report observed traffic. The present tense below describes
 * what the functions do when called, not something happening today. The
 * rationale and the full list of what this deliberately does not do are in
 * `docs/decisions/capability-coverage.md`.
 *
 * A status is established by `./probe.ts` on an occasion named from
 * `./vocabulary.ts` (`PROBE_TRIGGERS`), and maintained from what real traffic
 * was expected to show and did not. Three rules follow, and they are the whole
 * design.
 *
 * 🔴 **A timer alone never degrades anything.** `observeExpectedSignal` takes
 * an OBSERVATION, never an elapsed time, and this module exports no function
 * that ages, expires or sweeps an entry — pinned by
 * `packages/cli/test/policy-coverage.test.ts` › "exports nothing that ages,
 * expires or sweeps an entry, so only an observation can move it", and
 * measured end-to-end by › "reports no downgrade when a year passes and the
 * same wiring is probed again, because elapsed time is not evidence" against
 * its positive control. No traffic is not a failure: it is no evidence.
 *
 * 🔴 **Traffic lowers a status; it never raises one.** A missing signal is
 * evidence the mechanism did not act. A present signal is evidence it acted
 * once — not that a wiring defect the probe found has been repaired. So the
 * only route back up is another probe: › "never raises a status on traffic: a
 * degraded surface stays degraded until a probe says otherwise".
 *
 * 🔴 **Traffic that CONTRADICTS the record is its own answer.** A signal
 * observed on a surface the map records as `UNSUPPORTED` is not a promotion
 * and not a miss — the wiring and the traffic disagree, which is what
 * `INTEGRATION-FAILED` names: › "a signal observed where the map says nothing
 * is wired is a contradiction, not a pass". It is still not a pass;
 * `qualifierFor` maps it to `UNVERIFIABLE`.
 *
 * **Why this module throws where its neighbours return a `Validation`.** The
 * line is what the value IS, not how bad it is: outside data read off a disk
 * becomes a RESULT — `snapshot: unknown` is never trusted and never throws, it
 * becomes `INTEGRATION-FAILED` — while a value the CALLER chose (a word from a
 * closed vocabulary, its own clock, its own claim about which build it saw) is
 * a programming error and throws. `./evidence-matrix.ts` sits on the first
 * side, this module's two entry points on the second.
 *
 * Two limits worth stating rather than leaving to be discovered. `DEGRADED`
 * carries no verdict qualifier, so an operation on precisely the tool a
 * degraded matcher lost gets an unqualified allow — the item scopes the
 * `UNVERIFIABLE` requirement to the unenforceable states. And a `reason`
 * supplied with a miss that does not cross the threshold is not retained;
 * only the miss that degrades records one — › "discards the reason given with
 * a miss that does not degrade, and records the one given with the miss that
 * does".
 */

import type { HarnessAdapter } from './adapter.js';
import type { PolicyDeclaration } from './declaration.js';
import { probePolicy } from './probe.js';
import { isExactVersion, ISO_8601 } from './validation.js';
import { PROBE_TRIGGERS, UNENFORCEABLE_STATES } from './vocabulary.js';
import type {
  CapabilityState,
  ProbeTrigger,
  VerdictQualifier,
  VerificationSource,
} from './vocabulary.js';

/**
 * How many consecutive expected-but-absent signals degrade a supported policy.
 *
 * Three, not one: a single miss is as easily an operation that never reached
 * the mechanism as a mechanism that failed to act, and a contract that
 * degrades on it reports noise. It is a DEFAULT and not a constant — every
 * caller may set its own, because what counts as enough evidence depends on
 * how much traffic the surface sees.
 */
export const DEFAULT_DEGRADATION_THRESHOLD = 3;

/**
 * Which concrete surface a coverage map describes.
 *
 * The version is exact, and that is now a check rather than an adjective:
 * `coverageFromProbe` refuses an identity whose `harnessVersion` names a range
 * or a moving target, reading the same `isExactVersion` that
 * `./evidence-matrix.ts` refuses a row on. Three documents called it exact
 * while nothing read it, and the shape they all missed was this one.
 */
export interface SurfaceIdentity {
  /** The adapter's own id for its harness. */
  harness: string;
  /** The surface within it — the file or channel whose wiring was read. */
  surface: string;
  /**
   * The exact version observed — refused at the door by `coverageFromProbe`
   * if it names a range or a moving target: › "refuses to probe against the
   * harness version %j, because a moving target names no build".
   */
  harnessVersion: string;
  os: string;
}

/** What one policy is worth on that surface, and on what evidence. */
export interface CoverageEntry {
  policyId: string;
  /** The declaration version the status was computed against. */
  policyVersion: string;
  /**
   * The enforcing mechanism, copied off the declaration when the map was
   * built. It travels on the entry rather than being looked up later: a
   * downgrade is what an operator acts on, and a lookup that can miss put an
   * EMPTY mechanism into exactly that report — › "names a mechanism for a
   * policy no registry carries, which is the branch that used to report an
   * empty one".
   */
  mechanism: string;
  status: CapabilityState;
  /** When the status was last established or confirmed; supplied by the caller. */
  verifiedAt: string;
  verifiedBy: VerificationSource;
  /** What occasioned the probe this entry descends from; traffic never changes it. */
  triggeredBy: ProbeTrigger;
  /** Consecutive observations in which the expected signal was absent. */
  consecutiveMisses: number;
  /** Why the status is not `SUPPORTED`; absent exactly when it is. */
  degradationReason?: string;
  evidencePointer?: string;
}

export interface CoverageMap {
  surface: SurfaceIdentity;
  entries: readonly CoverageEntry[];
}

/** One policy's status falling on one surface — what an operator has to see. */
export interface Downgrade {
  surface: SurfaceIdentity;
  policyId: string;
  from: CapabilityState;
  to: CapabilityState;
  mechanism: string;
  reason: string;
  at: string;
}

/**
 * How much a state can enforce, as an order, for deciding what counts as a
 * fall. `UNSUPPORTED` and `INTEGRATION-FAILED` rank together on purpose: both
 * mean the policy cannot be relied on here, they differ in whether anything is
 * wired at all, and calling a move between them a downgrade would report a
 * change of diagnosis as a loss of capability.
 *
 * This is a DISPLAY ordering and nothing else reads it. What qualifies a
 * verdict is `UNENFORCEABLE_STATES` in `./vocabulary.ts`, which
 * `./decision-record.ts` reads too — keying qualification off a rank would
 * mean a future re-rank silently changed which verdicts are UNVERIFIABLE.
 */
const ENFORCEMENT_RANK: Record<CapabilityState, number> = {
  SUPPORTED: 0,
  DEGRADED: 1,
  UNSUPPORTED: 2,
  'INTEGRATION-FAILED': 2,
};

const requireTimestamp = (field: string, value: string): void => {
  if (!ISO_8601.test(value)) {
    throw new Error(
      `${field} must be an ISO-8601 date-time with an explicit zone; got ${JSON.stringify(value)}`,
    );
  }
};

/**
 * The probe's answer for every policy, as one map.
 *
 * `trigger` is required, and that is the point: `PROBE_TRIGGERS` names only
 * changes to the surface, so a caller must say which change occasioned this
 * read and cannot name an interval. `at` is the caller's clock — nothing here
 * reads one — and it is validated, because a status whose time cannot be
 * ordered against a change is not auditable.
 */
export function coverageFromProbe(args: {
  surface: SurfaceIdentity;
  policies: readonly PolicyDeclaration[];
  adapter: HarnessAdapter;
  snapshot: unknown;
  at: string;
  trigger: ProbeTrigger;
  evidencePointer?: string;
}): CoverageMap {
  const { surface, policies, adapter, snapshot, at, trigger, evidencePointer } = args;
  if (!(PROBE_TRIGGERS as readonly string[]).includes(trigger)) {
    throw new Error(
      `a probe is occasioned by one of ${PROBE_TRIGGERS.join(', ')}; got ${JSON.stringify(trigger)}`,
    );
  }
  requireTimestamp('at', at);
  // The identity is the caller's claim about WHICH build was observed, and
  // three documents called it exact while nothing read it. A map is the shape
  // that carries it, so this is where it is refused.
  if (!isExactVersion(surface.harnessVersion)) {
    throw new Error(
      `surface.harnessVersion must name the exact version observed, not a range or a moving target; got ${JSON.stringify(surface.harnessVersion)}`,
    );
  }

  const entries = policies.map((policy) => {
    const result = probePolicy(policy, adapter, snapshot);
    const entry: CoverageEntry = {
      policyId: policy.policyId,
      policyVersion: policy.policyVersion,
      mechanism: policy.mechanism,
      status: result.state,
      verifiedAt: at,
      verifiedBy: 'probe',
      triggeredBy: trigger,
      consecutiveMisses: 0,
    };
    if (result.reason !== undefined) entry.degradationReason = result.reason;
    if (evidencePointer !== undefined) entry.evidencePointer = evidencePointer;
    return entry;
  });
  return { surface, entries };
}

/**
 * Fold one observation of real traffic into an entry.
 *
 * `seen` is the whole input: the operation the policy judges happened, and the
 * observable signal the mechanism should have produced either appeared or did
 * not. There is no parameter for "and this much time has passed", because time
 * is not evidence about a mechanism.
 */
export function observeExpectedSignal(
  entry: CoverageEntry,
  observation: { seen: boolean; at: string; threshold?: number; reason?: string },
): CoverageEntry {
  const { seen, at, threshold = DEFAULT_DEGRADATION_THRESHOLD, reason } = observation;
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new Error(
      `the degradation threshold must be a whole number of observations, at least 1; got ${String(threshold)}`,
    );
  }
  requireTimestamp('at', at);

  if (seen) {
    const next: CoverageEntry = {
      ...entry,
      consecutiveMisses: 0,
      verifiedAt: at,
      verifiedBy: 'traffic',
    };
    // A signal seen where the record says nothing is wired is not a promotion
    // and not a miss: the wiring and the traffic disagree, and that is the
    // state the item reserves for it. The status is not raised — see the
    // second rule in this file's header — so the only status this branch
    // produces is the one naming the contradiction.
    if (entry.status === 'UNSUPPORTED') {
      next.status = 'INTEGRATION-FAILED';
      next.degradationReason = `the expected signal was observed although the recorded status was UNSUPPORTED, so the wiring and the traffic disagree`;
    }
    return next;
  }

  const consecutiveMisses = entry.consecutiveMisses + 1;
  const degrades = entry.status === 'SUPPORTED' && consecutiveMisses >= threshold;
  const next: CoverageEntry = {
    ...entry,
    consecutiveMisses,
    verifiedAt: at,
    verifiedBy: 'traffic',
  };
  if (!degrades) return next;
  next.status = 'DEGRADED';
  next.degradationReason =
    reason ??
    `the expected observable signal was absent on ${String(consecutiveMisses)} consecutive operations`;
  return next;
}

/** The entry for one policy, or `null` — never an invented status. */
export function statusOf(map: CoverageMap, policyId: string): CoverageEntry | null {
  return map.entries.find((entry) => entry.policyId === policyId) ?? null;
}

/**
 * The qualifier a verdict must carry when it was produced under this state.
 *
 * The unenforceable states mean the question could not be put to a working
 * mechanism, so an `allow` under either is UNVERIFIABLE rather than a pass —
 * `./decision-record.ts` refuses the unqualified record, and
 * `packages/cli/test/policy-coverage.test.ts` › "refuses the silent pass an
 * unwired surface would otherwise produce, and accepts it once qualifierFor
 * speaks" holds the two modules to it together.
 */
export function qualifierFor(state: CapabilityState): VerdictQualifier | undefined {
  return (UNENFORCEABLE_STATES as readonly CapabilityState[]).includes(state)
    ? 'UNVERIFIABLE'
    : undefined;
}

/**
 * Every policy whose status fell between two maps of the same surface.
 *
 * Only policies present in both are compared: an entry that appeared or
 * vanished is a change of what is being measured, not a capability that fell.
 * Two maps of DIFFERENT surfaces are refused rather than diffed — the result
 * is attributed to one surface identity, and attributing one surface's fall to
 * another is a report an operator would act on in the wrong place.
 */
export function downgradesBetween(before: CoverageMap, after: CoverageMap): Downgrade[] {
  // Deliberately NOT harnessVersion. A probe before and after an upgrade
  // carries two versions of one surface, and that pair is exactly what the
  // `upgrade` trigger exists to compare — refusing it disabled the comparison
  // for the case it was added for. Harness, surface and OS are what make it
  // the same place.
  const sameSurface =
    before.surface.harness === after.surface.harness &&
    before.surface.surface === after.surface.surface &&
    before.surface.os === after.surface.os;
  if (!sameSurface) {
    throw new Error(
      'two coverage maps of different surfaces cannot be compared: a downgrade is attributed to one surface, and these name two',
    );
  }

  const downgrades: Downgrade[] = [];
  for (const next of after.entries) {
    const previous = statusOf(before, next.policyId);
    if (previous === null) continue;
    if (ENFORCEMENT_RANK[next.status] <= ENFORCEMENT_RANK[previous.status]) continue;
    downgrades.push({
      surface: after.surface,
      policyId: next.policyId,
      from: previous.status,
      to: next.status,
      mechanism: next.mechanism,
      reason: next.degradationReason ?? 'the entry recorded no reason',
      at: next.verifiedAt,
    });
  }
  return downgrades;
}
