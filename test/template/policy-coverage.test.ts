import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  coverageFromProbe,
  downgradesBetween,
  observeExpectedSignal,
  statusOf,
  type CoverageEntry,
  type CoverageMap,
  type SurfaceIdentity,
} from '../../packages/cli/src/policy/core/coverage.js';
import {
  probePolicy,
  type HookGroup,
  type HookSnapshot,
} from '../../packages/cli/src/policy/core/probe.js';
import { validateEvidenceRow } from '../../packages/cli/src/policy/core/evidence-matrix.js';
import { isRecord } from '../../packages/cli/src/policy/core/validation.js';
import {
  HARNESS_ADAPTERS,
  POLICIES,
  type HarnessAdapter,
  type PolicyDeclaration,
  type ProbeTrigger,
} from '../../packages/cli/src/policy/index.js';

/**
 * The acceptance half of RP-36: the capability probe run against the hook-wiring
 * snapshots this rig REALLY ships, on both harness surfaces — not against a
 * fixture that agrees with it by construction.
 *
 * A green pass over the real files proves only that today's wiring satisfies
 * the probe; it does not prove the probe can tell anything apart. So each
 * acceptance test is paired with a MUTATION of the same real snapshot —
 * one policy's hook command removed, or one tool dropped from its matcher —
 * and the pair is what makes the check non-vacuous. Every mutation asserts
 * that it actually changed the snapshot before asserting the answer, because a
 * mutation that matched nothing would leave the test passing for the wrong
 * reason.
 *
 * The unit-level rules — thresholds, passive maintenance, the
 * UNVERIFIABLE linkage, the evidence-row shape — are in
 * `packages/cli/test/policy-coverage.test.ts`.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');

const PROBED_AT = '2026-09-04T09:00:00Z';
const LATER = '2026-09-04T18:30:00Z';

const readSnapshot = async (surfaceFile: string): Promise<HookSnapshot> =>
  JSON.parse(await readFile(path.join(universal, surfaceFile), 'utf8')) as HookSnapshot;

const adapters = HARNESS_ADAPTERS.map((adapter) => [adapter.harness, adapter] as const);

const combos = HARNESS_ADAPTERS.flatMap((adapter) =>
  POLICIES.map((policy) => [adapter.harness, policy.policyId, adapter, policy] as const),
);

/**
 * Three ways to leave the hook path in the command while stopping the command
 * from running it. Every one of them was read as `SUPPORTED` while the check
 * was `command.includes(hookPath)` — on the real files this rig ships, not on
 * a fixture — so they are the acceptance half of "a mention is not a wiring".
 *
 * Under canonical comparison each of them is a spelling this harness does not
 * generate, and the answer is `INTEGRATION-FAILED`: still non-passing, but the
 * honest word. "The mechanism is absent" is reserved for a surface that does
 * not name the hook at all, which is what the `unwired` mutation produces.
 */
const MENTION_MUTATIONS: readonly (readonly [
  string,
  (command: string, hookPath: string) => string,
])[] = [
  ['a neighbouring .bak file', (command, hookPath) => command.replace(hookPath, `${hookPath}.bak`)],
  ['a commented-out line', (command) => `# ${command}`],
  ['a fallback after something that succeeds', (command) => `true || ${command}`],
];

const mentionCases = combos.flatMap(([harness, policyId, adapter, policy]) =>
  MENTION_MUTATIONS.map(
    ([mutation, mutate]) => [harness, policyId, mutation, adapter, policy, mutate] as const,
  ),
);

/** A surface identity for the adapter; the version is a fixture, the rest is real. */
const identityOf = (adapter: HarnessAdapter): SurfaceIdentity => ({
  harness: adapter.harness,
  surface: adapter.surfaceFile,
  harnessVersion: '0.0.0-fixture',
  os: 'fixture-os 1.0',
});

const eachGroup = (snapshot: HookSnapshot, map: (group: HookGroup) => HookGroup): HookSnapshot => ({
  hooks: Object.fromEntries(
    Object.entries(snapshot.hooks).map(([event, groups]) => [event, (groups ?? []).map(map)]),
  ),
});

/**
 * Does this field's value name the hook file?
 *
 * Typed `unknown` on purpose: these helpers read a real snapshot off disk,
 * where a hook entry also carries `type` and may carry a numeric timeout.
 */
const namesHook = (wired: unknown, hookPath: string): boolean =>
  typeof wired === 'string' && wired.includes(hookPath);

/** How many hook entries in the snapshot run this hook file. */
const timesWired = (snapshot: HookSnapshot, hookPath: string): number =>
  Object.values(snapshot.hooks)
    .flatMap((groups) => groups ?? [])
    .flatMap((group) => [...group.hooks])
    // A hook entry no longer guarantees a `command`: a harness may key its
    // generated commands under other fields too, so ask every field. The type
    // says string, but this reads a real file — `type` and a timeout are in
    // there too, and a timeout is a number.
    .filter((hook) => Object.values(hook).some((wired) => namesHook(wired, hookPath))).length;

/** The real snapshot with one policy's hook command taken out of every group. */
const withoutHook = (snapshot: HookSnapshot, hookPath: string): HookSnapshot =>
  eachGroup(snapshot, (group) => ({
    ...group,
    hooks: [...group.hooks].filter(
      (hook) => !Object.values(hook).some((wired) => namesHook(wired, hookPath)),
    ),
  }));

/** The real snapshot with one tool dropped from the groups carrying that matcher. */
const withoutTool = (
  snapshot: HookSnapshot,
  matcher: string,
  tool: string,
): { snapshot: HookSnapshot; changed: number } => {
  let changed = 0;
  const narrowed = eachGroup(snapshot, (group) => {
    if (group.matcher !== matcher) return group;
    changed += 1;
    return {
      ...group,
      matcher: matcher
        .split('|')
        .filter((name) => name !== tool)
        .join('|'),
    };
  });
  return { snapshot: narrowed, changed };
};

const lastToolOf = (matcher: string): string => {
  const tools = matcher.split('|');
  const tool = tools.at(-1);
  if (tool === undefined || tools.length < 2) {
    throw new Error(`the matcher ${matcher} has no tool to drop`);
  }
  return tool;
};

const entryFor = (map: CoverageMap, policyId: string): CoverageEntry => {
  const entry = statusOf(map, policyId);
  if (entry === null) throw new Error(`the coverage map carries no entry for ${policyId}`);
  return entry;
};

/** The real snapshot with one policy's hook command rewritten by a mutator. */
const rewriteCommand = (
  snapshot: HookSnapshot,
  hookPath: string,
  mutate: (command: string) => string,
): { snapshot: HookSnapshot; changed: number } => {
  let changed = 0;
  const mutated = eachGroup(snapshot, (group) => ({
    ...group,
    hooks: [...group.hooks].map((hook) => {
      // Rewrites the shell field only, which is what every caller of this
      // helper means: the Windows spelling has its own mutations.
      const command = hook['command'];
      if (command === undefined || !command.includes(hookPath)) return hook;
      changed += 1;
      return { ...hook, command: mutate(command) };
    }),
  }));
  return { snapshot: mutated, changed };
};

const probeOf = async (
  adapter: HarnessAdapter,
  trigger: ProbeTrigger = 'install',
): Promise<CoverageMap> =>
  coverageFromProbe({
    surface: identityOf(adapter),
    policies: POLICIES,
    adapter,
    snapshot: await readSnapshot(adapter.surfaceFile),
    at: PROBED_AT,
    trigger,
    evidencePointer: `templates/agent-os/universal/${adapter.surfaceFile}`,
  });

describe('probing the surfaces this rig really ships', () => {
  it.each(['timer', 'hourly'])(
    'refuses the trigger %j, because the coverage contract accepts only a declared surface-change trigger',
    async (trigger) => {
      const adapter = HARNESS_ADAPTERS[0];
      if (!adapter) throw new Error('the generated rig declares no harness adapter');
      await expect(probeOf(adapter, trigger as ProbeTrigger)).rejects.toThrow(/occasioned/i);
    },
  );

  it('a signal observed where the map says nothing is wired is a contradiction, not a pass', async () => {
    const adapter = HARNESS_ADAPTERS[0];
    const policy = POLICIES[0];
    if (!adapter || !policy) throw new Error('the generated rig declares no probe combination');
    const snapshot = await readSnapshot(adapter.surfaceFile);
    const { hookPath } = adapter.nativeSurfaceOf(policy);
    const unwired = withoutHook(snapshot, hookPath);
    const map = coverageFromProbe({
      surface: identityOf(adapter),
      policies: POLICIES,
      adapter,
      snapshot: unwired,
      at: PROBED_AT,
      trigger: 'install',
    });

    const after = observeExpectedSignal(entryFor(map, policy.policyId), {
      seen: true,
      at: LATER,
    });
    expect(after.status).toBe('INTEGRATION-FAILED');
    expect(after.verifiedBy).toBe('traffic');
  });

  it.each(adapters)(
    'every registered policy is SUPPORTED on the real %s surface',
    async (_harness, adapter) => {
      const snapshot = await readSnapshot(adapter.surfaceFile);
      expect(
        POLICIES.map((policy) => [policy.policyId, probePolicy(policy, adapter, snapshot)]),
      ).toEqual(POLICIES.map((policy) => [policy.policyId, { state: 'SUPPORTED' }]));
    },
  );

  it.each(adapters)(
    'one probe of the real %s surface establishes every status, verified by the probe and by nothing else',
    async (_harness, adapter) => {
      const map = await probeOf(adapter, 'registration');
      expect(map.surface).toEqual(identityOf(adapter));
      expect(
        map.entries.map((entry) => [
          entry.policyId,
          entry.status,
          entry.verifiedBy,
          entry.triggeredBy,
          entry.mechanism,
          entry.consecutiveMisses,
          entry.verifiedAt,
        ]),
      ).toEqual(
        POLICIES.map((policy) => [
          policy.policyId,
          'SUPPORTED',
          'probe',
          'registration',
          policy.mechanism,
          0,
          PROBED_AT,
        ]),
      );
    },
  );

  it.each(adapters)(
    'a status on the real %s surface is maintained by observed traffic, without reading the surface again',
    async (_harness, adapter) => {
      const entry = entryFor(await probeOf(adapter), 'secret-write-refusal');
      const after = observeExpectedSignal(entry, { seen: true, at: LATER });
      expect(after.status).toBe('SUPPORTED');
      expect(after.verifiedBy).toBe('traffic');
      expect(after.verifiedAt).toBe(LATER);
      expect(after.consecutiveMisses).toBe(0);
    },
  );
});

describe('the probe tells the real surface apart from a broken one', () => {
  /**
   * The one mutation of a real surface that really does mean "the mechanism is
   * absent": the command is gone, and every command still in the file belongs
   * to another mechanism. It is also the acceptance half of the third member of
   * the classification — if an unrelated command were read as unverifiable,
   * every policy on every real surface would report `INTEGRATION-FAILED` and
   * the loud answer would carry no information at all.
   */
  it.each(combos)(
    'reports %s policy %s as UNSUPPORTED when its hook command leaves the real snapshot (mutation: unwired)',
    async (_harness, _policyId, adapter, policy: PolicyDeclaration) => {
      const snapshot = await readSnapshot(adapter.surfaceFile);
      const { hookPath } = adapter.nativeSurfaceOf(policy);
      expect(timesWired(snapshot, hookPath), `${hookPath} is not wired in the real snapshot`).toBe(
        1,
      );

      const mutated = withoutHook(snapshot, hookPath);
      expect(timesWired(mutated, hookPath), 'the mutation removed nothing').toBe(0);

      const result = probePolicy(policy, adapter, mutated);
      expect(
        result.state,
        'a surface still wiring every other guard was reported as a broken integration',
      ).toBe('UNSUPPORTED');
      expect(result.reason ?? '').toContain(hookPath);
    },
  );

  // The unwired mutation above removes the command; these three LEAVE the hook
  // path where it is and change the spelling, so the probe can see that
  // something here names this hook and cannot verify that it runs it.
  it.each(mentionCases)(
    'reports %s policy %s as INTEGRATION-FAILED when its real command becomes %s (mutation: mentioned, not run)',
    async (_harness, _policyId, mutation, adapter, policy: PolicyDeclaration, mutate) => {
      const snapshot = await readSnapshot(adapter.surfaceFile);
      const { hookPath } = adapter.nativeSurfaceOf(policy);
      const { snapshot: mutated, changed } = rewriteCommand(snapshot, hookPath, (command) =>
        mutate(command, hookPath),
      );
      expect(changed, 'the mutation rewrote no command in the real snapshot').toBe(1);

      const result = probePolicy(policy, adapter, mutated);
      expect(result.state, `${mutation} was read as enforcement`).toBe('INTEGRATION-FAILED');
      expect(result.reason ?? '').toContain(hookPath);
    },
  );

  it.each(combos)(
    'reports %s policy %s as DEGRADED when its matcher loses a declared tool (mutation: narrowed matcher)',
    async (_harness, _policyId, adapter, policy: PolicyDeclaration) => {
      const snapshot = await readSnapshot(adapter.surfaceFile);
      const { matcher } = adapter.nativeSurfaceOf(policy);
      const tool = lastToolOf(matcher);
      const { snapshot: mutated, changed } = withoutTool(snapshot, matcher, tool);
      expect(
        changed,
        `no group in the real snapshot carries the matcher ${matcher}`,
      ).toBeGreaterThan(0);

      const result = probePolicy(policy, adapter, mutated);
      expect(result.state).toBe('DEGRADED');
      expect(result.reason ?? '').toContain(tool);
    },
  );

  it.each(adapters)(
    'a downgrade on the real %s surface is observable: surface, old to new status, mechanism and reason',
    async (_harness, adapter) => {
      const before = await probeOf(adapter);
      const snapshot = await readSnapshot(adapter.surfaceFile);
      const policy = POLICIES[0];
      if (policy === undefined) throw new Error('the registry declares no policy');
      const { matcher } = adapter.nativeSurfaceOf(policy);
      const tool = lastToolOf(matcher);
      const { snapshot: mutated } = withoutTool(snapshot, matcher, tool);

      const after = coverageFromProbe({
        surface: identityOf(adapter),
        policies: POLICIES,
        adapter,
        snapshot: mutated,
        at: LATER,
        trigger: 'upgrade',
      });
      const downgrades = downgradesBetween(before, after);
      expect(downgrades.map((downgrade) => downgrade.policyId)).toContain(policy.policyId);

      const downgrade = downgrades.find((d) => d.policyId === policy.policyId);
      if (downgrade === undefined) throw new Error('no downgrade was reported');
      expect(downgrade.surface).toEqual(identityOf(adapter));
      expect(downgrade.from).toBe('SUPPORTED');
      expect(downgrade.to).toBe('DEGRADED');
      expect(downgrade.mechanism).toBe(policy.mechanism);
      expect(downgrade.reason).toContain(tool);
      expect(downgrade.at).toBe(LATER);
    },
  );

  /**
   * The real snapshot with one unreadable element added beside the groups that
   * really are wired. Everything the probe would otherwise report as
   * `SUPPORTED` is still there, so a probe that filters the bad element away
   * returns a pass — a partial read of the surface handed back as a
   * measurement. `rules/invariants.md`, "Refusing to inspect is a third
   * outcome": the probe was handed something it could tell it could not read,
   * and reporting that is the one thing it is for.
   */
  it.each(combos)(
    'reports %s policy %s as INTEGRATION-FAILED when the real snapshot gains an unreadable group beside the valid ones (mutation: partial read)',
    async (_harness, _policyId, adapter, policy: PolicyDeclaration) => {
      const snapshot = await readSnapshot(adapter.surfaceFile);
      const { event } = adapter.nativeSurfaceOf(policy);
      const groups = snapshot.hooks[event] ?? [];
      expect(groups.length, `the real snapshot wires nothing under ${event}`).toBeGreaterThan(0);
      expect(probePolicy(policy, adapter, snapshot).state).toBe('SUPPORTED');

      const mutated: unknown = {
        ...snapshot,
        hooks: { ...snapshot.hooks, [event]: ['garbage', ...groups] },
      };
      const result = probePolicy(policy, adapter, mutated);
      expect(result.state, 'a partial read of the real surface was handed back as a pass').toBe(
        'INTEGRATION-FAILED',
      );
      expect(result.reason ?? '').toContain(event);
    },
  );
});

/**
 * The mention mutations above change the command into something that plainly
 * does not run the hook. These leave a command that a shell WOULD run — or
 * would run under someone else's tree, or without waiting for it — and each of
 * them was read as `SUPPORTED` against the files this rig really ships:
 *
 * - a `&&` segment in front decides whether the hook runs at all, so `false &&`
 *   in front of the real command is a wiring that can never fire;
 * - the executed path may be rooted at any variable, so `$HOME/` in place of
 *   the harness's own root points at a DIFFERENT file with different bytes;
 * - a trailing `&` backgrounds the hook, and `PreToolUse` enforcement is the
 *   operation waiting for the exit code — a backgrounded guard refuses nothing;
 * - and the last two are the shapes the parser rounds ended on: an assignment
 *   whose command substitution can fail, which is structurally the derived
 *   harness's own command, and a redirection, which the parser had to accept.
 *
 * Under canonical comparison every one of them is simply not the string the rig
 * generates. Each asserts that the mutation really changed the command before
 * asserting the answer, because a mutation that matched nothing would leave the
 * test passing for the wrong reason.
 */
const escapeForRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const RUNNABLE_MUTATIONS: readonly (readonly [
  string,
  (command: string, hookPath: string) => string,
])[] = [
  ['a segment that always fails in front of it', (command) => `false && ${command}`],
  [
    'a segment that tests an opt-out variable in front of it',
    (command) => `test -n "$SKIP_HOOKS" && ${command}`,
  ],
  [
    'a hook file rooted under the home directory instead',
    (command, hookPath) =>
      command.replace(
        new RegExp(`\\$\\{?[A-Za-z_][A-Za-z0-9_]*\\}?/${escapeForRegExp(hookPath)}`),
        `$HOME/${hookPath}`,
      ),
  ],
  ['a backgrounded hook nothing waits for', (command) => `${command} &`],
  [
    'an assignment whose command substitution can fail in front of it',
    (command) => `X="$(exit 1)" && ${command}`,
  ],
  ['its output redirected away', (command) => `${command} >/dev/null 2>&1`],
  ['a second command on a new line after it', (command) => `${command}\necho hi`],
];

const runnableCases = combos.flatMap(([harness, policyId, adapter, policy]) =>
  RUNNABLE_MUTATIONS.map(
    ([mutation, mutate]) => [harness, policyId, mutation, adapter, policy, mutate] as const,
  ),
);

describe('a command a shell would run on the real surface is still not the command the rig generates', () => {
  it.each(runnableCases)(
    'reports %s policy %s as INTEGRATION-FAILED when its real command gains %s (mutation: runnable but not generated)',
    async (_harness, _policyId, mutation, adapter, policy: PolicyDeclaration, mutate) => {
      const snapshot = await readSnapshot(adapter.surfaceFile);
      const { hookPath } = adapter.nativeSurfaceOf(policy);
      let original = '';
      const { snapshot: mutated, changed } = rewriteCommand(snapshot, hookPath, (command) => {
        original = command;
        return mutate(command, hookPath);
      });
      expect(changed, 'the mutation rewrote no command in the real snapshot').toBe(1);
      const rewritten = mutate(original, hookPath);
      expect(rewritten, `${mutation} left the real command untouched`).not.toBe(original);

      const result = probePolicy(policy, adapter, mutated);
      expect(result.state, `${mutation} was read as enforcement`).toBe('INTEGRATION-FAILED');
      expect(result.reason ?? '').toContain(hookPath);
    },
  );

  /**
   * KEEP GREEN, and the tolerance the comparison really does grant on the real
   * files: a run of spaces or a tab where the shipped command has one space is
   * the same command to a shell, so re-indenting a snapshot must not turn every
   * policy on it unverifiable.
   */
  const RESPACINGS = [
    ['a run of spaces where it has one', (command: string) => command.replaceAll(' ', '   ')],
    ['a tab where it has a space', (command: string) => command.replaceAll(' ', '\t')],
    ['leading and trailing spaces', (command: string) => `  ${command}  `],
  ] as const;

  const respacedCases = combos.flatMap(([harness, policyId, adapter, policy]) =>
    RESPACINGS.map(
      ([mutation, mutate]) => [harness, policyId, mutation, adapter, policy, mutate] as const,
    ),
  );

  it.each(respacedCases)(
    'still reports %s policy %s as SUPPORTED when its real command carries %s (mutation: respaced)',
    async (_harness, _policyId, mutation, adapter, policy: PolicyDeclaration, mutate) => {
      const snapshot = await readSnapshot(adapter.surfaceFile);
      const { hookPath } = adapter.nativeSurfaceOf(policy);
      let original = '';
      const { snapshot: mutated, changed } = rewriteCommand(snapshot, hookPath, (command) => {
        original = command;
        return mutate(command);
      });
      expect(changed, 'the mutation rewrote no command in the real snapshot').toBe(1);
      expect(mutate(original), `${mutation} left the real command untouched`).not.toBe(original);
      expect(probePolicy(policy, adapter, mutated)).toEqual({ state: 'SUPPORTED' });
    },
  );
});

/**
 * The acceptance half of "the probe compares against what the rig would
 * generate": the adapter's answer and the bytes in the shipped file, held equal
 * on the real files rather than on a copied literal. This is what makes every
 * `SUPPORTED` above a measurement — if an adapter ever generated a command the
 * rig does not ship, every one of those passes would be a fixture agreeing with
 * itself.
 */
describe('what each adapter generates is what the shipped snapshot really carries', () => {
  it.each(combos)(
    'the %s snapshot wires %s with exactly the command that adapter generates',
    async (_harness, _policyId, adapter, policy: PolicyDeclaration) => {
      const snapshot = await readSnapshot(adapter.surfaceFile);
      const { hookPath } = adapter.nativeSurfaceOf(policy);
      const wired = Object.values(snapshot.hooks)
        .flatMap((groups) => groups ?? [])
        .flatMap((group) => [...group.hooks])
        .map((hook) => hook['command'] ?? '')
        .filter((command) => command.includes(hookPath));
      expect(wired, `${hookPath} is not wired once in the real snapshot`).toHaveLength(1);
      // The shell field only. Every field the adapter generates for is checked
      // by the sibling test below; this one is about the one command a reader
      // of the snapshot sees first, and about it being wired exactly once.
      const shell = adapter.nativeSurfaceOf(policy).commands['command'] ?? [];
      expect(
        shell.length,
        `the ${adapter.harness} adapter states no shell command it generates`,
      ).toBeGreaterThan(0);
      expect(
        shell,
        'the shipped snapshot carries a command this adapter would not generate',
      ).toContain(wired[0]);
    },
  );

  /**
   * The two harnesses name one hook file in two spellings, so each harness's own
   * command is the other's unverifiable one. A substring read calls both a
   * wiring; comparison tells them apart, which is what stops a Codex surface
   * being credited for a Claude-shaped command it will never run as written.
   */
  it.each(combos)(
    'reports %s policy %s as INTEGRATION-FAILED when its real command becomes the other harness spelling (mutation: foreign harness)',
    async (_harness, _policyId, adapter, policy: PolicyDeclaration) => {
      const other = HARNESS_ADAPTERS.find((candidate) => candidate.harness !== adapter.harness);
      if (other === undefined) throw new Error('only one harness adapter is registered');
      const foreign = other.nativeSurfaceOf(policy).commands['command']?.[0];
      if (foreign === undefined) throw new Error(`${other.harness} generates no command`);

      const snapshot = await readSnapshot(adapter.surfaceFile);
      const { hookPath } = adapter.nativeSurfaceOf(policy);
      let original = '';
      const { snapshot: mutated, changed } = rewriteCommand(snapshot, hookPath, (command) => {
        original = command;
        return foreign;
      });
      expect(changed, 'the mutation rewrote no command in the real snapshot').toBe(1);
      expect(foreign, 'the two harnesses generate the same command, so this pins nothing').not.toBe(
        original,
      );

      const result = probePolicy(policy, adapter, mutated);
      expect(result.state, 'one harness was credited for the other harness wiring').toBe(
        'INTEGRATION-FAILED',
      );
      expect(result.reason ?? '').toContain(hookPath);
    },
  );
});

/**
 * The last level of wiring the probe still read silently, measured on the real
 * files. A `matcher` PRESENT in a shape the probe cannot read was coerced to
 * `undefined` and treated as the EMPTY matcher, so a surface whose matcher was
 * never read was reported `DEGRADED` — a specific, actionable finding invented
 * out of a field the probe could not parse. `rules/invariants.md`, "Refusing to
 * inspect is a third outcome": the probe was handed something it could tell it
 * could not read.
 */
describe('an unreadable matcher on the real surface is reported, not read as the empty matcher', () => {
  it.each(combos)(
    'reports %s policy %s as INTEGRATION-FAILED when the real matchers become unreadable (mutation: matcher shape)',
    async (_harness, _policyId, adapter, policy: PolicyDeclaration) => {
      const snapshot = await readSnapshot(adapter.surfaceFile);
      const { event } = adapter.nativeSurfaceOf(policy);
      const groups = snapshot.hooks[event] ?? [];
      expect(groups.length, `the real snapshot wires nothing under ${event}`).toBeGreaterThan(0);
      expect(probePolicy(policy, adapter, snapshot).state).toBe('SUPPORTED');

      const mutated: unknown = {
        ...snapshot,
        hooks: { ...snapshot.hooks, [event]: groups.map((group) => ({ ...group, matcher: 42 })) },
      };
      const result = probePolicy(policy, adapter, mutated);
      expect(result.state, 'a matcher the probe could not read was read as the empty one').toBe(
        'INTEGRATION-FAILED',
      );
      expect(result.reason ?? '').toContain(event);
    },
  );
});

/**
 * The two surface-identity rules, measured where they are actually used: a
 * probe of a real surface.
 *
 * `harnessVersion` is documented as exact and nothing checked it, so a
 * coverage map of a real surface could say `latest` — and the comparison that
 * an `upgrade` probe exists to make was refused precisely because the version
 * had changed, which is the one thing an upgrade always changes.
 */
describe('a coverage map of a real surface names one exact version, and survives that version changing', () => {
  it.each(adapters)(
    'refuses to build a %s coverage map against a moving harness version',
    async (_harness, adapter) => {
      const snapshot = await readSnapshot(adapter.surfaceFile);
      expect(() =>
        coverageFromProbe({
          surface: { ...identityOf(adapter), harnessVersion: 'latest' },
          policies: POLICIES,
          adapter,
          snapshot,
          at: PROBED_AT,
          trigger: 'install',
        }),
      ).toThrow(/version/i);
    },
  );

  it.each(adapters)(
    'reports the fall a %s harness upgrade introduced, comparing the surface before and after the new version',
    async (_harness, adapter) => {
      const snapshot = await readSnapshot(adapter.surfaceFile);
      const policy = POLICIES[0];
      if (policy === undefined) throw new Error('the registry declares no policy');
      const { matcher } = adapter.nativeSurfaceOf(policy);
      const tool = lastToolOf(matcher);
      const { snapshot: narrowed, changed } = withoutTool(snapshot, matcher, tool);
      expect(
        changed,
        `no group in the real snapshot carries the matcher ${matcher}`,
      ).toBeGreaterThan(0);

      const oldVersion: SurfaceIdentity = { ...identityOf(adapter), harnessVersion: '1.104.2' };
      const newVersion: SurfaceIdentity = { ...identityOf(adapter), harnessVersion: '1.105.0' };
      const before = coverageFromProbe({
        surface: oldVersion,
        policies: POLICIES,
        adapter,
        snapshot,
        at: PROBED_AT,
        trigger: 'install',
      });
      const after = coverageFromProbe({
        surface: newVersion,
        policies: POLICIES,
        adapter,
        snapshot: narrowed,
        at: LATER,
        trigger: 'upgrade',
      });

      const downgrades = downgradesBetween(before, after);
      expect(downgrades.map((downgrade) => downgrade.policyId)).toContain(policy.policyId);
      const downgrade = downgrades.find((d) => d.policyId === policy.policyId);
      if (downgrade === undefined) throw new Error('no downgrade was reported');
      expect(
        downgrade.surface,
        'the fall was attributed to the version it was compared against',
      ).toEqual(newVersion);
    },
  );
});

/**
 * The structural half of "the mechanism travels on the entry": `coverage.ts`
 * used to name the downgrade's mechanism by looking the policy id up in the
 * registry, which made the field depend on a lookup that can miss and put an
 * EMPTY mechanism into an operator-facing report when it did. The behaviour is
 * pinned in `packages/cli/test/policy-coverage.test.ts` › "names a mechanism
 * for a policy no registry carries, which is the branch that used to report an
 * empty one"; this is the import that made the branch possible, and it is
 * cheaper to keep gone than to keep tested.
 */
describe('the coverage module owns no lookup it could get wrong', () => {
  it('reads a mechanism off the entry rather than importing the policy registry', async () => {
    const source = await readFile(
      path.join(repoRoot, 'packages', 'cli', 'src', 'policy', 'core', 'coverage.ts'),
      'utf8',
    );
    expect(source, 'coverage.ts still reaches into the registry').not.toMatch(/registry\.js/);
  });
});

/**
 * A hook entry on the derived surface carries TWO commands: `command`, which
 * Codex runs on macOS and Linux, and `commandWindows`, which it runs on Windows
 * — `test/template/codex.test.ts` holds the shipped file to that shape. The
 * probe read the first and nothing else, so a surface whose Windows spelling had
 * been replaced wholesale still read `SUPPORTED` for every policy. Measured on
 * this file rather than on a fixture: replacing all eight Windows spellings with
 * `echo "guard disabled"` left `secret-write-refusal`, `no-verify-refusal` and
 * `rulebook-mutation-restriction` all `SUPPORTED` — a false pass on a shipped
 * surface, on the platform this repository runs a Windows CI lane for.
 *
 * The command fields are read OFF THE SHIPPED ENTRY rather than listed here, so
 * a harness that grows a third spelling is covered the day the snapshot gains it
 * rather than the day someone remembers this file. That also gives the authoring
 * surface its answer for free: it ships one command field, so every mutation
 * below touches one field there and the surface is unaffected in every direction
 * a second field would have moved it.
 *
 * The untouched control is › "every registered policy is SUPPORTED on the real
 * %s surface"; each test here re-establishes it on the same read, so a mutation
 * is always measured against the file it mutated.
 */
const DISABLED = 'echo "guard disabled"';

/** The shipped snapshot exactly as JSON parses it — no field narrowed away. */
const readRaw = async (surfaceFile: string): Promise<unknown> =>
  JSON.parse(await readFile(path.join(universal, surfaceFile), 'utf8')) as unknown;

/** Every hook entry in a raw snapshot, at whatever depth the file puts them. */
const hookEntriesOf = (snapshot: unknown): Record<string, unknown>[] => {
  if (!isRecord(snapshot) || !isRecord(snapshot.hooks)) return [];
  const entries: Record<string, unknown>[] = [];
  for (const groups of Object.values(snapshot.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
      for (const entry of group.hooks) if (isRecord(entry)) entries.push(entry);
    }
  }
  return entries;
};

/**
 * Every field of a hook entry that carries a spelling of the command: the
 * portable one and any per-platform sibling beside it. `type` and `timeout` are
 * not spellings of a command, and are not read here.
 */
const commandFieldsOf = (entry: Record<string, unknown>): string[] =>
  Object.keys(entry).filter((field) => /^command/i.test(field));

/** The one shipped hook entry whose portable command runs `hookPath`. */
const shippedEntry = (snapshot: unknown, hookPath: string): Record<string, unknown> => {
  const found = hookEntriesOf(snapshot).filter(
    (entry) => typeof entry.command === 'string' && entry.command.includes(hookPath),
  );
  const entry = found[0];
  if (found.length !== 1 || entry === undefined) {
    throw new Error(`${hookPath} is wired ${String(found.length)} times in the shipped snapshot`);
  }
  return entry;
};

/**
 * The shipped snapshot with the hook entry that runs `hookPath` replaced by
 * what `mutate` returns, every other byte of the file left where it is.
 *
 * The entry is FOUND by its portable command, before the mutation, so a
 * mutation that removes or rewrites that command still finds its target.
 */
const rewriteEntryOf = (
  snapshot: unknown,
  hookPath: string,
  mutate: (entry: Record<string, unknown>) => Record<string, unknown>,
): { snapshot: unknown; changed: number } => {
  let changed = 0;
  if (!isRecord(snapshot) || !isRecord(snapshot.hooks)) return { snapshot, changed };
  const hooks: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(snapshot.hooks)) {
    hooks[event] = !Array.isArray(groups)
      ? groups
      : groups.map((group: unknown) => {
          if (!isRecord(group) || !Array.isArray(group.hooks)) return group;
          return {
            ...group,
            hooks: group.hooks.map((entry: unknown) => {
              if (!isRecord(entry) || typeof entry.command !== 'string') return entry;
              if (!entry.command.includes(hookPath)) return entry;
              changed += 1;
              return mutate(entry);
            }),
          };
        });
  }
  return { snapshot: { ...snapshot, hooks }, changed };
};

/**
 * A hook-entry FIELD name → the command spellings the adapter accepts in it.
 *
 * Spelled again here rather than imported from `packages/cli/test/policy-coverage.test.ts`,
 * for the reason that file states about its own fixtures: a change to one
 * file's helper must not silently re-aim the other's.
 */
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

const fieldSpellingsOf = (adapter: HarnessAdapter, policy: PolicyDeclaration): FieldSpellings => {
  // Read through `unknown` because the property's declared type is what is
  // under test: a flat list of commands cannot say which hook-entry field each
  // of them is the spelling for.
  const declared: unknown = adapter.nativeSurfaceOf(policy).commands;
  if (!isFieldSpellings(declared)) {
    throw new Error(
      `the ${adapter.harness} adapter does not name the hook-entry field each command it generates belongs to; it states ${JSON.stringify(declared)}`,
    );
  }
  return declared;
};

describe('every command spelling a surface ships is part of the wiring, not just the first', () => {
  it.each(combos)(
    'reports %s policy %s as not SUPPORTED when any one command field of its shipped entry carries a different command (mutation: one spelling replaced)',
    async (_harness, _policyId, adapter, policy: PolicyDeclaration) => {
      const snapshot = await readRaw(adapter.surfaceFile);
      const { hookPath } = adapter.nativeSurfaceOf(policy);
      expect(
        probePolicy(policy, adapter, snapshot).state,
        'the untouched surface does not read SUPPORTED, so nothing here is measured',
      ).toBe('SUPPORTED');

      const fields = commandFieldsOf(shippedEntry(snapshot, hookPath));
      expect(fields.length, 'the shipped entry carries no command field at all').toBeGreaterThan(0);

      const answers = fields.map((field) => {
        const { snapshot: mutated, changed } = rewriteEntryOf(snapshot, hookPath, (entry) => ({
          ...entry,
          [field]: DISABLED,
        }));
        expect(changed, `replacing ${field} rewrote no entry in the shipped snapshot`).toBe(1);
        expect(
          JSON.stringify(mutated),
          `replacing ${field} left the shipped snapshot unchanged`,
        ).not.toBe(JSON.stringify(snapshot));
        return [field, probePolicy(policy, adapter, mutated).state] as const;
      });

      expect(
        answers.filter(([, state]) => state === 'SUPPORTED'),
        'a command spelling this surface really ships was replaced and the surface still read as enforced',
      ).toEqual([]);
    },
  );

  it.each(combos)(
    'reports %s policy %s as not SUPPORTED when any one command field of its shipped entry is gone (mutation: one spelling deleted)',
    async (_harness, _policyId, adapter, policy: PolicyDeclaration) => {
      const snapshot = await readRaw(adapter.surfaceFile);
      const { hookPath } = adapter.nativeSurfaceOf(policy);
      expect(probePolicy(policy, adapter, snapshot).state).toBe('SUPPORTED');

      const fields = commandFieldsOf(shippedEntry(snapshot, hookPath));
      const answers = fields.map((field) => {
        const { snapshot: mutated, changed } = rewriteEntryOf(snapshot, hookPath, (entry) =>
          Object.fromEntries(Object.entries(entry).filter(([name]) => name !== field)),
        );
        expect(changed, `deleting ${field} rewrote no entry in the shipped snapshot`).toBe(1);
        expect(
          JSON.stringify(mutated),
          `deleting ${field} left the shipped snapshot unchanged`,
        ).not.toBe(JSON.stringify(snapshot));
        return [field, probePolicy(policy, adapter, mutated).state] as const;
      });

      expect(
        answers.filter(([, state]) => state === 'SUPPORTED'),
        'a command spelling this surface really ships was removed and the surface still read as enforced',
      ).toEqual([]);
    },
  );

  it.each(combos)(
    'reports %s policy %s as INTEGRATION-FAILED when a command field of its shipped entry is not a string (mutation: unreadable spelling)',
    async (_harness, _policyId, adapter, policy: PolicyDeclaration) => {
      const snapshot = await readRaw(adapter.surfaceFile);
      const { hookPath } = adapter.nativeSurfaceOf(policy);
      expect(probePolicy(policy, adapter, snapshot).state).toBe('SUPPORTED');

      const fields = commandFieldsOf(shippedEntry(snapshot, hookPath));
      const answers = fields.map((field) => {
        const { snapshot: mutated, changed } = rewriteEntryOf(snapshot, hookPath, (entry) => ({
          ...entry,
          [field]: 42,
        }));
        expect(changed, `making ${field} unreadable rewrote no entry`).toBe(1);
        return [field, probePolicy(policy, adapter, mutated).state] as const;
      });

      expect(answers).toEqual(fields.map((field) => [field, 'INTEGRATION-FAILED']));
    },
  );

  /**
   * KEEP GREEN, and the half of the rule that keeps it from firing on honest
   * work: an entry must carry every field the ADAPTER names, not every field
   * that looks like a command. The shipped files already carry fields no adapter
   * generates — `type` on both surfaces, `timeout` on one — and a harness that
   * grew a platform this rig does not target would add another.
   */
  it.each(combos)(
    'still reports %s policy %s as SUPPORTED when its shipped entry gains a command field this harness generates nothing for (mutation: undeclared spelling)',
    async (_harness, _policyId, adapter, policy: PolicyDeclaration) => {
      const snapshot = await readRaw(adapter.surfaceFile);
      const { hookPath } = adapter.nativeSurfaceOf(policy);
      const undeclared = 'commandLegacy';
      expect(
        commandFieldsOf(shippedEntry(snapshot, hookPath)),
        'the shipped entry already carries this field, so it pins nothing',
      ).not.toContain(undeclared);

      const { snapshot: mutated, changed } = rewriteEntryOf(snapshot, hookPath, (entry) => ({
        ...entry,
        [undeclared]: DISABLED,
      }));
      expect(changed, 'the mutation rewrote no entry in the shipped snapshot').toBe(1);
      expect(
        probePolicy(policy, adapter, mutated).state,
        'a field no adapter generates a command for was read as part of the wiring',
      ).toBe('SUPPORTED');
    },
  );

  /**
   * What makes every `SUPPORTED` above a measurement rather than a fixture
   * agreeing with itself: the adapter's answer and the bytes in the shipped
   * file, held equal in EVERY field the adapter generates one for — including
   * the Windows spelling, whose base64 is derived here from the adapter rather
   * than pasted, so a change to either side is reported.
   */
  it.each(combos)(
    'the %s snapshot wires %s with exactly the spelling that adapter generates, in every field it generates one for',
    async (_harness, _policyId, adapter, policy: PolicyDeclaration) => {
      const snapshot = await readRaw(adapter.surfaceFile);
      const entry = shippedEntry(snapshot, adapter.nativeSurfaceOf(policy).hookPath);
      const spellings = fieldSpellingsOf(adapter, policy);
      expect(
        Object.entries(spellings).map(([field, accepted]) => {
          const shipped = entry[field];
          return [field, typeof shipped === 'string' && accepted.includes(shipped)];
        }),
        'the shipped snapshot carries a spelling this adapter would not generate',
      ).toEqual(Object.keys(spellings).map((field) => [field, true]));
    },
  );

  it.each(combos)(
    'the %s adapter names a spelling for every command field the shipped entry for %s carries, and for no field it does not',
    async (_harness, _policyId, adapter, policy: PolicyDeclaration) => {
      const snapshot = await readRaw(adapter.surfaceFile);
      const entry = shippedEntry(snapshot, adapter.nativeSurfaceOf(policy).hookPath);
      expect(
        [...Object.keys(fieldSpellingsOf(adapter, policy))].sort(),
        'the fields the adapter generates and the command fields the file ships are not the same set',
      ).toEqual([...commandFieldsOf(entry)].sort());
    },
  );

  /**
   * The correspondence above holds vacuously if every surface ships exactly one
   * command field — which is the state the probe's old one-field read was
   * correct for, and the state deleting `commandWindows` from the derived
   * snapshot would restore.
   */
  it('wires a hook through more than one command spelling on at least one shipped surface, or the correspondence above pins nothing', async () => {
    const policy = POLICIES[0];
    if (policy === undefined) throw new Error('the registry declares no policy');
    const counts = await Promise.all(
      HARNESS_ADAPTERS.map(async (adapter) => {
        const snapshot = await readRaw(adapter.surfaceFile);
        const entry = shippedEntry(snapshot, adapter.nativeSurfaceOf(policy).hookPath);
        return [adapter.harness, commandFieldsOf(entry).length] as const;
      }),
    );
    expect(
      Math.max(...counts.map(([, count]) => count)),
      `no shipped surface carries a second command spelling: ${JSON.stringify(counts)}`,
    ).toBeGreaterThan(1);
  });
});

describe('the evidence matrix row for a real surface', () => {
  it.each(combos)(
    'a %s row for %s carries the exact version, the observed date-time and a pointer',
    async (_harness, _policyId, adapter, policy: PolicyDeclaration) => {
      const identity = identityOf(adapter);
      const entry = entryFor(await probeOf(adapter), policy.policyId);
      const row = {
        ...identity,
        observedAt: entry.verifiedAt,
        mechanism: policy.mechanism,
        observableSignal: `${policy.mechanism} refuses the operation and says why`,
        status: entry.status,
        evidencePointer: entry.evidencePointer ?? adapter.surfaceFile,
      };
      const result = validateEvidenceRow(row);
      expect(result.ok, result.ok ? '' : JSON.stringify(result.problems)).toBe(true);
    },
  );

  it.each(adapters)(
    'the same %s row is incomplete once the exact harness version is gone (mutation: no version)',
    async (_harness, adapter) => {
      const identity = identityOf(adapter);
      const entry = entryFor(await probeOf(adapter), 'secret-write-refusal');
      const row: Record<string, unknown> = {
        ...identity,
        observedAt: entry.verifiedAt,
        mechanism: 'guard-secret-file',
        observableSignal: 'a refusal on stderr and a non-zero exit code',
        status: entry.status,
        evidencePointer: adapter.surfaceFile,
      };
      delete row.harnessVersion;
      const result = validateEvidenceRow(row);
      expect(result.ok, 'a row with no harness version was accepted').toBe(false);
      if (!result.ok) {
        expect(result.problems.map((problem) => problem.field)).toContain('harnessVersion');
      }
    },
  );
});
