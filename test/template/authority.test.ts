// RP-339: the autonomous-controller authority contract.
//
// `.claude/scripts/lib/authority.mjs` is meant to become the single source of
// truth for what an autonomous controller session may decide on its own
// versus what stays the owner's call — the closed list of decisions a
// `delegated` authority may resolve, the closed list of boundaries that stay
// with the owner regardless of delegation, and the two pure functions that
// turn a raw execution-mode/decision-authority pair into the one posture
// object every surface reports against. This mirrors
// `test/template/posture.test.ts` (RP-280): same reason — one mechanism, one
// implementation (`.claude/rules/invariants.md`) — applied to a second
// closed-vocabulary contract instead of a second copy of the first.
//
// Limits, stated: the purity checks below are a TEXT scan of the module's
// own source — an `import` assembled from string concatenation, or a
// `process` reference spelled through a computed property, would not be
// caught. That is the same limit every sibling source-scan in this suite
// states for itself (see posture.test.ts, secrets-lib.test.ts,
// layers-split.test.ts); it targets drift, not an adversary.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universalDir = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const scriptsDir = path.join(universalDir, '.claude', 'scripts');
const modulePath = path.join(scriptsDir, 'lib', 'authority.mjs');
const moduleRel = '.claude/scripts/lib/authority.mjs';
const decisionRecordPath = path.join(universalDir, 'docs', 'decisions', 'decision-authority.md');
const decisionRecordRel = 'docs/decisions/decision-authority.md';
const layersJsonPath = path.join(universalDir, 'layers.json');

type ExecutionMode = 'attended' | 'unattended';
type DecisionAuthority = 'owner' | 'delegated';
type ParsedDecisionAuthority = DecisionAuthority | 'unknown';
type ParsedExecutionMode = ExecutionMode | 'unknown';

interface AuthorityDecision {
  id: string;
  summary: string;
}

interface AuthorityPosture {
  schemaVersion: 1;
  executionMode: ParsedExecutionMode;
  decisionAuthority: ParsedDecisionAuthority;
  publicationAuthority: 'owner';
}

interface AuthorityModule {
  EXECUTION_MODES: readonly ExecutionMode[];
  DECISION_AUTHORITIES: readonly DecisionAuthority[];
  DEFAULT_DECISION_AUTHORITY: DecisionAuthority;
  PUBLICATION_AUTHORITY: 'owner';
  DELEGABLE_DECISIONS: readonly AuthorityDecision[];
  NON_DELEGABLE_BOUNDARIES: readonly AuthorityDecision[];
  parseDecisionAuthority(raw: unknown): ParsedDecisionAuthority;
  parseExecutionMode(raw: unknown): ParsedExecutionMode;
  mayResolve(decisionId: string, authority: unknown): boolean;
  authorityPosture(input?: {
    executionMode?: unknown;
    decisionAuthority?: unknown;
  }): AuthorityPosture;
}

// The module ships as plain .mjs with no type declarations — same reason
// posture.test.ts, secrets-lib.test.ts and verdict.test.ts import their
// subjects through a file URL rather than a relative specifier.
const load = async (): Promise<AuthorityModule> =>
  (await import(pathToFileURL(modulePath).href)) as unknown as AuthorityModule;

// The closed id lists the spec decided on, independent of the module under
// test — so a correspondence test comparing the two is not just the module
// agreeing with itself.
const EXPECTED_DELEGABLE_IDS = [
  'implementation-choice',
  'scope-correction',
  'work-sequencing',
  'tracker-correction',
  'finding-disposition',
  'extra-gate-round',
  'elevated-change-acceptance',
  'merge',
  'release-candidate-freeze',
];

const EXPECTED_NON_DELEGABLE_IDS = [
  'never-rule',
  'kill-switch',
  'failing-mechanical-gate',
  'unreadable-evidence',
  'credential-protection',
  'hard-external-boundary',
  'publication',
];

const KEBAB_CASE = /^[a-z]+(-[a-z]+)*$/;

describe('authority.mjs — the closed decision/boundary vocabulary (RP-339)', () => {
  it('EXECUTION_MODES is frozen and exactly [attended, unattended]', async () => {
    const { EXECUTION_MODES } = await load();
    expect([...EXECUTION_MODES]).toEqual(['attended', 'unattended']);
    expect(Object.isFrozen(EXECUTION_MODES)).toBe(true);
  });

  it('DECISION_AUTHORITIES is frozen and exactly [owner, delegated]', async () => {
    const { DECISION_AUTHORITIES } = await load();
    expect([...DECISION_AUTHORITIES]).toEqual(['owner', 'delegated']);
    expect(Object.isFrozen(DECISION_AUTHORITIES)).toBe(true);
  });

  it('DEFAULT_DECISION_AUTHORITY and PUBLICATION_AUTHORITY are both "owner"', async () => {
    const { DEFAULT_DECISION_AUTHORITY, PUBLICATION_AUTHORITY } = await load();
    expect(DEFAULT_DECISION_AUTHORITY).toBe('owner');
    expect(PUBLICATION_AUTHORITY).toBe('owner');
  });

  it('exports exactly the delegable decision ids the contract names, in order, each kebab-case', async () => {
    const { DELEGABLE_DECISIONS } = await load();
    const ids = DELEGABLE_DECISIONS.map((d) => d.id);
    expect(ids).toEqual(EXPECTED_DELEGABLE_IDS);
    for (const id of ids) {
      expect(id, `${id} is not kebab-case`).toMatch(KEBAB_CASE);
    }
  });

  it('exports exactly the non-delegable boundary ids the contract names, in order, each kebab-case', async () => {
    const { NON_DELEGABLE_BOUNDARIES } = await load();
    const ids = NON_DELEGABLE_BOUNDARIES.map((b) => b.id);
    expect(ids).toEqual(EXPECTED_NON_DELEGABLE_IDS);
    for (const id of ids) {
      expect(id, `${id} is not kebab-case`).toMatch(KEBAB_CASE);
    }
  });

  it('every delegable decision and non-delegable boundary carries a non-empty summary', async () => {
    const { DELEGABLE_DECISIONS, NON_DELEGABLE_BOUNDARIES } = await load();
    for (const entry of [...DELEGABLE_DECISIONS, ...NON_DELEGABLE_BOUNDARIES]) {
      expect(typeof entry.summary, entry.id).toBe('string');
      expect(entry.summary.length, entry.id).toBeGreaterThan(0);
    }
  });

  it('no id appears in both lists, and every id across both lists is unique', async () => {
    const { DELEGABLE_DECISIONS, NON_DELEGABLE_BOUNDARIES } = await load();
    const delegableIds = DELEGABLE_DECISIONS.map((d) => d.id);
    const nonDelegableIds = NON_DELEGABLE_BOUNDARIES.map((b) => b.id);
    const allIds = [...delegableIds, ...nonDelegableIds];
    expect(new Set(allIds).size, 'duplicate id across the two lists').toBe(allIds.length);
    const overlap = delegableIds.filter((id) => nonDelegableIds.includes(id));
    expect(overlap, 'ids present in both lists').toEqual([]);
  });

  it('DELEGABLE_DECISIONS, NON_DELEGABLE_BOUNDARIES, and every entry object, are frozen', async () => {
    const { DELEGABLE_DECISIONS, NON_DELEGABLE_BOUNDARIES } = await load();
    expect(Object.isFrozen(DELEGABLE_DECISIONS)).toBe(true);
    expect(Object.isFrozen(NON_DELEGABLE_BOUNDARIES)).toBe(true);
    for (const entry of [...DELEGABLE_DECISIONS, ...NON_DELEGABLE_BOUNDARIES]) {
      expect(Object.isFrozen(entry), entry.id).toBe(true);
    }
  });

  it('mutating a frozen decision entry throws rather than silently succeeding', async () => {
    const { DELEGABLE_DECISIONS } = await load();
    const first = DELEGABLE_DECISIONS[0];
    expect(first).toBeDefined();
    expect(() => {
      first!.id = 'mutated';
    }).toThrow();
  });

  it('mutating the frozen DELEGABLE_DECISIONS array throws rather than silently succeeding', async () => {
    const { DELEGABLE_DECISIONS } = await load();
    expect(() => {
      // @ts-expect-error — deliberately mutating a frozen array to prove it rejects the write
      DELEGABLE_DECISIONS.push({ id: 'injected', summary: 'should never land' });
    }).toThrow();
  });
});

describe('parseDecisionAuthority (RP-339)', () => {
  it('defaults undefined and null to "owner" — the backwards-compatible default', async () => {
    const { parseDecisionAuthority } = await load();
    expect(parseDecisionAuthority(undefined)).toBe('owner');
    expect(parseDecisionAuthority(null)).toBe('owner');
  });

  it('reads exactly "owner" and exactly "delegated" as themselves', async () => {
    const { parseDecisionAuthority } = await load();
    expect(parseDecisionAuthority('owner')).toBe('owner');
    expect(parseDecisionAuthority('delegated')).toBe('delegated');
  });

  it('reads anything else as "unknown" — never a silent fallback to owner or delegated', async () => {
    const { parseDecisionAuthority } = await load();
    const malformed: unknown[] = [
      '',
      'Delegated',
      ' delegated',
      'delegated ',
      'yes',
      true,
      1,
      {},
      ['delegated'],
    ];
    for (const raw of malformed) {
      expect(parseDecisionAuthority(raw), JSON.stringify(raw)).toBe('unknown');
    }
  });
});

describe('parseExecutionMode (RP-339)', () => {
  it('reads exactly "attended" and exactly "unattended" as themselves', async () => {
    const { parseExecutionMode } = await load();
    expect(parseExecutionMode('attended')).toBe('attended');
    expect(parseExecutionMode('unattended')).toBe('unattended');
  });

  it('reads anything else as "unknown", including undefined, null and a case/space variant', async () => {
    const { parseExecutionMode } = await load();
    const malformed: unknown[] = [undefined, null, '', 'Unattended', true];
    for (const raw of malformed) {
      expect(parseExecutionMode(raw), JSON.stringify(raw)).toBe('unknown');
    }
  });
});

describe('mayResolve (RP-339)', () => {
  it('is true only for a delegable id under exactly "delegated"', async () => {
    const { mayResolve, DELEGABLE_DECISIONS } = await load();
    for (const { id } of DELEGABLE_DECISIONS) {
      expect(mayResolve(id, 'delegated'), id).toBe(true);
    }
  });

  it('is false for every delegable id under owner, unknown, undefined, or any other string', async () => {
    const { mayResolve, DELEGABLE_DECISIONS } = await load();
    const notDelegated: unknown[] = ['owner', 'unknown', undefined, 'Delegated', 'yes', ''];
    for (const { id } of DELEGABLE_DECISIONS) {
      for (const authority of notDelegated) {
        expect(mayResolve(id, authority), `${id} / ${JSON.stringify(authority)}`).toBe(false);
      }
    }
  });

  it('is false for every non-delegable id under every authority, including "delegated"', async () => {
    const { mayResolve, NON_DELEGABLE_BOUNDARIES, DECISION_AUTHORITIES } = await load();
    const authorities: unknown[] = [...DECISION_AUTHORITIES, 'unknown', undefined];
    for (const { id } of NON_DELEGABLE_BOUNDARIES) {
      for (const authority of authorities) {
        expect(mayResolve(id, authority), `${id} / ${JSON.stringify(authority)}`).toBe(false);
      }
    }
  });

  it('throws, naming the id, for a decisionId neither list names — the vocabulary is closed', async () => {
    const { mayResolve } = await load();
    for (const id of ['publish-to-npm', '', 'MERGE']) {
      expect(() => mayResolve(id, 'delegated'), JSON.stringify(id)).toThrow(
        new RegExp(id.length > 0 ? id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '.'),
      );
    }
  });
});

describe('authorityPosture (RP-339)', () => {
  it('called with no argument reports unknown execution mode, owner decision authority, owner publication authority', async () => {
    const { authorityPosture } = await load();
    expect(authorityPosture()).toEqual({
      schemaVersion: 1,
      executionMode: 'unknown',
      decisionAuthority: 'owner',
      publicationAuthority: 'owner',
    });
  });

  it('passes a recognised execution mode and decision authority straight through', async () => {
    const { authorityPosture } = await load();
    expect(
      authorityPosture({ executionMode: 'unattended', decisionAuthority: 'delegated' }),
    ).toEqual({
      schemaVersion: 1,
      executionMode: 'unattended',
      decisionAuthority: 'delegated',
      publicationAuthority: 'owner',
    });
  });

  it('a malformed decisionAuthority reports "unknown", never "delegated"', async () => {
    const { authorityPosture } = await load();
    const result = authorityPosture({ decisionAuthority: 'nonsense' });
    expect(result.decisionAuthority).toBe('unknown');
    expect(result.decisionAuthority).not.toBe('delegated');
  });

  it('an extra publicationAuthority input key is ignored — the result always says owner', async () => {
    const { authorityPosture } = await load();
    for (const spoofed of ['delegated', 'controller']) {
      const result = authorityPosture({
        executionMode: 'attended',
        decisionAuthority: 'owner',
        // @ts-expect-error — deliberately passing an input key the contract does not accept
        publicationAuthority: spoofed,
      });
      expect(result.publicationAuthority, spoofed).toBe('owner');
    }
  });

  it('key order is exactly schemaVersion, executionMode, decisionAuthority, publicationAuthority', async () => {
    const { authorityPosture } = await load();
    const result = authorityPosture({ executionMode: 'attended', decisionAuthority: 'delegated' });
    expect(Object.keys(result)).toEqual([
      'schemaVersion',
      'executionMode',
      'decisionAuthority',
      'publicationAuthority',
    ]);
  });

  it('is deterministic — two calls with equal input serialise byte-identically to the exact expected string', async () => {
    const { authorityPosture } = await load();
    const first = JSON.stringify(
      authorityPosture({ executionMode: 'unattended', decisionAuthority: 'delegated' }),
    );
    const second = JSON.stringify(
      authorityPosture({ executionMode: 'unattended', decisionAuthority: 'delegated' }),
    );
    expect(first).toBe(second);
    expect(first).toBe(
      '{"schemaVersion":1,"executionMode":"unattended","decisionAuthority":"delegated","publicationAuthority":"owner"}',
    );
  });

  it('the returned posture object is frozen', async () => {
    const { authorityPosture } = await load();
    const result = authorityPosture();
    expect(Object.isFrozen(result)).toBe(true);
  });
});

describe('authority.mjs is pure Core — no I/O, no __PROJECT_NAME__, no imports at all (RP-339)', () => {
  it('declares no import statement and no dynamic import', async () => {
    const content = await readFile(modulePath, 'utf8');
    expect(content).not.toMatch(/^\s*import\s/m);
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

describe('authority.mjs sits in the process (Core) layer of layers.json (RP-339)', () => {
  it('lists the module under `process`, and not under `workflow`', async () => {
    const manifest = JSON.parse(await readFile(layersJsonPath, 'utf8')) as Record<string, string[]>;
    expect(manifest.process ?? []).toContain(moduleRel);
    expect(manifest.workflow ?? []).not.toContain(moduleRel);
  });

  it('lists the decision record under `process`, and not under `workflow`', async () => {
    const manifest = JSON.parse(await readFile(layersJsonPath, 'utf8')) as Record<string, string[]>;
    expect(manifest.process ?? []).toContain(decisionRecordRel);
    expect(manifest.workflow ?? []).not.toContain(decisionRecordRel);
  });

  // Having no import statements at all (asserted above) means authority.mjs
  // trivially satisfies layers-split.test.ts's "no core .mjs file imports a
  // workflow-layer file" rule — there is nothing it could import that would
  // violate it.
  it('imports nothing, so it cannot reach into the workflow layer', async () => {
    const content = await readFile(modulePath, 'utf8');
    const IMPORT = /(?:from|import)\s*\(?\s*['"](\.{1,2}\/[A-Za-z0-9._\-/]+\.mjs)['"]/g;
    expect([...content.matchAll(IMPORT)]).toEqual([]);
  });
});

describe('the decision-authority decision record (RP-339)', () => {
  it('exists and names authority.mjs as the single source', async () => {
    const content = await readFile(decisionRecordPath, 'utf8');
    expect(content).toContain(moduleRel);
  });

  // The record points at the module; it does not restate either list,
  // because a restated list is a second copy that drifts the moment an id is
  // added or renamed in the module and not here (`.claude/rules/invariants.md`,
  // "one mechanism, one implementation").
  it('does not re-list any decision or boundary id — it points at the module instead of duplicating it', async () => {
    const content = await readFile(decisionRecordPath, 'utf8');
    const allIds = [...EXPECTED_DELEGABLE_IDS, ...EXPECTED_NON_DELEGABLE_IDS];
    const reListed = allIds.filter((id) => content.includes(id));
    expect(reListed, 'ids the decision record restates verbatim').toEqual([]);
  });
});
