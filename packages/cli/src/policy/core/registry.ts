/**
 * The policy registry (RP-76): the declarations of the policies this rig
 * enforces, and the compatibility rule a decision record is read against.
 *
 * The three entries are the guards the rulebook already ships; declaring them
 * changes nothing about how they run. Each field below was read off the
 * guard's own header and its tests rather than inferred from its name, and the
 * correspondence between a declaration and the hook wiring both harnesses
 * carry is pinned in `test/template/policy-declaration.test.ts` › "every
 * registered policy is wired in the %s snapshot under its event, matcher and
 * hook path". Which hook file a mechanism name resolves to is the adapter's
 * business (`../harness/`), not this file's.
 */

import { definePolicy } from './declaration.js';
import type { PolicyDeclaration } from './declaration.js';
import { POLICY_VERSION } from './declaration.js';

const NEVER_TIER = 'rules/autonomy.md#never';

/**
 * What the three share, stated once: each is a pre-operation hook of the
 * Never tier that can allow, block, or refuse to inspect; each fails open on
 * its own error and closed on input it can see but cannot read
 * (`rules/invariants.md`, "Fail closed on a match, fail open on an error" and
 * "Refusing to inspect is a third outcome"). The one evidence every outcome
 * carries is the exit code; a refusal also prints a diagnostic line, an allow
 * prints nothing, so `diagnostic-text` is not required of every record.
 */
const guard = (
  declaration: Pick<
    PolicyDeclaration,
    'policyId' | 'invariant' | 'operations' | 'mechanism' | 'redaction'
  >,
): PolicyDeclaration =>
  definePolicy({
    policyVersion: '1.0',
    lifecycle: 'active',
    tier: 'never',
    timing: 'before-operation',
    requiredCapability: 'pre-operation-hook',
    outcomes: ['allow', 'block', 'refuse-to-inspect'],
    onInternalError: 'fail-open',
    onUnreadableInput: 'fail-closed',
    requiredEvidence: ['exit-code'],
    statedIn: NEVER_TIER,
    ...declaration,
  });

/**
 * Secret-write refusal. The guard refuses an edit that names a credential file
 * or carries a credential value; the value arm never prints what it matched —
 * `test/template/guard-secret-file.test.ts` › "never prints the credential it
 * found, nor a fragment of it" — which is what `omit-matched-values` records.
 */
const secretWriteRefusal = guard({
  policyId: 'secret-write-refusal',
  invariant: 'A credential never enters the repository through an edit.',
  operations: ['file-edit'],
  mechanism: 'guard-secret-file',
  redaction: 'omit-matched-values',
});

/**
 * No-verify refusal. The guard refuses a shell command that bypasses the
 * pre-commit gate — `test/template/shell-tools.test.ts` › "refuses a
 * pre-commit bypass through %s" pins the block on every shell tool. The
 * refuse-to-inspect outcome and the fail-open on an unparseable payload are
 * `test/template/hook-command-shape.test.ts` › "%s does not tell the caller to
 * split and retry" and › "allows a malformed payload it cannot parse at all".
 * ⚠ One limit of `onInternalError: 'fail-open'` for this guard: it has no
 * try/catch, so an internal throw exits 1, which the harness reads as allow —
 * a property of the harness that no test here pins.
 */
const noVerifyRefusal = guard({
  policyId: 'no-verify-refusal',
  invariant: 'The pre-commit gate is never bypassed.',
  operations: ['shell-command'],
  mechanism: 'block-no-verify',
  redaction: 'none',
});

/**
 * Rulebook-mutation restriction. In an unattended run the guard refuses an
 * edit under a rulebook prefix outside the current item's allow-list; in an
 * attended session it does nothing — `test/template/guard-rulebook.test.ts` ›
 * "blocks an edit to a rulebook path the allow-list does not name" and ›
 * "allows a hook edit when no unattended flag exists".
 */
const rulebookMutationRestriction = guard({
  policyId: 'rulebook-mutation-restriction',
  invariant:
    "In an unattended run, the rulebook is never edited outside the current item's allow-list.",
  operations: ['file-edit'],
  mechanism: 'guard-rulebook',
  redaction: 'none',
});

/** Every declared policy, in declaration order. */
export const POLICIES: readonly PolicyDeclaration[] = Object.freeze([
  secretWriteRefusal,
  noVerifyRefusal,
  rulebookMutationRestriction,
]);

export function findPolicy(policyId: string): PolicyDeclaration | null {
  return POLICIES.find((policy) => policy.policyId === policyId) ?? null;
}

export function policyIds(): string[] {
  return POLICIES.map((policy) => policy.policyId);
}

/** The policies the registry still offers — everything not retired. */
export function activePolicies(): PolicyDeclaration[] {
  return POLICIES.filter((policy) => policy.lifecycle !== 'retired');
}

export type Compatibility = 'compatible' | 'incompatible' | 'unknown-policy' | 'malformed-version';

const majorOf = (version: string): number => Number(version.split('.')[0]);

/**
 * Can a decision record naming `policyVersion` be read against the registered
 * policy? Same MAJOR: yes, whatever the MINOR — a MINOR bump is additive.
 * Different MAJOR: no, the semantics that produced the verdict are not these.
 * A version that is not `MAJOR.MINOR` is refused as malformed rather than
 * parsed for a MAJOR it might have meant.
 */
export function compatibilityOf(policyId: string, policyVersion: string): Compatibility {
  const policy = findPolicy(policyId);
  if (policy === null) return 'unknown-policy';
  if (!POLICY_VERSION.test(policyVersion)) return 'malformed-version';
  return majorOf(policyVersion) === majorOf(policy.policyVersion) ? 'compatible' : 'incompatible';
}
