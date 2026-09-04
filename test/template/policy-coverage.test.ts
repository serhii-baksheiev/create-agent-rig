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
import { probePolicy, type HookSnapshot } from '../../packages/cli/src/policy/core/probe.js';
import { validateEvidenceRow } from '../../packages/cli/src/policy/core/evidence-matrix.js';
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

const eachGroup = (
  snapshot: HookSnapshot,
  map: (group: { matcher?: string; hooks: readonly { command: string }[] }) => {
    matcher?: string;
    hooks: readonly { command: string }[];
  },
): HookSnapshot => ({
  hooks: Object.fromEntries(
    Object.entries(snapshot.hooks).map(([event, groups]) => [event, (groups ?? []).map(map)]),
  ),
});

/** How many hook entries in the snapshot run this hook file. */
const timesWired = (snapshot: HookSnapshot, hookPath: string): number =>
  Object.values(snapshot.hooks)
    .flatMap((groups) => groups ?? [])
    .flatMap((group) => [...group.hooks])
    .filter((hook) => hook.command.includes(hookPath)).length;

/** The real snapshot with one policy's hook command taken out of every group. */
const withoutHook = (snapshot: HookSnapshot, hookPath: string): HookSnapshot =>
  eachGroup(snapshot, (group) => ({
    ...group,
    hooks: [...group.hooks].filter((hook) => !hook.command.includes(hookPath)),
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
      if (!hook.command.includes(hookPath)) return hook;
      changed += 1;
      return { ...hook, command: mutate(hook.command) };
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
      expect(result.state).toBe('UNSUPPORTED');
      expect(result.reason ?? '').toContain(hookPath);
    },
  );

  // The unwired mutation above removes the command; these three LEAVE the hook
  // path where it is and change only whether the command RUNS it.
  it.each(mentionCases)(
    'reports %s policy %s as UNSUPPORTED when its real command becomes %s (mutation: mentioned, not run)',
    async (_harness, _policyId, mutation, adapter, policy: PolicyDeclaration, mutate) => {
      const snapshot = await readSnapshot(adapter.surfaceFile);
      const { hookPath } = adapter.nativeSurfaceOf(policy);
      const { snapshot: mutated, changed } = rewriteCommand(snapshot, hookPath, (command) =>
        mutate(command, hookPath),
      );
      expect(changed, 'the mutation rewrote no command in the real snapshot').toBe(1);

      const result = probePolicy(policy, adapter, mutated);
      expect(result.state, `${mutation} was read as enforcement`).toBe('UNSUPPORTED');
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
