import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HARNESS_ADAPTERS,
  POLICIES,
  type HarnessAdapter,
  type PolicyDeclaration,
} from '../../packages/cli/src/policy/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const policyDir = path.join(repoRoot, 'packages', 'cli', 'src', 'policy');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');

/**
 * RP-76 asked for a typed policy declaration whose shared core carries no
 * provider vocabulary, and whose per-harness adapters are the ONLY place a
 * harness is named — so that adding a harness touches adapters only, proven by
 * the Codex adapter. It also asked that the three represented guards keep their
 * runtime behaviour, and (anti-acceptance) that no interpreter or generic
 * compiler framework appears in the policy code.
 *
 * Two trees are read here, and the scope of each check is stated because they
 * differ. The first four checks read `packages/cli/src/policy/` — the
 * generator's own source, which does not ship into a rig:
 *
 * - the provider-vocabulary scan over `src/policy/core/`, with a POSITIVE
 *   CONTROL proving the scanner detects the tokens it is asked to refuse;
 * - which files may mention each harness;
 * - dependency direction (core imports nothing outside `./`; harness imports
 *   `../core/` or siblings; nothing under `src/policy/` imports a builtin or a
 *   bare package; no `eval(` / `new Function(` under `src/policy/`).
 *
 * The last two read `templates/agent-os/universal/`, the tree that ships:
 *
 * - declaration ↔ native-surface correspondence in BOTH directions against the
 *   hook-wiring snapshots, with MUTATION tests against in-memory snapshots so
 *   the check is proven to name an offender (adapter, policy id, hook path) —
 *   not merely to pass on the real files;
 * - the guards the declaration represents still exist at the paths the
 *   adapters name.
 */

type HookGroup = { matcher?: string; hooks: Array<{ command: string }> };
type HookSnapshot = { hooks: Record<string, HookGroup[] | undefined> };

const PROVIDER_TOKENS = [
  'claude',
  'codex',
  'anthropic',
  'openai',
  'chatgpt',
  'gpt',
  'gemini',
  'copilot',
  'apply_patch',
  'PreToolUse',
  'CLAUDE_PROJECT_DIR',
  'settings.json',
  'hooks.json',
  'AGENTS.md',
  'CLAUDE.md',
  '.codex',
  '.claude',
];

/**
 * Hooks wired in the snapshots that no policy declares yet. Each is a candidate
 * for a later declaration; listing them here is what makes a NEW undeclared hook
 * go red rather than slide in beside them.
 */
const UNDECLARED_HOOKS = [
  'guard-core-purity', // candidate: core-purity policy (file-edit)
  'guard-web-boundary', // candidate: web-boundary policy (file-edit)
  'guard-bash', // candidate: never-tier shell policy + kill switch (shell-command)
];

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole-token, case-insensitive: which provider tokens does this text carry? */
const providerTokensIn = (text: string): string[] =>
  PROVIDER_TOKENS.filter((token) =>
    new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(token)}(?![A-Za-z0-9_])`, 'i').test(text),
  );

const toPosix = (p: string) => p.split(path.sep).join('/');

/** Every `.ts` under `dir`, as sorted posix paths relative to `dir`. */
const listTs = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => toPosix(path.relative(dir, path.join(e.parentPath, e.name))))
    .sort();
};

const readPolicyFile = (rel: string) => readFile(path.join(policyDir, rel), 'utf8');

/** Import/export specifiers in a TS source — static, re-export, side-effect, dynamic. */
const importSpecifiersIn = (source: string): string[] => {
  const specifiers: string[] = [];
  for (const re of [
    /\b(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /^\s*import\s+['"]([^'"]+)['"]/gm,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]) {
    for (const match of source.matchAll(re)) {
      if (match[1] !== undefined) specifiers.push(match[1]);
    }
  }
  return specifiers;
};

const readSnapshot = async (surfaceFile: string): Promise<HookSnapshot> =>
  JSON.parse(await readFile(path.join(universal, surfaceFile), 'utf8')) as HookSnapshot;

type MissingSurface = { harness: string; policyId: string; hookPath: string };

/** Forward: every policy's native surface has a group in the snapshot that covers it. */
const missingSurfaces = (
  adapter: HarnessAdapter,
  policies: readonly PolicyDeclaration[],
  snapshot: HookSnapshot,
): MissingSurface[] => {
  const missing: MissingSurface[] = [];
  for (const policy of policies) {
    const surface = adapter.nativeSurfaceOf(policy);
    const groups = snapshot.hooks[surface.event] ?? [];
    const tools = surface.matcher.split('|');
    const covered = groups.some((group) => {
      const groupTools = (group.matcher ?? '').split('|');
      const matches = tools.every((tool) => groupTools.includes(tool));
      const wired = group.hooks.some((h) => h.command.includes(surface.hookPath));
      return matches && wired;
    });
    if (!covered) {
      missing.push({
        harness: adapter.harness,
        policyId: policy.policyId,
        hookPath: surface.hookPath,
      });
    }
  }
  return missing;
};

/** Reverse: every hook wired under PreToolUse is declared or explicitly listed as not yet. */
const undeclaredHooksIn = (
  adapters: readonly HarnessAdapter[],
  policies: readonly PolicyDeclaration[],
  snapshot: HookSnapshot,
): string[] => {
  const declared = new Set(
    adapters.flatMap((adapter) => policies.map((p) => adapter.nativeSurfaceOf(p).hookPath)),
  );
  const offenders = new Set<string>();
  for (const group of snapshot.hooks.PreToolUse ?? []) {
    for (const hook of group.hooks) {
      for (const match of hook.command.matchAll(/\.claude\/hooks\/([a-z0-9-]+)\.mjs/g)) {
        const name = match[1] ?? '';
        const hookPath = `.claude/hooks/${name}.mjs`;
        if (!declared.has(hookPath) && !UNDECLARED_HOOKS.includes(name)) offenders.add(name);
      }
    }
  }
  return [...offenders].sort();
};

const fixtureDeclaration = (overrides: Partial<PolicyDeclaration>): PolicyDeclaration => ({
  policyId: 'fixture-policy',
  policyVersion: '1.0',
  lifecycle: 'active',
  invariant: 'A fixture never happens.',
  tier: 'never',
  operations: ['file-edit'],
  timing: 'before-operation',
  requiredCapability: 'pre-operation-hook',
  mechanism: 'guard-fixture',
  outcomes: ['allow', 'block', 'refuse-to-inspect'],
  onInternalError: 'fail-open',
  onUnreadableInput: 'fail-closed',
  requiredEvidence: ['exit-code', 'diagnostic-text'],
  redaction: 'none',
  statedIn: 'rules/autonomy.md#never',
  ...overrides,
});

/** An in-memory snapshot shaped like the real ones, for the mutation tests. */
const snapshotWith = (
  fileEditMatcher: string,
  shellMatcher: string,
  extraCommands: string[] = [],
): HookSnapshot => ({
  hooks: {
    PreToolUse: [
      {
        matcher: fileEditMatcher,
        hooks: [
          ...['guard-core-purity', 'guard-web-boundary', 'guard-secret-file', 'guard-rulebook'].map(
            (n) => ({ command: `node "$X/.claude/hooks/${n}.mjs"` }),
          ),
          ...extraCommands.map((command) => ({ command })),
        ],
      },
      {
        matcher: shellMatcher,
        hooks: ['block-no-verify', 'guard-bash'].map((n) => ({
          command: `node "$X/.claude/hooks/${n}.mjs"`,
        })),
      },
    ],
  },
});

const REAL_FILE_EDIT = 'Write|Edit|MultiEdit|NotebookEdit|apply_patch';
const REAL_SHELL = 'Bash|PowerShell';

describe('the policy core carries no provider vocabulary', () => {
  it('the scanner reports claude and codex for a text that contains them (positive control)', () => {
    const found = providerTokensIn('const harness = "Claude"; // and codex too');
    expect(found).toContain('claude');
    expect(found).toContain('codex');
  });

  it('the scanner matches whole tokens only, so a word merely containing one is not reported', () => {
    expect(providerTokensIn('const egypt = 1; const claudette = 2;')).toEqual([]);
  });

  it('no file under src/policy/core mentions a harness, a vendor, a native tool or a native path', async () => {
    const files = await listTs(path.join(policyDir, 'core'));
    expect(files.length, 'the core has no files to scan').toBeGreaterThan(0);
    for (const rel of files) {
      const found = providerTokensIn(await readPolicyFile(`core/${rel}`));
      expect(found, `core/${rel} carries provider vocabulary: ${found.join(', ')}`).toEqual([]);
    }
  });
});

describe('adding a harness touches adapters only', () => {
  const filesMentioning = async (word: string): Promise<string[]> => {
    const files = await listTs(policyDir);
    const hits: string[] = [];
    for (const rel of files) {
      if ((await readPolicyFile(rel)).toLowerCase().includes(word)) hits.push(rel);
    }
    return hits.sort();
  };

  it('codex is named only by its own adapter and the adapter index', async () => {
    expect(await filesMentioning('codex')).toEqual(['harness/codex.ts', 'harness/index.ts']);
  });

  // `.claude/hooks/` is the ONE directory both harnesses run their hook files
  // from — the rulebook keeps its historical name (CLAUDE.md, "One operating
  // system, two harnesses") — so the module that spells that directory once
  // for every adapter is allowed the word too. It is still an adapter-side
  // file: nothing under core/ may name it.
  it('claude is named only by its own adapter, the shared hooks directory and the adapter index', async () => {
    expect(await filesMentioning('claude')).toEqual([
      'harness/claude.ts',
      'harness/index.ts',
      'harness/shared-hooks.ts',
    ]);
  });
});

describe('dependency direction inside src/policy', () => {
  it('the core imports only its own siblings, never upward', async () => {
    for (const rel of await listTs(path.join(policyDir, 'core'))) {
      for (const spec of importSpecifiersIn(await readPolicyFile(`core/${rel}`))) {
        expect(spec.startsWith('./'), `core/${rel} imports ${spec}`).toBe(true);
        expect(spec.includes('../'), `core/${rel} reaches outside the core: ${spec}`).toBe(false);
      }
    }
  });

  it('a harness adapter imports only the core or a sibling adapter', async () => {
    for (const rel of await listTs(path.join(policyDir, 'harness'))) {
      for (const spec of importSpecifiersIn(await readPolicyFile(`harness/${rel}`))) {
        expect(
          spec.startsWith('./') || spec.startsWith('../core/'),
          `harness/${rel} imports ${spec}`,
        ).toBe(true);
        expect(spec.replace(/^\.\.\/core\//, '').includes('../'), `harness/${rel}: ${spec}`).toBe(
          false,
        );
      }
    }
  });

  it('nothing under src/policy imports a node builtin or a bare package', async () => {
    for (const rel of await listTs(policyDir)) {
      for (const spec of importSpecifiersIn(await readPolicyFile(rel))) {
        expect(spec.startsWith('node:'), `${rel} imports the builtin ${spec}`).toBe(false);
        expect(spec.startsWith('.'), `${rel} imports the bare package ${spec}`).toBe(true);
      }
    }
  });

  // the two literals below are search strings handed to `includes`; nothing is executed
  it('nothing under src/policy evaluates text as code (no interpreter)', async () => {
    for (const rel of await listTs(policyDir)) {
      const text = await readPolicyFile(rel);
      expect(text.includes('eval('), `${rel} calls eval`).toBe(false);
      expect(text.includes('new Function('), `${rel} builds a Function from text`).toBe(false);
    }
  });
});

describe('declaration and native surface correspond', () => {
  it.each(HARNESS_ADAPTERS.map((a) => [a.harness, a] as const))(
    'every registered policy is wired in the %s snapshot under its event, matcher and hook path',
    async (_harness, adapter) => {
      const snapshot = await readSnapshot(adapter.surfaceFile);
      expect(missingSurfaces(adapter, POLICIES, snapshot)).toEqual([]);
    },
  );

  it.each(HARNESS_ADAPTERS.map((a) => [a.harness, a] as const))(
    'every PreToolUse hook in the %s snapshot is declared by a policy or listed as not yet',
    async (_harness, adapter) => {
      const snapshot = await readSnapshot(adapter.surfaceFile);
      expect(undeclaredHooksIn(HARNESS_ADAPTERS, POLICIES, snapshot)).toEqual([]);
    },
  );

  it('the undeclared-hook list names hooks that exist and are not already declared', async () => {
    const declared = new Set(POLICIES.map((p) => p.mechanism));
    for (const name of UNDECLARED_HOOKS) {
      expect(declared.has(name), `${name} is declared now; drop it from UNDECLARED_HOOKS`).toBe(
        false,
      );
      const info = await stat(path.join(universal, '.claude', 'hooks', `${name}.mjs`));
      expect(info.isFile()).toBe(true);
    }
  });

  it.each(HARNESS_ADAPTERS.map((a) => [a.harness, a] as const))(
    'reports a policy whose mechanism no %s group wires, naming adapter, policy and hook path (mutation: guard-nothing)',
    (_harness, adapter) => {
      const nothing = fixtureDeclaration({
        policyId: 'nothing-policy',
        mechanism: 'guard-nothing',
      });
      const snapshot = snapshotWith(REAL_FILE_EDIT, REAL_SHELL);
      expect(missingSurfaces(adapter, [...POLICIES, nothing], snapshot)).toEqual([
        {
          harness: adapter.harness,
          policyId: 'nothing-policy',
          hookPath: '.claude/hooks/guard-nothing.mjs',
        },
      ]);
    },
  );

  it.each(HARNESS_ADAPTERS.map((a) => [a.harness, a] as const))(
    'reports the no-verify policy on %s when the shell matcher loses PowerShell (mutation: matcher)',
    (_harness, adapter) => {
      const snapshot = snapshotWith(REAL_FILE_EDIT, 'Bash');
      expect(missingSurfaces(adapter, POLICIES, snapshot)).toEqual([
        {
          harness: adapter.harness,
          policyId: 'no-verify-refusal',
          hookPath: '.claude/hooks/block-no-verify.mjs',
        },
      ]);
    },
  );

  it('reports a hook wired in the snapshot that no policy declares (mutation: guard-extra)', () => {
    const snapshot = snapshotWith(REAL_FILE_EDIT, REAL_SHELL, [
      'node "$X/.claude/hooks/guard-extra.mjs"',
    ]);
    expect(undeclaredHooksIn(HARNESS_ADAPTERS, POLICIES, snapshot)).toEqual(['guard-extra']);
  });

  it('the unmutated in-memory snapshot is clean, so the mutations above are the only cause of red', () => {
    const snapshot = snapshotWith(REAL_FILE_EDIT, REAL_SHELL);
    for (const adapter of HARNESS_ADAPTERS) {
      expect(missingSurfaces(adapter, POLICIES, snapshot)).toEqual([]);
    }
    expect(undeclaredHooksIn(HARNESS_ADAPTERS, POLICIES, snapshot)).toEqual([]);
  });
});

describe('the guards the declaration represents still exist', () => {
  const combos = HARNESS_ADAPTERS.flatMap((adapter) =>
    POLICIES.map((policy) => [adapter.harness, policy.policyId, adapter, policy] as const),
  );

  it.each(combos)(
    '%s names a hook file for %s that ships in the universal layer',
    async (_harness, _policyId, adapter, policy) => {
      const { hookPath } = adapter.nativeSurfaceOf(policy);
      const info = await stat(path.join(universal, hookPath));
      expect(info.isFile(), `${hookPath} is not a file`).toBe(true);
    },
  );
});
