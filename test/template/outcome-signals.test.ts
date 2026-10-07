import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// RP-356 — the 1.7.0 Outcome Evidence contract. This file is TDD Red: it pins
// the schema of a module that does not exist yet
// (`templates/agent-os/universal/.claude/scripts/lib/outcome-signals.mjs`)
// and two decision records that do not exist yet. Every test below is
// expected to fail because its subject is absent, not because of a typo in
// the test.
//
// Every path here is the TEMPLATE copy under `templates/agent-os/universal/`
// — never a synced `.claude/` copy — because the template is the source RP-355
// will extend, and an assertion against a synced copy would pass on a stale
// sync.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universalDir = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const scriptsDir = path.join(universalDir, '.claude', 'scripts');
const outcomeSignalsModulePath = path.join(scriptsDir, 'lib', 'outcome-signals.mjs');
const layersJsonPath = path.join(universalDir, 'layers.json');
const outcomeSignalsRecordPath = path.join(universalDir, 'docs', 'decisions', 'outcome-signals.md');
const outcomeInteropRecordPath = path.join(repoRoot, 'docs', 'decisions', 'outcome-interop.md');
const outcomeInteropTemplatePath = path.join(
  universalDir,
  'docs',
  'decisions',
  'outcome-interop.md',
);

interface Signal {
  name: string;
  signalVersion: number;
  definition: string;
  source: string;
  population: string;
  unknown: string;
  limits: readonly string[];
  comparableOn: readonly string[];
  groupBy: readonly string[];
  conditional?: boolean;
}

interface OutcomeSignalsModule {
  SIGNALS: readonly Signal[];
  DIMENSIONS: readonly string[];
  COMPARISON_RESULTS: readonly string[];
  UNKNOWN: string;
}

const loadOutcomeSignals = async (): Promise<OutcomeSignalsModule> =>
  (await import(pathToFileURL(outcomeSignalsModulePath).href)) as OutcomeSignalsModule;

const read = (file: string) => readFile(file, 'utf8');

const SIGNAL_NAMES = [
  'first-shipping-verdict',
  'gate-rounds',
  'claim-to-merge',
  'interventions',
  'continuation',
  'tokens-per-ship',
] as const;

describe('outcome-signals.mjs — the six Outcome Evidence signal definitions (RP-356, Red)', () => {
  it('exports SIGNALS as a frozen array of exactly six frozen definitions, named and ordered as the contract states', async () => {
    const { SIGNALS } = await loadOutcomeSignals();
    expect(Object.isFrozen(SIGNALS)).toBe(true);
    expect(SIGNALS).toHaveLength(6);
    expect(SIGNALS.map((signal) => signal.name)).toEqual([...SIGNAL_NAMES]);
    for (const signal of SIGNALS) {
      expect(Object.isFrozen(signal), `${signal.name} must be frozen`).toBe(true);
    }
  });

  it('every signal carries signalVersion 1, a positive integer', async () => {
    const { SIGNALS } = await loadOutcomeSignals();
    for (const signal of SIGNALS) {
      expect(Number.isInteger(signal.signalVersion), signal.name).toBe(true);
      expect(signal.signalVersion, signal.name).toBeGreaterThan(0);
      expect(signal.signalVersion, signal.name).toBe(1);
    }
  });

  it('every signal carries non-empty definition, source, population and unknown strings, and a non-empty limits array of strings', async () => {
    const { SIGNALS } = await loadOutcomeSignals();
    for (const signal of SIGNALS) {
      for (const field of ['definition', 'source', 'population', 'unknown'] as const) {
        expect(typeof signal[field], `${signal.name}.${field}`).toBe('string');
        expect((signal[field] as string).trim().length, `${signal.name}.${field}`).toBeGreaterThan(
          0,
        );
      }
      expect(Array.isArray(signal.limits), `${signal.name}.limits`).toBe(true);
      expect(signal.limits.length, `${signal.name}.limits`).toBeGreaterThan(0);
      for (const limit of signal.limits) {
        expect(typeof limit, `${signal.name}.limits[]`).toBe('string');
      }
    }
  });

  it('every signal declares comparableOn including repository, signalVersion and population, drawn from DIMENSIONS', async () => {
    const { SIGNALS, DIMENSIONS } = await loadOutcomeSignals();
    for (const signal of SIGNALS) {
      expect(Array.isArray(signal.comparableOn), signal.name).toBe(true);
      for (const dimension of ['repository', 'signalVersion', 'population']) {
        expect(signal.comparableOn, `${signal.name}.comparableOn`).toContain(dimension);
      }
      for (const dimension of signal.comparableOn) {
        expect(DIMENSIONS, `${signal.name}.comparableOn entry "${dimension}"`).toContain(dimension);
      }
    }
  });

  it('every signal declares groupBy (possibly empty) drawn from DIMENSIONS', async () => {
    const { SIGNALS, DIMENSIONS } = await loadOutcomeSignals();
    for (const signal of SIGNALS) {
      expect(Array.isArray(signal.groupBy), signal.name).toBe(true);
      for (const dimension of signal.groupBy) {
        expect(DIMENSIONS, `${signal.name}.groupBy entry "${dimension}"`).toContain(dimension);
      }
    }
  });

  it('tokens-per-ship alone is conditional and groups by harness', async () => {
    const { SIGNALS } = await loadOutcomeSignals();
    const tokensPerShip = SIGNALS.find((signal) => signal.name === 'tokens-per-ship');
    expect(tokensPerShip, 'tokens-per-ship must exist').toBeDefined();
    expect(tokensPerShip?.conditional).toBe(true);
    expect(tokensPerShip?.groupBy).toContain('harness');

    for (const signal of SIGNALS) {
      if (signal.name === 'tokens-per-ship') continue;
      expect(signal.conditional, `${signal.name}.conditional`).not.toBe(true);
    }
  });

  it('exports DIMENSIONS as the frozen allowed dimension vocabulary', async () => {
    const { DIMENSIONS } = await loadOutcomeSignals();
    expect(Object.isFrozen(DIMENSIONS)).toBe(true);
    expect([...DIMENSIONS].sort()).toEqual(
      ['repository', 'signalVersion', 'harness', 'lane', 'population'].sort(),
    );
  });

  it('exports frozen COMPARISON_RESULTS in the stated order, and the UNKNOWN sentinel', async () => {
    const { COMPARISON_RESULTS, UNKNOWN } = await loadOutcomeSignals();
    expect(Object.isFrozen(COMPARISON_RESULTS)).toBe(true);
    expect(COMPARISON_RESULTS).toEqual(['comparable', 'not comparable', 'insufficient']);
    expect(UNKNOWN).toBe('unknown');
  });
});

// RP-356's contract: "Outcome Evidence MUST NOT group, score, rank or compare
// humans." This test is the mechanical half of that sentence, and its scope
// is deliberately narrow — stated here so nobody infers cover that is not
// there (`.claude/rules/invariants.md`, "State the limits — and test them").
//
// What this test PROTECTS: every object key in `SIGNALS`, and every value
// `SIGNALS` or `DIMENSIONS` offers as a `comparableOn`/`groupBy` dimension —
// the module's own schema vocabulary, never anything else.
//
// What this test does NOT protect, by design:
//   - free-text VALUES inside `definition`, `source`, `population`, `unknown`
//     or `limits` strings (prose can legitimately discuss "the author of a
//     commit" while explaining why that is out of scope — this test does not
//     scan prose, only schema keys and dimension values);
//   - any encoding of the forbidden vocabulary that is not a literal schema
//     key or dimension value (an obfuscated string, a computed key);
//   - future OUTPUT code (RP-355 and beyond) that reads `groupBy` and then
//     bypasses it to group by something person-shaped at render time — this
//     module only has to offer `groupBy` as data for RP-355 to consume
//     correctly; whether a later consumer honours it is that consumer's test
//     to write, not this one's.
//
// The vocabulary below is an INDEPENDENT ORACLE: it is written here, by hand,
// and never imported from the module under test — so this test cannot be
// satisfied merely by the module checking its own work
// (`.claude/rules/invariants.md`, "The independent-oracle invariant").
const PERSON_IDENTITY_VOCABULARY = [
  'author',
  'assignee',
  'reviewer',
  'committer',
  'user',
  'username',
  'login',
  'email',
  'actor',
  'person',
  'people',
  'human',
  'member',
  'account',
  'owner',
  'team',
] as const;

export const GUARD_TEST_NAME =
  'never groups, scores, ranks, or compares humans — no SIGNALS key or dimension value names a person';

const namesAPerson = (value: string): boolean => {
  const lowered = value.toLowerCase();
  return PERSON_IDENTITY_VOCABULARY.some((term) => new RegExp(`\\b${term}\\b`).test(lowered));
};

/** Every object key anywhere inside `value`, recursively, arrays included. */
const deepKeys = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap((entry) => deepKeys(entry));
  if (value !== null && typeof value === 'object') {
    return [
      ...Object.keys(value as Record<string, unknown>),
      ...Object.values(value as Record<string, unknown>).flatMap((entry) => deepKeys(entry)),
    ];
  }
  return [];
};

describe('the no-person invariant (RP-356, Red)', () => {
  it(GUARD_TEST_NAME, async () => {
    const { SIGNALS, DIMENSIONS } = await loadOutcomeSignals();

    const offendingKeys = deepKeys(SIGNALS).filter((key) => namesAPerson(key));
    expect(offendingKeys, 'no SIGNALS object key may name a person').toEqual([]);

    const offendingDimensionValues = SIGNALS.flatMap((signal) => [
      ...signal.comparableOn,
      ...signal.groupBy,
    ]).filter((value) => namesAPerson(value));
    expect(offendingDimensionValues, 'no comparableOn/groupBy value may name a person').toEqual([]);

    // Second assertion (design item B): DIMENSIONS itself names no person.
    const offendingDimensions = DIMENSIONS.filter((value) => namesAPerson(value));
    expect(offendingDimensions, 'DIMENSIONS must name no person').toEqual([]);
  });
});

describe('outcome-signals.mjs is listed in layers.json under the workflow layer (RP-356, Red)', () => {
  it('appears in the workflow array, not the process array', async () => {
    const manifest = JSON.parse(await read(layersJsonPath)) as {
      process: string[];
      workflow: string[];
    };
    expect(manifest.workflow).toContain('.claude/scripts/lib/outcome-signals.mjs');
    expect(manifest.process).not.toContain('.claude/scripts/lib/outcome-signals.mjs');
  });
});

// --- Part C: templates/agent-os/universal/docs/decisions/outcome-signals.md ---

/** Rows of the form `| \`<signal-name>\` | <signalVersion> |`. */
const signalTableRowsIn = (markdown: string): Map<string, string> => {
  const rows = new Map<string, string>();
  for (const match of markdown.matchAll(/^\s*\|\s*`([a-z0-9-]+)`\s*\|\s*(\d+)\s*\|/gm)) {
    rows.set(match[1]!, match[2]!);
  }
  return rows;
};

describe('outcome-signals.md decision record (RP-356, Red)', () => {
  it('carries one table row per signal, naming its signalVersion, in correspondence with SIGNALS both directions', async () => {
    const { SIGNALS } = await loadOutcomeSignals();
    const markdown = await read(outcomeSignalsRecordPath);
    const rows = signalTableRowsIn(markdown);

    const missingRows = SIGNALS.filter((signal) => !rows.has(signal.name)).map((s) => s.name);
    expect(missingRows, 'every signal needs a table row').toEqual([]);

    const unknownRows = [...rows.keys()].filter(
      (name) => !SIGNALS.some((signal) => signal.name === name),
    );
    expect(unknownRows, 'no table row for a signal the module does not know').toEqual([]);

    for (const signal of SIGNALS) {
      expect(rows.get(signal.name), `${signal.name} row`).toBe(String(signal.signalVersion));
    }
  });

  it('states "unknown" is never zero and is excluded with its count shown', async () => {
    const markdown = await read(outcomeSignalsRecordPath);
    expect(markdown).toMatch(/unknown/i);
    expect(markdown.toLowerCase()).toMatch(/never\s+zero/);
    expect(markdown.toLowerCase()).toMatch(/count\s+shown/);
  });

  it('states comparisons are named run sets, never an implicit calendar window', async () => {
    const markdown = await read(outcomeSignalsRecordPath);
    expect(markdown.toLowerCase()).toMatch(/named\s+run\s+set/);
    expect(markdown.toLowerCase()).toMatch(/calendar\s+window/);
  });

  it('states a signalVersion mismatch is "not comparable", and insufficient coverage is "insufficient"', async () => {
    const markdown = await read(outcomeSignalsRecordPath);
    expect(markdown).toMatch(/signalVersion mismatch[^\n]*not comparable/i);
    expect(markdown.toLowerCase()).toMatch(/insufficient coverage[^\n]*insufficient/);
  });

  it('states a delta is descriptive unless the repository configures a direction', async () => {
    const markdown = await read(outcomeSignalsRecordPath);
    expect(markdown.toLowerCase()).toMatch(/descriptive/);
    expect(markdown.toLowerCase()).toMatch(/configures?\s+a\s+direction/);
  });

  it('calls claim-to-merge "total wall time", and uses "active engineering time" only inside a negating sentence', async () => {
    const markdown = await read(outcomeSignalsRecordPath);
    expect(markdown.toLowerCase()).toMatch(/total\s+wall\s+time/);

    const phrase = 'active engineering time';
    const lowered = markdown.toLowerCase();
    expect(lowered, 'the phrase must appear at least once').toContain(phrase);

    // Every sentence containing the phrase must also contain "not" or "never".
    const sentences = markdown.split(/(?<=[.!?])\s+/);
    const carryingPhrase = sentences.filter((sentence) => sentence.toLowerCase().includes(phrase));
    expect(carryingPhrase.length, 'at least one sentence must carry the phrase').toBeGreaterThan(0);
    for (const sentence of carryingPhrase) {
      const loweredSentence = sentence.toLowerCase();
      expect(
        loweredSentence.includes('not') || loweredSentence.includes('never'),
        `sentence must negate "active engineering time": ${sentence}`,
      ).toBe(true);
    }
  });

  it('cites the no-person invariant with a pointer to its exact guard test name', async () => {
    const markdown = await read(outcomeSignalsRecordPath);
    expect(markdown).toContain('test/template/outcome-signals.test.ts');
    expect(markdown).toContain(GUARD_TEST_NAME);
  });
});

// --- Part D: docs/decisions/outcome-interop.md (generator-only, repo root) ---

describe('outcome-interop.md generator-only record (RP-356, Red)', () => {
  it('exists at the repo root, not under templates/agent-os/universal', async () => {
    const markdown = await read(outcomeInteropRecordPath);
    expect(markdown.length).toBeGreaterThan(0);
    await expect(read(outcomeInteropTemplatePath)).rejects.toThrow();
  });

  it('carries the not-synced banner', async () => {
    const markdown = await read(outcomeInteropRecordPath);
    expect(markdown).toMatch(/not synced/i);
    expect(markdown).toMatch(/edit it in place/i);
  });

  it('names the acceptable CDEvents candidates', async () => {
    const markdown = await read(outcomeInteropRecordPath);
    const lowered = markdown.toLowerCase();
    expect(lowered).toMatch(/vcs change created/);
    expect(lowered).toMatch(/vcs change merged/);
    expect(lowered).toMatch(/change reviewed/);
    expect(lowered).toMatch(/outcome caveat/);
    expect(lowered).toMatch(/non-tdd-red/);
    expect(lowered).toMatch(/testsuiterun finished/);
    expect(lowered).toMatch(/testoutput published/);
  });

  it('lists every mapping that MUST NOT be made', async () => {
    const markdown = await read(outcomeInteropRecordPath);
    const lowered = markdown.toLowerCase();
    expect(lowered).toMatch(/agent dispatch is not a ci taskrun/);
    expect(lowered).toMatch(/intentional tdd red does not inflate generic test failure/);
    expect(lowered).toMatch(/rig claim\/close is not the tracker ticket source of truth/);
    expect(lowered).toMatch(/workflow escalation\/stall is not a production incident/);
    expect(lowered).toMatch(/evidence screenshot\/trace is not a build artifact with a purl/);
  });

  it('states no CDEvents exporter or sink is committed', async () => {
    const markdown = await read(outcomeInteropRecordPath);
    const lowered = markdown.toLowerCase();
    expect(lowered).toMatch(/no cdevents exporter/);
    expect(lowered).toMatch(/sink/);
    expect(lowered).toMatch(/committed/);
  });

  it('carries the future-descriptor note naming the scope binding and RP-312', async () => {
    const markdown = await read(outcomeInteropRecordPath);
    const lowered = markdown.toLowerCase();
    expect(lowered).toMatch(/head\/run\/window/);
    expect(lowered).toMatch(/window\/population\/metric/);
    expect(lowered).toMatch(/scope binding/);
    expect(markdown).toMatch(/RP-312/);
    expect(lowered).toMatch(/descriptor is not changed/);
  });
});
