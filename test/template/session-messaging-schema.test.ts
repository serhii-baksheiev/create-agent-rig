import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const contractDir = path.join(repoRoot, 'contracts', 'session-messaging', 'v1');
const schemaPath = path.join(contractDir, 'schema.ts');
const fixturesDir = path.join(contractDir, 'fixtures');
const requireFromHere = createRequire(import.meta.url);

const PUBLIC_DEFINITIONS = [
  'SessionIdentity',
  'Envelope',
  'DeliveryIntent',
  'DeliveryClass',
  'SessionCapabilities',
  'DeliveryReceipt',
  'ProbeResult',
] as const;

const INTENTS = ['notify', 'wake'] as const;
const DELIVERY_CLASSES = ['PUSH', 'TURN_BOUNDARY', 'POLL', 'OFFLINE'] as const;
const REQUIRED_RECEIPT_CASES = [
  'receipt-wake-allowed',
  'receipt-receiver-policy-downgrade',
  'receipt-unsafe-admission-downgrade',
  'receipt-terminal-decline',
  'receipt-surfaced-without-handled',
  'receipt-handled-ack',
  'receipt-handled-reply',
] as const;

type PublicDefinition = (typeof PUBLIC_DEFINITIONS)[number];
type DeliveryClass = (typeof DELIVERY_CLASSES)[number];
type JsonSchema = Record<string, unknown> & {
  $schema?: unknown;
  $defs?: Record<string, unknown>;
};
type AjvError = { instancePath: string; keyword: string };
type Validator = ((value: unknown) => boolean) & { errors?: AjvError[] | null };
type AjvInstance = { compile: (schema: unknown) => Validator };
type AjvConstructor = new (options?: Record<string, unknown>) => AjvInstance;

type GoldenFixture = {
  file: string;
  case: string;
  definition: PublicDefinition;
  valid: boolean;
  value: unknown;
  expectedKeyword?: string;
  expectedInstancePath?: string;
  deliveryClass?: DeliveryClass;
  baseline?: 'non-enterprise';
};

const recordOf = (value: unknown, description: string): Record<string, unknown> => {
  expect(value, description).toBeTypeOf('object');
  expect(value, description).not.toBeNull();
  expect(Array.isArray(value), description).toBe(false);
  return value as Record<string, unknown>;
};

const jsonFilesBelow = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const absolute = path.join(dir, entry.name);
      return entry.isDirectory()
        ? jsonFilesBelow(absolute)
        : Promise.resolve(entry.name.endsWith('.json') ? [absolute] : []);
    }),
  );
  return nested.flat().sort();
};

const loadFixtureTree = async (kind: 'positive' | 'negative'): Promise<GoldenFixture[]> => {
  const files = await jsonFilesBelow(path.join(fixturesDir, kind));
  expect(files, `${kind} fixture tree must contain JSON fixtures`).not.toHaveLength(0);
  return Promise.all(
    files.map(async (file) => {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
      const fixture = recordOf(parsed, `${path.relative(repoRoot, file)} must contain an object`);
      expect(fixture.case, `${file}: case`).toBeTypeOf('string');
      expect(PUBLIC_DEFINITIONS, `${file}: definition`).toContain(fixture.definition);
      expect(fixture.valid, `${file}: valid`).toBe(kind === 'positive');
      expect(Object.hasOwn(fixture, 'value'), `${file}: value`).toBe(true);
      if (kind === 'negative') {
        expect(fixture.expectedKeyword, `${file}: expectedKeyword`).toBeTypeOf('string');
        expect(fixture.expectedInstancePath, `${file}: expectedInstancePath`).toBeTypeOf('string');
      }
      return { file, ...fixture } as GoldenFixture;
    }),
  );
};

const loadSchema = async (): Promise<JsonSchema> => {
  const module = (await import(pathToFileURL(schemaPath).href)) as Record<string, unknown>;
  return recordOf(
    module.sessionMessagingSchema,
    'schema.ts must export sessionMessagingSchema',
  ) as JsonSchema;
};

const loadAjv2020 = (): AjvInstance => {
  const loaded: unknown = requireFromHere('ajv/dist/2020.js');
  const constructor =
    (loaded as { default?: AjvConstructor }).default ?? (loaded as AjvConstructor);
  return new constructor({ allErrors: true, strict: true });
};

const compileDefinition = async (definition: PublicDefinition): Promise<Validator> => {
  const schema = await loadSchema();
  return loadAjv2020().compile({
    $schema: schema.$schema,
    $defs: schema.$defs,
    $ref: `#/$defs/${definition}`,
  });
};

const fixtureByCase = (fixtures: GoldenFixture[], name: string): GoldenFixture => {
  const matches = fixtures.filter((fixture) => fixture.case === name);
  expect(matches, `exactly one fixture must cover ${name}`).toHaveLength(1);
  return matches[0]!;
};

const validateFixture = async (fixture: GoldenFixture): Promise<Validator> => {
  const validate = await compileDefinition(fixture.definition);
  validate(fixture.value);
  return validate;
};

describe('session messaging Contract v1 Draft 2020-12 schemas', () => {
  it('exports one Draft 2020-12 schema with all seven public definitions', async () => {
    const schema = await loadSchema();
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    for (const definition of PUBLIC_DEFINITIONS) {
      expect(schema.$defs, `missing public definition ${definition}`).toHaveProperty(definition);
      expect(() =>
        loadAjv2020().compile({
          $schema: schema.$schema,
          $defs: schema.$defs,
          $ref: `#/$defs/${definition}`,
        }),
      ).not.toThrow();
    }
  });

  it('keeps every positive fixture valid and covers every public definition', async () => {
    const fixtures = await loadFixtureTree('positive');
    expect(new Set(fixtures.map(({ case: name }) => name)).size).toBe(fixtures.length);
    expect(new Set(fixtures.map(({ definition }) => definition))).toEqual(
      new Set(PUBLIC_DEFINITIONS),
    );
    for (const fixture of fixtures) {
      expect((await validateFixture(fixture)).errors, fixture.file).toBeNull();
    }
  });

  it('rejects every negative fixture for its intended keyword and instance path', async () => {
    const fixtures = await loadFixtureTree('negative');
    expect(new Set(fixtures.map(({ case: name }) => name)).size).toBe(fixtures.length);
    expect(new Set(fixtures.map(({ definition }) => definition))).toEqual(
      new Set(PUBLIC_DEFINITIONS),
    );
    for (const fixture of fixtures) {
      const validate = await validateFixture(fixture);
      expect(validate.errors, `${fixture.file} unexpectedly passed`).not.toBeNull();
      expect(validate.errors, fixture.file).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            keyword: fixture.expectedKeyword,
            instancePath: fixture.expectedInstancePath,
          }),
        ]),
      );
    }
  });

  it('keeps concurrent instances of the same engineer and harness separately addressable', async () => {
    const fixtures = await loadFixtureTree('positive');
    const first = fixtureByCase(fixtures, 'session-concurrent-a');
    const second = fixtureByCase(fixtures, 'session-concurrent-b');
    expect(first.definition).toBe('SessionIdentity');
    expect(second.definition).toBe('SessionIdentity');

    const firstIdentity = recordOf(first.value, first.file);
    const secondIdentity = recordOf(second.value, second.file);
    expect(secondIdentity).toMatchObject({
      engineerId: firstIdentity.engineerId,
      harness: firstIdentity.harness,
      projectId: firstIdentity.projectId,
    });
    expect(firstIdentity.instanceId).toBeTypeOf('string');
    expect(secondIdentity.instanceId).toBeTypeOf('string');
    expect(secondIdentity.instanceId).not.toBe(firstIdentity.instanceId);
    expect((await validateFixture(first)).errors).toBeNull();
    expect((await validateFixture(second)).errors).toBeNull();
  });

  it('keeps Envelope on supported major v1 and rejects a foreign major', async () => {
    const supported = fixtureByCase(await loadFixtureTree('positive'), 'envelope-supported-major');
    const foreign = fixtureByCase(await loadFixtureTree('negative'), 'envelope-foreign-major');
    expect(recordOf(supported.value, supported.file).contractMajor).toBe(1);
    expect(recordOf(foreign.value, foreign.file).contractMajor).not.toBe(1);
    expect((await validateFixture(supported)).errors).toBeNull();
    expect((await validateFixture(foreign)).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ instancePath: '/contractMajor' })]),
    );
  });

  it('excludes trust, transport subjects, NATS subjects and harness-native payloads from Envelope', async () => {
    const fixtures = await loadFixtureTree('negative');
    const exclusions = [
      ['envelope-top-level-trust', 'trust'],
      ['envelope-transport-subject', 'transportSubject'],
      ['envelope-nats-subject', 'natsSubject'],
      ['envelope-harness-native-payload', 'harnessNativePayload'],
    ] as const;
    for (const [name, property] of exclusions) {
      const fixture = fixtureByCase(fixtures, name);
      expect(recordOf(fixture.value, fixture.file)).toHaveProperty(property);
      expect((await validateFixture(fixture)).errors, fixture.file).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ keyword: 'additionalProperties', instancePath: '' }),
        ]),
      );
    }
  });

  it('accepts every DeliveryIntent and DeliveryClass combination independently', async () => {
    const fixtures = await loadFixtureTree('positive');
    const schema = await loadSchema();
    const validatePair = loadAjv2020().compile({
      $schema: schema.$schema,
      $defs: schema.$defs,
      type: 'object',
      required: ['intent', 'deliveryClass'],
      properties: {
        intent: { $ref: '#/$defs/DeliveryIntent' },
        deliveryClass: { $ref: '#/$defs/DeliveryClass' },
      },
      additionalProperties: false,
    });
    for (const intent of INTENTS) {
      for (const deliveryClass of DELIVERY_CLASSES) {
        const name = `orthogonal-${deliveryClass.toLowerCase().replace('_', '-')}-${intent}`;
        const fixture = fixtureByCase(fixtures, name);
        expect(fixture.definition).toBe('Envelope');
        expect(recordOf(fixture.value, fixture.file).requestedIntent).toBe(intent);
        expect(fixture.deliveryClass).toBe(deliveryClass);
        expect(validatePair({ intent, deliveryClass }), name).toBe(true);
      }
    }
  });

  it('distinguishes allowed wake, downgrades, decline, surfaced and explicitly handled receipts', async () => {
    const fixtures = await loadFixtureTree('positive');
    for (const name of REQUIRED_RECEIPT_CASES) {
      const fixture = fixtureByCase(fixtures, name);
      expect(fixture.definition).toBe('DeliveryReceipt');
      expect((await validateFixture(fixture)).errors).toBeNull();
    }
    for (const name of [
      'receipt-receiver-policy-downgrade',
      'receipt-unsafe-admission-downgrade',
    ]) {
      const receipt = recordOf(fixtureByCase(fixtures, name).value, name);
      expect(receipt.requestedIntent).toBe('wake');
      expect(receipt.effectiveIntent).toBe('notify');
      expect(receipt).toHaveProperty('downgrade.reason');
    }
    expect(
      recordOf(fixtureByCase(fixtures, 'receipt-terminal-decline').value, 'decline'),
    ).toMatchObject({ outcome: 'declined', declineReason: expect.any(String) });
    expect(
      recordOf(fixtureByCase(fixtures, 'receipt-surfaced-without-handled').value, 'surfaced'),
    ).toMatchObject({ outcome: 'surfaced' });
    for (const name of ['receipt-handled-ack', 'receipt-handled-reply']) {
      expect(recordOf(fixtureByCase(fixtures, name).value, name)).toMatchObject({
        outcome: 'handled',
        busReaction: expect.any(Object),
      });
    }
  });

  it('rejects a handled receipt without an explicit bus-visible reaction', async () => {
    const fixture = fixtureByCase(
      await loadFixtureTree('negative'),
      'receipt-handled-without-reaction',
    );
    const value = recordOf(fixture.value, fixture.file);
    expect(value.outcome).toBe('handled');
    expect(value).not.toHaveProperty('busReaction');
    expect((await validateFixture(fixture)).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ keyword: 'required', instancePath: '' })]),
    );
  });

  it('rejects receiver-policy elevation from notify to wake', async () => {
    const fixture = fixtureByCase(
      await loadFixtureTree('negative'),
      'receipt-notify-upgraded-to-wake',
    );
    expect(fixture.definition).toBe('DeliveryReceipt');
    const value = recordOf(fixture.value, fixture.file);
    expect(value).toMatchObject({ requestedIntent: 'notify', effectiveIntent: 'wake' });
    expect(value).not.toHaveProperty('downgrade');

    const validate = await validateFixture(fixture);
    expect(validate.errors, `${fixture.file} unexpectedly elevated notify into wake`).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          keyword: fixture.expectedKeyword,
          instancePath: fixture.expectedInstancePath,
        }),
      ]),
    );
  });

  it('requires per-session capability evidence without treating absent traffic as failure', async () => {
    const fixtures = await loadFixtureTree('positive');
    const evidenceFixture = fixtureByCase(fixtures, 'capability-complete-evidence');
    const noTrafficFixture = fixtureByCase(fixtures, 'capability-no-traffic-is-not-failure');
    const capability = recordOf(evidenceFixture.value, evidenceFixture.file);
    const evidence = recordOf(capability.evidence, `${evidenceFixture.file}: evidence`);
    expect(capability).toEqual(
      expect.objectContaining({
        effectiveDeliveryClass: expect.any(String),
        supportedIntents: expect.any(Array),
        ingressKind: expect.any(String),
        verifiedAt: expect.any(String),
        verifiedBy: expect.stringMatching(/^(probe|traffic)$/),
        verificationState: expect.stringMatching(/^(verified|degraded|unverified)$/),
        consecutiveExpectedObservationFailures: expect.any(Number),
      }),
    );
    expect(evidence).toEqual(
      expect.objectContaining({
        harness: expect.any(String),
        surface: expect.any(String),
        harnessVersion: expect.any(String),
        os: expect.any(String),
        observedDate: expect.any(String),
        mechanism: expect.any(String),
        result: expect.any(String),
        evidencePointer: expect.any(String),
        degradationThreshold: expect.any(Number),
      }),
    );
    const noTraffic = recordOf(noTrafficFixture.value, noTrafficFixture.file);
    expect(noTraffic).not.toHaveProperty('lastAckAt');
    expect(noTraffic.consecutiveExpectedObservationFailures).toBe(0);
    expect((await validateFixture(noTrafficFixture)).errors).toBeNull();
  });

  it('rejects capability evidence without harness version or observed date', async () => {
    const fixtures = await loadFixtureTree('negative');
    for (const name of [
      'capability-evidence-missing-version',
      'capability-evidence-missing-observed-date',
    ]) {
      const fixture = fixtureByCase(fixtures, name);
      expect(fixture.definition).toBe('SessionCapabilities');
      expect(fixture).toMatchObject({
        expectedKeyword: 'required',
        expectedInstancePath: '/evidence',
      });
      expect((await validateFixture(fixture)).errors, fixture.file).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ keyword: 'required', instancePath: '/evidence' }),
        ]),
      );
    }
  });

  it('keeps the complete core contract usable without enterprise-managed fields', async () => {
    const fixtures = (await loadFixtureTree('positive')).filter(
      ({ baseline }) => baseline === 'non-enterprise',
    );
    expect(new Set(fixtures.map(({ definition }) => definition))).toEqual(
      new Set(PUBLIC_DEFINITIONS),
    );
    for (const fixture of fixtures) {
      expect(JSON.stringify(fixture.value), fixture.file).not.toMatch(/enterprise/i);
      expect((await validateFixture(fixture)).errors).toBeNull();
    }
  });

  it('models registration and reconnect ProbeResult records as one-shot evidence only', async () => {
    const positive = await loadFixtureTree('positive');
    for (const name of ['probe-registration-one-shot', 'probe-reconnect-one-shot']) {
      const fixture = fixtureByCase(positive, name);
      expect(fixture.definition).toBe('ProbeResult');
      const value = recordOf(fixture.value, fixture.file);
      expect(value.trigger).toMatch(/^(registration|reconnect)$/);
      expect(value).toEqual(
        expect.objectContaining({
          mechanism: expect.any(String),
          outcome: expect.any(String),
          observedAt: expect.any(String),
          effectiveCapability: expect.any(Object),
          verificationState: expect.stringMatching(/^(verified|degraded|unverified)$/),
        }),
      );
      expect((await validateFixture(fixture)).errors).toBeNull();
    }

    // This proves only that a public ProbeResult cannot carry scheduling state;
    // periodic runtime behavior needs runtime tests in a later ticket.
    const periodic = fixtureByCase(await loadFixtureTree('negative'), 'probe-periodic-schedule');
    expect(JSON.stringify(periodic.value)).toMatch(/periodic|interval|schedule/i);
    expect((await validateFixture(periodic)).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyword: 'additionalProperties', instancePath: '' }),
      ]),
    );
  });
});
