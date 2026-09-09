import { CAPABILITY_STATES, type CapabilityState } from '../core/vocabulary.js';

export const BENCHMARK_CLASSIFICATIONS = Object.freeze([
  'equivalent',
  'intentional-degradation',
  'unsupported',
] as const);

export type BenchmarkClassification = (typeof BENCHMARK_CLASSIFICATIONS)[number];

const MEASUREMENT_KINDS = Object.freeze([
  'capability-probe',
  'guard-enforcement',
  'compatibility-rejection',
] as const);
type MeasurementKind = (typeof MEASUREMENT_KINDS)[number];

export interface BenchmarkScenario {
  readonly id: string;
  readonly fixture: string;
  readonly mutation: string;
  readonly action: string;
  readonly measurementKind: MeasurementKind;
  readonly expectedStates: readonly CapabilityState[];
}

export interface BenchmarkCorpus {
  readonly contractMajor: 1;
  readonly scenarios: readonly BenchmarkScenario[];
}

const REQUIRED_SCENARIO_IDS = [
  'real-wiring',
  'unwired-enforcement',
  'disabled-enforcement',
  'narrowed-enforcement',
  'bypassed-enforcement',
  'unreadable-input',
  'hook-input',
  'protected-rulebook',
  'widening',
  'foreign-major',
] as const;

const requiredScenarioIds = new Set<string>(REQUIRED_SCENARIO_IDS);

const scenario = (
  id: (typeof REQUIRED_SCENARIO_IDS)[number],
  fixture: string,
  mutation: string,
  action: string,
  measurementKind: MeasurementKind,
  expectedStates: readonly CapabilityState[],
): BenchmarkScenario =>
  Object.freeze({
    id,
    fixture,
    mutation,
    action,
    measurementKind,
    expectedStates: Object.freeze([...expectedStates]),
  });

export const BENCHMARK_CORPUS: BenchmarkCorpus = Object.freeze({
  contractMajor: 1,
  scenarios: Object.freeze([
    scenario(
      'real-wiring',
      'universal-rig',
      'none',
      'exercise protected write',
      'capability-probe',
      ['SUPPORTED'],
    ),
    scenario(
      'unwired-enforcement',
      'universal-rig',
      'remove hook registration',
      'exercise protected write',
      'capability-probe',
      ['UNSUPPORTED'],
    ),
    scenario(
      'disabled-enforcement',
      'universal-rig',
      'disable all hooks',
      'exercise protected write',
      'capability-probe',
      ['UNSUPPORTED'],
    ),
    scenario(
      'narrowed-enforcement',
      'universal-rig',
      'narrow matcher',
      'exercise omitted protected write',
      'capability-probe',
      ['DEGRADED'],
    ),
    scenario(
      'bypassed-enforcement',
      'universal-rig',
      'bypass guard command',
      'exercise protected write',
      'capability-probe',
      ['INTEGRATION-FAILED'],
    ),
    scenario(
      'unreadable-input',
      'universal-rig',
      'make snapshot unreadable',
      'exercise protected write',
      'capability-probe',
      ['INTEGRATION-FAILED'],
    ),
    scenario(
      'hook-input',
      'universal-rig',
      'make tool_input unreadable',
      'exercise protected write',
      'guard-enforcement',
      ['SUPPORTED'],
    ),
    scenario(
      'protected-rulebook',
      'universal-rig',
      'none',
      'edit protected rulebook',
      'guard-enforcement',
      ['SUPPORTED'],
    ),
    scenario(
      'widening',
      'universal-rig',
      'widen authorization allow-list',
      'attempt unauthorized widening',
      'guard-enforcement',
      ['SUPPORTED'],
    ),
    scenario(
      'foreign-major',
      'contracts/session-messaging/v1/fixtures/negative/envelope-foreign-major.json',
      'foreign schema major',
      'check policy compatibility',
      'compatibility-rejection',
      ['UNSUPPORTED'],
    ),
  ]),
});

const canonicalScenarios = new Map(BENCHMARK_CORPUS.scenarios.map((entry) => [entry.id, entry]));

export const classifyCapability = (
  state: CapabilityState,
): { classification: BenchmarkClassification; integrationFailed: boolean } => {
  switch (state) {
    case 'SUPPORTED':
      return { classification: 'equivalent', integrationFailed: false };
    case 'DEGRADED':
      return { classification: 'intentional-degradation', integrationFailed: false };
    case 'UNSUPPORTED':
      return { classification: 'unsupported', integrationFailed: false };
    case 'INTEGRATION-FAILED':
      return { classification: 'unsupported', integrationFailed: true };
    default:
      throw new Error(`Unknown capability state: ${String(state)}`);
  }
};

const isOwnDataRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => descriptor.enumerable === true && 'value' in descriptor,
  );
};

const isDataArray = (value: unknown): value is unknown[] => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || descriptor.enumerable !== true || !('value' in descriptor))
      return false;
  }
  return true;
};

const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};

const nonBlank = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

const invalidCorpus = (reason: string): never => {
  throw new Error(`Invalid benchmark corpus: ${reason}`);
};

export const parseBenchmarkCorpus = (input: unknown): BenchmarkCorpus => {
  if (!isOwnDataRecord(input) || !hasOnlyKeys(input, ['contractMajor', 'scenarios'])) {
    return invalidCorpus('must be a plain corpus with contractMajor and scenarios');
  }
  if (input.contractMajor !== 1) return invalidCorpus('unsupported contract major; expected 1');
  if (!isDataArray(input.scenarios)) return invalidCorpus('scenarios must be a data array');
  if (input.scenarios.length !== REQUIRED_SCENARIO_IDS.length) {
    return invalidCorpus('must include every required scenario exactly once');
  }

  const ids = new Set<string>();
  const scenarios: BenchmarkScenario[] = [];
  for (const value of input.scenarios) {
    if (
      !isOwnDataRecord(value) ||
      !hasOnlyKeys(value, [
        'id',
        'fixture',
        'mutation',
        'action',
        'measurementKind',
        'expectedStates',
      ])
    ) {
      return invalidCorpus(
        'each scenario must have only id, fixture, mutation, action, measurementKind, and expectedStates',
      );
    }
    const { id, fixture, mutation, action, measurementKind, expectedStates } = value;
    if (!nonBlank(id) || !requiredScenarioIds.has(id))
      return invalidCorpus(`unknown scenario ${String(id)}`);
    if (ids.has(id)) return invalidCorpus(`scenario ${id} is duplicated`);
    if (!nonBlank(fixture) || !nonBlank(mutation) || !nonBlank(action)) {
      return invalidCorpus(`scenario ${id} has empty metadata`);
    }
    if (
      typeof measurementKind !== 'string' ||
      !(MEASUREMENT_KINDS as readonly string[]).includes(measurementKind)
    ) {
      return invalidCorpus(`scenario ${id} has an unknown measurement kind`);
    }
    if (!isDataArray(expectedStates) || expectedStates.length === 0) {
      return invalidCorpus(`scenario ${id} must name expected capability states`);
    }
    const states = new Set<CapabilityState>();
    for (const expectedState of expectedStates) {
      if (
        typeof expectedState !== 'string' ||
        !(CAPABILITY_STATES as readonly string[]).includes(expectedState)
      ) {
        return invalidCorpus(`scenario ${id} has an unknown capability state`);
      }
      if (states.has(expectedState as CapabilityState))
        return invalidCorpus(`scenario ${id} repeats a capability state`);
      states.add(expectedState as CapabilityState);
    }
    const canonical = canonicalScenarios.get(id)!;
    if (
      fixture !== canonical.fixture ||
      mutation !== canonical.mutation ||
      action !== canonical.action ||
      measurementKind !== canonical.measurementKind
    ) {
      return invalidCorpus(`scenario ${id} changes its canonical metadata`);
    }
    if (
      expectedStates.length !== canonical.expectedStates.length ||
      expectedStates.some((state, index) => state !== canonical.expectedStates[index])
    ) {
      return invalidCorpus(`scenario ${id} changes its expected capability states`);
    }
    ids.add(id);
    scenarios.push(
      Object.freeze({
        id,
        fixture,
        mutation,
        action,
        measurementKind: measurementKind as MeasurementKind,
        expectedStates: Object.freeze([...states]),
      }),
    );
  }
  for (const id of REQUIRED_SCENARIO_IDS) {
    if (!ids.has(id)) return invalidCorpus(`required scenario ${id} is missing`);
  }
  return Object.freeze({ contractMajor: 1, scenarios: Object.freeze(scenarios) });
};
