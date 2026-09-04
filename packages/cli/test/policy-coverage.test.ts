import { describe, expect, it } from 'vitest';
import * as coverageModule from '../src/policy/core/coverage.js';
import {
  DEFAULT_DEGRADATION_THRESHOLD,
  coverageFromProbe,
  downgradesBetween,
  observeExpectedSignal,
  qualifierFor,
  statusOf,
  type CoverageEntry,
  type CoverageMap,
  type Downgrade,
  type SurfaceIdentity,
} from '../src/policy/core/coverage.js';
import {
  MAX_HOOK_COMMAND_LENGTH,
  MAX_NAMED_TOOLS_IN_REASON,
  probePolicy,
  type HookSnapshot,
} from '../src/policy/core/probe.js';
import { validateEvidenceRow, type EvidenceRow } from '../src/policy/core/evidence-matrix.js';
import { ISO_8601 } from '../src/policy/core/validation.js';
import {
  CAPABILITY_STATES,
  HARNESS_ADAPTERS,
  POLICIES,
  PROBE_TRIGGERS,
  SHARED_HOOKS_DIR,
  VERIFICATION_SOURCES,
  claudeAdapter,
  codexAdapter,
  definePolicy,
  findPolicy,
  validateDecisionRecord,
  type HarnessAdapter,
  type PolicyDeclaration,
  type Problem,
  type ProbeTrigger,
} from '../src/policy/index.js';

/**
 * RP-36: capability & degradation contract. A policy's status on a harness
 * surface is established ONCE, by a probe of that surface's own hook wiring,
 * and maintained PASSIVELY afterwards — by what real traffic was expected to
 * show and did not. Nothing here re-probes on a schedule, and no elapsed time
 * degrades anything: "no traffic" is not a failure, it is no evidence.
 *
 * The four things this file pins, each of which is an acceptance criterion of
 * the item:
 *
 * - the probe's four answers, including the loud one — a snapshot it can see
 *   and cannot read is `INTEGRATION-FAILED`, never a quiet pass, and that
 *   holds for wiring BELOW the `hooks` field too: an unreadable group beside a
 *   readable one is a partial read, and a partial read is never a pass;
 * - a hook counts as wired only when the hook path is the argument the command
 *   really EXECUTES — a mention of it in an echo, a comment, a `.bak`
 *   neighbour or the right-hand side of a `||` is not wiring;
 * - degradation happens only on an observed miss, only after a CONFIGURABLE
 *   number of them, and never past `DEGRADED` — except for the one
 *   contradiction traffic really can establish, a signal observed on a surface
 *   the map recorded as wiring nothing;
 * - a probe is occasioned by a named trigger from `PROBE_TRIGGERS` and records
 *   which one, so "nothing here re-probes on a schedule" is a required
 *   argument rather than a sentence;
 * - an unenforceable policy reaches the decision-record validator carrying
 *   `UNVERIFIABLE` — proven through the real validator, not a stub, because
 *   the link between the two modules is the property worth having;
 * - an evidence-matrix row without an exact harness version and an observed
 *   date-time is incomplete, and is refused as such.
 *
 * The acceptance half — the same probe against the snapshots this rig really
 * ships, on both harnesses, with the mutations that stop it being vacuous —
 * is `test/template/policy-coverage.test.ts`.
 */

const T0 = '2026-09-04T09:00:00Z';
const T1 = '2026-09-04T10:00:00Z';
const T2 = '2026-09-04T11:00:00Z';

const policyNamed = (policyId: string): PolicyDeclaration => {
  const policy = findPolicy(policyId);
  if (policy === null) throw new Error(`${policyId} is not a registered policy`);
  return policy;
};

const SECRET_WRITE = policyNamed('secret-write-refusal');
const NO_VERIFY = policyNamed('no-verify-refusal');

const EVENT = claudeAdapter.nativeSurfaceOf(SECRET_WRITE).event;

const SURFACE: SurfaceIdentity = {
  harness: 'fixture-harness',
  surface: 'fixture/hook-wiring.json',
  harnessVersion: '2.0.14',
  os: 'fixture-os 1.0',
};

type Group = { matcher: string; wiring: readonly PolicyDeclaration[] };

/**
 * The command this harness GENERATES for a policy's hook, read off the adapter
 * rather than spelled here.
 *
 * Every fixture below builds from this, which is the point: the probe answers
 * `SUPPORTED` by comparing a command against what the rig would generate, so a
 * fixture that spelled its own version of that command would be asserting its
 * own invention rather than the thing under test. `commands[0]` is the shell
 * spelling; an adapter may offer more than one, and only the first is needed to
 * build a wiring the probe must recognise.
 *
 * A full entry needs EVERY field the adapter generates for, which is what
 * `generatedEntry` below builds; this is the shell spelling alone, for the
 * cases that mutate one command's text.
 */
const generatedCommand = (adapter: HarnessAdapter, policy: PolicyDeclaration): string => {
  const command = adapter.nativeSurfaceOf(policy).commands['command']?.[0];
  if (command === undefined) {
    throw new Error(`the ${adapter.harness} adapter generates no command for ${policy.policyId}`);
  }
  return command;
};

/**
 * A policy the registry does not carry, standing in for one of the guards this
 * rig ships without declaring — so a fixture can wire ANOTHER mechanism's real
 * generated command and the probe has something unrelated to read.
 */
const CORE_PURITY = definePolicy({
  ...SECRET_WRITE,
  policyId: 'fixture-core-purity',
  mechanism: 'guard-core-purity',
});

/**
 * An in-memory hook-wiring snapshot, shaped like the ones the rig ships —
 * modelled on `snapshotWith` in `test/template/policy-declaration.test.ts`
 * rather than imported from it, so a change to that file's fixture cannot
 * silently re-aim this one.
 */
const snapshotWith = (
  event: string,
  groups: readonly Group[],
  adapter: HarnessAdapter = claudeAdapter,
): HookSnapshot => ({
  hooks: {
    [event]: groups.map(({ matcher, wiring }) => ({
      matcher,
      hooks: wiring.map((policy) => generatedEntry(adapter, policy)),
    })),
  },
});

/** Every registered policy wired exactly as the adapter says it should be. */
const fullyWired = (adapter: HarnessAdapter): HookSnapshot => {
  const byMatcher = new Map<string, PolicyDeclaration[]>();
  for (const policy of POLICIES) {
    const { matcher } = adapter.nativeSurfaceOf(policy);
    byMatcher.set(matcher, [...(byMatcher.get(matcher) ?? []), policy]);
  }
  const event = adapter.nativeSurfaceOf(SECRET_WRITE).event;
  return snapshotWith(
    event,
    [...byMatcher].map(([matcher, wiring]) => ({ matcher, wiring })),
    adapter,
  );
};

const dropLastTool = (matcher: string): { matcher: string; dropped: string } => {
  const tools = matcher.split('|');
  const dropped = tools.at(-1);
  if (dropped === undefined || tools.length < 2) {
    throw new Error(`the matcher ${matcher} has no tool to drop`);
  }
  return { matcher: tools.slice(0, -1).join('|'), dropped };
};

const SECRET_WRITE_SURFACE = claudeAdapter.nativeSurfaceOf(SECRET_WRITE);

/**
 * The declared matcher for the file-edit policy, wiring exactly the commands
 * given — verbatim, not assembled from the mechanism name. The wiring is what
 * is under test in the "runs" group below, so the command has to be the
 * fixture rather than something a helper spells for it.
 */
const runningExactly = (...commands: readonly string[]): unknown => ({
  hooks: {
    [EVENT]: [
      {
        matcher: SECRET_WRITE_SURFACE.matcher,
        // The other fields carry what the harness generates, so a case that
        // mutates `command` measures that field and not a missing sibling.
        hooks: commands.map((command) => ({
          ...generatedEntry(claudeAdapter, SECRET_WRITE),
          command,
        })),
      },
    ],
  },
});

const entryWith = (overrides: Partial<CoverageEntry> = {}): CoverageEntry => ({
  policyId: SECRET_WRITE.policyId,
  policyVersion: SECRET_WRITE.policyVersion,
  mechanism: SECRET_WRITE.mechanism,
  status: 'SUPPORTED',
  verifiedAt: T0,
  verifiedBy: 'probe',
  triggeredBy: 'install',
  consecutiveMisses: 0,
  ...overrides,
});

const mapOf = (entries: readonly CoverageEntry[]): CoverageMap => ({
  surface: SURFACE,
  entries,
});

const entryFrom = (map: CoverageMap, policyId: string): CoverageEntry => {
  const entry = statusOf(map, policyId);
  if (entry === null) throw new Error(`the coverage map carries no entry for ${policyId}`);
  return entry;
};

describe('the verification vocabularies are closed, and none of them names a timer', () => {
  it('names the two ways a status is established: a probe, and real traffic', () => {
    expect([...VERIFICATION_SOURCES]).toEqual(['probe', 'traffic']);
    expect(Object.isFrozen(VERIFICATION_SOURCES)).toBe(true);
  });

  it('names the events that occasion a probe, all of them a change to the surface', () => {
    expect([...PROBE_TRIGGERS]).toEqual(['install', 'upgrade', 'registration', 'reconnect']);
    expect(Object.isFrozen(PROBE_TRIGGERS)).toBe(true);
  });

  it.each(PROBE_TRIGGERS)(
    'the trigger %s is an event on the surface, not the passage of time',
    (trigger) => {
      expect(trigger).not.toMatch(/periodic|interval|schedule|timer|poll|cron/i);
    },
  );
});

describe('probing a surface for one policy', () => {
  it.each(HARNESS_ADAPTERS.map((adapter) => [adapter.harness, adapter] as const))(
    'reads every registered policy as SUPPORTED when the %s wiring matches the declaration exactly',
    (_harness, adapter) => {
      const snapshot = fullyWired(adapter);
      expect(
        POLICIES.map((policy) => [policy.policyId, probePolicy(policy, adapter, snapshot)]),
      ).toEqual(POLICIES.map((policy) => [policy.policyId, { state: 'SUPPORTED' }]));
    },
  );

  it('reports no reason when the policy is supported, because there is nothing to explain', () => {
    expect(
      probePolicy(SECRET_WRITE, claudeAdapter, fullyWired(claudeAdapter)).reason,
    ).toBeUndefined();
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'PreToolUse'],
    ['a number', 42],
    ['a list', ['PreToolUse']],
  ])(
    'refuses %s as a snapshot: the evidence cannot be read, so the answer is INTEGRATION-FAILED',
    (_case, snapshot) => {
      const result = probePolicy(SECRET_WRITE, claudeAdapter, snapshot);
      expect(result.state).toBe('INTEGRATION-FAILED');
      expect(result.reason ?? '').toContain('hooks');
    },
  );

  it.each([
    ['a string', { hooks: 'none' }],
    ['null', { hooks: null }],
    ['a list', { hooks: [{ matcher: 'Write' }] }],
    // An array is an object to `typeof`, so an empty one is the case that would
    // fall through a bare typeof check and be read as "nothing wired". It is
    // the UNREADABLE case, not the absent one: `hooks` WAS supplied, in a shape
    // a record reader rejects (`isRecord` in core/validation.ts excludes
    // arrays), so the probe reports that it could not read what it was handed
    // rather than reporting a zero it never counted.
    ['an empty list', { hooks: [] }],
    ['a number', { hooks: 0 }],
  ])('refuses a snapshot whose hooks is %s, naming the shape it expected', (_case, snapshot) => {
    const result = probePolicy(SECRET_WRITE, claudeAdapter, snapshot);
    expect(result.state).toBe('INTEGRATION-FAILED');
    expect(result.reason ?? '').toContain('hooks');
  });

  // The group above and the one below are the ABSENT/UNREADABLE distinction of
  // `rules/invariants.md`, "Refusing to inspect is a third outcome, not a match
  // and not an error": a field that is simply ABSENT leaves the reader nothing
  // to judge — the snapshot is readable and says no mechanism is wired here —
  // while a field PRESENT in a shape the reader does not accept is the refusal
  // case, and reporting that is the one thing the probe is for. They must not
  // be simplified into one branch: collapsing them either turns an honest "the
  // rig is not installed on this surface" into a false alarm, or turns a
  // surface whose wiring cannot be read into a quiet, uncounted zero.
  //
  // The same pair recurs one level down, and the UNREADABLE half of THAT is
  // the describe "wiring below the hooks field that cannot be read is
  // reported, not dropped" further down this file. The cases immediately below
  // are the ABSENT half at both levels: the event key is not there at all, so
  // there is nothing to fail to read.
  it.each([
    ['carries no hooks key at all', {}],
    ['carries an empty hooks object', { hooks: {} }],
    ['wires groups only under another event', { hooks: { SomeOtherEvent: [] } }],
  ])(
    'reads a readable snapshot that %s as UNSUPPORTED, naming the hook path it looked for',
    (_case, snapshot) => {
      const { hookPath } = claudeAdapter.nativeSurfaceOf(SECRET_WRITE);
      const result = probePolicy(SECRET_WRITE, claudeAdapter, snapshot);
      expect(result.state).toBe('UNSUPPORTED');
      expect(result.reason ?? '').toContain(hookPath);
    },
  );

  it('cannot pass silently on a readable snapshot that wires nothing, because that state is UNVERIFIABLE', () => {
    const { state } = probePolicy(SECRET_WRITE, claudeAdapter, {});
    expect(state).toBe('UNSUPPORTED');
    expect(qualifierFor(state)).toBe('UNVERIFIABLE');
  });

  it('reads a hook wired nowhere under the policy event as UNSUPPORTED, naming the hook path', () => {
    const { hookPath } = claudeAdapter.nativeSurfaceOf(SECRET_WRITE);
    const result = probePolicy(SECRET_WRITE, claudeAdapter, snapshotWith(EVENT, []));
    expect(result.state).toBe('UNSUPPORTED');
    expect(result.reason ?? '').toContain(hookPath);
  });

  it('reads a policy as UNSUPPORTED when only other hooks are wired under its event', () => {
    const { matcher, hookPath } = claudeAdapter.nativeSurfaceOf(SECRET_WRITE);
    const snapshot = snapshotWith(EVENT, [{ matcher, wiring: [CORE_PURITY] }]);
    const result = probePolicy(SECRET_WRITE, claudeAdapter, snapshot);
    expect(result.state).toBe('UNSUPPORTED');
    expect(result.reason ?? '').toContain(hookPath);
  });

  it('reads a hook wired under a different event as UNSUPPORTED, because the event is part of the surface', () => {
    const { matcher, hookPath } = claudeAdapter.nativeSurfaceOf(SECRET_WRITE);
    const elsewhere = snapshotWith('PostToolUse', [{ matcher, wiring: [SECRET_WRITE] }]);
    const result = probePolicy(SECRET_WRITE, claudeAdapter, elsewhere);
    expect(result.state).toBe('UNSUPPORTED');
    expect(result.reason ?? '').toContain(hookPath);
  });

  it('reads a wiring that drops a declared tool as DEGRADED, naming the tool that is missing', () => {
    const surface = claudeAdapter.nativeSurfaceOf(SECRET_WRITE);
    const { matcher, dropped } = dropLastTool(surface.matcher);
    const snapshot = snapshotWith(EVENT, [{ matcher, wiring: [SECRET_WRITE] }]);
    const result = probePolicy(SECRET_WRITE, claudeAdapter, snapshot);
    expect(result.state).toBe('DEGRADED');
    expect(result.reason ?? '').toContain(dropped);
  });

  it('reads a wiring that adds a tool the declaration does not name as DEGRADED, naming that tool', () => {
    const surface = claudeAdapter.nativeSurfaceOf(SECRET_WRITE);
    const snapshot = snapshotWith(EVENT, [
      { matcher: `${surface.matcher}|Task`, wiring: [SECRET_WRITE] },
    ]);
    const result = probePolicy(SECRET_WRITE, claudeAdapter, snapshot);
    expect(result.state).toBe('DEGRADED');
    expect(result.reason ?? '').toContain('Task');
  });

  it('reads the shell policy as DEGRADED on its own account when the file-edit wiring is intact', () => {
    const shell = claudeAdapter.nativeSurfaceOf(NO_VERIFY);
    const edit = claudeAdapter.nativeSurfaceOf(SECRET_WRITE);
    const { matcher, dropped } = dropLastTool(shell.matcher);
    const snapshot = snapshotWith(EVENT, [
      { matcher: edit.matcher, wiring: [SECRET_WRITE] },
      { matcher, wiring: [NO_VERIFY] },
    ]);
    expect(probePolicy(SECRET_WRITE, claudeAdapter, snapshot).state).toBe('SUPPORTED');
    const result = probePolicy(NO_VERIFY, claudeAdapter, snapshot);
    expect(result.state).toBe('DEGRADED');
    expect(result.reason ?? '').toContain(dropped);
  });

  it('is SUPPORTED when one group matches the declaration exactly, even though another does not', () => {
    const surface = claudeAdapter.nativeSurfaceOf(SECRET_WRITE);
    const { matcher } = dropLastTool(surface.matcher);
    const snapshot = snapshotWith(EVENT, [
      { matcher, wiring: [SECRET_WRITE] },
      { matcher: surface.matcher, wiring: [SECRET_WRITE] },
    ]);
    expect(probePolicy(SECRET_WRITE, claudeAdapter, snapshot)).toEqual({ state: 'SUPPORTED' });
  });
});

/**
 * A hook counts as wired when the command IS the one this harness generates —
 * not when a parse of it concludes that a shell would probably run the hook.
 *
 * Three rounds of the second design closed one class of false `SUPPORTED` each
 * and opened the next, and the last of them could not be tightened further
 * without refusing the wiring the rig itself ships: `X="$(exit 1)" && node
 * <hook>` is an assignment whose command substitution can fail, and it is
 * structurally the shape of the derived harness's own command. So the parse is
 * gone. The rig GENERATES its wiring, so the probe compares against what it
 * would have generated:
 *
 * - **RUNS** — the command normalises to one the adapter declares in
 *   `commands`. `normalise` is trim plus collapsing runs of spaces and tabs;
 *   nothing is tokenised, unquoted or split.
 * - **UNREADABLE** — not RUNS, and either past the length cap (unread) or
 *   naming the hook path in a spelling this harness does not generate.
 * - **UNRELATED** — everything else: another mechanism's hook, wired normally.
 *
 * The inversion that makes this safe is the whole point of the redesign, and
 * it has a test of its own: `includes(hookPath)` survives, but only to choose
 * between `INTEGRATION-FAILED` and `UNSUPPORTED` — two non-passing answers. A
 * substring false positive can no longer reach `SUPPORTED`.
 */
// Verbatim from the two snapshots this rig ships —
// `templates/agent-os/universal/.claude/settings.json` and
// `templates/agent-os/universal/.codex/hooks.json`. Copied rather than read
// here so this stays a unit test; `test/template/policy-coverage.test.ts`
// probes the real files and mutates them. Module-scoped rather than declared
// inside one describe because four groups below pin the same two strings, and
// two spellings of one fact are two things to keep in step.
const REAL_AUTHORING_COMMAND = 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-secret-file.mjs"';
const REAL_DERIVED_COMMAND =
  'repoRoot="$(git rev-parse --show-toplevel)" && CLAUDE_PROJECT_DIR="$repoRoot" node "$repoRoot/.claude/hooks/guard-secret-file.mjs"';

/**
 * Each harness beside the command ITS OWN snapshot really carries. Paired this
 * way on purpose: the spelling of a wiring is a fact about the harness that
 * generates it, so a command is only evidence about the adapter that ships it.
 */
const SHIPPED_BY_ITS_OWN_HARNESS = [
  ['claude', claudeAdapter, REAL_AUTHORING_COMMAND],
  ['codex', codexAdapter, REAL_DERIVED_COMMAND],
] as const;

/** Every adapter, labelled by harness, for an `it.each` over both surfaces. */
const EACH_ADAPTER = HARNESS_ADAPTERS.map((adapter) => [adapter.harness, adapter] as const);

const escapeForRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The `$VAR/<hookPath>` a generated command roots its hook path at. */
const rootedPath = (hookPath: string): RegExp =>
  new RegExp(`\\$([A-Za-z_][A-Za-z0-9_]*)/${escapeForRegExp(hookPath)}`);

/** The declared matcher of one adapter, wiring exactly the commands given. */
const runningOn = (adapter: HarnessAdapter, ...commands: readonly string[]): unknown => {
  const surface = adapter.nativeSurfaceOf(SECRET_WRITE);
  return {
    hooks: {
      [surface.event]: [
        {
          matcher: surface.matcher,
          hooks: commands.map((command) => ({
            ...generatedEntry(adapter, SECRET_WRITE),
            command,
          })),
        },
      ],
    },
  };
};

/**
 * The adapter is now the source of the wiring the probe recognises, so what it
 * offers is itself part of the contract: a list of commands, each naming the
 * hook path it runs, and no list of root variables — because nothing strips a
 * prefix any more.
 */
describe('a harness adapter states the commands it generates for a hook', () => {
  it.each(EACH_ADAPTER)(
    'the %s surface offers at least one generated command, each naming the hook path it runs',
    (_harness, adapter) => {
      const surface = adapter.nativeSurfaceOf(SECRET_WRITE);
      const fields = Object.entries(surface.commands);
      expect(fields.length, 'the adapter generates no command at all').toBeGreaterThan(0);
      for (const [field, spellings] of fields) {
        expect(Array.isArray(spellings), `${field} does not carry a list of spellings`).toBe(true);
        expect(spellings.length, `${field} offers no spelling`).toBeGreaterThan(0);
        for (const command of spellings) {
          expect(typeof command).toBe('string');
        }
      }
      // Only the shell spelling has to name the path literally: an encoded
      // wrapper carries it inside its payload, which is exactly why the probe
      // compares whole commands rather than searching them.
      expect(
        surface.commands['command']?.[0],
        'the generated shell command does not name the hook it runs',
      ).toContain(surface.hookPath);
    },
  );

  it.each(EACH_ADAPTER)(
    'the %s surface no longer names root variables, because no prefix is stripped from anything',
    (_harness, adapter) => {
      expect(adapter.nativeSurfaceOf(SECRET_WRITE)).not.toHaveProperty('hookRootVariables');
    },
  );

  it('generates a distinct command per policy, so one policy is never read off another wiring', () => {
    const commands = POLICIES.map((policy) => generatedCommand(claudeAdapter, policy));
    expect(new Set(commands).size).toBe(POLICIES.length);
  });
});

/** A hook-entry FIELD name → the command spellings this harness accepts in it. */
type FieldSpellings = Readonly<Record<string, readonly string[]>>;

const isFieldSpellings = (value: unknown): value is FieldSpellings => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const fields: [string, unknown][] = Object.entries(value);
  return (
    fields.length > 0 &&
    fields.every(
      ([field, spellings]) =>
        field !== '' &&
        Array.isArray(spellings) &&
        spellings.length > 0 &&
        spellings.every((spelling: unknown) => typeof spelling === 'string'),
    )
  );
};

/**
 * What this harness generates for a hook, per hook-entry field.
 *
 * Read through a guard rather than indexed, so an adapter that cannot say which
 * FIELD a command belongs to fails with that sentence — instead of quietly
 * handing back the first character of a string, which is what indexing a
 * flat list of commands by field name would produce.
 */
const fieldSpellingsOf = (adapter: HarnessAdapter, policy: PolicyDeclaration): FieldSpellings => {
  // Read through `unknown` because the property's declared type is exactly what
  // is under test here: a flat list of commands cannot say which hook-entry
  // field each of them is the spelling for.
  const declared: unknown = adapter.nativeSurfaceOf(policy).commands;
  if (!isFieldSpellings(declared)) {
    throw new Error(
      `the ${adapter.harness} adapter does not name the hook-entry field each command it generates belongs to; it states ${JSON.stringify(declared)}`,
    );
  }
  return declared;
};

/** The hook entry this harness generates: every field it names, in its first spelling. */
const generatedEntry = (
  adapter: HarnessAdapter,
  policy: PolicyDeclaration,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(fieldSpellingsOf(adapter, policy)).map(([field, spellings]) => {
      const first = spellings[0];
      if (first === undefined) {
        throw new Error(`the ${adapter.harness} adapter states no spelling for the field ${field}`);
      }
      return [field, first];
    }),
  );

/** The adapter's own event and matcher, wiring exactly the hook entries given. */
const wiringEntries = (
  adapter: HarnessAdapter,
  policy: PolicyDeclaration,
  ...entries: readonly unknown[]
): unknown => {
  const surface = adapter.nativeSurfaceOf(policy);
  return { hooks: { [surface.event]: [{ matcher: surface.matcher, hooks: entries }] } };
};

/**
 * A hook entry is not one command.
 *
 * The derived harness ships TWO per entry — the portable one it runs on macOS
 * and Linux, and a second field it runs on Windows — and a probe that compares
 * only the first credits a surface for a command nobody looked at. Measured on
 * the file this rig really ships, not on a fixture: replacing every Windows
 * spelling in `templates/agent-os/universal/.codex/hooks.json` with `echo
 * "guard disabled"` left all three registered policies `SUPPORTED`. The
 * acceptance half of that measurement is `test/template/policy-coverage.test.ts`
 * › "reports %s policy %s as not SUPPORTED when any one command field of its
 * shipped entry carries a different command (mutation: one spelling replaced)".
 *
 * So what an adapter generates is a MAPPING from hook-entry field to the
 * spellings accepted there, and an entry runs the hook only when every field the
 * adapter names is present and matches. A named field that is missing, not a
 * string, or spelled otherwise leaves an entry this cannot verify.
 *
 * The fields are read off the adapter INSIDE each test rather than tabled at
 * collection time: an `it.each` table is built when the module is evaluated, so
 * an adapter that cannot answer would stop the whole file from collecting
 * instead of failing the tests that ask it.
 */
describe('a hook entry runs the hook only when every field the harness generates for it matches', () => {
  const DISABLED = 'echo "guard disabled"';

  it.each(EACH_ADAPTER)(
    'the %s surface names a hook-entry field for every command it generates, and a spelling for each',
    (_harness, adapter) => {
      const spellings = fieldSpellingsOf(adapter, SECRET_WRITE);
      expect(Object.keys(spellings).length, 'the adapter names no field at all').toBeGreaterThan(0);
      expect(
        Object.entries(spellings).map(([field, accepted]) => [field, accepted.length > 0]),
        'a field the adapter names carries no spelling of the command',
      ).toEqual(Object.keys(spellings).map((field) => [field, true]));
    },
  );

  it.each(EACH_ADAPTER)(
    'reads a %s entry carrying every field that harness generates, in the spelling it generates, as SUPPORTED',
    (_harness, adapter) => {
      const entry = generatedEntry(adapter, SECRET_WRITE);
      expect(
        probePolicy(SECRET_WRITE, adapter, wiringEntries(adapter, SECRET_WRITE, entry)),
      ).toEqual({ state: 'SUPPORTED' });
    },
  );

  it.each(EACH_ADAPTER)(
    'refuses a %s entry in which any one field that harness generates carries a different command',
    (_harness, adapter) => {
      const entry = generatedEntry(adapter, SECRET_WRITE);
      const fields = Object.keys(entry);
      const answers = fields.map(
        (field) =>
          [
            field,
            probePolicy(
              SECRET_WRITE,
              adapter,
              wiringEntries(adapter, SECRET_WRITE, { ...entry, [field]: DISABLED }),
            ).state,
          ] as const,
      );
      expect(
        answers.filter(([, state]) => state === 'SUPPORTED'),
        'a field this harness generates a command for carried another command, and the wiring still read as enforcement',
      ).toEqual([]);
    },
  );

  it.each(EACH_ADAPTER)(
    'refuses a %s entry that omits a field that harness generates',
    (_harness, adapter) => {
      const entry = generatedEntry(adapter, SECRET_WRITE);
      const fields = Object.keys(entry);
      const answers = fields.map((field) => {
        const without = Object.fromEntries(
          Object.entries(entry).filter(([name]) => name !== field),
        );
        return [
          field,
          probePolicy(SECRET_WRITE, adapter, wiringEntries(adapter, SECRET_WRITE, without)).state,
        ] as const;
      });
      expect(
        answers.filter(([, state]) => state === 'SUPPORTED'),
        'a field this harness generates a command for was absent, and the wiring still read as enforcement',
      ).toEqual([]);
    },
  );

  it.each(EACH_ADAPTER)(
    'reports INTEGRATION-FAILED when a field the %s harness generates is present in a shape it cannot read',
    (_harness, adapter) => {
      const entry = generatedEntry(adapter, SECRET_WRITE);
      const fields = Object.keys(entry);
      const answers = fields.map((field) => [
        field,
        probePolicy(
          SECRET_WRITE,
          adapter,
          wiringEntries(adapter, SECRET_WRITE, { ...entry, [field]: 42 }),
        ).state,
      ]);
      expect(answers).toEqual(fields.map((field) => [field, 'INTEGRATION-FAILED']));
    },
  );

  /**
   * The other half of the rule, and the half that keeps it from firing on
   * honest work: the entry must carry every field the adapter NAMES, not every
   * field that looks like a command. The shipped surfaces already carry fields
   * no adapter generates — `type` on both, `timeout` on one — and a harness
   * that grows a platform this rig does not target would add another.
   */
  it.each(EACH_ADAPTER)(
    'still reads a %s entry carrying a command field that harness generates nothing for, because the rule is about the fields it does',
    (_harness, adapter) => {
      const entry = generatedEntry(adapter, SECRET_WRITE);
      const undeclared = 'commandLegacy';
      expect(
        Object.keys(entry),
        'the adapter generates a spelling for this field after all, so it pins nothing',
      ).not.toContain(undeclared);
      expect(
        probePolicy(
          SECRET_WRITE,
          adapter,
          wiringEntries(adapter, SECRET_WRITE, {
            ...entry,
            type: 'command',
            [undeclared]: DISABLED,
          }),
        ),
      ).toEqual({ state: 'SUPPORTED' });
    },
  );
});

/**
 * A command of a given length that names no hook, for pinning the length cap.
 *
 * The scan is bounded, and the bound is a number the caller can read rather
 * than a constant buried in the module: `rules/invariants.md`, "A guard that
 * fails open must do provably bounded work".
 *
 * The two sides of the bound are told apart on a command that does NOT name
 * the hook path, because that is the only input the cap changes the answer
 * for: inside the cap it is read and found to be another mechanism's business
 * (`UNSUPPORTED`), past it the command is not read at all, and an unread
 * command is not evidence of absence (`INTEGRATION-FAILED`). Measured on a
 * command that mentions the hook, both sides answer `INTEGRATION-FAILED` and
 * the cap would be pinned by a test that cannot go red.
 *
 * Module-scoped because two describes need it: the one that pins the cap, and
 * the one that pins what the refusal past the cap SAYS.
 */
const unrelatedOfLength = (length: number): string => {
  const head = `node "$CLAUDE_PROJECT_DIR/${SHARED_HOOKS_DIR}/other-`;
  const tail = '.mjs"';
  const filler = length - head.length - tail.length;
  if (filler < 1) {
    throw new Error(`the cap ${String(length)} is too small to pad a command up to`);
  }
  return `${head}${'x'.repeat(filler)}${tail}`;
};

describe('a command wires the hook only when it is the command this harness generates', () => {
  const { hookPath } = SECRET_WRITE_SURFACE;

  // The literals copied off the two shipped snapshots are held to the adapter's
  // own answer, in both directions at once: this is the unit-level half of "the
  // probe compares against what the rig would generate", and it goes red either
  // if an adapter changes its spelling or if the copy here goes stale.
  it.each([
    ['the authoring harness', claudeAdapter, REAL_AUTHORING_COMMAND],
    ['the derived harness', codexAdapter, REAL_DERIVED_COMMAND],
  ] as const)(
    '%s generates exactly the command its shipped snapshot carries',
    (_harness, adapter, shipped) => {
      expect(
        shipped,
        'the copied literal no longer names the hook the adapter points at',
      ).toContain(adapter.nativeSurfaceOf(SECRET_WRITE).hookPath);
      expect(generatedCommand(adapter, SECRET_WRITE)).toBe(shipped);
    },
  );

  it.each(SHIPPED_BY_ITS_OWN_HARNESS)(
    'reads the real %s command as running the hook, because it is what the rig really ships',
    (_harness, adapter, command) => {
      expect(probePolicy(SECRET_WRITE, adapter, runningOn(adapter, command))).toEqual({
        state: 'SUPPORTED',
      });
    },
  );

  /**
   * Each shipped command read through the OTHER harness's adapter. The two
   * spellings name the same hook file, so a substring read calls both a wiring;
   * a comparison against what THIS harness generates calls the foreign one what
   * it is — a spelling this adapter cannot verify.
   */
  it.each([
    [
      'the authoring harness command through the derived adapter',
      codexAdapter,
      REAL_AUTHORING_COMMAND,
    ],
    [
      'the derived harness command through the authoring adapter',
      claudeAdapter,
      REAL_DERIVED_COMMAND,
    ],
  ] as const)(
    'refuses %s, because it is not a spelling this harness generates',
    (_case, adapter, command) => {
      const surface = adapter.nativeSurfaceOf(SECRET_WRITE);
      expect(command, 'the two harnesses no longer name one hook file').toContain(surface.hookPath);
      const result = probePolicy(SECRET_WRITE, adapter, runningOn(adapter, command));
      expect(result.state, 'one harness command was read as the other harness wiring').toBe(
        'INTEGRATION-FAILED',
      );
      expect(result.reason ?? '').toContain(surface.hookPath);
    },
  );

  /**
   * The spellings a shell WOULD run, and which the old parse accepted around
   * the path: a flag, the two ways a shell spells a variable prefix, a relative
   * prefix and no prefix at all. Under canonical comparison every one of them is
   * a spelling this harness does not generate, so none of them can be verified —
   * which is the deliberate understatement the redesign trades a parser for.
   */
  it.each([
    ['a flag before the path', `node --experimental-strip-types "$CLAUDE_PROJECT_DIR/${hookPath}"`],
    ['a braced variable prefix', `node "\${CLAUDE_PROJECT_DIR}/${hookPath}"`],
    ['an unquoted variable prefix', `node $CLAUDE_PROJECT_DIR/${hookPath}`],
    ['a relative prefix', `node ./${hookPath}`],
    ['no prefix at all', `node ${hookPath}`],
  ])(
    'refuses %s, because a hand-written wiring is a spelling this harness cannot verify',
    (_case, command) => {
      const result = probePolicy(SECRET_WRITE, claudeAdapter, runningExactly(command));
      expect(result.state).toBe('INTEGRATION-FAILED');
      expect(result.reason ?? '').toContain(hookPath);
    },
  );

  it.each([
    [
      'a neighbouring file whose name merely begins with the hook path',
      `node "$CLAUDE_PROJECT_DIR/${hookPath}.bak"`,
    ],
    ['a disabled copy of the hook', `node "$CLAUDE_PROJECT_DIR/${hookPath}.disabled"`],
    ['a command that only prints the hook path', `echo "${hookPath}"`],
    ['a commented-out wiring', `# node ${hookPath}`],
    [
      'the hook path handed as an argument to a different program',
      `node ${SHARED_HOOKS_DIR}/other.mjs --skip ${hookPath}`,
    ],
    ['a copy of the hook vendored under another tree', `node vendor/evil/${hookPath}`],
    ['a wiring that runs only when something else fails', `true || node ${hookPath}`],
    ['a second command sequenced after it', `node ${hookPath} ; echo done`],
    ['a pipeline', `node ${hookPath} | tee wiring.log`],
  ])(
    'reads %s as INTEGRATION-FAILED, because something names this hook in a spelling it cannot verify',
    (_case, command) => {
      const result = probePolicy(SECRET_WRITE, claudeAdapter, runningExactly(command));
      expect(result.state, `the command ${command} was read as enforcement`).toBe(
        'INTEGRATION-FAILED',
      );
      expect(result.reason ?? '').toContain(hookPath);
    },
  );

  /**
   * The headline property of the redesign, stated as its own case rather than
   * left to be inferred from the table above. `includes(hookPath)` is still
   * used — but only to choose between `INTEGRATION-FAILED` and `UNSUPPORTED`,
   * which are both non-passing. A substring false positive costs an operator a
   * look at a file; it can no longer cost the contract a false `SUPPORTED`.
   */
  it('never reaches SUPPORTED from a mere mention of the hook path, whichever spelling the mention takes', () => {
    const mentions = [
      `node "$CLAUDE_PROJECT_DIR/${hookPath}.bak"`,
      `echo "${hookPath}"`,
      `# node ${hookPath}`,
      `node vendor/evil/${hookPath}`,
      `node "$HOME/${hookPath}"`,
      `false && node ${hookPath}`,
      `node ${hookPath} &`,
    ];
    expect(
      mentions.map(
        (command) => probePolicy(SECRET_WRITE, claudeAdapter, runningExactly(command)).state,
      ),
    ).toEqual(mentions.map(() => 'INTEGRATION-FAILED'));
  });

  it('states its command-length cap as a whole number, and one that admits the commands the rig ships', () => {
    expect(Number.isInteger(MAX_HOOK_COMMAND_LENGTH)).toBe(true);
    expect(MAX_HOOK_COMMAND_LENGTH).toBeGreaterThan(REAL_DERIVED_COMMAND.length);
  });

  it('still reads a command exactly at the cap, and finds an unrelated one to be an absence', () => {
    const command = unrelatedOfLength(MAX_HOOK_COMMAND_LENGTH);
    expect(command).toHaveLength(MAX_HOOK_COMMAND_LENGTH);
    expect(
      command,
      'the padded command names the hook, so the cap is not what is measured',
    ).not.toContain(hookPath);
    const result = probePolicy(SECRET_WRITE, claudeAdapter, runningExactly(command));
    expect(result.state, 'a command inside the cap was not read at all').toBe('UNSUPPORTED');
  });

  it('refuses a command one byte over the cap rather than reading it, even though it names no hook', () => {
    const command = unrelatedOfLength(MAX_HOOK_COMMAND_LENGTH + 1);
    expect(command).toHaveLength(MAX_HOOK_COMMAND_LENGTH + 1);
    expect(command).not.toContain(hookPath);
    const result = probePolicy(SECRET_WRITE, claudeAdapter, runningExactly(command));
    expect(result.state, 'a command too long to read was reported as a plain absence').toBe(
      'INTEGRATION-FAILED',
    );
    const reason = result.reason ?? '';
    expect(reason, 'a refusal with no reason is not evidence').not.toBe('');
    expect(
      reason.length,
      `an operator-facing reason of ${String(reason.length)} characters quoted the command back`,
    ).toBeLessThan(400);
  });

  it('still reads the command it generates as SUPPORTED, so the cap admits everything it claims to', () => {
    expect(
      probePolicy(
        SECRET_WRITE,
        claudeAdapter,
        runningExactly(generatedCommand(claudeAdapter, SECRET_WRITE)),
      ),
    ).toEqual({ state: 'SUPPORTED' });
  });

  /**
   * A command it could not verify came off a file on disk, so the refusal that
   * names it is untrusted input on its way to a terminal — the same rule the
   * degraded reason already lives under, applied to the branch this redesign
   * adds. This case is also the newline separator of the six shapes the last
   * parser round left open.
   */
  it('does not let a command it could not verify forge a line of the report', () => {
    const forged = `${generatedCommand(claudeAdapter, SECRET_WRITE)}\n\u001b[31mSUPPORTED: all guards enforced\u001b[0m`;
    const result = probePolicy(SECRET_WRITE, claudeAdapter, runningExactly(forged));
    expect(result.state, 'a command with a second line after it was read as enforcement').toBe(
      'INTEGRATION-FAILED',
    );
    const reason = result.reason ?? '';
    expect(reason, 'a raw ANSI escape reached an operator-facing diagnostic').not.toContain(
      '\u001b',
    );
    expect(reason, 'a raw newline let the command forge a line of its own').not.toContain('\n');
  });
});

/**
 * A refusal is stored on a coverage entry and shown to an operator, so the
 * cause it states has to be the cause that happened. Two different things end
 * in `INTEGRATION-FAILED`, and they ask for different actions:
 *
 * - a command was READ, and names the hook in a spelling this harness does not
 *   generate — a tampered or hand-edited surface, worth opening the file for;
 * - a command was NOT READ at all, being past the length cap — nothing was
 *   observed about it, including whether it names the hook.
 *
 * Reporting the second as the first asserts an observation that did not occur.
 * The cap's own test asserts only that the reason is non-empty and short, which
 * is satisfied by the wrong sentence, so the two causes are pinned here
 * separately and pinned APART: one sentence serving both is a diagnostic that
 * cannot direct anyone anywhere.
 */
describe('a refusal states the cause that really happened, and the two causes do not read alike', () => {
  const { hookPath } = SECRET_WRITE_SURFACE;
  const tooLong = unrelatedOfLength(MAX_HOOK_COMMAND_LENGTH + 1);
  const commented = `# ${REAL_AUTHORING_COMMAND}`;

  const refusalOf = (command: string) =>
    probePolicy(SECRET_WRITE, claudeAdapter, runningExactly(command));

  it('says a command past the cap was not read, instead of claiming something named the hook', () => {
    expect(
      tooLong,
      'the padded command names the hook, so this measures the other cause',
    ).not.toContain(hookPath);
    const result = refusalOf(tooLong);
    expect(result.state).toBe('INTEGRATION-FAILED');
    const reason = result.reason ?? '';
    expect(
      reason,
      'the refusal reports that something named the hook, which nothing in this wiring did',
    ).not.toContain(`names ${hookPath}`);
    expect(reason, 'the refusal does not say the command was too long to read').toMatch(
      new RegExp(`${String(MAX_HOOK_COMMAND_LENGTH)}|too long|not read|never read|unread`, 'i'),
    );
    expect(
      reason.length,
      `an operator-facing reason of ${String(reason.length)} characters quoted the command back`,
    ).toBeLessThan(400);
  });

  // KEEP GREEN. The other branch, whose sentence is true and must stay: this is
  // what the cap's refusal is being separated FROM.
  it('still says a command it did read names the hook in a spelling this harness does not generate', () => {
    expect(commented, 'the mention no longer names the hook').toContain(hookPath);
    const result = refusalOf(commented);
    expect(result.state).toBe('INTEGRATION-FAILED');
    const reason = result.reason ?? '';
    expect(reason, 'the refusal does not name the hook it read').toContain(hookPath);
    expect(reason, 'the refusal does not say that something named the hook').toMatch(
      /\bnam(?:e|es|ed)\b/i,
    );
    expect(
      reason,
      'the refusal does not say the spelling is not one this harness generates',
    ).toMatch(/generat/i);
  });

  it('gives the command it did not read a different reason from the one it read and could not verify', () => {
    const unread = refusalOf(tooLong);
    const read = refusalOf(commented);
    expect([unread.state, read.state]).toEqual(['INTEGRATION-FAILED', 'INTEGRATION-FAILED']);
    expect(
      unread.reason ?? '',
      'one sentence serves two causes, so an operator cannot tell a command that was never read from one that was read and could not be verified',
    ).not.toBe(read.reason ?? '');
  });
});

/**
 * The six shapes the last round of the parser left open, each built from the
 * adapter's OWN generated command so both harnesses are measured against their
 * own spelling. Every one of them names the hook path and is not the string the
 * rig generates, so every one of them is a refusal to verify.
 *
 * The last entry is the one that ended the parser: an assignment whose command
 * substitution can fail is structurally the derived harness's own command, so no
 * tightening of the segment rule could refuse `X="$(exit 1)" && …` without also
 * refusing the wiring this rig ships. Comparison has no such problem — it does
 * not care what a segment does, only whether the whole string is the one that
 * was generated.
 */
const SPELLINGS_THE_PARSER_LET_THROUGH: readonly (readonly [
  string,
  (canonical: string, hookPath: string) => string,
])[] = [
  ['a second command on a new line after it', (canonical) => `${canonical}\necho hi`],
  ['a backgrounded second command after it', (canonical) => `${canonical} && echo done &`],
  [
    'a whole wiring quoted into an assignment ahead of a different program',
    (_canonical, hookPath) => `MSG="&& node ${hookPath}"&&node ./other.mjs`,
  ],
  ['an unterminated quote around the hook path', (canonical) => canonical.slice(0, -1)],
  [
    'a stray closing brace on the root variable',
    (canonical, hookPath) =>
      canonical.replace(rootedPath(hookPath), (_match, name: string) => `$${name}}/${hookPath}`),
  ],
  [
    'an unclosed opening brace on the root variable',
    (canonical, hookPath) =>
      canonical.replace(rootedPath(hookPath), (_match, name: string) => `\${${name}/${hookPath}`),
  ],
  [
    'an assignment whose command substitution can fail in front of it',
    (canonical) => `X="$(exit 1)" && ${canonical}`,
  ],
];

const spellingCases = HARNESS_ADAPTERS.flatMap((adapter) =>
  SPELLINGS_THE_PARSER_LET_THROUGH.map(
    ([label, mutate]) => [adapter.harness, label, adapter, mutate] as const,
  ),
);

describe('the shapes a shell parser could not refuse without refusing the wiring the rig ships', () => {
  it.each(spellingCases)(
    'refuses a %s wiring carrying %s, because it is not the command this harness generates',
    (_harness, label, adapter, mutate) => {
      const surface = adapter.nativeSurfaceOf(SECRET_WRITE);
      const canonical = generatedCommand(adapter, SECRET_WRITE);
      const command = mutate(canonical, surface.hookPath);
      expect(command, `${label} left the generated command untouched`).not.toBe(canonical);
      expect(command, `${label} dropped the hook path, so it pins the wrong thing`).toContain(
        surface.hookPath,
      );

      const result = probePolicy(SECRET_WRITE, adapter, runningOn(adapter, command));
      expect(result.state, `${label} was read as enforcement`).toBe('INTEGRATION-FAILED');
      const reason = result.reason ?? '';
      expect(reason, 'the refusal does not name the hook it could not verify').toContain(
        surface.hookPath,
      );
      expect(
        reason,
        'the refusal does not say the spelling is not one this harness generates',
      ).toMatch(/generat/i);
    },
  );
});

/**
 * `&&` used to join segments the probe read one at a time, and a segment before
 * the hook decides whether the hook ever runs — `false && node <hook>` can never
 * fire. Comparison inherits the answer for free: none of these is the string the
 * rig generates, so none of them is verifiable. The inputs are kept because they
 * are still commands that must never read `SUPPORTED`; only the word changed,
 * from "the mechanism is absent" to "something names this hook in a spelling I
 * cannot verify".
 */
describe('a segment that could stop the hook running is still not a wiring this can verify', () => {
  const { hookPath } = SECRET_WRITE_SURFACE;

  it.each([
    ['a segment that always fails', `false && node ${hookPath}`],
    ['a segment that tests for a flag file', `[ -f /tmp/enable ] && node ${hookPath}`],
    ['a segment that tests an opt-out variable', `test -n "$SKIP_HOOKS" && node ${hookPath}`],
    ['a directory change', `cd "$D" && node ${hookPath}`],
    ['a command that prints a whole wiring', `echo "&& node ${hookPath}"`],
    [
      'a wiring handed to another program as one quoted argument',
      `node ./other.mjs "&& node ${hookPath}"`,
    ],
  ])(
    'reads %s before the hook as INTEGRATION-FAILED, because the whole string is not one this harness generates',
    (_case, command) => {
      const result = probePolicy(SECRET_WRITE, claudeAdapter, runningExactly(command));
      expect(result.state, `the command ${command} was read as enforcement`).toBe(
        'INTEGRATION-FAILED',
      );
      expect(result.reason ?? '').toContain(hookPath);
    },
  );

  // KEEP GREEN. The two commands the rig really ships, each through its own
  // adapter. Delete one of these and the comparison is free to tighten until
  // every real surface stops reading SUPPORTED.
  it.each(SHIPPED_BY_ITS_OWN_HARNESS)(
    'still reads the real %s command as running the hook, so the rule refuses nothing the rig ships',
    (_harness, adapter, command) => {
      expect(probePolicy(SECRET_WRITE, adapter, runningOn(adapter, command))).toEqual({
        state: 'SUPPORTED',
      });
    },
  );
});

/**
 * A hook file under someone else's tree is a DIFFERENT file, with different
 * bytes and a different owner: `$HOME/.claude/hooks/guard-secret-file.mjs` is
 * not this rig's enforcement, and reading it as such is a false pass on
 * evidence about another program.
 *
 * The old probe had to strip a `$VAR/` prefix to answer this, which is why the
 * adapter had to declare which variables were its own. Comparison needs neither:
 * a command rooted anywhere but where this harness generates it is simply not
 * the string this harness generates. The cases survive because the false pass
 * they were paid for is still worth pinning; only the word changed.
 */
describe('a hook rooted somewhere the harness does not generate is not this rig enforcing', () => {
  it.each(SHIPPED_BY_ITS_OWN_HARNESS)(
    'accepts the root the real %s command uses, because that is the harness rooting its own hooks',
    (_harness, adapter, command) => {
      const { hookPath } = adapter.nativeSurfaceOf(SECRET_WRITE);
      expect(
        command,
        'the copied literal no longer names the hook the adapter points at',
      ).toContain(hookPath);
      expect(probePolicy(SECRET_WRITE, adapter, runningOn(adapter, command))).toEqual({
        state: 'SUPPORTED',
      });
    },
  );

  const FOREIGN_ROOTS = [
    ['a home directory', (hookPath: string) => `node "$HOME/${hookPath}"`],
    ['a temporary directory', (hookPath: string) => `node "$TMPDIR/${hookPath}"`],
    ['an unquoted variable of its own', (hookPath: string) => `node $EVIL/${hookPath}`],
    ['a braced variable of its own', (hookPath: string) => `node "\${EVIL}/${hookPath}"`],
  ] as const;

  const foreignCases = HARNESS_ADAPTERS.flatMap((adapter) =>
    FOREIGN_ROOTS.map(([label, build]) => [adapter.harness, label, adapter, build] as const),
  );

  it.each(foreignCases)(
    'reads a hook under %s rooted at %s as INTEGRATION-FAILED, because that tree is not the one the harness generates',
    (_harness, _label, adapter, build) => {
      const { hookPath } = adapter.nativeSurfaceOf(SECRET_WRITE);
      const command = build(hookPath);
      const result = probePolicy(SECRET_WRITE, adapter, runningOn(adapter, command));
      expect(result.state, `the command ${command} was read as this rig's enforcement`).toBe(
        'INTEGRATION-FAILED',
      );
      expect(result.reason ?? '').toContain(hookPath);
    },
  );
});

/**
 * A backgrounded hook cannot refuse anything. `PreToolUse` enforcement works
 * because the operation WAITS for the hook's exit code; `node <hook> &` returns
 * immediately and the operation proceeds while the guard is still starting. So
 * a trailing `&` is the difference between a mechanism and a log line, and
 * reading it as enforcement is a false pass on a surface that enforces nothing.
 *
 * Comparison answers all of these without a rule about `&`, which is also why
 * the redirected keep-green control below changed word: `node <hook>
 * >/dev/null 2>&1` is a command a shell WOULD run and the rig does NOT
 * generate, so it is unverifiable rather than supported. That is the price of
 * dropping the parser, and it is paid in the safe direction.
 */
describe('a backgrounded hook is not enforcement, because nothing waits for its answer', () => {
  const { hookPath } = SECRET_WRITE_SURFACE;

  it.each([
    ['backgrounded', `node ${hookPath} &`],
    ['backgrounded and disowned', `node ${hookPath} & disown`],
    ['backgrounded with its output discarded', `node ${hookPath} >/dev/null 2>&1 &`],
    ['redirected but not backgrounded', `node ${hookPath} >/dev/null 2>&1`],
  ])(
    'reads a %s hook as INTEGRATION-FAILED, because it is not the command this harness generates',
    (_case, command) => {
      const result = probePolicy(SECRET_WRITE, claudeAdapter, runningExactly(command));
      expect(result.state, `the command ${command} was read as enforcement`).toBe(
        'INTEGRATION-FAILED',
      );
      expect(result.reason ?? '').toContain(hookPath);
    },
  );
});

/**
 * The one difference from a generated command the comparison tolerates, and its
 * exact edge.
 *
 * `normalise` is trim plus collapsing runs of SPACES AND TABS — not runs of
 * whitespace. The distinction is load-bearing and it is the one place the
 * design brief for this change was self-contradictory: a shell separates words
 * on space and tab, so collapsing those cannot change what runs, while a
 * NEWLINE terminates a command. Collapsing `\n` to a space would read
 * `node\n"$DIR/<hook>"` — two commands, neither of which runs the hook under
 * node — as the generated wiring, which is a false pass manufactured by the
 * normaliser itself. Everything a shell does not split words on is refused,
 * including the ones that merely look like spaces.
 */
describe('the only difference from a generated command that still reads as a wiring is spacing', () => {
  const TOLERATED = [
    ['leading and trailing spaces', (canonical: string) => `   ${canonical}   `],
    [
      'a run of spaces where the generated command has one',
      (c: string) => c.replaceAll(' ', '   '),
    ],
    ['a tab where the generated command has a space', (c: string) => c.replaceAll(' ', '\t')],
    ['a mixture of tabs and spaces', (c: string) => c.replaceAll(' ', ' \t ')],
  ] as const;

  const toleratedCases = HARNESS_ADAPTERS.flatMap((adapter) =>
    TOLERATED.map(([label, mutate]) => [adapter.harness, label, adapter, mutate] as const),
  );

  it.each(toleratedCases)(
    'still reads a %s wiring with %s as SUPPORTED, because a shell separates words on both',
    (_harness, label, adapter, mutate) => {
      const canonical = generatedCommand(adapter, SECRET_WRITE);
      const command = mutate(canonical);
      expect(command, `${label} left the generated command untouched`).not.toBe(canonical);
      expect(probePolicy(SECRET_WRITE, adapter, runningOn(adapter, command))).toEqual({
        state: 'SUPPORTED',
      });
    },
  );

  /**
   * The four characters a shell really does NOT split words on. A newline is
   * out of this table and has a case of its own below: it IS a default IFS
   * character, so this reason would be false of it \u2014 and false in the one
   * direction that costs something, since a reader who believed it would put
   * `\n` back beside these four the day the normaliser is touched.
   *
   * Measured rather than asserted: `set -- $(printf 'a\nb')` leaves two
   * positional parameters, `set -- $(printf 'a\rb')` leaves one, and the
   * default IFS is space, tab and newline exactly.
   */
  const REFUSED_WHITESPACE = [
    ['a carriage return', '\r'],
    ['a vertical tab', '\v'],
    ['a form feed', '\f'],
    ['a non-breaking space', '\u00a0'],
  ] as const;

  const refusedCases = HARNESS_ADAPTERS.flatMap((adapter) =>
    REFUSED_WHITESPACE.map(
      ([label, whitespace]) => [adapter.harness, label, adapter, whitespace] as const,
    ),
  );

  it.each(refusedCases)(
    'refuses a %s wiring whose spaces became %s, because a shell does not separate words on it',
    (_harness, label, adapter, whitespace) => {
      const canonical = generatedCommand(adapter, SECRET_WRITE);
      const command = canonical.replaceAll(' ', whitespace);
      expect(command, `${label} left the generated command untouched`).not.toBe(canonical);
      const result = probePolicy(SECRET_WRITE, adapter, runningOn(adapter, command));
      expect(
        result.state,
        `${label} was collapsed to a space and the result read as enforcement`,
      ).toBe('INTEGRATION-FAILED');
    },
  );

  /**
   * The newline is refused for the OPPOSITE reason to the four above, which is
   * why it is not in their table. A shell does separate words on it — it is one
   * of the three default IFS characters — so "a shell does not separate words
   * on it" is simply false here. What makes it inadmissible is that it also
   * ends a COMMAND: `node` on one line and the hook path on the next is two
   * commands, the second executing the hook file directly under no interpreter
   * this rig chose, so collapsing it to a space would manufacture a match
   * against the generated string and hand back the one answer this module must
   * never give without evidence.
   */
  it.each(EACH_ADAPTER)(
    'refuses a %s wiring whose spaces became a newline, because that ends the command rather than joining words',
    (_harness, adapter) => {
      const canonical = generatedCommand(adapter, SECRET_WRITE);
      const command = canonical.replaceAll(' ', '\n');
      expect(command, 'the newline left the generated command untouched').not.toBe(canonical);
      expect(
        probePolicy(SECRET_WRITE, adapter, runningOn(adapter, command)).state,
        'a newline was collapsed to a space and the result read as enforcement',
      ).toBe('INTEGRATION-FAILED');
    },
  );
});

/**
 * The third member of the classification, and the one that keeps the loud
 * answer rare. A command that says nothing about this hook is a DIFFERENT
 * mechanism wired normally — the ordinary content of every real surface — and
 * reporting it as a broken integration would make `INTEGRATION-FAILED` the
 * answer for every policy on every surface, which is to say no answer at all.
 */
describe('a command about another mechanism is an absence here, not a broken integration', () => {
  it.each(EACH_ADAPTER)(
    'reads the %s surface as UNSUPPORTED when every group runs another mechanism generated command',
    (_harness, adapter) => {
      const { matcher, hookPath, event } = adapter.nativeSurfaceOf(SECRET_WRITE);
      const snapshot = snapshotWith(event, [{ matcher, wiring: [CORE_PURITY] }], adapter);
      const result = probePolicy(SECRET_WRITE, adapter, snapshot);
      expect(result.state, 'an ordinary surface wiring another guard was reported broken').toBe(
        'UNSUPPORTED',
      );
      expect(result.reason ?? '').toContain(hookPath);
    },
  );

  it.each(EACH_ADAPTER)(
    'reads the whole %s wiring as UNSUPPORTED for a policy whose own command is not in it',
    (_harness, adapter) => {
      const result = probePolicy(CORE_PURITY, adapter, fullyWired(adapter));
      expect(result.state, 'a surface wiring three other guards was reported broken').toBe(
        'UNSUPPORTED',
      );
      expect(result.reason ?? '').toContain(adapter.nativeSurfaceOf(CORE_PURITY).hookPath);
    },
  );

  /**
   * The classification is exhaustive and each member has its own answer: this
   * is the case that goes red if any two of the three are ever collapsed.
   */
  it.each(EACH_ADAPTER)(
    'gives the %s surface one answer per kind of command: generated, unverifiable, unrelated',
    (_harness, adapter) => {
      const canonical = generatedCommand(adapter, SECRET_WRITE);
      const kinds = [
        ['the command this harness generates', canonical],
        ['a spelling of this hook it does not generate', `# ${canonical}`],
        ["another mechanism's generated command", generatedCommand(adapter, CORE_PURITY)],
      ] as const;
      expect(
        kinds.map(([kind, command]) => [
          kind,
          probePolicy(SECRET_WRITE, adapter, runningOn(adapter, command)).state,
        ]),
      ).toEqual([
        ['the command this harness generates', 'SUPPORTED'],
        ['a spelling of this hook it does not generate', 'INTEGRATION-FAILED'],
        ["another mechanism's generated command", 'UNSUPPORTED'],
      ]);
    },
  );

  /**
   * The two non-passing answers must not read alike, or the operator cannot
   * tell "the rig is not installed here" from "something here names this hook
   * and I cannot verify it" — the first is a fresh checkout, the second is a
   * tampered or hand-edited surface.
   */
  it.each(EACH_ADAPTER)(
    'says the mechanism is absent on %s only when nothing there names it at all',
    (_harness, adapter) => {
      const { matcher, event } = adapter.nativeSurfaceOf(SECRET_WRITE);
      const absent = probePolicy(
        SECRET_WRITE,
        adapter,
        snapshotWith(event, [{ matcher, wiring: [CORE_PURITY] }], adapter),
      );
      const unverifiable = probePolicy(
        SECRET_WRITE,
        adapter,
        runningOn(adapter, `# ${generatedCommand(adapter, SECRET_WRITE)}`),
      );
      expect(absent.reason ?? '').toContain('absent');
      expect(
        unverifiable.reason ?? '',
        'a surface that names the hook was reported as one that does not have it',
      ).not.toContain('absent');
    },
  );
});

/**
 * The UNREADABLE half of the ABSENT/UNREADABLE pair, one level below `hooks`.
 * `rules/invariants.md`, "Refusing to inspect is a third outcome, not a match
 * and not an error": a field PRESENT in a shape the reader does not accept is
 * the case worth reporting, and dropping it silently turns a surface whose
 * wiring could not be read into a quiet, uncounted zero.
 *
 * The case that matters most is the last one here: an unreadable element
 * BESIDE a valid group. Filtering it away leaves a group that matches the
 * declaration, so the probe reports `SUPPORTED` — a partial read of the wiring
 * handed back as a pass.
 */
describe('wiring below the hooks field that cannot be read is reported, not dropped', () => {
  const { matcher } = SECRET_WRITE_SURFACE;
  // A group the probe really would pass — which is what makes filtering it away
  // a partial read reported as a whole one. It carries the shipped literal
  // rather than reaching into the adapter, because an `it.each` table is built
  // at collection time; the literal and the adapter's answer are held equal by
  // › "the authoring harness generates exactly the command its shipped snapshot
  // carries", so this is not a second spelling of the fact.
  const validGroup = { matcher, hooks: [{ command: REAL_AUTHORING_COMMAND }] };

  it.each([
    [
      'the event value is one group object rather than a list of them',
      { hooks: { [EVENT]: validGroup } },
    ],
    ['the event value is a string', { hooks: { [EVENT]: 'nope' } }],
    ["a group's hooks field is not a list", { hooks: { [EVENT]: [{ matcher, hooks: 'nope' }] } }],
    [
      'a group carries an element that is not an object',
      { hooks: { [EVENT]: [{ matcher, hooks: ['nope'] }] } },
    ],
  ])(
    'reports INTEGRATION-FAILED when %s, naming the event it could not read',
    (_case, snapshot) => {
      const result = probePolicy(SECRET_WRITE, claudeAdapter, snapshot);
      expect(result.state).toBe('INTEGRATION-FAILED');
      expect(result.reason ?? '').toContain(EVENT);
    },
  );

  it.each([
    ['a number', { matcher, hooks: [{ command: 42 }] }],
    ['an object', { matcher, hooks: [{ command: { run: 'node' } }] }],
    ['absent altogether', { matcher, hooks: [{ type: 'command' }] }],
  ])(
    'reports INTEGRATION-FAILED when a hook command is %s, naming the field it could not read',
    (_case, group) => {
      const result = probePolicy(SECRET_WRITE, claudeAdapter, { hooks: { [EVENT]: [group] } });
      expect(result.state).toBe('INTEGRATION-FAILED');
      expect(result.reason ?? '').toContain('command');
    },
  );

  it('does not report SUPPORTED when an unreadable element sits beside a valid group, because that is a partial read', () => {
    const result = probePolicy(SECRET_WRITE, claudeAdapter, {
      hooks: { [EVENT]: ['garbage', validGroup] },
    });
    expect(result.state, 'a partial read of the wiring was handed back as a pass').not.toBe(
      'SUPPORTED',
    );
    expect(result.state).toBe('INTEGRATION-FAILED');
    expect(result.reason ?? '').toContain(EVENT);
  });

  /**
   * The last level of wiring still read silently. A `matcher` PRESENT in a
   * shape this cannot read was coerced to `undefined` and then treated as the
   * EMPTY matcher — so the probe reported `DEGRADED`, naming every declared
   * tool as uncovered, on a surface whose matcher it never read. That is a
   * measurement invented from a field it could not parse, and it is exactly
   * the case `rules/invariants.md` reserves the loud answer for: the reader
   * was handed something, could tell it could not read it, and said so about
   * every other level but this one.
   */
  it.each([
    ['a number', 42],
    ['a list', ['Write', 'Edit']],
    ['an object', { tools: ['Write'] }],
    ['null', null],
  ])(
    'reports INTEGRATION-FAILED when a matcher is %s, naming the event it could not read',
    (_case, matcherValue) => {
      const group = {
        matcher: matcherValue,
        hooks: [{ command: generatedCommand(claudeAdapter, SECRET_WRITE) }],
      };
      const result = probePolicy(SECRET_WRITE, claudeAdapter, { hooks: { [EVENT]: [group] } });
      expect(result.state, 'a matcher in an unreadable shape was read as the empty matcher').toBe(
        'INTEGRATION-FAILED',
      );
      expect(result.reason ?? '').toContain(EVENT);
    },
  );

  /**
   * KEEP GREEN, and the ABSENT half of the pair above. A group with no
   * `matcher` key at all leaves nothing to fail to read, so it is not the
   * refusal case — the probe reads it as a group that names no tool, which
   * covers none of the declared ones, which is `DEGRADED`. That is the answer
   * today, pinned here so that tightening the PRESENT-but-unreadable case
   * above cannot quietly move it. (Whether an absent matcher should instead
   * mean "every tool" is a question about harness semantics, not about
   * readability; it is not what this change decides.)
   */
  it('reads a group with no matcher key at all as DEGRADED, because an absent field leaves nothing to fail to read', () => {
    const group = { hooks: [{ command: generatedCommand(claudeAdapter, SECRET_WRITE) }] };
    const result = probePolicy(SECRET_WRITE, claudeAdapter, { hooks: { [EVENT]: [group] } });
    expect(result.state).toBe('DEGRADED');
    expect(result.reason ?? '').toContain('does not cover');
  });
});

/**
 * The reason is an operator-facing diagnostic assembled from a matcher string
 * that came off a file on disk, so it is untrusted input on its way to a
 * terminal. Two properties follow, and neither is optional:
 *
 * - it is BOUNDED, because a matcher can carry arbitrarily many segments and
 *   an unbounded join is unbounded work in a module whose callers fail open;
 * - it is ESCAPED, because a segment carrying a newline and an ANSI sequence
 *   can otherwise forge a whole line of the report it appears in.
 */
describe('the reason a degraded surface reports is bounded and escaped', () => {
  const { matcher } = SECRET_WRITE_SURFACE;
  const wiredUnder = (declaredMatcher: string): unknown => ({
    hooks: {
      [EVENT]: [
        {
          matcher: declaredMatcher,
          hooks: [{ command: generatedCommand(claudeAdapter, SECRET_WRITE) }],
        },
      ],
    },
  });

  it('states how many tool names a reason may list, as a whole number a caller can read', () => {
    expect(Number.isInteger(MAX_NAMED_TOOLS_IN_REASON)).toBe(true);
    expect(MAX_NAMED_TOOLS_IN_REASON).toBeGreaterThan(0);
  });

  it('keeps the reason short when a thousand tools are added, and says how many it did not name', () => {
    const extra = Array.from({ length: 1000 }, (_unused, index) => `T${String(index)}`);
    const result = probePolicy(
      SECRET_WRITE,
      claudeAdapter,
      wiredUnder([matcher, ...extra].join('|')),
    );
    expect(result.state).toBe('DEGRADED');
    const reason = result.reason ?? '';
    expect(
      reason.length,
      `an operator-facing reason of ${String(reason.length)} characters is not a diagnostic`,
    ).toBeLessThan(400);
    const unnamed = extra.length - MAX_NAMED_TOOLS_IN_REASON;
    expect(reason, 'the reason does not say how many tools it left out').toMatch(
      new RegExp(`\\b${String(unnamed)}\\b`),
    );
  });

  it('escapes a tool name carrying a newline and an ANSI sequence, so a matcher cannot forge a line of the report', () => {
    const forged = '\n\u001b[31mSUPPORTED: all guards enforced\u001b[0m';
    const result = probePolicy(SECRET_WRITE, claudeAdapter, wiredUnder(`${matcher}|${forged}`));
    expect(result.state).toBe('DEGRADED');
    const reason = result.reason ?? '';
    expect(reason, 'a raw ANSI escape reached an operator-facing diagnostic').not.toContain(
      '\u001b',
    );
    expect(reason, 'a raw newline let the matcher forge a line of its own').not.toContain('\n');
    expect(reason).toContain(JSON.stringify(forged).slice(1, -1));
  });
});

describe('building a coverage map from one probe', () => {
  const probeOnce = (snapshot: unknown, at = T0, trigger: ProbeTrigger = 'install'): CoverageMap =>
    coverageFromProbe({
      surface: SURFACE,
      policies: POLICIES,
      adapter: claudeAdapter,
      snapshot,
      at,
      trigger,
    });

  it('records one entry per registered policy, in registration order', () => {
    const map = probeOnce(fullyWired(claudeAdapter));
    expect(map.entries.map((entry) => entry.policyId)).toEqual(POLICIES.map((p) => p.policyId));
  });

  it('keeps the surface identity it was given, so a row can be attributed later', () => {
    expect(probeOnce(fullyWired(claudeAdapter)).surface).toEqual(SURFACE);
  });

  it('marks every entry verified by the probe, at the moment the caller supplied, with no misses', () => {
    const map = probeOnce(fullyWired(claudeAdapter), T1);
    for (const entry of map.entries) {
      expect(entry.status).toBe('SUPPORTED');
      expect(entry.verifiedBy).toBe('probe');
      expect(entry.verifiedAt).toBe(T1);
      expect(entry.consecutiveMisses).toBe(0);
      expect(entry.degradationReason).toBeUndefined();
    }
  });

  it('copies the policy version off the declaration, so a record names semantics a reader can look up', () => {
    const map = probeOnce(fullyWired(claudeAdapter));
    expect(map.entries.map((entry) => [entry.policyId, entry.policyVersion])).toEqual(
      POLICIES.map((policy) => [policy.policyId, policy.policyVersion]),
    );
  });

  it('carries the probe reason onto the entry exactly when the probe gave one', () => {
    const surface = claudeAdapter.nativeSurfaceOf(SECRET_WRITE);
    const { matcher, dropped } = dropLastTool(surface.matcher);
    const map = probeOnce(
      snapshotWith(EVENT, [
        { matcher, wiring: [SECRET_WRITE] },
        {
          matcher: claudeAdapter.nativeSurfaceOf(NO_VERIFY).matcher,
          wiring: [NO_VERIFY],
        },
      ]),
    );
    const degraded = entryFrom(map, SECRET_WRITE.policyId);
    expect(degraded.status).toBe('DEGRADED');
    expect(degraded.degradationReason ?? '').toContain(dropped);
    expect(entryFrom(map, NO_VERIFY.policyId).degradationReason).toBeUndefined();
  });

  it('records the evidence pointer the caller supplied, and none when it supplied none', () => {
    const pointer = 'docs/evidence/claude-2.0.14.md';
    const withPointer = coverageFromProbe({
      surface: SURFACE,
      policies: POLICIES,
      adapter: claudeAdapter,
      snapshot: fullyWired(claudeAdapter),
      at: T0,
      trigger: 'install',
      evidencePointer: pointer,
    });
    for (const entry of withPointer.entries) expect(entry.evidencePointer).toBe(pointer);
    for (const entry of probeOnce(fullyWired(claudeAdapter)).entries) {
      expect(entry.evidencePointer).toBeUndefined();
    }
  });

  it('answers for a registered policy and refuses to invent one for a policy it never probed', () => {
    const map = probeOnce(fullyWired(claudeAdapter));
    expect(entryFrom(map, SECRET_WRITE.policyId).policyId).toBe(SECRET_WRITE.policyId);
    expect(statusOf(map, 'no-such-policy')).toBeNull();
  });
});

/**
 * `PROBE_TRIGGERS` is the vocabulary that keeps "no periodic re-probing" a
 * property of the code rather than a sentence in a header — but a vocabulary
 * with no consumer keeps nothing. So the trigger is a REQUIRED argument of the
 * only function that builds a map from a probe, and it travels onto every
 * entry: a map can be asked what occasioned it, and an answer outside the
 * vocabulary is refused at the door rather than recorded.
 */
describe('a probe is occasioned by a named trigger, and the map records which', () => {
  const probeWith = (trigger: ProbeTrigger): CoverageMap =>
    coverageFromProbe({
      surface: SURFACE,
      policies: POLICIES,
      adapter: claudeAdapter,
      snapshot: fullyWired(claudeAdapter),
      at: T0,
      trigger,
    });

  it.each(PROBE_TRIGGERS)('records %s on every entry of the map it produced', (trigger) => {
    expect(probeWith(trigger).entries.map((entry) => entry.triggeredBy)).toEqual(
      POLICIES.map(() => trigger),
    );
  });

  it.each(['periodic', 'schedule', 'timer', 'poll', '', 'INSTALL'])(
    'refuses the trigger %j, because a probe is occasioned by a change to the surface and by nothing else',
    (trigger) => {
      expect(() => probeWith(trigger as ProbeTrigger)).toThrow();
    },
  );

  it('leaves the trigger alone when traffic is observed, because traffic is not a probe', () => {
    const entry = entryWith({ triggeredBy: 'upgrade' });
    expect(observeExpectedSignal(entry, { seen: true, at: T1 }).triggeredBy).toBe('upgrade');
    expect(observeExpectedSignal(entry, { seen: false, at: T1, threshold: 1 }).triggeredBy).toBe(
      'upgrade',
    );
  });
});

/**
 * `verifiedAt` is the field that makes a status auditable — "was this before
 * or after the change" is unanswerable without it, and unanswerable in exactly
 * the same way from a bare date or the word "yesterday". `validation.ts` says
 * every shape that records WHEN something was observed reads it against the
 * one `ISO_8601`; this is that claim, applied to the two entry points that
 * write the field. The pattern is imported rather than restated, so a change
 * to it moves both sides at once.
 */
describe('a coverage entry says when it was verified, in a form a later reader can order', () => {
  const BAD_TIMESTAMPS: readonly unknown[] = [
    '2026-09-04',
    'yesterday',
    '2026-09-04T09:00:00',
    '',
    20260904,
  ];
  const GOOD_TIMESTAMPS = ['2026-09-04T09:00:00Z', '2026-09-04T09:30:00.250+04:00'] as const;

  const probeAt = (at: string): CoverageMap =>
    coverageFromProbe({
      surface: SURFACE,
      policies: POLICIES,
      adapter: claudeAdapter,
      snapshot: fullyWired(claudeAdapter),
      at,
      trigger: 'install',
    });

  it.each(BAD_TIMESTAMPS)(
    'refuses the probe timestamp %j, which is exactly what the shared ISO-8601 pattern refuses',
    (at) => {
      expect(typeof at === 'string' && ISO_8601.test(at)).toBe(false);
      expect(() => probeAt(at as string)).toThrow();
    },
  );

  it.each(BAD_TIMESTAMPS)('refuses the observation timestamp %j on the same pattern', (at) => {
    expect(typeof at === 'string' && ISO_8601.test(at)).toBe(false);
    expect(() => observeExpectedSignal(entryWith(), { seen: true, at: at as string })).toThrow();
  });

  it.each(GOOD_TIMESTAMPS)(
    'accepts the timestamp %j at both entry points, and records it',
    (at) => {
      expect(ISO_8601.test(at)).toBe(true);
      for (const entry of probeAt(at).entries) expect(entry.verifiedAt).toBe(at);
      expect(observeExpectedSignal(entryWith(), { seen: true, at }).verifiedAt).toBe(at);
    },
  );
});

/**
 * `SurfaceIdentity.harnessVersion` is documented as exact — "the version is
 * exact, never a range" on the interface, "the exact version observed" on the
 * field, and the same claim in the decision record — and nothing checked it.
 * `coverageFromProbe` copies the surface through untouched, and no
 * `SurfaceIdentity` ever reaches the evidence-row validator, so a coverage map
 * saying `latest` was built and stored exactly like an exact one. That answers
 * neither of the two questions the field exists for: which build was this, and
 * was this before or after the change.
 *
 * The rule is the same rule the evidence row already applies, and this file
 * asks only that a probe be refused a moving target — not where the rule
 * lives. One implementation read by both modules is the point.
 */
describe('a coverage map names the exact harness version it was probed on', () => {
  const probeOnSurfaceVersion = (harnessVersion: string): CoverageMap =>
    coverageFromProbe({
      surface: { ...SURFACE, harnessVersion },
      policies: POLICIES,
      adapter: claudeAdapter,
      snapshot: fullyWired(claudeAdapter),
      at: T0,
      trigger: 'install',
    });

  it.each(['latest', '^2.0', '2.x', '*', ''])(
    'refuses to probe against the harness version %j, because a moving target names no build',
    (harnessVersion) => {
      expect(() => probeOnSurfaceVersion(harnessVersion)).toThrow(/version/i);
    },
  );

  it.each(['0.0.0-fixture', '1.104.2', '20260904.3'])(
    'probes against the exact harness version %j, including a plain build id',
    (harnessVersion) => {
      expect(probeOnSurfaceVersion(harnessVersion).surface.harnessVersion).toBe(harnessVersion);
    },
  );
});

describe('maintaining a status from observed traffic', () => {
  it('clears the miss count and credits traffic when the expected signal is seen', () => {
    const after = observeExpectedSignal(entryWith({ consecutiveMisses: 2 }), {
      seen: true,
      at: T1,
    });
    expect(after.consecutiveMisses).toBe(0);
    expect(after.verifiedAt).toBe(T1);
    expect(after.verifiedBy).toBe('traffic');
    expect(after.status).toBe('SUPPORTED');
  });

  it('never raises a status on traffic: a degraded surface stays degraded until a probe says otherwise', () => {
    const degraded = entryWith({
      status: 'DEGRADED',
      degradationReason: 'the matcher lost apply_patch',
      consecutiveMisses: 3,
    });
    const after = observeExpectedSignal(degraded, { seen: true, at: T1 });
    expect(after.status).toBe('DEGRADED');
    expect(after.degradationReason).toBe('the matcher lost apply_patch');
    expect(after.consecutiveMisses).toBe(0);
    expect(after.verifiedBy).toBe('traffic');
  });

  it('counts a miss below the threshold without touching the status', () => {
    const after = observeExpectedSignal(entryWith(), { seen: false, at: T1 });
    expect(after.consecutiveMisses).toBe(1);
    expect(after.status).toBe('SUPPORTED');
  });

  it('degrades a supported surface only once the misses reach the default threshold', () => {
    expect(DEFAULT_DEGRADATION_THRESHOLD).toBe(3);
    let entry = entryWith();
    for (let miss = 1; miss < DEFAULT_DEGRADATION_THRESHOLD; miss += 1) {
      entry = observeExpectedSignal(entry, { seen: false, at: T1 });
      expect(entry.status, `degraded after ${miss} of ${DEFAULT_DEGRADATION_THRESHOLD}`).toBe(
        'SUPPORTED',
      );
      expect(entry.consecutiveMisses).toBe(miss);
    }
    entry = observeExpectedSignal(entry, {
      seen: false,
      at: T2,
      reason: 'no refusal line on an edit that names a credential file',
    });
    expect(entry.status).toBe('DEGRADED');
    expect(entry.consecutiveMisses).toBe(DEFAULT_DEGRADATION_THRESHOLD);
    expect(entry.verifiedBy).toBe('traffic');
    expect(entry.verifiedAt).toBe(T2);
    expect(entry.degradationReason).toBe('no refusal line on an edit that names a credential file');
  });

  it('degrades on the first miss when the caller sets the threshold to one', () => {
    const after = observeExpectedSignal(entryWith(), { seen: false, at: T1, threshold: 1 });
    expect(after.status).toBe('DEGRADED');
    expect(after.consecutiveMisses).toBe(1);
  });

  it('has still not degraded on the fourth miss when the caller sets the threshold to five', () => {
    let entry = entryWith();
    for (let miss = 0; miss < 4; miss += 1) {
      entry = observeExpectedSignal(entry, { seen: false, at: T1, threshold: 5 });
    }
    expect(entry.status).toBe('SUPPORTED');
    expect(entry.consecutiveMisses).toBe(4);
  });

  it.each([0, -1, 2.5, Number.NaN])(
    'refuses the threshold %s rather than degrading on the first miss',
    (threshold) => {
      expect(() =>
        observeExpectedSignal(entryWith(), { seen: false, at: T1, threshold }),
      ).toThrow();
    },
  );

  it.each(CAPABILITY_STATES)(
    'traffic never takes a %s surface past DEGRADED, whatever a probe would have said',
    (status) => {
      let entry = entryWith({
        status,
        degradationReason: status === 'SUPPORTED' ? undefined : 'seeded by a probe',
      });
      for (let miss = 0; miss < 10; miss += 1) {
        entry = observeExpectedSignal(entry, {
          seen: false,
          at: T1,
          threshold: 1,
          reason: 'the expected signal never appeared',
        });
      }
      expect(entry.status).toBe(status === 'SUPPORTED' ? 'DEGRADED' : status);
    },
  );

  /**
   * `coverage.ts`'s header and `docs/decisions/capability-coverage.md` both
   * state this as a limit of the design, and until this case nothing measured
   * it — the sentence was a claim about a mechanism with nothing behind it,
   * which `rules/invariants.md` gives two exits from: delete it, or make it a
   * pointer to the test that proves it. This is that test.
   *
   * Both halves are here on purpose. A caller supplies a reason with EVERY
   * observation, and only the observation that actually degrades the entry
   * puts one on the record — so the reason a reader sees names the miss that
   * changed the status, not the first one that was merely counted.
   */
  it('discards the reason given with a miss that does not degrade, and records the one given with the miss that does', () => {
    const early = observeExpectedSignal(entryWith(), {
      seen: false,
      at: T1,
      threshold: 2,
      reason: 'the first miss, which only counts',
    });
    expect(early.consecutiveMisses).toBe(1);
    expect(early.status).toBe('SUPPORTED');
    expect(
      early.degradationReason,
      'a reason from a miss that changed nothing was recorded as a downgrade reason',
    ).toBeUndefined();

    const degrading = observeExpectedSignal(early, {
      seen: false,
      at: T2,
      threshold: 2,
      reason: 'the miss that crossed the threshold',
    });
    expect(degrading.status).toBe('DEGRADED');
    expect(degrading.degradationReason).toBe('the miss that crossed the threshold');
  });

  it('says why it degraded, because a degraded row that cannot say why is not evidence', () => {
    const after = observeExpectedSignal(entryWith(), {
      seen: false,
      at: T1,
      threshold: 1,
      reason: 'two blocked edits produced no diagnostic line',
    });
    expect(after.degradationReason).toBe('two blocked edits produced no diagnostic line');
  });
});

/**
 * RP-36 defines `INTEGRATION-FAILED` as "the mechanism is present but the
 * probe or the evidence CONTRADICTS the declared behaviour". The probe reaches
 * it from a snapshot it cannot read; this is the other half — the state
 * reached from evidence.
 *
 * The contradiction is sharp and needs no interpretation: the map says the
 * hook is wired nowhere on this surface, and an operation just produced the
 * signal that only that hook emits. One of the two is wrong, and neither
 * "supported" nor "unsupported" is an honest word for it. Note that this is
 * the ONE case where traffic moves a status somewhere other than `DEGRADED` —
 * and it is not an exception to "traffic never raises a status", because
 * `INTEGRATION-FAILED` ranks no higher than `UNSUPPORTED`.
 */
describe('a signal observed where the map says nothing is wired is a contradiction, not a pass', () => {
  it('reports INTEGRATION-FAILED when the expected signal is seen on an UNSUPPORTED entry', () => {
    const entry = entryWith({
      status: 'UNSUPPORTED',
      degradationReason: 'no group under the event runs the hook',
    });
    const after = observeExpectedSignal(entry, { seen: true, at: T1 });
    expect(after.status).toBe('INTEGRATION-FAILED');
    expect(after.verifiedBy).toBe('traffic');
    expect(after.verifiedAt).toBe(T1);
    expect(
      after.degradationReason ?? '',
      'the contradiction is recorded without naming the status it contradicts',
    ).toContain('UNSUPPORTED');
    expect(after.degradationReason).not.toBe(entry.degradationReason);
    // The contradiction is still not a pass: a surface whose wiring and whose
    // traffic disagree answered no question, so a verdict taken under it is
    // qualified exactly as one taken under UNSUPPORTED would have been.
    expect(qualifierFor(after.status)).toBe('UNVERIFIABLE');
  });

  it('leaves an entry already INTEGRATION-FAILED exactly where it is when the signal is seen', () => {
    const entry = entryWith({
      status: 'INTEGRATION-FAILED',
      degradationReason: 'the wiring under the event could not be read',
    });
    const after = observeExpectedSignal(entry, { seen: true, at: T1 });
    expect(after.status).toBe('INTEGRATION-FAILED');
    expect(after.verifiedBy).toBe('traffic');
    expect(after.verifiedAt).toBe(T1);
  });
});

/**
 * A downgrade is what an operator reads, and the mechanism is the part of it
 * they act on — the file to go and look at. Reading it back out of the
 * registry made the field depend on a lookup that can miss, and the miss
 * branch put an EMPTY mechanism into the one report that exists to be acted
 * on. The mechanism is a fact of the declaration the entry was built from, so
 * it travels on the entry and the downgrade copies it: no lookup, no branch,
 * nothing to miss.
 */
describe('the mechanism an operator has to look at travels on the entry', () => {
  it('copies the mechanism off each declaration when the map is built', () => {
    const map = coverageFromProbe({
      surface: SURFACE,
      policies: POLICIES,
      adapter: claudeAdapter,
      snapshot: fullyWired(claudeAdapter),
      at: T0,
      trigger: 'install',
    });
    expect(map.entries.map((entry) => [entry.policyId, entry.mechanism])).toEqual(
      POLICIES.map((policy) => [policy.policyId, policy.mechanism]),
    );
  });

  it('reports the mechanism the after-entry carries, not one looked up by policy id', () => {
    const before = mapOf([entryWith()]);
    const after = mapOf([
      entryWith({
        mechanism: 'renamed-in-a-later-declaration',
        status: 'DEGRADED',
        verifiedAt: T1,
        verifiedBy: 'traffic',
        degradationReason: 'the matcher lost a tool',
      }),
    ]);
    expect(downgradesBetween(before, after).map((downgrade) => downgrade.mechanism)).toEqual([
      'renamed-in-a-later-declaration',
    ]);
  });

  it('names a mechanism for a policy no registry carries, which is the branch that used to report an empty one', () => {
    const unregistered = definePolicy({
      ...SECRET_WRITE,
      policyId: 'fixture-only-policy',
      mechanism: 'fixture-only-guard',
    });
    expect(
      findPolicy(unregistered.policyId),
      'the fixture policy is registered, so this proves nothing',
    ).toBeNull();

    const probeOfOne = (snapshot: unknown, at: string, trigger: ProbeTrigger): CoverageMap =>
      coverageFromProbe({
        surface: SURFACE,
        policies: [unregistered],
        adapter: claudeAdapter,
        snapshot,
        at,
        trigger,
      });
    const wired = snapshotWith(EVENT, [
      {
        matcher: claudeAdapter.nativeSurfaceOf(unregistered).matcher,
        wiring: [unregistered],
      },
    ]);
    const before = probeOfOne(wired, T0, 'install');
    expect(entryFrom(before, unregistered.policyId).status).toBe('SUPPORTED');

    const after = probeOfOne(snapshotWith(EVENT, []), T1, 'upgrade');
    expect(
      downgradesBetween(before, after).map((downgrade) => [
        downgrade.policyId,
        downgrade.mechanism,
      ]),
    ).toEqual([['fixture-only-policy', 'fixture-only-guard']]);
  });
});

describe('a timer alone never degrades anything', () => {
  /**
   * The time-driven verbs, matched as WORDS of an identifier rather than as
   * substrings of it.
   *
   * A substring test was the first shape here and it was wrong in both
   * directions at once: it reported `coverageFromProbe` (for the `age` inside
   * `coverage`) while still missing `entryAge`, because the `A` there is
   * preceded by a letter. Splitting on camelCase and separator boundaries
   * fixes both of those.
   *
   * The word list that followed the split was a CLOSED enumeration of
   * inflections, and the comment that stood here called it "strictly the
   * stricter check". That was false, and its own next clause was the
   * counterexample: `expirationSweeper`, `staleness`, `ticking` and `poller`
   * all pass a closed list of spellings and would all have been caught by the
   * substring form it claimed to dominate. Enumerating spellings cannot
   * converge, so the alternation below is STEMS.
   *
   * What the stems bought: every inflection of a verb, including the four
   * above. What they gave up: a word that merely BEGINS with a stem is now
   * reported, so `pollution` is a false positive the closed list did not have.
   * That trade is deliberate — a false report costs one rename argument, a
   * false pass costs the invariant — and it is pinned below rather than left
   * for a reader to rediscover. The one entry kept as a closed alternation is
   * `age`, precisely so that `agent` is not swept in with it.
   */
  const TIME_DRIVEN =
    /^(age|ages|aged|aging|ageing|elaps\w*|expir\w*|stale\w*|tick\w*|sweep\w*|decay\w*|periodic\w*|schedul\w*|interval\w*|timer\w*|poll\w*|cron\w*)$/i;

  const wordsOf = (name: string): string[] =>
    name
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[^A-Za-z0-9]+/)
      .filter((word) => word !== '');

  const offends = (name: string): boolean => wordsOf(name).some((word) => TIME_DRIVEN.test(word));

  it('reports a time-driven name in any inflection, and spares one that merely contains the letters (positive control)', () => {
    // Caught by the word split alone.
    expect(offends('ageEntries')).toBe(true);
    expect(offends('entryAge')).toBe(true);
    expect(offends('sweep_stale')).toBe(true);
    expect(offends('expireStatuses')).toBe(true);
    // The four a closed list of inflections let straight through.
    expect(offends('expirationSweeper')).toBe(true);
    expect(offends('staleness')).toBe(true);
    expect(offends('ticking')).toBe(true);
    expect(offends('poller')).toBe(true);
    // Still spared: a word that merely contains a verb's letters.
    expect(offends('coverageFromProbe')).toBe(false);
    expect(offends('statusOf')).toBe(false);
    expect(offends('agentSpec')).toBe(false);
  });

  it('reports a word that merely begins with a stem, which is what the stems cost (negative control)', () => {
    expect(offends('pollutionIndex')).toBe(true);
  });

  it('exports nothing that ages, expires or sweeps an entry, so only an observation can move it', () => {
    const surface = coverageModule as unknown as Record<string, unknown>;
    const functions = Object.keys(surface).filter((name) => typeof surface[name] === 'function');
    expect(functions.length, 'the coverage module exports no functions at all').toBeGreaterThan(0);
    expect(
      functions.filter((name) => wordsOf(name).some((word) => TIME_DRIVEN.test(word))),
    ).toEqual([]);
  });

  /**
   * What stood here compared a clone of one map to a clone of the same map and
   * then diffed that map against itself. It could not go red for ANY
   * implementation — `downgradesBetween(m, m)` is empty by the shape of the
   * comparison, not by the property being claimed — so it stood as evidence for
   * an acceptance criterion while measuring nothing. The pair below replaces it:
   * the same wiring probed a year apart reports nothing, and the SAME
   * comparison over changed wiring reports everything, which is what makes the
   * silence a measurement rather than a tautology.
   */
  const probeOfSameSurface = (snapshot: unknown, at: string, trigger: ProbeTrigger): CoverageMap =>
    coverageFromProbe({
      surface: SURFACE,
      policies: POLICIES,
      adapter: claudeAdapter,
      snapshot,
      at,
      trigger,
    });

  it('reports no downgrade when a year passes and the same wiring is probed again, because elapsed time is not evidence', () => {
    const installed = probeOfSameSurface(fullyWired(claudeAdapter), T0, 'install');
    const aYearLater = probeOfSameSurface(
      fullyWired(claudeAdapter),
      '2027-09-04T09:00:00Z',
      'reconnect',
    );
    expect(aYearLater.entries.map((entry) => entry.status)).toEqual(
      POLICIES.map(() => 'SUPPORTED'),
    );
    expect(aYearLater.entries.map((entry) => entry.consecutiveMisses)).toEqual(
      POLICIES.map(() => 0),
    );
    expect(downgradesBetween(installed, aYearLater)).toEqual([]);
  });

  it('reports every policy the moment the wiring itself changes, over the same year (positive control)', () => {
    const installed = probeOfSameSurface(fullyWired(claudeAdapter), T0, 'install');
    const unwired = probeOfSameSurface(snapshotWith(EVENT, []), '2027-09-04T09:00:00Z', 'upgrade');
    expect(downgradesBetween(installed, unwired).map((downgrade) => downgrade.policyId)).toEqual(
      POLICIES.map((policy) => policy.policyId),
    );
  });
});

describe('qualifying a verdict by what the surface can enforce', () => {
  const UNENFORCEABLE: readonly string[] = ['UNSUPPORTED', 'INTEGRATION-FAILED'];

  it.each(CAPABILITY_STATES)(
    'a %s verdict is qualified UNVERIFIABLE exactly when the policy could not be enforced',
    (state) => {
      expect(qualifierFor(state)).toBe(UNENFORCEABLE.includes(state) ? 'UNVERIFIABLE' : undefined);
    },
  );

  const recordFor = (entry: CoverageEntry, verdict: Record<string, unknown>) => ({
    schemaVersion: 1,
    policyId: entry.policyId,
    policyVersion: entry.policyVersion,
    harness: SURFACE.harness,
    operation: 'file-edit',
    capabilityState: entry.status,
    observedFacts: [{ name: 'file_path', value: '.env' }],
    verdict,
    evidence: [{ kind: 'exit-code', value: '0' }],
    artifactVersion: '0.9.0',
    diagnostics: { redacted: true, text: '' },
    recordedAt: entry.verifiedAt,
  });

  it('refuses the silent pass an unwired surface would otherwise produce, and accepts it once qualifierFor speaks', () => {
    const map = coverageFromProbe({
      surface: SURFACE,
      policies: POLICIES,
      adapter: claudeAdapter,
      snapshot: snapshotWith(EVENT, []),
      at: T0,
      trigger: 'install',
    });
    const entry = entryFrom(map, SECRET_WRITE.policyId);
    expect(entry.status).toBe('UNSUPPORTED');

    const silent = validateDecisionRecord(recordFor(entry, { outcome: 'allow' }));
    expect(silent.ok, 'an UNSUPPORTED allow with no qualifier was accepted').toBe(false);
    if (!silent.ok) {
      expect(silent.problems.some((p: Problem) => /^(verdict|capabilityState)/.test(p.field))).toBe(
        true,
      );
    }

    const qualified = validateDecisionRecord(
      recordFor(entry, {
        outcome: 'allow',
        qualifier: qualifierFor(entry.status),
        reason: entry.degradationReason ?? 'the hook is wired nowhere on this surface',
      }),
    );
    expect(qualified.ok, qualified.ok ? '' : JSON.stringify(qualified.problems)).toBe(true);
  });

  it('leaves a supported surface unqualified, so the linkage does not weaken an honest pass', () => {
    const map = coverageFromProbe({
      surface: SURFACE,
      policies: POLICIES,
      adapter: claudeAdapter,
      snapshot: fullyWired(claudeAdapter),
      at: T0,
      trigger: 'install',
    });
    const entry = entryFrom(map, SECRET_WRITE.policyId);
    expect(qualifierFor(entry.status)).toBeUndefined();
    const result = validateDecisionRecord(recordFor(entry, { outcome: 'allow' }));
    expect(result.ok, result.ok ? '' : JSON.stringify(result.problems)).toBe(true);
  });
});

describe('reporting what changed between two coverage maps', () => {
  const transition = (from: CoverageEntry['status'], to: CoverageEntry['status']) => ({
    before: mapOf([
      entryWith({ status: from, degradationReason: from === 'SUPPORTED' ? undefined : 'earlier' }),
    ]),
    after: mapOf([
      entryWith({
        status: to,
        verifiedAt: T1,
        verifiedBy: 'traffic',
        consecutiveMisses: 3,
        degradationReason: to === 'SUPPORTED' ? undefined : 'the expected refusal never appeared',
      }),
    ]),
  });

  it('reports a downgrade with the surface, both statuses, the mechanism and the reason', () => {
    const { before, after } = transition('SUPPORTED', 'DEGRADED');
    const expected: Downgrade[] = [
      {
        surface: SURFACE,
        policyId: SECRET_WRITE.policyId,
        from: 'SUPPORTED',
        to: 'DEGRADED',
        mechanism: SECRET_WRITE.mechanism,
        reason: 'the expected refusal never appeared',
        at: T1,
      },
    ];
    expect(downgradesBetween(before, after)).toEqual(expected);
  });

  it.each([
    ['SUPPORTED', 'DEGRADED', true],
    ['SUPPORTED', 'UNSUPPORTED', true],
    ['SUPPORTED', 'INTEGRATION-FAILED', true],
    ['DEGRADED', 'UNSUPPORTED', true],
    ['DEGRADED', 'SUPPORTED', false],
    ['UNSUPPORTED', 'SUPPORTED', false],
    ['SUPPORTED', 'SUPPORTED', false],
    ['DEGRADED', 'DEGRADED', false],
  ] as const)('%s to %s is a downgrade: %s', (from, to, reported) => {
    const { before, after } = transition(from, to);
    expect(downgradesBetween(before, after)).toHaveLength(reported ? 1 : 0);
  });

  it('reports nothing at all when the whole map is unchanged', () => {
    const map = mapOf(POLICIES.map((policy) => entryWith({ policyId: policy.policyId })));
    expect(downgradesBetween(map, map)).toEqual([]);
  });

  /**
   * Two maps of different surfaces are refused rather than diffed, because a
   * downgrade is attributed to ONE surface identity and reporting one
   * surface's fall against another sends an operator to the wrong machine.
   * The refusal had no test at all, so nothing said which fields make two
   * maps two surfaces — and the answer mattered, because one of them was
   * wrong.
   */
  const fallOn = (surface: SurfaceIdentity): CoverageMap => ({
    surface,
    entries: [
      entryWith({
        status: 'DEGRADED',
        verifiedAt: T1,
        verifiedBy: 'traffic',
        degradationReason: 'the expected refusal never appeared',
      }),
    ],
  });
  const holdOn = (surface: SurfaceIdentity): CoverageMap => ({
    surface,
    entries: [entryWith()],
  });

  it.each([
    ['harness', { harness: 'another-harness' }],
    ['surface', { surface: 'another/hook-wiring.json' }],
    ['os', { os: 'another-os 2.0' }],
  ] as const)(
    'refuses two maps whose %s differs, because a downgrade is attributed to one surface and these name two',
    (_field, difference) => {
      expect(() =>
        downgradesBetween(holdOn(SURFACE), fallOn({ ...SURFACE, ...difference })),
      ).toThrow();
    },
  );

  /**
   * The one field that must NOT make two maps two surfaces. A probe before and
   * after a harness upgrade is the same machine, the same file, the same OS
   * and a new version — it is precisely what `PROBE_TRIGGERS` names `upgrade`
   * for, and it is the moment a policy is most likely to have silently lost
   * its wiring. Refusing that comparison means the one downgrade the trigger
   * exists to catch is the one downgrade that can never be reported.
   */
  it('compares two probes of the same surface across a harness upgrade, which is the fall the upgrade trigger exists to catch', () => {
    const before = holdOn({ ...SURFACE, harnessVersion: '2.0.14' });
    const upgraded: SurfaceIdentity = { ...SURFACE, harnessVersion: '2.1.0' };
    const downgrades = downgradesBetween(before, fallOn(upgraded));
    expect(downgrades.map((downgrade) => [downgrade.from, downgrade.to])).toEqual([
      ['SUPPORTED', 'DEGRADED'],
    ]);
    // The downgrade is attributed to the version it was observed ON, not the
    // one it was compared against: an operator acts on the surface as it is now.
    expect(downgrades[0]?.surface).toEqual(upgraded);
  });

  it('reports one downgrade per policy that fell, and leaves the ones that held out of it', () => {
    const before = mapOf([
      entryWith({ policyId: SECRET_WRITE.policyId }),
      entryWith({ policyId: NO_VERIFY.policyId }),
    ]);
    const after = mapOf([
      entryWith({
        policyId: SECRET_WRITE.policyId,
        status: 'DEGRADED',
        verifiedAt: T1,
        degradationReason: 'the matcher lost a tool',
      }),
      entryWith({ policyId: NO_VERIFY.policyId }),
    ]);
    const downgrades = downgradesBetween(before, after);
    expect(downgrades.map((d) => d.policyId)).toEqual([SECRET_WRITE.policyId]);
  });
});

describe('validating an evidence-matrix row', () => {
  const validRow = (): EvidenceRow => ({
    harness: 'fixture-harness',
    surface: 'fixture/hook-wiring.json',
    harnessVersion: '2.0.14',
    os: 'fixture-os 1.0',
    observedAt: '2026-09-04T09:30:00Z',
    mechanism: 'guard-secret-file',
    observableSignal: 'a refusal on stderr and a non-zero exit code',
    status: 'SUPPORTED',
    evidencePointer: 'guard-secret-file.test.mjs › "refuses a credential file by name"',
  });

  const rowWith = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    ...validRow(),
    ...overrides,
  });

  const rowWithout = (key: string): Record<string, unknown> => {
    const row = rowWith({});
    delete row[key];
    return row;
  };

  const problemsOfRow = (input: unknown): Problem[] => {
    const result = validateEvidenceRow(input);
    expect(result.ok, 'expected the row to be refused').toBe(false);
    return result.ok ? [] : result.problems;
  };

  const fieldsOf = (problems: Problem[]): string[] => problems.map((p) => p.field);

  it('accepts a complete row and hands back the same value', () => {
    const input = validRow();
    const result = validateEvidenceRow(input);
    expect(result.ok, result.ok ? '' : JSON.stringify(result.problems)).toBe(true);
    if (result.ok) expect(result.value).toEqual(input);
  });

  it.each([null, undefined, 'a string', 42, ['an', 'array']])(
    'refuses %s because a row is an object',
    (input) => {
      expect(validateEvidenceRow(input).ok).toBe(false);
    },
  );

  it('refuses a row that does not name the exact harness version it was observed on', () => {
    expect(fieldsOf(problemsOfRow(rowWithout('harnessVersion')))).toContain('harnessVersion');
  });

  it.each(['', ' '])('refuses a row whose harness version is blank (%j)', (harnessVersion) => {
    expect(fieldsOf(problemsOfRow(rowWith({ harnessVersion })))).toContain('harnessVersion');
  });

  /**
   * "The exact version observed — not a range, not 'latest'" is stated three
   * times in `evidence-matrix.ts`, and until this pair of cases nothing checked
   * it: a blank was refused and every vague word and range operator went
   * through. A row saying `latest` reads like evidence and answers neither
   * "which build was this" nor "was this before or after the change", which is
   * the whole reason an incomplete row is refused rather than stored.
   */
  it.each(['latest', 'current', 'unknown', '^2.0', '~2.0', '>=2', '2.x', '*'])(
    'refuses the harness version %j, because it names a range or a moving target rather than a build',
    (harnessVersion) => {
      expect(fieldsOf(problemsOfRow(rowWith({ harnessVersion })))).toContain('harnessVersion');
    },
  );

  it.each(['2.0.14', '0.0.0-fixture', '1.104.2', '20260904.3'])(
    'accepts the exact harness version %j, including a plain build id',
    (harnessVersion) => {
      const result = validateEvidenceRow(rowWith({ harnessVersion }));
      expect(result.ok, result.ok ? '' : JSON.stringify(result.problems)).toBe(true);
    },
  );

  /**
   * Two npm range spellings that carry no range OPERATOR character, so a check
   * looking for `^ ~ * < > =` lets them through. Both name a SET of builds,
   * which is the thing the column exists to exclude: neither answers "which
   * build was this", and a row carrying one reads like evidence while being a
   * dependency constraint.
   */
  it.each(['1.2.3 || 1.2.4', '1.2.3 - 1.2.7'])(
    'refuses the harness version %j, because it names a set of builds without using a range operator',
    (harnessVersion) => {
      expect(fieldsOf(problemsOfRow(rowWith({ harnessVersion })))).toContain('harnessVersion');
    },
  );

  /**
   * The other direction of the same rule, and the case a bare `\bx\b` gets
   * wrong: a capital X inside a build identifier is a character of the build's
   * name, not a wildcard COMPONENT. `2.x` names every 2, `1.0.0-X` names one
   * build — refusing it would refuse honest evidence and teach an operator to
   * work around the check.
   */
  it('accepts a build identifier carrying a capital X, because that is a character of a build name and not a wildcard component', () => {
    const result = validateEvidenceRow(rowWith({ harnessVersion: '1.0.0-X' }));
    expect(result.ok, result.ok ? '' : JSON.stringify(result.problems)).toBe(true);
  });

  it('refuses a row that does not say when it was observed', () => {
    expect(fieldsOf(problemsOfRow(rowWithout('observedAt')))).toContain('observedAt');
  });

  it.each(['2026-09-04', 'yesterday', '2026-09-04T09:30:00', '', 20260904])(
    'refuses an observedAt that is not an ISO-8601 date-time with a zone (%j)',
    (observedAt) => {
      expect(fieldsOf(problemsOfRow(rowWith({ observedAt })))).toContain('observedAt');
    },
  );

  it.each(['2026-09-04T09:30:00Z', '2026-09-04T09:30:00.250+04:00'])(
    'accepts the observedAt %j',
    (observedAt) => {
      const result = validateEvidenceRow(rowWith({ observedAt }));
      expect(result.ok, result.ok ? '' : JSON.stringify(result.problems)).toBe(true);
    },
  );

  it('refuses a status outside the capability vocabulary and quotes the value', () => {
    const named = problemsOfRow(rowWith({ status: 'PROBABLY' })).filter(
      (p) => p.field === 'status',
    );
    expect(named.length, 'no problem names the status').toBeGreaterThan(0);
    expect(named.some((p) => p.message.includes('PROBABLY'))).toBe(true);
  });

  it.each(CAPABILITY_STATES.filter((state) => state !== 'SUPPORTED'))(
    'refuses a %s row that does not say why it is not supported',
    (status) => {
      expect(fieldsOf(problemsOfRow(rowWith({ status })))).toContain('downgradeReason');
    },
  );

  it.each(CAPABILITY_STATES.filter((state) => state !== 'SUPPORTED'))(
    'accepts a %s row once it carries the reason',
    (status) => {
      const result = validateEvidenceRow(
        rowWith({ status, downgradeReason: 'the matcher lost apply_patch on 2026-09-04' }),
      );
      expect(result.ok, result.ok ? '' : JSON.stringify(result.problems)).toBe(true);
    },
  );

  it('accepts a supported row that carries no downgrade reason, because there is none to give', () => {
    expect(validateEvidenceRow(rowWith({ status: 'SUPPORTED' })).ok).toBe(true);
  });

  /**
   * The shape is closed in both directions, and only one of them was checked.
   * A `SUPPORTED` row carrying a `downgradeReason` validated `ok` and was
   * handed back typed as an `EvidenceRow` whose optional field the interface
   * says is present exactly when the status is not `SUPPORTED` — so the
   * validator returned a value whose type is a lie, and the field was never
   * checked for being a string either. A supported row has nothing to explain;
   * carrying an explanation is a defect in the row, not a spare field.
   */
  it.each([
    ['a plausible sentence', 'the matcher lost apply_patch on 2026-09-04'],
    ['a number', 42],
    ['null', null],
    ['an empty string', ''],
  ])(
    'refuses a SUPPORTED row that carries a downgrade reason (%s), naming that field',
    (_case, downgradeReason) => {
      expect(fieldsOf(problemsOfRow(rowWith({ status: 'SUPPORTED', downgradeReason })))).toContain(
        'downgradeReason',
      );
    },
  );

  /**
   * The two halves of the shape read `downgradeReason` differently: the
   * required half reads the VALUE (which walks the prototype chain), and the
   * forbidden half reads PRESENCE with `in` (which also walks it), while the
   * closed-shape check reads own keys only. A row whose reason is inherited
   * therefore satisfies "a DEGRADED row says why" with a value that is not on
   * the row — and `JSON.stringify` of that same row emits no reason at all, so
   * what gets stored is precisely the incomplete row the matrix refuses.
   *
   * Both halves are pinned, because they must move in OPPOSITE directions: an
   * inherited reason is not really there, so a row that needs one has not got
   * one, and a row that must not have one has not got one either.
   */
  const withInheritedReason = (own: Record<string, unknown>): Record<string, unknown> =>
    Object.assign(
      Object.create({
        downgradeReason: 'inherited from a prototype, not stored on the row',
      }) as Record<string, unknown>,
      own,
    );

  it('refuses a DEGRADED row whose reason is inherited from a prototype, because the row itself carries none', () => {
    const row = withInheritedReason(rowWith({ status: 'DEGRADED' }));
    expect(
      JSON.parse(JSON.stringify(row)),
      'the fixture stores the reason after all, so it proves nothing',
    ).not.toHaveProperty('downgradeReason');
    expect(fieldsOf(problemsOfRow(row))).toContain('downgradeReason');
  });

  it('accepts a SUPPORTED row whose only downgrade reason is inherited, because there is nothing on the row to refuse', () => {
    const row = withInheritedReason(rowWith({ status: 'SUPPORTED' }));
    const result = validateEvidenceRow(row);
    expect(result.ok, result.ok ? '' : JSON.stringify(result.problems)).toBe(true);
  });

  it.each(['harness', 'surface', 'os', 'mechanism', 'observableSignal', 'evidencePointer'])(
    'refuses a row whose %s is empty',
    (field) => {
      expect(fieldsOf(problemsOfRow(rowWith({ [field]: '' })))).toContain(field);
    },
  );

  it('refuses a row with no evidence pointer, because the row would then point at nothing', () => {
    expect(fieldsOf(problemsOfRow(rowWithout('evidencePointer')))).toContain('evidencePointer');
  });

  it('refuses an unknown extra key, because the shape is closed', () => {
    expect(fieldsOf(problemsOfRow(rowWith({ confidence: 'high' })))).toContain('confidence');
  });

  it('reports every problem at once rather than stopping at the first', () => {
    const broken = rowWith({ harnessVersion: '', observedAt: '2026-09-04', status: 'PROBABLY' });
    const fields = fieldsOf(problemsOfRow(broken));
    expect(fields).toContain('harnessVersion');
    expect(fields).toContain('observedAt');
    expect(fields).toContain('status');
  });
});
