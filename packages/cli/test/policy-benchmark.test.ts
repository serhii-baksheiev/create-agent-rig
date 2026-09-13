import { describe, expect, it } from 'vitest';
import {
  BENCHMARK_CORPUS,
  BENCHMARK_CLASSIFICATIONS,
  classifyCapability,
  parseBenchmarkCorpus,
} from '../src/policy/benchmark/corpus.js';

describe('the versioned policy benchmark corpus', () => {
  it('names every scenario whose mutation distinguishes working enforcement from a pass-shaped failure', () => {
    expect(BENCHMARK_CORPUS.contractMajor).toBe(1);
    expect(BENCHMARK_CORPUS.scenarios.map((scenario) => scenario.id)).toEqual(
      expect.arrayContaining([
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
      ]),
    );
    expect(new Set(BENCHMARK_CORPUS.scenarios.map((scenario) => scenario.id)).size).toBe(
      BENCHMARK_CORPUS.scenarios.length,
    );
  });

  it('accepts only its own corpus major, so scenarios from another contract cannot silently receive this verdict', () => {
    expect(parseBenchmarkCorpus(BENCHMARK_CORPUS)).toEqual(BENCHMARK_CORPUS);
    expect(() =>
      parseBenchmarkCorpus({
        ...BENCHMARK_CORPUS,
        contractMajor: BENCHMARK_CORPUS.contractMajor + 1,
      }),
    ).toThrow(/major|version|1/i);
  });

  it('keeps the canonical outcomes distinct for a working guard, a missing guard, a malformed integration, and an intentional matcher degradation', () => {
    expect(
      Object.fromEntries(
        BENCHMARK_CORPUS.scenarios.map((scenario) => [scenario.id, scenario.expectedStates]),
      ),
    ).toEqual({
      'real-wiring': ['SUPPORTED'],
      'unwired-enforcement': ['UNSUPPORTED'],
      'disabled-enforcement': ['UNSUPPORTED'],
      'narrowed-enforcement': ['DEGRADED'],
      'bypassed-enforcement': ['INTEGRATION-FAILED'],
      'unreadable-input': ['INTEGRATION-FAILED'],
      'hook-input': ['SUPPORTED'],
      'protected-rulebook': ['SUPPORTED'],
      widening: ['SUPPORTED'],
      'foreign-major': ['UNSUPPORTED'],
    });
  });

  it('states whether each scenario measures a capability, a guard decision, or a compatibility rejection, so supported rejection cannot read like supported enforcement', () => {
    expect(
      Object.fromEntries(
        BENCHMARK_CORPUS.scenarios.map((scenario) => [scenario.id, scenario.measurementKind]),
      ),
    ).toEqual({
      'real-wiring': 'capability-probe',
      'unwired-enforcement': 'capability-probe',
      'disabled-enforcement': 'capability-probe',
      'narrowed-enforcement': 'capability-probe',
      'bypassed-enforcement': 'capability-probe',
      'unreadable-input': 'capability-probe',
      'hook-input': 'guard-enforcement',
      'protected-rulebook': 'guard-enforcement',
      widening: 'guard-enforcement',
      'foreign-major': 'compatibility-rejection',
    });
  });
});

const mutableCorpus = () => ({
  contractMajor: BENCHMARK_CORPUS.contractMajor,
  scenarios: BENCHMARK_CORPUS.scenarios.map((scenario) => ({
    ...scenario,
    expectedStates: [...scenario.expectedStates],
  })),
});

describe('reading a benchmark corpus across a process boundary', () => {
  it('refuses a corpus that omits the scenario list, because a partial run cannot establish equivalence', () => {
    expect(() => parseBenchmarkCorpus({ contractMajor: 1 })).toThrow(/scenarios|corpus/i);
  });

  it('refuses an empty scenario list, because every required mutation must be measured', () => {
    expect(() => parseBenchmarkCorpus({ contractMajor: 1, scenarios: [] })).toThrow(
      /every required|scenario/i,
    );
  });

  it('refuses a duplicated scenario id, because two readings of one mutation cannot stand in for another', () => {
    const corpus = mutableCorpus();
    corpus.scenarios[1] = { ...corpus.scenarios[0]! };
    expect(() => parseBenchmarkCorpus(corpus)).toThrow(/duplicated|required/i);
  });

  it('refuses an unknown scenario id, instead of letting a caller substitute its own evidence obligation', () => {
    const corpus = mutableCorpus();
    corpus.scenarios[0] = { ...corpus.scenarios[0]!, id: 'invented-scenario' };
    expect(() => parseBenchmarkCorpus(corpus)).toThrow(/unknown scenario/i);
  });

  it('refuses a baseline that was weakened to accept unsupported capability', () => {
    const corpus = mutableCorpus();
    corpus.scenarios[0] = { ...corpus.scenarios[0]!, expectedStates: ['UNSUPPORTED'] };
    expect(() => parseBenchmarkCorpus(corpus)).toThrow(/expected capability states/i);
  });

  it.each(['prototype', 'accessor'])(
    'refuses a corpus carried through a %s field, because only serialisable own data can be benchmark evidence',
    (shape) => {
      const corpus = mutableCorpus();
      const uncarried =
        shape === 'prototype'
          ? Object.create(corpus)
          : Object.defineProperty({}, 'contractMajor', {
              enumerable: true,
              get: () => corpus.contractMajor,
            });
      if (shape === 'accessor') {
        Object.defineProperty(uncarried, 'scenarios', {
          enumerable: true,
          get: () => corpus.scenarios,
        });
      }
      expect(() => parseBenchmarkCorpus(uncarried)).toThrow(/plain|corpus|data/i);
    },
  );

  it('returns a copied frozen corpus, so mutating the caller input cannot change the measured scenarios afterwards', () => {
    const supplied = mutableCorpus();
    const parsed = parseBenchmarkCorpus(supplied);
    supplied.scenarios[0]!.expectedStates[0] = 'UNSUPPORTED';
    supplied.scenarios.push({ ...supplied.scenarios[0]!, id: 'duplicate-after-parse' });

    expect(parsed).toEqual(BENCHMARK_CORPUS);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.scenarios)).toBe(true);
    expect(Object.isFrozen(parsed.scenarios[0]!.expectedStates)).toBe(true);
  });
});

describe('classifying measured capability', () => {
  it('derives the closed benchmark classifications from CapabilityState without inventing a fourth answer', () => {
    expect(BENCHMARK_CLASSIFICATIONS).toEqual([
      'equivalent',
      'intentional-degradation',
      'unsupported',
    ]);
    expect(classifyCapability('SUPPORTED')).toEqual({
      classification: 'equivalent',
      integrationFailed: false,
    });
    expect(classifyCapability('DEGRADED')).toEqual({
      classification: 'intentional-degradation',
      integrationFailed: false,
    });
    expect(classifyCapability('UNSUPPORTED')).toEqual({
      classification: 'unsupported',
      integrationFailed: false,
    });
  });

  it('keeps an integration failure visible while classifying it as unsupported, so it can never be mistaken for working enforcement', () => {
    expect(classifyCapability('INTEGRATION-FAILED')).toEqual({
      classification: 'unsupported',
      integrationFailed: true,
    });
  });
});
