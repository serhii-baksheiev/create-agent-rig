// RP-341: the stop-class vocabulary — distinguishing an owner-decision
// boundary (`decision-needed`) that a `delegated` authority may resolve and
// continue past, from a per-item wall that only ever escalates the item
// (`work-blocked`), from a run-level condition that always stops the run
// regardless of authority (`systemic-wall`, `hard-external-boundary`).
//
// `.claude/scripts/queue/stop-class.mjs` is meant to become the single
// source of truth for: the four stop classes; the three resolutions a stop
// can reach (`decide-and-continue`, `escalate-item`, `stop-run`); the
// per-item stop catalogue (`ITEM_STOPS`) naming which class and which
// delegable decision (if any) each named item-level stop carries; the
// mapping from every run-level stop `core.mjs` can report to its class
// (`RUN_STOP_CLASS`); and the pure function (`resolutionOf`) that turns a
// stop class, a decision authority and a decision id into one of the three
// resolutions. It imports nothing but `../lib/authority.mjs` (RP-339) — the
// closed delegable/non-delegable decision vocabulary — so a decision id it
// names is checked against that one contract rather than a second copy of
// it (`.claude/rules/invariants.md`, "one mechanism, one implementation").
//
// `core.mjs`'s `stopConditionOf` is extended here too: every run-level stop
// it returns must carry a `stopClass` field, and the two clean ends
// (`nothing-selectable`, `queue-empty`) must carry `stopClass: null` — they
// end a run successfully with nothing to report, never a wall. It also
// takes no authority input at all: a systemic or external condition stops
// the run exactly the same way whether the caller claims `delegated` or not.
//
// Limits, stated: the purity checks below are a TEXT scan of the module's
// own source — an `import` assembled from string concatenation, or a
// `process` reference spelled through a computed property, would not be
// caught. That is the same limit every sibling source-scan in this suite
// states for itself (see authority.test.ts, posture.test.ts,
// secrets-lib.test.ts, layers-split.test.ts); it targets drift, not an
// adversary.
//
// The expected `STOP_CLASSES` / `RESOLUTIONS` / `ITEM_STOPS` /
// `RUN_STOP_CLASS` values below are declared independently of the module
// under test, as the oracle — so a correspondence test comparing the two is
// not just the module agreeing with itself
// (`.claude/rules/invariants.md`, "the independent-oracle invariant").
// `RUN_STOP_CLASS`'s expected key set is derived a second, independent way
// again: by driving `stopConditionOf` in `queue/core.mjs` with one input per
// run-level condition and reading back the `kind`s it actually returns,
// rather than copying the six names from this file's own prose.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universalDir = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const scriptsDir = path.join(universalDir, '.claude', 'scripts');
const modulePath = path.join(scriptsDir, 'queue', 'stop-class.mjs');
const authorityModulePath = path.join(scriptsDir, 'lib', 'authority.mjs');
const coreModulePath = path.join(scriptsDir, 'queue', 'core.mjs');
// The module's placement under `workflow` in `layers.json` is pinned by the
// named workflow set in layers-split.test.ts › "the workflow layer is exactly
// the named set RP-180 decided on", not repeated here.

type StopClass = 'decision-needed' | 'work-blocked' | 'systemic-wall' | 'hard-external-boundary';
type Resolution = 'decide-and-continue' | 'escalate-item' | 'stop-run';

interface ItemStop {
  id: string;
  stopClass: StopClass;
  decision: string | null;
}

interface StopClassModule {
  STOP_CLASSES: readonly StopClass[];
  RESOLUTIONS: readonly Resolution[];
  ITEM_STOPS: readonly ItemStop[];
  RUN_STOP_CLASS: Readonly<Record<string, StopClass>>;
  resolutionOf(input: {
    stopClass: string;
    authority: unknown;
    decision: string | null;
  }): Resolution;
}

// The module ships as plain .mjs with no type declarations — same reason
// authority.test.ts, posture.test.ts and verdict.test.ts import their
// subjects through a file URL rather than a relative specifier.
const load = async (): Promise<StopClassModule> =>
  (await import(pathToFileURL(modulePath).href)) as unknown as StopClassModule;

// Loaded untyped, exactly the way this same suite's queue.test.ts already
// loads `core.mjs` — these two are read-only cross-checks, not the module
// under test.
const loadAuthority = async () => import(pathToFileURL(authorityModulePath).href);
const loadCore = async () => import(pathToFileURL(coreModulePath).href);

// --- independent oracles, declared before the module is ever loaded --------

const EXPECTED_STOP_CLASSES: StopClass[] = [
  'decision-needed',
  'work-blocked',
  'systemic-wall',
  'hard-external-boundary',
];

const EXPECTED_RESOLUTIONS: Resolution[] = ['decide-and-continue', 'escalate-item', 'stop-run'];

const EXPECTED_ITEM_STOPS: ItemStop[] = [
  { id: 'three-strikes', stopClass: 'work-blocked', decision: null },
  { id: 'attempt-budget', stopClass: 'work-blocked', decision: null },
  { id: 'blocking-verdict', stopClass: 'work-blocked', decision: null },
  { id: 'gate-round-cap', stopClass: 'decision-needed', decision: 'extra-gate-round' },
  { id: 'premise-false', stopClass: 'decision-needed', decision: 'scope-correction' },
  { id: 'surprise-scope', stopClass: 'decision-needed', decision: 'elevated-change-acceptance' },
  { id: 'invariant-conflict', stopClass: 'decision-needed', decision: null },
  { id: 'external-blocker', stopClass: 'hard-external-boundary', decision: null },
];

// The resolution each catalogued item stop reaches under exactly `delegated`
// authority — declared by hand against the spec, not read off the module.
const EXPECTED_RESOLUTION_UNDER_DELEGATED: Record<string, Resolution> = {
  'three-strikes': 'escalate-item',
  'attempt-budget': 'escalate-item',
  'blocking-verdict': 'escalate-item',
  'gate-round-cap': 'decide-and-continue',
  'premise-false': 'decide-and-continue',
  'surprise-scope': 'decide-and-continue',
  'invariant-conflict': 'escalate-item',
  'external-blocker': 'stop-run',
};

const EXPECTED_RUN_STOP_CLASS: Record<string, StopClass> = {
  'queue-unreadable': 'systemic-wall',
  'runtime-regression': 'systemic-wall',
  'revalidation-hold': 'systemic-wall',
  'repeated-escalation': 'systemic-wall',
  'kill-switch': 'hard-external-boundary',
  budget: 'hard-external-boundary',
};

const REVALIDATION_HOLD = {
  ticket: 'X',
  checkpoint: 'SELECT',
  result: 'CHANGED',
  detectionId: 'd',
};

describe('STOP_CLASSES (RP-341)', () => {
  it('is frozen and exactly the four stop classes, in order', async () => {
    const { STOP_CLASSES } = await load();
    expect([...STOP_CLASSES]).toEqual(EXPECTED_STOP_CLASSES);
    expect(Object.isFrozen(STOP_CLASSES)).toBe(true);
  });
});

describe('RESOLUTIONS (RP-341)', () => {
  it('is frozen and exactly the three resolutions, in order', async () => {
    const { RESOLUTIONS } = await load();
    expect([...RESOLUTIONS]).toEqual(EXPECTED_RESOLUTIONS);
    expect(Object.isFrozen(RESOLUTIONS)).toBe(true);
  });
});

describe('ITEM_STOPS — the per-item stop catalogue (RP-341)', () => {
  it('is frozen, and every entry object is frozen', async () => {
    const { ITEM_STOPS } = await load();
    expect(Object.isFrozen(ITEM_STOPS)).toBe(true);
    for (const entry of ITEM_STOPS) {
      expect(Object.isFrozen(entry), entry?.id).toBe(true);
    }
  });

  it('lists exactly the eight catalogued stops, in order, each with its stop class and decision', async () => {
    const { ITEM_STOPS } = await load();
    const shape = ITEM_STOPS.map(({ id, stopClass, decision }) => ({ id, stopClass, decision }));
    expect(shape).toEqual(EXPECTED_ITEM_STOPS);
  });

  it('every stopClass named in ITEM_STOPS is a member of STOP_CLASSES', async () => {
    const { ITEM_STOPS, STOP_CLASSES } = await load();
    for (const entry of ITEM_STOPS) {
      expect([...STOP_CLASSES], entry.id).toContain(entry.stopClass);
    }
  });

  it('every non-null decision in ITEM_STOPS is a delegable decision id authority.mjs names — cross-module correspondence', async () => {
    const { ITEM_STOPS } = await load();
    const { DELEGABLE_DECISIONS } = await loadAuthority();
    const delegableIds = new Set((DELEGABLE_DECISIONS as Array<{ id: string }>).map((d) => d.id));
    for (const entry of ITEM_STOPS) {
      if (entry.decision === null) continue;
      expect(delegableIds.has(entry.decision), `${entry.id} -> ${entry.decision}`).toBe(true);
    }
  });
});

describe('RUN_STOP_CLASS — every run-level stop core.mjs can return, mapped to its class (RP-341)', () => {
  it('is frozen', async () => {
    const { RUN_STOP_CLASS } = await load();
    expect(Object.isFrozen(RUN_STOP_CLASS)).toBe(true);
  });

  it("maps exactly the six run-stop kinds core.mjs can return, minus the two clean ends — derived by driving stopConditionOf, not by reading this file's own prose", async () => {
    const { stopConditionOf } = await loadCore();
    const driven = [
      stopConditionOf({ queueReadable: false }),
      stopConditionOf({ lastDeployVerdict: 'REGRESSION' }),
      stopConditionOf({ killSwitch: true }),
      stopConditionOf({ revalidationHold: REVALIDATION_HOLD }),
      stopConditionOf({ consecutiveEscalations: 2 }),
      stopConditionOf({ budgetExhausted: true }),
      // the two clean ends — explicitly excluded from RUN_STOP_CLASS
      stopConditionOf({
        candidates: 0,
        skipped: [{ id: '1', reason: 'held', causes: ['spacing'] }],
      }),
      stopConditionOf({ candidates: 0 }),
    ] as Array<{ kind: string }>;

    const allKinds = driven.map((stop) => stop?.kind);
    expect(allKinds).toContain('nothing-selectable');
    expect(allKinds).toContain('queue-empty');

    const runStopKinds = allKinds.filter(
      (kind) => kind !== 'nothing-selectable' && kind !== 'queue-empty',
    );
    expect(new Set(runStopKinds)).toEqual(new Set(Object.keys(EXPECTED_RUN_STOP_CLASS)));

    const { RUN_STOP_CLASS } = await load();
    expect(new Set(Object.keys(RUN_STOP_CLASS))).toEqual(new Set(runStopKinds));
    for (const kind of runStopKinds) {
      expect(RUN_STOP_CLASS[kind], kind).toBe(EXPECTED_RUN_STOP_CLASS[kind]);
    }
  });
});

describe('stopConditionOf (core.mjs) now carries a stopClass on every stop it returns (RP-341)', () => {
  it('reports stopClass systemic-wall for queue-unreadable, runtime-regression, revalidation-hold and repeated-escalation', async () => {
    const { stopConditionOf } = await loadCore();
    expect(stopConditionOf({ queueReadable: false })?.stopClass).toBe('systemic-wall');
    expect(stopConditionOf({ lastDeployVerdict: 'REGRESSION' })?.stopClass).toBe('systemic-wall');
    expect(stopConditionOf({ revalidationHold: REVALIDATION_HOLD })?.stopClass).toBe(
      'systemic-wall',
    );
    expect(stopConditionOf({ consecutiveEscalations: 2 })?.stopClass).toBe('systemic-wall');
  });

  it('reports stopClass hard-external-boundary for kill-switch and budget', async () => {
    const { stopConditionOf } = await loadCore();
    expect(stopConditionOf({ killSwitch: true })?.stopClass).toBe('hard-external-boundary');
    expect(stopConditionOf({ budgetExhausted: true })?.stopClass).toBe('hard-external-boundary');
  });

  it('reports stopClass null for the two clean ends, nothing-selectable and queue-empty', async () => {
    const { stopConditionOf } = await loadCore();
    const nothingSelectable = stopConditionOf({
      candidates: 0,
      skipped: [{ id: '1', reason: 'held', causes: ['spacing'] }],
    });
    expect(nothingSelectable?.kind).toBe('nothing-selectable');
    expect(nothingSelectable?.stopClass).toBeNull();

    const queueEmpty = stopConditionOf({ candidates: 0 });
    expect(queueEmpty?.kind).toBe('queue-empty');
    expect(queueEmpty?.stopClass).toBeNull();
  });

  it('takes no authority input: decisionAuthority alongside a systemic/external input is ignored — the result is deep-equal to the call without it, and the stop still fires', async () => {
    const { stopConditionOf } = await loadCore();
    const cases: Array<Record<string, unknown>> = [
      { queueReadable: false },
      { lastDeployVerdict: 'REGRESSION' },
      { killSwitch: true },
      { revalidationHold: REVALIDATION_HOLD },
      { consecutiveEscalations: 2 },
      { budgetExhausted: true },
    ];
    for (const input of cases) {
      const without = stopConditionOf(input);
      const withAuthority = stopConditionOf({ ...input, decisionAuthority: 'delegated' });
      expect(withAuthority, JSON.stringify(input)).toEqual(without);
      expect(withAuthority, JSON.stringify(input)).not.toBeNull();
    }
  });
});

describe('resolutionOf (RP-341)', () => {
  const AUTHORITIES: unknown[] = ['owner', 'delegated', 'unknown', undefined];
  const ANY_DECISIONS: Array<string | null> = [
    null,
    'extra-gate-round',
    'publication',
    'kill-switch',
  ];

  it('systemic-wall and hard-external-boundary resolve to stop-run under every authority, whatever the decision value', async () => {
    const { resolutionOf } = await load();
    for (const stopClass of ['systemic-wall', 'hard-external-boundary'] as const) {
      for (const authority of AUTHORITIES) {
        for (const decision of ANY_DECISIONS) {
          expect(
            resolutionOf({ stopClass, authority, decision }),
            `${stopClass} / ${JSON.stringify(authority)} / ${decision}`,
          ).toBe('stop-run');
        }
      }
    }
  });

  it('work-blocked resolves to escalate-item under every authority', async () => {
    const { resolutionOf } = await load();
    for (const authority of AUTHORITIES) {
      expect(
        resolutionOf({ stopClass: 'work-blocked', authority, decision: null }),
        JSON.stringify(authority),
      ).toBe('escalate-item');
    }
  });

  it('decision-needed with a delegable decision resolves to decide-and-continue only under exactly "delegated"', async () => {
    const { resolutionOf } = await load();
    expect(
      resolutionOf({
        stopClass: 'decision-needed',
        authority: 'delegated',
        decision: 'extra-gate-round',
      }),
    ).toBe('decide-and-continue');
    for (const authority of ['owner', 'unknown', undefined, 'Delegated']) {
      expect(
        resolutionOf({ stopClass: 'decision-needed', authority, decision: 'extra-gate-round' }),
        JSON.stringify(authority),
      ).toBe('escalate-item');
    }
  });

  it('decision-needed with a null decision never continues, even under delegated (e.g. invariant-conflict)', async () => {
    const { resolutionOf } = await load();
    expect(
      resolutionOf({ stopClass: 'decision-needed', authority: 'delegated', decision: null }),
    ).toBe('escalate-item');
  });

  it('decision-needed with a non-delegable boundary id never continues, even under delegated — delegation never converts a true boundary into permission', async () => {
    const { resolutionOf } = await load();
    for (const decision of ['publication', 'kill-switch']) {
      expect(
        resolutionOf({ stopClass: 'decision-needed', authority: 'delegated', decision }),
        decision,
      ).toBe('escalate-item');
    }
  });

  it('throws, naming it, for an unknown stopClass', async () => {
    const { resolutionOf } = await load();
    expect(() =>
      resolutionOf({ stopClass: 'made-up', authority: 'delegated', decision: null }),
    ).toThrow(/made-up/);
  });

  it("throws for a decision id neither of authority.mjs's lists names — the vocabulary is closed", async () => {
    const { resolutionOf } = await load();
    expect(() =>
      resolutionOf({
        stopClass: 'decision-needed',
        authority: 'delegated',
        decision: 'not-a-real-decision',
      }),
    ).toThrow(/not-a-real-decision/);
  });

  it('table-driven: every ITEM_STOPS entry resolves, under delegated authority, to the independently declared expected resolution — and none of them is decide-and-continue under owner', async () => {
    const { resolutionOf, ITEM_STOPS } = await load();
    expect(ITEM_STOPS.length).toBeGreaterThan(0);
    for (const entry of ITEM_STOPS) {
      const delegated = resolutionOf({
        stopClass: entry.stopClass,
        authority: 'delegated',
        decision: entry.decision,
      });
      expect(delegated, entry.id).toBe(EXPECTED_RESOLUTION_UNDER_DELEGATED[entry.id]);

      const owner = resolutionOf({
        stopClass: entry.stopClass,
        authority: 'owner',
        decision: entry.decision,
      });
      expect(owner, entry.id).not.toBe('decide-and-continue');
    }
  });
});

describe('stop-class.mjs is pure Core, with exactly one import — ../lib/authority.mjs (RP-341)', () => {
  it('declares exactly one import statement, naming ../lib/authority.mjs', async () => {
    const content = await readFile(modulePath, 'utf8');
    const importStatements = [...content.matchAll(/^\s*import\s[^\n]*$/gm)].map((m) => m[0].trim());
    expect(importStatements).toHaveLength(1);
    expect(importStatements[0]).toMatch(/from\s+['"]\.\.\/lib\/authority\.mjs['"]/);
  });

  it('declares no dynamic import and no require', async () => {
    const content = await readFile(modulePath, 'utf8');
    expect(content).not.toMatch(/\bimport\s*\(/);
    expect(content).not.toMatch(/\brequire\s*\(/);
  });

  it('carries no __PROJECT_NAME__ substitution token', async () => {
    const content = await readFile(modulePath, 'utf8');
    expect(content).not.toContain('__PROJECT_NAME__');
  });

  it('touches no process/fs/child_process I/O surface', async () => {
    const content = await readFile(modulePath, 'utf8');
    expect(content).not.toMatch(/\bprocess\./);
    expect(content).not.toMatch(/\bchild_process\b/);
    expect(content).not.toMatch(/\breadFile\b|\bwriteFile\b|\breadFileSync\b|\bwriteFileSync\b/);
  });
});
