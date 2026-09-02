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

  it.each(REGISTERED)('%s requires an exit code and diagnostic text as evidence', (policyId) => {
    const evidence = findPolicy(policyId)?.requiredEvidence ?? [];
    expect(evidence).toEqual(expect.arrayContaining(['exit-code', 'diagnostic-text']));
  });

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

  it('refuses a qualifier whose reason is empty', () => {
    const problems = problemsOfRecord(
      recordWith({ verdict: { outcome: 'allow', qualifier: 'UNMEASURED', reason: '' } }),
    );
    expect(problems.some((p) => p.field.startsWith('verdict'))).toBe(true);
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
      recordWith({ evidence: validRecord().evidence.filter((e) => e.kind !== 'diagnostic-text') }),
    );
    const named = problems.filter((p) => p.field.startsWith('evidence'));
    expect(named.length, 'no problem names the evidence').toBeGreaterThan(0);
    expect(named.some((p) => p.message.includes('diagnostic-text'))).toBe(true);
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

  it('refuses a recordedAt that does not parse as a date', () => {
    expect(fieldsOf(problemsOfRecord(recordWith({ recordedAt: 'yesterday' })))).toContain(
      'recordedAt',
    );
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
