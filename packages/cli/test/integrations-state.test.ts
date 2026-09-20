import { describe, expect, it } from 'vitest';
import {
  INSTANCE_STATES,
  REJECTED_REASONS,
  UNVERIFIED_REASONS,
  classify,
  toDoctorStatus,
  type DeclaredInput,
  type DoctorStatus,
  type InstanceState,
  type ObservedNow,
  type ReceiptBaseline,
} from '../src/integrations/state.js';

const accepted: DeclaredInput = { kind: 'accepted' };
const acceptedPinned: DeclaredInput = { kind: 'accepted', version: '1.0.0' };
const rejected: DeclaredInput = { kind: 'rejected', reason: 'not-in-matrix' };
const notDeclared: DeclaredInput = { kind: 'not-declared' };

const baseline: ReceiptBaseline = { version: '1.0.0', digest: 'abcdef1' };

const notObservedVariants: readonly Extract<ObservedNow, { present: false }>[] = [
  { present: false, kind: 'no-route' },
  { present: false, kind: 'not-applicable' },
  { present: false, kind: 'guided-pending' },
  { present: false, kind: 'unverifiable', reason: 'timeout' },
  { present: false, kind: 'missing' },
];

describe('classify', () => {
  it('a forged receipt claiming installed, with no observation, never classifies as installed, for every non-present observation', () => {
    for (const observed of notObservedVariants) {
      expect(classify(accepted, baseline, observed), observed.kind).not.toBe('installed');
    }
  });
});

type ClassifyCase = {
  name: string;
  declared: DeclaredInput;
  receipt: ReceiptBaseline | undefined;
  observed: ObservedNow;
  expected: InstanceState;
};

// A hand-written literal truth table — never produced by calling `classify`.
const CLASSIFY_TABLE: readonly ClassifyCase[] = [
  {
    name: 'rejected wins regardless of receipt or observation',
    declared: rejected,
    receipt: undefined,
    observed: { present: true, version: '1.0.0', digest: 'abcdef1' },
    expected: 'rejected',
  },
  {
    name: 'rejected wins even with a receipt and a present observation',
    declared: rejected,
    receipt: baseline,
    observed: { present: false, kind: 'missing' },
    expected: 'rejected',
  },
  {
    name: 'not declared, no receipt: not-applicable',
    declared: notDeclared,
    receipt: undefined,
    observed: { present: false, kind: 'missing' },
    expected: 'not-applicable',
  },
  {
    // Advisory: an incidental installation the repository never opted into
    // (no declaration, no receipt) is out of scope entirely, not evidence of
    // drift — a present observation cannot promote it into something more.
    name: 'not declared, no receipt, present observation: still not-applicable',
    declared: notDeclared,
    receipt: undefined,
    observed: { present: true, version: '1.0.0', digest: 'abcdef1' },
    expected: 'not-applicable',
  },
  {
    name: 'not declared, a receipt exists: orphaned',
    declared: notDeclared,
    receipt: baseline,
    observed: { present: false, kind: 'missing' },
    expected: 'orphaned',
  },
  {
    name: 'not declared with a receipt outranks even a present observation: still orphaned',
    declared: notDeclared,
    receipt: baseline,
    observed: { present: true, version: '1.0.0', digest: 'abcdef1' },
    expected: 'orphaned',
  },
  {
    name: 'accepted, no-route observed: unsupported',
    declared: accepted,
    receipt: undefined,
    observed: { present: false, kind: 'no-route' },
    expected: 'unsupported',
  },
  {
    name: 'accepted, not-applicable observed: not-applicable',
    declared: accepted,
    receipt: undefined,
    observed: { present: false, kind: 'not-applicable' },
    expected: 'not-applicable',
  },
  {
    name: 'accepted, guided-pending observed: pending-user-action',
    declared: accepted,
    receipt: undefined,
    observed: { present: false, kind: 'guided-pending' },
    expected: 'pending-user-action',
  },
  {
    name: 'accepted, unverifiable observed: unverified',
    declared: accepted,
    receipt: undefined,
    observed: { present: false, kind: 'unverifiable', reason: 'timeout' },
    expected: 'unverified',
  },
  {
    name: 'accepted, missing observed: missing',
    declared: accepted,
    receipt: undefined,
    observed: { present: false, kind: 'missing' },
    expected: 'missing',
  },
  {
    name: 'accepted, present observed, no receipt, no version pin: installed',
    declared: accepted,
    receipt: undefined,
    observed: { present: true, version: '1.0.0', digest: 'abcdef1' },
    expected: 'installed',
  },
  {
    name: 'accepted, present observed matching the receipt baseline: installed',
    declared: accepted,
    receipt: baseline,
    observed: { present: true, version: '1.0.0', digest: 'abcdef1' },
    expected: 'installed',
  },
  {
    name: 'accepted, present observed with a version mismatch against the receipt: drifted',
    declared: accepted,
    receipt: baseline,
    observed: { present: true, version: '2.0.0', digest: 'abcdef1' },
    expected: 'drifted',
  },
  {
    name: 'accepted, present observed with a digest mismatch against the receipt: drifted',
    declared: accepted,
    receipt: baseline,
    observed: { present: true, version: '1.0.0', digest: 'deadbee' },
    expected: 'drifted',
  },
  {
    name: 'accepted with a version pin, present observed matching the pin, no receipt: installed',
    declared: acceptedPinned,
    receipt: undefined,
    observed: { present: true, version: '1.0.0', digest: null },
    expected: 'installed',
  },
  {
    name: 'accepted with a version pin, present observed differing from the pin, no receipt: drifted',
    declared: acceptedPinned,
    receipt: undefined,
    observed: { present: true, version: '2.0.0', digest: null },
    expected: 'drifted',
  },
  {
    name: 'accepted, present observed, receipt with null version/digest (never compared): installed',
    declared: accepted,
    receipt: { version: null, digest: null },
    observed: { present: true, version: '1.0.0', digest: 'abcdef1' },
    expected: 'installed',
  },
  {
    // Advisory: a pin exists (a known baseline), but THIS probe could not
    // read a version from what it found present. Reporting "installed" would
    // be misplaced confidence, so this resolves to unverified instead of
    // silently trusting the pin.
    name: 'accepted with a version pin, present observed but version unreadable (null), no receipt: unverified',
    declared: acceptedPinned,
    receipt: undefined,
    observed: { present: true, version: null, digest: null },
    expected: 'unverified',
  },
  {
    // Same reasoning, from the RECEIPT side: no declared pin, but the receipt
    // itself recorded a known version baseline, and this probe cannot read
    // one now.
    name: 'accepted (no pin), receipt baseline has a known version, present observed but version unreadable (null): unverified',
    declared: accepted,
    receipt: { version: '1.0.0', digest: null },
    observed: { present: true, version: null, digest: null },
    expected: 'unverified',
  },
  {
    // No version baseline anywhere (declared has no pin, receipt's version is
    // null) — an unreadable observed version is not a confirmation failure
    // here, because nothing needed confirming. Falls through to the ordinary
    // digest-only comparison instead.
    name: 'accepted (no pin), receipt has no version baseline (null), present observed with unreadable version but matching digest: installed',
    declared: accepted,
    receipt: { version: null, digest: 'abcdef1' },
    observed: { present: true, version: null, digest: 'abcdef1' },
    expected: 'installed',
  },
];

describe('classify — every declared × receipt × observed combination per the table', () => {
  it.each(CLASSIFY_TABLE)('$name', ({ declared, receipt, observed, expected }) => {
    expect(classify(declared, receipt, observed)).toBe(expected);
  });
});

type DoctorCase = { state: InstanceState; required: boolean; expected: DoctorStatus };

// A hand-written literal table — never produced by calling `toDoctorStatus`.
const DOCTOR_TABLE: readonly DoctorCase[] = [
  { state: 'installed', required: true, expected: 'ok' },
  { state: 'installed', required: false, expected: 'ok' },
  { state: 'not-applicable', required: true, expected: 'ok' },
  { state: 'not-applicable', required: false, expected: 'ok' },
  { state: 'unverified', required: true, expected: 'warn' },
  { state: 'unverified', required: false, expected: 'warn' },
  { state: 'pending-user-action', required: true, expected: 'fail' },
  { state: 'pending-user-action', required: false, expected: 'warn' },
  { state: 'missing', required: true, expected: 'fail' },
  { state: 'missing', required: false, expected: 'warn' },
  { state: 'drifted', required: true, expected: 'fail' },
  { state: 'drifted', required: false, expected: 'warn' },
  { state: 'rejected', required: true, expected: 'fail' },
  { state: 'rejected', required: false, expected: 'fail' },
  { state: 'orphaned', required: true, expected: 'warn' },
  { state: 'orphaned', required: false, expected: 'warn' },
  { state: 'unsupported', required: true, expected: 'fail' },
  { state: 'unsupported', required: false, expected: 'warn' },
];

describe('toDoctorStatus — maps every state × required to ok, warn or fail per the contract, and never maps unverified to ok', () => {
  it.each(DOCTOR_TABLE)(
    '$state, required=$required -> $expected',
    ({ state, required, expected }) => {
      expect(toDoctorStatus(state, required)).toBe(expected);
    },
  );

  it('covers every InstanceState exactly twice (required true and false)', () => {
    expect(DOCTOR_TABLE).toHaveLength(INSTANCE_STATES.length * 2);
    for (const state of INSTANCE_STATES) {
      expect(DOCTOR_TABLE.filter((row) => row.state === state)).toHaveLength(2);
    }
  });

  it('never maps unverified to ok', () => {
    expect(toDoctorStatus('unverified', true)).not.toBe('ok');
    expect(toDoctorStatus('unverified', false)).not.toBe('ok');
  });
});

describe('closed vocabularies are runtime-immutable frozen arrays', () => {
  it('INSTANCE_STATES holds exactly the nine documented states', () => {
    expect([...INSTANCE_STATES]).toEqual([
      'installed',
      'drifted',
      'missing',
      'pending-user-action',
      'unverified',
      'unsupported',
      'not-applicable',
      'rejected',
      'orphaned',
    ]);
  });

  it('UNVERIFIED_REASONS holds exactly the five documented reasons', () => {
    expect([...UNVERIFIED_REASONS]).toEqual([
      'tool-absent',
      'tool-not-spawnable',
      'timeout',
      'output-unparseable',
      'no-sanctioned-probe',
    ]);
  });

  it('REJECTED_REASONS holds exactly the six documented reasons', () => {
    expect([...REJECTED_REASONS]).toEqual([
      'not-in-matrix',
      'unknown-license',
      'non-official-source',
      'arbitrary-command-refused',
      'exclusive-group-conflict',
      'unpinnable-version',
    ]);
  });

  it.each([
    ['INSTANCE_STATES', INSTANCE_STATES],
    ['UNVERIFIED_REASONS', UNVERIFIED_REASONS],
    ['REJECTED_REASONS', REJECTED_REASONS],
  ])('mutating %s throws', (_name, frozen) => {
    expect(() => {
      (frozen as string[]).push('x');
    }).toThrow();
  });
});
