// RP-280: the unattended-execution posture contract.
//
// `.claude/scripts/lib/posture.mjs` is meant to become the single source of
// truth for what "unattended posture" means: the closed list of conditions
// preflight and doctor can report on, which ones are required (a run must
// stop), which are advisory (a run may caution and continue), and which this
// rig cannot mechanically observe at all — stated so a reader does not
// assume a surface covers ground it does not. Two readers (preflight's
// verdict, doctor's per-condition status) derive their answer from the same
// list, per `.claude/rules/invariants.md` ("one mechanism, one
// implementation") — so this file pins the module's shape before either
// reader exists.
//
// Limits, stated: the purity checks below are a TEXT scan of the module's
// own source — an `import` assembled from string concatenation, or a
// `process` reference spelled through a computed property, would not be
// caught. That is the same limit every sibling source-scan in this suite
// states for itself (see secrets-lib.test.ts, layers-split.test.ts); it
// targets drift, not an adversary.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universalDir = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const scriptsDir = path.join(universalDir, '.claude', 'scripts');
const modulePath = path.join(scriptsDir, 'lib', 'posture.mjs');
const moduleRel = '.claude/scripts/lib/posture.mjs';
const decisionRecordPath = path.join(universalDir, 'docs', 'decisions', 'unattended-posture.md');
const layersJsonPath = path.join(universalDir, 'layers.json');

type Surface = 'preflight' | 'doctor';
type Classification = 'required' | 'advisory' | 'not-observable';
type Harness = 'both' | 'claude-code' | 'codex';
type Outcome = 'pass' | 'fail' | 'unknown';

interface PostureCondition {
  id: string;
  classification: Classification;
  surfaces: readonly Surface[];
  harness: Harness;
  summary: string;
}

interface PostureModule {
  POSTURE_CONDITIONS: readonly PostureCondition[];
  conditionById(id: string): PostureCondition | undefined;
  preflightVerdict(outcomes: Record<string, Outcome>): 'STOP' | 'CAUTION' | 'GO';
  doctorStatus(id: string, outcome: Outcome): 'fail' | 'warn' | 'ok';
}

// The module ships as plain .mjs with no type declarations — same reason
// secrets-lib.test.ts and verdict.test.ts import their subjects through a
// file URL rather than a relative specifier.
const load = async (): Promise<PostureModule> =>
  (await import(pathToFileURL(modulePath).href)) as unknown as PostureModule;

// The closed id lists the spec decided on, independent of the module under
// test — so a correspondence test comparing the two is not just the module
// agreeing with itself.
const EXPECTED_REQUIRED = [
  'kill-switch-armed',
  'run-dir-inherited',
  'detection-contract-invalid',
  'queue-unreadable',
  'last-deploy-failed',
  'hook-wiring-missing',
  'guard-integrity-failed',
  'unattended-flag-stale',
  'workflow-layer-missing',
];

const EXPECTED_ADVISORY = [
  'default-branch-stale',
  'tracker-credentials-missing',
  'dod-checks-missing',
  'gitignore-runtime-entries-missing',
];

const EXPECTED_NOT_OBSERVABLE = [
  'harness-hooks-loaded',
  'codex-hook-trust',
  'workspace-trust',
  'native-sandbox-mode',
  'session-root-matches-run',
  'run-dir-fresh-per-run',
  'budget-declared',
  'stray-worktree',
];

const EXPECTED_SURFACES: Record<string, readonly Surface[]> = {
  'kill-switch-armed': ['preflight', 'doctor'],
  'run-dir-inherited': ['preflight'],
  'detection-contract-invalid': ['preflight', 'doctor'],
  'queue-unreadable': ['preflight'],
  'last-deploy-failed': ['preflight'],
  'hook-wiring-missing': ['doctor'],
  'guard-integrity-failed': ['doctor'],
  'unattended-flag-stale': ['preflight', 'doctor'],
  'workflow-layer-missing': ['doctor'],
  'default-branch-stale': ['preflight'],
  'tracker-credentials-missing': ['doctor'],
  'dod-checks-missing': ['doctor'],
  'gitignore-runtime-entries-missing': ['doctor'],
};

const KEBAB_CASE = /^[a-z]+(-[a-z]+)*$/;

describe('posture.mjs — the closed condition list (RP-280)', () => {
  it('exports exactly the required/advisory/not-observable ids the contract names, each kebab-case and unique', async () => {
    const { POSTURE_CONDITIONS } = await load();
    const ids = POSTURE_CONDITIONS.map((c) => c.id);

    expect(new Set(ids).size, 'duplicate id').toBe(ids.length);
    for (const id of ids) {
      expect(id, `${id} is not kebab-case`).toMatch(KEBAB_CASE);
    }

    const byClassification = (classification: Classification) =>
      POSTURE_CONDITIONS.filter((c) => c.classification === classification)
        .map((c) => c.id)
        .sort();

    expect(byClassification('required')).toEqual([...EXPECTED_REQUIRED].sort());
    expect(byClassification('advisory')).toEqual([...EXPECTED_ADVISORY].sort());
    expect(byClassification('not-observable')).toEqual([...EXPECTED_NOT_OBSERVABLE].sort());
    expect(ids.sort()).toEqual(
      [...EXPECTED_REQUIRED, ...EXPECTED_ADVISORY, ...EXPECTED_NOT_OBSERVABLE].sort(),
    );
  });

  it('every required/advisory condition declares exactly the surfaces the contract names', async () => {
    const { POSTURE_CONDITIONS } = await load();
    for (const [id, surfaces] of Object.entries(EXPECTED_SURFACES)) {
      const condition = POSTURE_CONDITIONS.find((c) => c.id === id);
      expect(condition, `${id} missing from POSTURE_CONDITIONS`).toBeDefined();
      expect([...(condition?.surfaces ?? [])], id).toEqual([...surfaces]);
    }
  });

  it('every not-observable condition declares an empty surfaces array', async () => {
    const { POSTURE_CONDITIONS } = await load();
    for (const id of EXPECTED_NOT_OBSERVABLE) {
      const condition = POSTURE_CONDITIONS.find((c) => c.id === id);
      expect(condition, `${id} missing from POSTURE_CONDITIONS`).toBeDefined();
      expect(condition?.surfaces, id).toEqual([]);
    }
  });

  it('codex-hook-trust is scoped to the codex harness; every condition declares a valid harness', async () => {
    const { POSTURE_CONDITIONS } = await load();
    const VALID_HARNESS = new Set(['both', 'claude-code', 'codex']);
    for (const condition of POSTURE_CONDITIONS) {
      expect(VALID_HARNESS.has(condition.harness), condition.id).toBe(true);
    }
    const codexHookTrust = POSTURE_CONDITIONS.find((c) => c.id === 'codex-hook-trust');
    expect(codexHookTrust?.harness).toBe('codex');
  });

  it('every condition carries a non-empty summary and a surfaces array that is a subset of [preflight, doctor]', async () => {
    const { POSTURE_CONDITIONS } = await load();
    for (const condition of POSTURE_CONDITIONS) {
      expect(typeof condition.summary, condition.id).toBe('string');
      expect(condition.summary.length, condition.id).toBeGreaterThan(0);
      for (const surface of condition.surfaces) {
        expect(['preflight', 'doctor'], condition.id).toContain(surface);
      }
    }
  });

  it('POSTURE_CONDITIONS, each condition object, and each surfaces array are frozen', async () => {
    const { POSTURE_CONDITIONS } = await load();
    expect(Object.isFrozen(POSTURE_CONDITIONS)).toBe(true);
    for (const condition of POSTURE_CONDITIONS) {
      expect(Object.isFrozen(condition), condition.id).toBe(true);
      expect(Object.isFrozen(condition.surfaces), condition.id).toBe(true);
    }
  });

  it('mutating a frozen condition object throws rather than silently succeeding', async () => {
    const { POSTURE_CONDITIONS } = await load();
    const first = POSTURE_CONDITIONS[0];
    expect(first).toBeDefined();
    expect(() => {
      first!.id = 'mutated';
    }).toThrow();
  });

  it('mutating the frozen POSTURE_CONDITIONS array throws rather than silently succeeding', async () => {
    const { POSTURE_CONDITIONS } = await load();
    expect(() => {
      // @ts-expect-error — deliberately mutating a frozen array to prove it rejects the write
      POSTURE_CONDITIONS.push({
        id: 'injected',
        classification: 'advisory',
        surfaces: ['preflight'],
        harness: 'both',
        summary: 'should never land',
      });
    }).toThrow();
  });
});

describe('conditionById (RP-280)', () => {
  it('returns the matching condition object for a known id', async () => {
    const { conditionById } = await load();
    const condition = conditionById('kill-switch-armed');
    expect(condition?.id).toBe('kill-switch-armed');
  });

  it('returns undefined for an id the contract does not name', async () => {
    const { conditionById } = await load();
    expect(conditionById('not-a-real-condition')).toBeUndefined();
  });
});

describe('preflightVerdict (RP-280)', () => {
  it('returns STOP when a required condition reports fail', async () => {
    const { preflightVerdict } = await load();
    expect(preflightVerdict({ 'kill-switch-armed': 'fail' })).toBe('STOP');
  });

  it('returns CAUTION when an advisory condition reports fail', async () => {
    const { preflightVerdict } = await load();
    expect(preflightVerdict({ 'default-branch-stale': 'fail' })).toBe('CAUTION');
  });

  it('returns CAUTION on an unknown outcome, even for a required condition', async () => {
    const { preflightVerdict } = await load();
    expect(preflightVerdict({ 'kill-switch-armed': 'unknown' })).toBe('CAUTION');
  });

  it('returns GO when every reported condition passes', async () => {
    const { preflightVerdict } = await load();
    expect(preflightVerdict({ 'kill-switch-armed': 'pass', 'default-branch-stale': 'pass' })).toBe(
      'GO',
    );
  });

  it('returns GO on an empty outcomes object', async () => {
    const { preflightVerdict } = await load();
    expect(preflightVerdict({})).toBe('GO');
  });

  it('a required fail outranks an advisory fail or an unknown reported alongside it', async () => {
    const { preflightVerdict } = await load();
    expect(
      preflightVerdict({
        'kill-switch-armed': 'fail',
        'default-branch-stale': 'fail',
        'queue-unreadable': 'unknown',
      }),
    ).toBe('STOP');
  });

  it('throws for an id POSTURE_CONDITIONS does not name', async () => {
    const { preflightVerdict } = await load();
    expect(() => preflightVerdict({ 'not-a-real-condition': 'fail' })).toThrow();
  });

  it('throws for a not-observable id — a surface may not report what the contract says it cannot observe', async () => {
    const { preflightVerdict } = await load();
    expect(() => preflightVerdict({ 'harness-hooks-loaded': 'fail' })).toThrow();
  });

  it('throws for a doctor-only id reported to preflightVerdict', async () => {
    const { preflightVerdict } = await load();
    expect(() => preflightVerdict({ 'hook-wiring-missing': 'fail' })).toThrow();
  });
});

describe('doctorStatus (RP-280)', () => {
  it('maps required+fail to fail', async () => {
    const { doctorStatus } = await load();
    expect(doctorStatus('kill-switch-armed', 'fail')).toBe('fail');
  });

  it('maps required+unknown to warn, not fail', async () => {
    const { doctorStatus } = await load();
    expect(doctorStatus('kill-switch-armed', 'unknown')).toBe('warn');
  });

  it('maps required+pass to ok', async () => {
    const { doctorStatus } = await load();
    expect(doctorStatus('kill-switch-armed', 'pass')).toBe('ok');
  });

  it('maps advisory+fail to warn, not fail', async () => {
    const { doctorStatus } = await load();
    expect(doctorStatus('tracker-credentials-missing', 'fail')).toBe('warn');
  });

  it('maps advisory+unknown to warn', async () => {
    const { doctorStatus } = await load();
    expect(doctorStatus('tracker-credentials-missing', 'unknown')).toBe('warn');
  });

  it('maps advisory+pass to ok', async () => {
    const { doctorStatus } = await load();
    expect(doctorStatus('tracker-credentials-missing', 'pass')).toBe('ok');
  });

  it('throws for an id POSTURE_CONDITIONS does not name', async () => {
    const { doctorStatus } = await load();
    expect(() => doctorStatus('not-a-real-condition', 'fail')).toThrow();
  });

  it('throws for a not-observable id', async () => {
    const { doctorStatus } = await load();
    expect(() => doctorStatus('harness-hooks-loaded', 'fail')).toThrow();
  });

  it('throws for a preflight-only id reported to doctorStatus', async () => {
    const { doctorStatus } = await load();
    expect(() => doctorStatus('run-dir-inherited', 'fail')).toThrow();
  });
});

describe('posture.mjs is pure Core — no I/O, no __PROJECT_NAME__, no imports at all (RP-280)', () => {
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

describe('posture.mjs sits in the process (Core) layer of layers.json (RP-280)', () => {
  it('is listed under `process`, and not under `workflow`', async () => {
    const manifest = JSON.parse(await readFile(layersJsonPath, 'utf8')) as Record<string, string[]>;
    expect(manifest.process ?? []).toContain(moduleRel);
    expect(manifest.workflow ?? []).not.toContain(moduleRel);
  });

  // Having no import statements at all (asserted above) means posture.mjs
  // trivially satisfies layers-split.test.ts's "no core .mjs file imports a
  // workflow-layer file" rule — there is nothing it could import that would
  // violate it.
  it('imports nothing, so it cannot reach into the workflow layer', async () => {
    const content = await readFile(modulePath, 'utf8');
    const IMPORT = /(?:from|import)\s*\(?\s*['"](\.{1,2}\/[A-Za-z0-9._\-/]+\.mjs)['"]/g;
    expect([...content.matchAll(IMPORT)]).toEqual([]);
  });
});

describe('the unattended-posture decision record (RP-280)', () => {
  it('exists and names posture.mjs as the single source', async () => {
    const content = await readFile(decisionRecordPath, 'utf8');
    expect(content).toContain(moduleRel);
  });

  // The record points at the module; it does not restate the list, because a
  // restated list is a second copy that drifts the moment an id is added or
  // renamed in the module and not here (`.claude/rules/invariants.md`, "one
  // mechanism, one implementation").
  it('does not re-list any condition id — it points at the module instead of duplicating it', async () => {
    const content = await readFile(decisionRecordPath, 'utf8');
    const allIds = [...EXPECTED_REQUIRED, ...EXPECTED_ADVISORY, ...EXPECTED_NOT_OBSERVABLE];
    const reListed = allIds.filter((id) => content.includes(id));
    expect(reListed, 'ids the decision record restates verbatim').toEqual([]);
  });
});
