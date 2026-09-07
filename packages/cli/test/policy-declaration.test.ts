import { describe, expect, it } from 'vitest';
import {
  AUTONOMY_TIERS,
  CAPABILITY_STATES,
  DECISION_OUTCOMES,
  DECISION_RECORD_SCHEMA_VERSION,
  ENFORCEMENT_TIMINGS,
  EVIDENCE_KINDS,
  FAILURE_SEMANTICS,
  HARNESS_ADAPTERS,
  HARNESS_CAPABILITIES,
  LIFECYCLE_STATES,
  OPERATIONS,
  POLICIES,
  REDACTION_RULES,
  VERDICT_QUALIFIERS,
  activePolicies,
  claudeAdapter,
  codexAdapter,
  compatibilityOf,
  definePolicy,
  findPolicy,
  policyIds,
  validateDeclaration,
  validateDecisionRecord,
  type DecisionRecord,
  type PolicyDeclaration,
  type Problem,
} from '../src/policy/index.js';

/**
 * RP-76: a typed declaration in code becomes the semantic source of the rig's
 * policies — NOT an IR, no policy language, no interpreter. The core carries
 * closed vocabularies, a declaration shape with a validator, a registry of the
 * three policies the hooks already enforce (secret-write refusal, no-verify
 * refusal, rulebook-mutation restriction), a compatibility rule over
 * `policyVersion`, and a decision-record schema whose validator refuses the
 * silent-pass shapes (an unsupported harness that reports `allow` with no
 * `UNVERIFIABLE` qualifier — the capability states are the closed vocabulary
 * `CAPABILITY_STATES` defines).
 * Per-harness adapters turn a declaration into that harness's native hook
 * surface; the core never learns a harness's name.
 *
 * The refusal tests below each name the field the validator must report, so
 * a validator that "passes" by returning `ok: false` with an unrelated problem
 * still goes red. The template-side correspondence and mutation tests live in
 * `test/template/policy-declaration.test.ts`.
 */

const validDeclaration = (): PolicyDeclaration => ({
  policyId: 'example-policy',
  policyVersion: '1.0',
  lifecycle: 'active',
  invariant: 'An example never happens in the example directory.',
  tier: 'never',
  operations: ['file-edit'],
  timing: 'before-operation',
  requiredCapability: 'pre-operation-hook',
  mechanism: 'guard-example',
  outcomes: ['allow', 'block', 'refuse-to-inspect'],
  onInternalError: 'fail-open',
  onUnreadableInput: 'fail-closed',
  requiredEvidence: ['exit-code'],
  redaction: 'none',
  statedIn: 'rules/autonomy.md#never',
});

const declarationWith = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  ...validDeclaration(),
  ...overrides,
});

const problemsOfDeclaration = (input: unknown): Problem[] => {
  const result = validateDeclaration(input);
  expect(result.ok, 'expected the declaration to be refused').toBe(false);
  return result.ok ? [] : result.problems;
};

const fieldsOf = (problems: Problem[]): string[] => problems.map((p) => p.field);

describe('the vocabularies are closed', () => {
  const VOCABULARIES: Array<[string, readonly string[], readonly string[]]> = [
    [
      'capability states',
      CAPABILITY_STATES,
      ['SUPPORTED', 'DEGRADED', 'UNSUPPORTED', 'INTEGRATION-FAILED'],
    ],
    ['autonomy tiers', AUTONOMY_TIERS, ['tier-0', 'tier-1', 'tier-2', 'never']],
    ['operations', OPERATIONS, ['file-edit', 'shell-command']],
    ['enforcement timings', ENFORCEMENT_TIMINGS, ['before-operation']],
    ['harness capabilities', HARNESS_CAPABILITIES, ['pre-operation-hook']],
    ['decision outcomes', DECISION_OUTCOMES, ['allow', 'block', 'refuse-to-inspect']],
    ['failure semantics', FAILURE_SEMANTICS, ['fail-open', 'fail-closed']],
    ['evidence kinds', EVIDENCE_KINDS, ['exit-code', 'diagnostic-text', 'test-pointer']],
    ['redaction rules', REDACTION_RULES, ['none', 'omit-matched-values']],
    ['lifecycle states', LIFECYCLE_STATES, ['active', 'deprecated', 'retired']],
    ['verdict qualifiers', VERDICT_QUALIFIERS, ['UNVERIFIABLE', 'UNMEASURED']],
  ];

  it.each(VOCABULARIES)('%s is frozen, so no caller can widen it at runtime', (_name, list) => {
    expect(Object.isFrozen(list)).toBe(true);
  });

  it.each(VOCABULARIES)('%s is non-empty and duplicate-free', (_name, list) => {
    expect(list.length).toBeGreaterThan(0);
    expect(new Set(list).size).toBe(list.length);
  });

  it.each(VOCABULARIES)(
    '%s names exactly the values the declaration may use',
    (_name, list, expected) => {
      expect([...list]).toEqual(expected);
    },
  );
});

describe('validating a declaration', () => {
  it('accepts a complete declaration and hands back the same value', () => {
    const input = validDeclaration();
    const result = validateDeclaration(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(input);
  });

  it.each([null, undefined, 'a string', 42, ['an', 'array']])(
    'refuses %s because a declaration is an object',
    (input) => {
      expect(validateDeclaration(input).ok).toBe(false);
    },
  );

  it('refuses a declaration with a field missing and names that field', () => {
    const input = declarationWith({});
    delete input.invariant;
    expect(fieldsOf(problemsOfDeclaration(input))).toContain('invariant');
  });

  it('refuses an unknown extra key, because the shape is closed', () => {
    const input = declarationWith({ severity: 'high' });
    expect(fieldsOf(problemsOfDeclaration(input))).toContain('severity');
  });

  const ENUM_FIELDS: Array<[string, unknown, string]> = [
    ['lifecycle', 'zombie', 'zombie'],
    ['tier', 'tier-9', 'tier-9'],
    ['timing', 'after-operation', 'after-operation'],
    ['requiredCapability', 'telepathy', 'telepathy'],
    ['onInternalError', 'fail-sideways', 'fail-sideways'],
    ['onUnreadableInput', 'fail-sideways', 'fail-sideways'],
    ['redaction', 'blur', 'blur'],
    ['operations', ['file-edit', 'network-call'], 'network-call'],
    ['outcomes', ['allow', 'warn'], 'warn'],
    ['requiredEvidence', ['screenshot'], 'screenshot'],
  ];

  it.each(ENUM_FIELDS)(
    'refuses a %s outside the vocabulary and quotes the offending value',
    (field, value, offending) => {
      const problems = problemsOfDeclaration(declarationWith({ [field]: value }));
      const named = problems.filter((p) => p.field === field);
      expect(named.length, `no problem names the field ${field}`).toBeGreaterThan(0);
      expect(named.some((p) => p.message.includes(offending))).toBe(true);
    },
  );

  it.each(['1', '1.0.0', 'v1.0', '-1.0', '1.x', ''])(
    'refuses the malformed policyVersion %j (MAJOR.MINOR only)',
    (version) => {
      expect(
        fieldsOf(problemsOfDeclaration(declarationWith({ policyVersion: version }))),
      ).toContain('policyVersion');
    },
  );

  it.each(['Secret_Write', '1-starts-with-digit', 'has space', ''])(
    'refuses the policyId %j, which is not kebab-case',
    (policyId) => {
      expect(fieldsOf(problemsOfDeclaration(declarationWith({ policyId })))).toContain('policyId');
    },
  );

  it('refuses an empty operations list', () => {
    expect(fieldsOf(problemsOfDeclaration(declarationWith({ operations: [] })))).toContain(
      'operations',
    );
  });

  it('refuses an empty outcomes list', () => {
    expect(fieldsOf(problemsOfDeclaration(declarationWith({ outcomes: [] })))).toContain(
      'outcomes',
    );
  });

  it('accepts an empty requiredEvidence list', () => {
    expect(validateDeclaration(declarationWith({ requiredEvidence: [] })).ok).toBe(true);
  });

  it('refuses a duplicated operation', () => {
    expect(
      fieldsOf(problemsOfDeclaration(declarationWith({ operations: ['file-edit', 'file-edit'] }))),
    ).toContain('operations');
  });

  it('refuses a duplicated outcome', () => {
    expect(
      fieldsOf(problemsOfDeclaration(declarationWith({ outcomes: ['allow', 'block', 'allow'] }))),
    ).toContain('outcomes');
  });

  it('refuses a duplicated evidence kind', () => {
    expect(
      fieldsOf(
        problemsOfDeclaration(declarationWith({ requiredEvidence: ['exit-code', 'exit-code'] })),
      ),
    ).toContain('requiredEvidence');
  });

  it.each(['invariant', 'mechanism', 'statedIn'])('refuses an empty %s', (field) => {
    expect(fieldsOf(problemsOfDeclaration(declarationWith({ [field]: '' })))).toContain(field);
  });

  it('reports every problem at once rather than stopping at the first', () => {
    const problems = problemsOfDeclaration(
      declarationWith({ lifecycle: 'zombie', policyVersion: 'x', operations: [] }),
    );
    const fields = fieldsOf(problems);
    expect(fields).toContain('lifecycle');
    expect(fields).toContain('policyVersion');
    expect(fields).toContain('operations');
  });
});

describe('defining a policy', () => {
  it('returns a frozen copy of a valid declaration', () => {
    const input = validDeclaration();
    const policy = definePolicy(input);
    expect(policy).toEqual(input);
    expect(policy).not.toBe(input);
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it('throws on an invalid declaration and lists every problem as `field: message`', () => {
    const invalid = declarationWith({ lifecycle: 'zombie', policyVersion: 'x' });
    // the cast is the point: definePolicy is typed to accept a declaration, and
    // the test hands it one that lies about its shape
    const call = () => definePolicy(invalid as unknown as PolicyDeclaration);
    expect(call).toThrow(Error);
    expect(call).toThrow(/lifecycle: .*zombie/);
    expect(call).toThrow(/policyVersion: /);
  });
});

describe('the registry', () => {
  const REGISTERED = ['secret-write-refusal', 'no-verify-refusal', 'rulebook-mutation-restriction'];

  it('registers exactly the three guards the hooks already enforce, in that order', () => {
    expect(policyIds()).toEqual(REGISTERED);
    expect(POLICIES.map((p) => p.policyId)).toEqual(REGISTERED);
  });

  it.each(REGISTERED)('%s passes the declaration validator', (policyId) => {
    const policy = findPolicy(policyId);
    expect(policy).not.toBeNull();
    const result = validateDeclaration(policy);
    expect(result.ok, result.ok ? '' : JSON.stringify(result.problems)).toBe(true);
  });

  it.each(REGISTERED)(
    '%s is an active 1.0 Never-tier policy enforced before the operation by a pre-operation hook',
    (policyId) => {
      const policy = findPolicy(policyId);
      expect(policy).toMatchObject({
        lifecycle: 'active',
        policyVersion: '1.0',
        tier: 'never',
        timing: 'before-operation',
        requiredCapability: 'pre-operation-hook',
        onInternalError: 'fail-open',
        onUnreadableInput: 'fail-closed',
      });
    },
  );

  it.each(REGISTERED)('%s can allow, block, or refuse to inspect', (policyId) => {
    const outcomes = findPolicy(policyId)?.outcomes ?? [];
    expect(outcomes).toEqual(expect.arrayContaining(['allow', 'block', 'refuse-to-inspect']));
  });

  // Exit code only: an allow prints no diagnostic line, so requiring one would
  // make every allow verdict unrecordable.
  it.each(REGISTERED)(
    '%s requires an exit code as evidence, and nothing an allow lacks',
    (policyId) => {
      const evidence = findPolicy(policyId)?.requiredEvidence ?? [];
      expect(evidence).toEqual(['exit-code']);
    },
  );

  it('the secret-write refusal is guard-secret-file over file edits with matched values redacted', () => {
    expect(findPolicy('secret-write-refusal')).toMatchObject({
      mechanism: 'guard-secret-file',
      operations: ['file-edit'],
      redaction: 'omit-matched-values',
    });
  });

  it('the no-verify refusal is block-no-verify over shell commands with nothing to redact', () => {
    expect(findPolicy('no-verify-refusal')).toMatchObject({
      mechanism: 'block-no-verify',
      operations: ['shell-command'],
      redaction: 'none',
    });
  });

  it('the rulebook-mutation restriction is guard-rulebook over file edits with nothing to redact', () => {
    expect(findPolicy('rulebook-mutation-restriction')).toMatchObject({
      mechanism: 'guard-rulebook',
      operations: ['file-edit'],
      redaction: 'none',
    });
  });

  it('answers null for a policy id it does not know', () => {
    expect(findPolicy('no-such-policy')).toBeNull();
  });

  it('lists every registered policy as active while none is retired', () => {
    expect(activePolicies().map((p) => p.policyId)).toEqual(REGISTERED);
    expect(activePolicies().every((p) => p.lifecycle !== 'retired')).toBe(true);
  });

  it('treats a version with the same MAJOR as compatible, whatever the MINOR', () => {
    expect(compatibilityOf('secret-write-refusal', '1.0')).toBe('compatible');
    expect(compatibilityOf('secret-write-refusal', '1.7')).toBe('compatible');
  });

  it('treats a version with a different MAJOR as incompatible', () => {
    expect(compatibilityOf('secret-write-refusal', '2.0')).toBe('incompatible');
    expect(compatibilityOf('secret-write-refusal', '0.9')).toBe('incompatible');
  });

  it('says unknown-policy for an id it does not register', () => {
    expect(compatibilityOf('no-such-policy', '1.0')).toBe('unknown-policy');
  });

  it.each(['1', '1.0.0', 'v1.0', ''])(
    'says malformed-version for %j instead of guessing a MAJOR',
    (version) => {
      expect(compatibilityOf('secret-write-refusal', version)).toBe('malformed-version');
    },
  );
});

describe('validating a decision record', () => {
  const validRecord = (): DecisionRecord => ({
    schemaVersion: 1,
    policyId: 'secret-write-refusal',
    policyVersion: '1.0',
    harness: 'test-harness',
    operation: 'file-edit',
    capabilityState: 'SUPPORTED',
    observedFacts: [{ name: 'file_path', value: '.env' }],
    verdict: { outcome: 'block', reason: 'the path names a credential file' },
    evidence: [
      { kind: 'exit-code', value: '2' },
      { kind: 'diagnostic-text', value: 'guard-secret-file: refused .env' },
      {
        kind: 'test-pointer',
        value: 'guard-secret-file.test.ts › "refuses a credential file by name"',
      },
    ],
    artifactVersion: '0.7.1',
    diagnostics: { redacted: true, text: 'refused .env (values omitted)' },
    recordedAt: '2026-09-02T10:00:00.000Z',
  });

  const recordWith = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    ...validRecord(),
    ...overrides,
  });

  const problemsOfRecord = (input: unknown): Problem[] => {
    const result = validateDecisionRecord(input);
    expect(result.ok, 'expected the record to be refused').toBe(false);
    return result.ok ? [] : result.problems;
  };

  it('pins the schema version at 1', () => {
    expect(DECISION_RECORD_SCHEMA_VERSION).toBe(1);
  });

  it('accepts a complete record for the secret-write refusal and hands back the same value', () => {
    const input = validRecord();
    const result = validateDecisionRecord(input);
    expect(result.ok, result.ok ? '' : JSON.stringify(result.problems)).toBe(true);
    if (result.ok) expect(result.value).toEqual(input);
  });

  it('refuses an unknown extra key, because the shape is closed', () => {
    expect(fieldsOf(problemsOfRecord(recordWith({ note: 'extra' })))).toContain('note');
  });

  it('refuses a schemaVersion other than 1', () => {
    expect(fieldsOf(problemsOfRecord(recordWith({ schemaVersion: 2 })))).toContain('schemaVersion');
  });

  it('refuses a policyId the registry does not know', () => {
    expect(fieldsOf(problemsOfRecord(recordWith({ policyId: 'no-such-policy' })))).toContain(
      'policyId',
    );
  });

  it('refuses a policyVersion whose MAJOR differs from the registered policy', () => {
    expect(fieldsOf(problemsOfRecord(recordWith({ policyVersion: '2.0' })))).toContain(
      'policyVersion',
    );
  });

  it('accepts a policyVersion whose MINOR differs from the registered policy', () => {
    expect(validateDecisionRecord(recordWith({ policyVersion: '1.3' })).ok).toBe(true);
  });

  it('refuses an operation the policy does not declare', () => {
    expect(fieldsOf(problemsOfRecord(recordWith({ operation: 'shell-command' })))).toContain(
      'operation',
    );
  });

  it('refuses a capabilityState outside the vocabulary and quotes the value', () => {
    const problems = problemsOfRecord(recordWith({ capabilityState: 'MAYBE' }));
    const named = problems.filter((p) => p.field === 'capabilityState');
    expect(named.length).toBeGreaterThan(0);
    expect(named.some((p) => p.message.includes('MAYBE'))).toBe(true);
  });

  it('refuses a verdict outcome outside the vocabulary and quotes the value', () => {
    const problems = problemsOfRecord(recordWith({ verdict: { outcome: 'warn' } }));
    const named = problems.filter((p) => /^verdict(\.outcome)?$/.test(p.field));
    expect(named.length, 'no problem names the verdict outcome').toBeGreaterThan(0);
    expect(named.some((p) => p.message.includes('warn'))).toBe(true);
  });

  it('refuses an evidence kind outside the vocabulary and quotes the value', () => {
    const problems = problemsOfRecord(
      recordWith({ evidence: [...validRecord().evidence, { kind: 'screenshot', value: 'x' }] }),
    );
    const named = problems.filter((p) => p.field.startsWith('evidence'));
    expect(named.length, 'no problem names the evidence').toBeGreaterThan(0);
    expect(named.some((p) => p.message.includes('screenshot'))).toBe(true);
  });

  it('refuses an empty harness id', () => {
    expect(fieldsOf(problemsOfRecord(recordWith({ harness: '' })))).toContain('harness');
  });

  it('refuses a qualifier that carries no reason', () => {
    const problems = problemsOfRecord(
      recordWith({ verdict: { outcome: 'allow', qualifier: 'UNMEASURED' } }),
    );
    expect(problems.some((p) => p.field.startsWith('verdict'))).toBe(true);
  });

  it.each(['', ' ', '\n\t'])('refuses a qualifier whose reason is blank (%j)', (reason) => {
    const problems = problemsOfRecord(
      recordWith({ verdict: { outcome: 'allow', qualifier: 'UNMEASURED', reason } }),
    );
    expect(problems.some((p) => p.field.startsWith('verdict'))).toBe(true);
  });

  it('refuses an unknown key inside the verdict, because that shape is closed too', () => {
    const problems = problemsOfRecord(
      recordWith({ verdict: { outcome: 'block', reason: 'named a credential file', severity: 9 } }),
    );
    expect(fieldsOf(problems)).toContain('verdict.severity');
  });

  it('accepts an allow verdict that carries only an exit code as evidence', () => {
    const result = validateDecisionRecord(
      recordWith({
        verdict: { outcome: 'allow' },
        evidence: [{ kind: 'exit-code', value: '0' }],
        diagnostics: { redacted: true, text: '' },
      }),
    );
    expect(result.ok, result.ok ? '' : JSON.stringify(result.problems)).toBe(true);
  });

  it.each([
    ['an entry that is not an object', ['not-a-fact']],
    ['an entry missing its value', [{ name: 'file_path' }]],
    ['an entry with an empty name', [{ name: '', value: '.env' }]],
    ['an entry carrying an unknown key', [{ name: 'file_path', value: '.env', source: 'x' }]],
  ])('refuses observedFacts with %s', (_case, observedFacts) => {
    const problems = problemsOfRecord(recordWith({ observedFacts }));
    expect(problems.some((p) => p.field.startsWith('observedFacts'))).toBe(true);
  });

  it('refuses observedFacts that is not a list', () => {
    expect(fieldsOf(problemsOfRecord(recordWith({ observedFacts: 'none' })))).toContain(
      'observedFacts',
    );
  });

  it('refuses an empty artifactVersion', () => {
    expect(fieldsOf(problemsOfRecord(recordWith({ artifactVersion: '' })))).toContain(
      'artifactVersion',
    );
  });

  it.each(['UNSUPPORTED', 'INTEGRATION-FAILED'])(
    'refuses a silent pass: capabilityState %s with a verdict that is not qualified UNVERIFIABLE',
    (capabilityState) => {
      const unqualified = problemsOfRecord(
        recordWith({ capabilityState, verdict: { outcome: 'allow' } }),
      );
      expect(unqualified.some((p) => /^(verdict|capabilityState)/.test(p.field))).toBe(true);

      const wrongQualifier = problemsOfRecord(
        recordWith({
          capabilityState,
          verdict: { outcome: 'allow', qualifier: 'UNMEASURED', reason: 'not measured' },
        }),
      );
      expect(wrongQualifier.some((p) => /^(verdict|capabilityState)/.test(p.field))).toBe(true);
    },
  );

  it.each(['UNSUPPORTED', 'INTEGRATION-FAILED'])(
    'accepts capabilityState %s once the verdict is qualified UNVERIFIABLE with a reason',
    (capabilityState) => {
      const result = validateDecisionRecord(
        recordWith({
          capabilityState,
          verdict: {
            outcome: 'allow',
            qualifier: 'UNVERIFIABLE',
            reason: 'the harness exposes no pre-operation hook',
          },
        }),
      );
      expect(result.ok, result.ok ? '' : JSON.stringify(result.problems)).toBe(true);
    },
  );

  it('refuses a record missing a required evidence kind and names the kind', () => {
    const problems = problemsOfRecord(
      recordWith({ evidence: validRecord().evidence.filter((e) => e.kind !== 'exit-code') }),
    );
    const named = problems.filter((p) => p.field.startsWith('evidence'));
    expect(named.length, 'no problem names the evidence').toBeGreaterThan(0);
    expect(named.some((p) => p.message.includes('exit-code'))).toBe(true);
  });

  it('refuses unredacted diagnostics for a policy whose redaction rule is not none', () => {
    const problems = problemsOfRecord(
      recordWith({ diagnostics: { redacted: false, text: 'refused .env' } }),
    );
    expect(problems.some((p) => p.field.startsWith('diagnostics'))).toBe(true);
  });

  it('accepts unredacted diagnostics for a policy whose redaction rule is none', () => {
    const result = validateDecisionRecord(
      recordWith({
        policyId: 'no-verify-refusal',
        operation: 'shell-command',
        diagnostics: { redacted: false, text: 'refused git commit --no-verify' },
      }),
    );
    expect(result.ok, result.ok ? '' : JSON.stringify(result.problems)).toBe(true);
  });

  it.each(['yesterday', 'Sep 2 2026', '2026-09-02', '2026-09-02T10:00:00'])(
    'refuses a recordedAt that is not an ISO-8601 timestamp with a zone (%j)',
    (recordedAt) => {
      expect(fieldsOf(problemsOfRecord(recordWith({ recordedAt })))).toContain('recordedAt');
    },
  );

  it.each(['2026-09-02T10:00:00Z', '2026-09-02T10:00:00.250+04:00'])(
    'accepts the ISO-8601 timestamp %j',
    (recordedAt) => {
      expect(validateDecisionRecord(recordWith({ recordedAt })).ok).toBe(true);
    },
  );

  /**
   * RP-153: the validator read these fields THROUGH THE PROTOTYPE CHAIN while
   * `unknownKeys` judged the same record by `Object.keys`, so the closed-shape
   * check and the field reads disagreed about what the record even contains —
   * and the reads were the wider of the two, which is the direction that
   * passes. `carriesField`/`ownField` in `../src/policy/core/validation.ts` are
   * the notion `probe.ts` and `evidence-matrix.ts` already read by: own AND
   * enumerable, exactly the set `Object.keys` walks and `JSON.stringify` writes
   * out. A decision record is an audit artifact, so a field no serialisation of
   * it carries must not be readable as one it does.
   */

  /** What `JSON.stringify` — and so the audit file the record becomes — carries. */
  const serialised = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

  const withoutOwn = (object: Record<string, unknown>, field: string): Record<string, unknown> => {
    const owned: Record<string, unknown> = { ...object };
    delete owned[field];
    return owned;
  };

  /** The same object with `field` on its PROTOTYPE: resolved by `in`, owned by nothing. */
  const inherits = (object: Record<string, unknown>, field: string): Record<string, unknown> =>
    Object.assign(
      Object.create({ [field]: object[field] }) as Record<string, unknown>,
      withoutOwn(object, field),
    );

  /** The same object with `field` own but NOT enumerable: no serialisation carries it. */
  const hides = (object: Record<string, unknown>, field: string): Record<string, unknown> => {
    const hidden = withoutOwn(object, field);
    Object.defineProperty(hidden, field, {
      value: object[field],
      enumerable: false,
      writable: true,
      configurable: true,
    });
    return hidden;
  };

  type UncarriedShape = 'only inherited' | 'own but not enumerable';

  const HIDE: Record<
    UncarriedShape,
    (object: Record<string, unknown>, field: string) => Record<string, unknown>
  > = {
    'only inherited': inherits,
    'own but not enumerable': hides,
  };

  const SHAPES: readonly UncarriedShape[] = ['only inherited', 'own but not enumerable'];

  /**
   * `object` with `field` present in one of the two uncarried shapes — and the
   * fixture proven to be that case: JavaScript still resolves the field, and no
   * serialisation of the object carries it.
   */
  const uncarried = (
    shape: UncarriedShape,
    object: Record<string, unknown>,
    field: string,
  ): Record<string, unknown> => {
    const result = HIDE[shape](object, field);
    expect(Object.keys(result), `the fixture owns ${field} after all`).not.toContain(field);
    expect(
      serialised(result),
      `the fixture still serialises ${field}, so it proves nothing`,
    ).not.toHaveProperty(field);
    expect(field in result, `the fixture no longer resolves ${field} at all`).toBe(true);
    return result;
  };

  it.each(SHAPES)(
    'refuses an UNSUPPORTED record whose verdict qualifier is %s, because what it writes out is a silent pass',
    (shape) => {
      const verdict: Record<string, unknown> = {
        outcome: 'allow',
        qualifier: 'UNVERIFIABLE',
        reason: 'the harness exposes no pre-operation hook',
      };
      const problems = problemsOfRecord(
        recordWith({
          capabilityState: 'UNSUPPORTED',
          verdict: uncarried(shape, verdict, 'qualifier'),
        }),
      );
      const named = problems.filter((p) => p.field === 'verdict.qualifier');
      expect(
        named.length,
        'a qualifier no serialisation carries was read as qualifying the verdict',
      ).toBeGreaterThan(0);
      expect(named.some((p) => p.message.includes('silent pass'))).toBe(true);
    },
  );

  it.each(SHAPES)(
    'reads a verdict whose qualifier is %s as the plain allow it serialises as, rather than demanding a reason for it',
    (shape) => {
      const verdict: Record<string, unknown> = { outcome: 'allow', qualifier: 'UNMEASURED' };
      const result = validateDecisionRecord(
        recordWith({ verdict: uncarried(shape, verdict, 'qualifier') }),
      );
      expect(result.ok, result.ok ? '' : JSON.stringify(result.problems)).toBe(true);
    },
  );

  it.each(SHAPES)(
    'refuses a qualified verdict whose reason is %s, because the record would say it was qualified and not why',
    (shape) => {
      const verdict: Record<string, unknown> = {
        outcome: 'allow',
        qualifier: 'UNMEASURED',
        reason: 'the run recorded no measurement',
      };
      const problems = problemsOfRecord(
        recordWith({ verdict: uncarried(shape, verdict, 'reason') }),
      );
      const named = problems.filter((p) => p.field === 'verdict.reason');
      expect(
        named.length,
        'a reason no serialisation carries satisfied the requirement to say why',
      ).toBeGreaterThan(0);
      expect(named.some((p) => p.message.includes('UNMEASURED'))).toBe(true);
    },
  );

  it.each(SHAPES)(
    'refuses a verdict whose outcome is %s, because the verdict it writes out carries no outcome',
    (shape) => {
      const verdict: Record<string, unknown> = {
        outcome: 'block',
        reason: 'the path names a credential file',
      };
      const problems = problemsOfRecord(
        recordWith({ verdict: uncarried(shape, verdict, 'outcome') }),
      );
      expect(fieldsOf(problems)).toContain('verdict.outcome');
    },
  );

  it.each(
    SHAPES.flatMap((shape) => (['name', 'value'] as const).map((field) => [field, shape] as const)),
  )(
    'refuses an observedFacts entry whose %s is %s, because the entry itself records nothing',
    (field, shape) => {
      const fact: Record<string, unknown> = { name: 'file_path', value: '.env' };
      const problems = problemsOfRecord(
        recordWith({ observedFacts: [uncarried(shape, fact, field)] }),
      );
      expect(fieldsOf(problems)).toContain(`observedFacts[0].${field}`);
    },
  );

  it.each(SHAPES)(
    'refuses an evidence entry whose kind is %s, and still reports the required kind missing, because the record serialises without it',
    (shape) => {
      const exitCode: Record<string, unknown> = { kind: 'exit-code', value: '2' };
      const problems = problemsOfRecord(
        recordWith({ evidence: [uncarried(shape, exitCode, 'kind')] }),
      );
      expect(fieldsOf(problems)).toContain('evidence[0].kind');
      expect(
        problems.some((p) => p.field === 'evidence' && p.message.includes('exit-code')),
        'a kind no serialisation carries counted toward the evidence the policy requires',
      ).toBe(true);
    },
  );

  it.each(SHAPES)(
    'refuses an evidence entry whose value is %s, because the entry points at nothing a later reader could open',
    (shape) => {
      const pointer: Record<string, unknown> = {
        kind: 'test-pointer',
        value: 'guard-secret-file.test.ts › "refuses a credential file by name"',
      };
      const problems = problemsOfRecord(
        recordWith({
          evidence: [{ kind: 'exit-code', value: '2' }, uncarried(shape, pointer, 'value')],
        }),
      );
      expect(fieldsOf(problems)).toContain('evidence[1].value');
    },
  );

  it.each(SHAPES)(
    'refuses diagnostics whose redacted claim is %s, because a redacting policy needs the claim in what is written out',
    (shape) => {
      const diagnostics: Record<string, unknown> = {
        redacted: true,
        text: 'refused .env (values omitted)',
      };
      const problems = problemsOfRecord(
        recordWith({ diagnostics: uncarried(shape, diagnostics, 'redacted') }),
      );
      expect(fieldsOf(problems)).toContain('diagnostics.redacted');
    },
  );

  it.each(SHAPES)(
    'refuses diagnostics whose text is %s, because the record would serialise with no diagnostics text',
    (shape) => {
      const diagnostics: Record<string, unknown> = {
        redacted: true,
        text: 'refused .env (values omitted)',
      };
      const problems = problemsOfRecord(
        recordWith({ diagnostics: uncarried(shape, diagnostics, 'text') }),
      );
      expect(fieldsOf(problems)).toContain('diagnostics.text');
    },
  );

  it.each(
    SHAPES.flatMap((shape) =>
      (['capabilityState', 'recordedAt'] as const).map((field) => [field, shape] as const),
    ),
  )(
    'refuses a record whose %s is %s, because the record it writes out carries no such field',
    (field, shape) => {
      const problems = problemsOfRecord(uncarried(shape, recordWith({}), field));
      expect(fieldsOf(problems)).toContain(field);
    },
  );

  it('refuses a record whose schemaVersion is only inherited, because a version on a prototype pins nothing the file carries', () => {
    const problems = problemsOfRecord(uncarried('only inherited', recordWith({}), 'schemaVersion'));
    expect(fieldsOf(problems)).toContain('schemaVersion');
  });

  // KEEP GREEN. The positive control the cases above are measured against: the
  // rule is enumerability, not the tool that defined the property. A fix that
  // refused everything `Object.defineProperty` touched would pass them all and
  // refuse every record an emitter builds that way.
  it('still accepts a record whose every field is defined through Object.defineProperty as own and enumerable', () => {
    const record: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(recordWith({}))) {
      Object.defineProperty(record, field, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    expect(Object.keys(record), 'the fixture no longer carries every field').toEqual(
      Object.keys(recordWith({})),
    );
    const result = validateDecisionRecord(record);
    expect(result.ok, result.ok ? '' : JSON.stringify(result.problems)).toBe(true);
  });
});

describe('the harness adapters', () => {
  it('registers two adapters with distinct harness ids', () => {
    expect(HARNESS_ADAPTERS).toHaveLength(2);
    expect(new Set(HARNESS_ADAPTERS.map((a) => a.harness)).size).toBe(2);
    expect(HARNESS_ADAPTERS).toContain(claudeAdapter);
    expect(HARNESS_ADAPTERS).toContain(codexAdapter);
  });

  it('the Claude adapter names its harness and its hook-wiring snapshot', () => {
    expect(claudeAdapter.harness).toBe('claude');
    expect(claudeAdapter.surfaceFile).toBe('.claude/settings.json');
  });

  it('the Codex adapter names its harness and its hook-wiring snapshot', () => {
    expect(codexAdapter.harness).toBe('codex');
    expect(codexAdapter.surfaceFile).toBe('.codex/hooks.json');
  });

  const MATCHERS: Record<string, string> = {
    'file-edit': 'Write|Edit|MultiEdit|NotebookEdit|apply_patch',
    'shell-command': 'Bash|PowerShell',
  };

  const combos = HARNESS_ADAPTERS.flatMap((adapter) =>
    POLICIES.map((policy) => [adapter.harness, policy.policyId, adapter, policy] as const),
  );

  it.each(combos)(
    '%s maps %s onto a PreToolUse hook at the mechanism path with the matcher of its operation',
    (_harness, _policyId, adapter, policy) => {
      const surface = adapter.nativeSurfaceOf(policy);
      expect(surface.event).toBe('PreToolUse');
      expect(surface.hookPath).toBe(`.claude/hooks/${policy.mechanism}.mjs`);
      const [operation] = policy.operations;
      expect(surface.matcher).toBe(MATCHERS[operation ?? '']);
    },
  );
});
