import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateEvidenceRow } from '../../packages/cli/src/policy/core/evidence-matrix.js';

/**
 * RP-173: one closed routing policy (`templates/agent-os/subagent-routing.json`)
 * pins the model and effort of every named subagent on BOTH harnesses. The
 * Claude agent frontmatter and settings are checked against it by
 * `scripts/subagent-routing.mjs`; the Codex projection is derived from it.
 *
 * The module is loaded with a dynamic import, the way codex.test.ts loads
 * `scripts/sync-codex-adapter.mjs`, so its absence is a failing test rather
 * than a failing typecheck.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const agentOs = path.join(repoRoot, 'templates', 'agent-os');
const universal = path.join(agentOs, 'universal');
const policyPath = path.join(agentOs, 'subagent-routing.json');

const text = (...parts: string[]) => readFile(path.join(...parts), 'utf8');

interface Route {
  model: string;
  effort: string;
}

interface RoutingPolicy {
  claudeModels: Record<string, string[]>;
  unnamed: { claude: { model: string }; codex: Route };
  roles: Record<string, { claude: Route; codex: Route }>;
}

interface ClaudeAgent {
  name: string;
  source: string;
  model?: string;
  effort?: string;
}

interface CodexProfiles {
  default: Route;
  agents: Record<string, Route>;
}

interface RoutingModule {
  CLAUDE_EFFORTS: readonly string[];
  FORBIDDEN_CLAUDE_ENV: readonly string[];
  validateRoutingPolicy: (policy: unknown) => unknown;
  codexProfilesOf: (policy: RoutingPolicy) => CodexProfiles;
  validateClaudeAgents: (policy: RoutingPolicy, agents: ClaudeAgent[]) => unknown;
  validateClaudeSettings: (policy: RoutingPolicy, settings: unknown) => unknown;
}

const routing = async (): Promise<RoutingModule> =>
  (await import(
    pathToFileURL(path.join(repoRoot, 'scripts', 'subagent-routing.mjs')).href
  )) as RoutingModule;

const syncAdapter = async () =>
  (await import(pathToFileURL(path.join(repoRoot, 'scripts', 'sync-codex-adapter.mjs')).href)) as {
    validateAgentProfiles: (
      policy: unknown,
      sourceAgents: Array<{ name: string; source: string }>,
    ) => unknown;
  };

const realPolicy = async (): Promise<RoutingPolicy> =>
  JSON.parse(await readFile(policyPath, 'utf8')) as RoutingPolicy;

/** The message of whatever `run` throws, or '' when it does not throw. */
const thrownMessage = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
};

/** A small valid policy, independent of the shipped one. */
const fixturePolicy = (): RoutingPolicy => ({
  claudeModels: {
    'claude-fixture-large': ['low', 'medium', 'high'],
    'claude-fixture-small': ['low'],
  },
  unnamed: {
    claude: { model: 'claude-fixture-small' },
    codex: { model: 'codex-fixture', effort: 'medium' },
  },
  roles: {
    reviewer: {
      claude: { model: 'claude-fixture-large', effort: 'high' },
      codex: { model: 'codex-fixture', effort: 'high' },
    },
    writer: {
      claude: { model: 'claude-fixture-small', effort: 'low' },
      codex: { model: 'codex-fixture', effort: 'medium' },
    },
  },
});

const withRole = (
  policy: RoutingPolicy,
  role: string,
  entry: Record<string, unknown>,
): Record<string, unknown> => ({ ...policy, roles: { ...policy.roles, [role]: entry } });

const withUnnamedClaude = (
  policy: RoutingPolicy,
  claude: Record<string, unknown>,
): Record<string, unknown> => ({ ...policy, unnamed: { ...policy.unnamed, claude } });

const RP_173_ROUTING: RoutingPolicy = {
  claudeModels: {
    'claude-opus-5': ['low', 'medium', 'high', 'xhigh', 'max'],
    'claude-sonnet-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  unnamed: {
    claude: { model: 'claude-sonnet-5' },
    codex: { model: 'gpt-5.6-terra', effort: 'medium' },
  },
  roles: {
    'test-writer': {
      claude: { model: 'claude-sonnet-5', effort: 'high' },
      codex: { model: 'gpt-5.6-terra', effort: 'high' },
    },
    'prose-reviewer': {
      claude: { model: 'claude-sonnet-5', effort: 'high' },
      codex: { model: 'gpt-5.6-terra', effort: 'high' },
    },
    'code-reviewer': {
      claude: { model: 'claude-opus-5', effort: 'high' },
      codex: { model: 'gpt-5.6-sol', effort: 'high' },
    },
    'security-scanner': {
      claude: { model: 'claude-opus-5', effort: 'high' },
      codex: { model: 'gpt-5.6-sol', effort: 'high' },
    },
    'cdk-diff-reviewer': {
      claude: { model: 'claude-opus-5', effort: 'high' },
      codex: { model: 'gpt-5.6-sol', effort: 'high' },
    },
  },
};

const FORBIDDEN_VARIABLES = ['CLAUDE_CODE_SUBAGENT_MODEL_FORCE', 'CLAUDE_CODE_EFFORT_LEVEL'];

describe('the routing policy is closed', () => {
  it('names the Claude effort ladder and the variables that void pinned routing', async () => {
    const { CLAUDE_EFFORTS, FORBIDDEN_CLAUDE_ENV } = await routing();
    expect([...CLAUDE_EFFORTS]).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect([...FORBIDDEN_CLAUDE_ENV]).toEqual(FORBIDDEN_VARIABLES);
  });

  it.each<[string, (policy: RoutingPolicy) => unknown, RegExp]>([
    [
      'an unknown top-level key',
      (p) => ({ ...p, fallback: {} }),
      /routing policy has an unknown key: fallback/,
    ],
    [
      'a role with no Claude mapping',
      (p) => withRole(p, 'reviewer', { codex: p.roles.reviewer!.codex }),
      /routing role reviewer is missing its claude mapping/,
    ],
    [
      'a role with no Codex mapping',
      (p) => withRole(p, 'reviewer', { claude: p.roles.reviewer!.claude }),
      /routing role reviewer is missing its codex mapping/,
    ],
    [
      'a role naming a harness the policy does not know',
      (p) =>
        withRole(p, 'reviewer', {
          ...p.roles.reviewer!,
          gemini: { model: 'gemini-fixture', effort: 'high' },
        }),
      /routing role reviewer names an unknown harness: gemini/,
    ],
    [
      'a role pinning a Claude model the policy does not declare',
      (p) =>
        withRole(p, 'reviewer', {
          ...p.roles.reviewer!,
          claude: { model: 'claude-fixture-huge', effort: 'high' },
        }),
      /routing role reviewer pins an unknown Claude model: claude-fixture-huge/,
    ],
    [
      'a role pinning an effort its Claude model does not support',
      (p) =>
        withRole(p, 'writer', {
          ...p.roles.writer!,
          claude: { model: 'claude-fixture-small', effort: 'high' },
        }),
      /routing role writer pins effort high, which claude-fixture-small does not support/,
    ],
    [
      'a role carrying a Claude field the policy does not know',
      (p) =>
        withRole(p, 'reviewer', {
          ...p.roles.reviewer!,
          claude: { ...p.roles.reviewer!.claude, temperature: 0 },
        }),
      /routing role reviewer carries an unknown Claude field: temperature/,
    ],
    [
      'a role carrying a Codex field the policy does not know',
      (p) =>
        withRole(p, 'reviewer', {
          ...p.roles.reviewer!,
          codex: { ...p.roles.reviewer!.codex, temperature: 0 },
        }),
      /routing role reviewer carries an unknown Codex field: temperature/,
    ],
    [
      'unnamed Codex subagents carrying a field the policy does not know',
      (p) => ({ ...p, unnamed: { ...p.unnamed, codex: { ...p.unnamed.codex, temperature: 0 } } }),
      /unnamed Codex subagents carry an unknown field: temperature/,
    ],
    [
      'unnamed Claude subagents pinning an effort',
      (p) => withUnnamedClaude(p, { model: 'claude-fixture-small', effort: 'low' }),
      /unnamed Claude subagents cannot pin an effort/,
    ],
    [
      'unnamed Claude subagents naming a model the policy does not declare',
      (p) => withUnnamedClaude(p, { model: 'claude-fixture-huge' }),
      /unnamed Claude subagents name an unknown Claude model: claude-fixture-huge/,
    ],
  ])('refuses a routing policy with %s', async (_case, mutate, message) => {
    const { validateRoutingPolicy } = await routing();
    expect(() => validateRoutingPolicy(mutate(fixturePolicy()))).toThrow(message);
  });

  it('reports every routing-policy problem in one error rather than stopping at the first', async () => {
    const { validateRoutingPolicy } = await routing();
    const policy = {
      ...withUnnamedClaude(fixturePolicy(), { model: 'claude-fixture-small', effort: 'low' }),
      fallback: {},
    };
    const message = thrownMessage(() => validateRoutingPolicy(policy));
    expect(message).toMatch(/routing policy has an unknown key: fallback/);
    expect(message).toMatch(/unnamed Claude subagents cannot pin an effort/);
  });

  it('returns a policy it accepts', async () => {
    const { validateRoutingPolicy } = await routing();
    expect(validateRoutingPolicy(fixturePolicy())).toEqual(fixturePolicy());
  });

  it('accepts the routing policy the templates ship', async () => {
    const { validateRoutingPolicy } = await routing();
    const policy = await realPolicy();
    expect(() => validateRoutingPolicy(policy)).not.toThrow();
  });

  it('ships the role routing RP-173 names for both harnesses', async () => {
    await expect(realPolicy()).resolves.toEqual(RP_173_ROUTING);
  });
});

describe('Claude agents are checked against the routing policy', () => {
  const matchingAgents = (): ClaudeAgent[] => [
    {
      name: 'reviewer',
      source: 'agents/reviewer.md',
      model: 'claude-fixture-large',
      effort: 'high',
    },
    { name: 'writer', source: 'agents/writer.md', model: 'claude-fixture-small', effort: 'low' },
  ];
  const writer = (): ClaudeAgent => matchingAgents()[1]!;

  it.each<[string, () => ClaudeAgent[], RegExp]>([
    [
      'an agent that pins no model',
      () => [{ name: 'reviewer', source: 'agents/reviewer.md', effort: 'high' }, writer()],
      /Claude agent reviewer is missing model: agents\/reviewer\.md/,
    ],
    [
      'an agent that pins no effort',
      () => [
        { name: 'reviewer', source: 'agents/reviewer.md', model: 'claude-fixture-large' },
        writer(),
      ],
      /Claude agent reviewer is missing effort: agents\/reviewer\.md/,
    ],
    [
      'an agent pinning a different model than its role',
      () => [
        {
          name: 'reviewer',
          source: 'agents/reviewer.md',
          model: 'claude-fixture-small',
          effort: 'high',
        },
        writer(),
      ],
      /Claude agent reviewer pins model claude-fixture-small, the routing policy says claude-fixture-large: agents\/reviewer\.md/,
    ],
    [
      'an agent pinning a different effort than its role',
      () => [
        {
          name: 'reviewer',
          source: 'agents/reviewer.md',
          model: 'claude-fixture-large',
          effort: 'medium',
        },
        writer(),
      ],
      /Claude agent reviewer pins effort medium, the routing policy says high: agents\/reviewer\.md/,
    ],
    [
      'an agent with no routing role',
      () => [
        ...matchingAgents(),
        {
          name: 'stranger',
          source: 'agents/stranger.md',
          model: 'claude-fixture-large',
          effort: 'high',
        },
      ],
      /Claude agent stranger has no routing role: agents\/stranger\.md/,
    ],
    [
      'a routing role with no agent',
      () => matchingAgents().filter((agent) => agent.name !== 'writer'),
      /routing role writer has no Claude agent/,
    ],
  ])('refuses %s', async (_case, agents, message) => {
    const { validateClaudeAgents } = await routing();
    expect(() => validateClaudeAgents(fixturePolicy(), agents())).toThrow(message);
  });

  it('reports every agent problem in one error rather than stopping at the first', async () => {
    const { validateClaudeAgents } = await routing();
    const message = thrownMessage(() =>
      validateClaudeAgents(fixturePolicy(), [
        { name: 'reviewer', source: 'agents/reviewer.md', effort: 'high' },
        {
          name: 'stranger',
          source: 'agents/stranger.md',
          model: 'claude-fixture-large',
          effort: 'high',
        },
      ]),
    );
    expect(message).toMatch(/Claude agent reviewer is missing model/);
    expect(message).toMatch(/Claude agent stranger has no routing role/);
    expect(message).toMatch(/routing role writer has no Claude agent/);
  });

  it('accepts agents that match their roles one for one', async () => {
    const { validateClaudeAgents } = await routing();
    expect(() => validateClaudeAgents(fixturePolicy(), matchingAgents())).not.toThrow();
  });
});

describe('Claude settings give unnamed subagents the policy default', () => {
  it.each<[string, unknown]>([
    ['no env at all', { hooks: {} }],
    ['an env without the default model', { env: {} }],
    ['a different default model', { env: { CLAUDE_CODE_SUBAGENT_MODEL: 'claude-fixture-large' } }],
  ])('refuses settings with %s', async (_case, settings) => {
    const { validateClaudeSettings } = await routing();
    expect(() => validateClaudeSettings(fixturePolicy(), settings)).toThrow(
      /Claude settings must set env\.CLAUDE_CODE_SUBAGENT_MODEL to claude-fixture-small/,
    );
  });

  it.each(FORBIDDEN_VARIABLES)(
    'refuses settings that set %s, because it voids the pinned routing',
    async (variable) => {
      const { validateClaudeSettings } = await routing();
      const settings = {
        env: { CLAUDE_CODE_SUBAGENT_MODEL: 'claude-fixture-small', [variable]: '1' },
      };
      expect(() => validateClaudeSettings(fixturePolicy(), settings)).toThrow(
        new RegExp(`Claude settings must not set env\\.${variable}: it voids the pinned routing`),
      );
    },
  );

  it('accepts settings whose env names exactly the policy default', async () => {
    const { validateClaudeSettings } = await routing();
    const settings = { hooks: {}, env: { CLAUDE_CODE_SUBAGENT_MODEL: 'claude-fixture-small' } };
    expect(() => validateClaudeSettings(fixturePolicy(), settings)).not.toThrow();
  });
});

/** `key: value` lines of a leading frontmatter block. */
function frontmatterOf(markdown: string): Map<string, string> {
  const block = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(markdown)?.[1] ?? '';
  const fields = new Map<string, string>();
  for (const line of block.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator > 0) {
      fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
    }
  }
  return fields;
}

interface AgentTemplate extends ClaudeAgent {
  layer: string;
}

/** Every Claude agent template in every agent-os layer the sync script composes. */
async function claudeAgentTemplates(): Promise<AgentTemplate[]> {
  const stackRoot = path.join(agentOs, 'stack');
  const stacks = (await readdir(stackRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(stackRoot, entry.name));
  const agents: AgentTemplate[] = [];
  for (const layer of [universal, path.join(agentOs, 'init'), ...stacks]) {
    const dir = path.join(layer, '.claude', 'agents');
    if (!existsSync(dir)) continue;
    for (const file of (await readdir(dir)).filter((name) => name.endsWith('.md')).sort()) {
      const source = path.join(dir, file);
      const fields = frontmatterOf(await readFile(source, 'utf8'));
      agents.push({
        layer,
        source,
        name: fields.get('name') ?? path.basename(file, '.md'),
        model: fields.get('model'),
        effort: fields.get('effort'),
      });
    }
  }
  return agents;
}

describe('the shipped templates follow the routing policy', () => {
  it('pins every Claude agent template to the model and effort its routing role declares', async () => {
    const policy = await realPolicy();
    const agents = await claudeAgentTemplates();
    expect(agents.length).toBeGreaterThan(0);
    for (const agent of agents) {
      const role = policy.roles[agent.name];
      expect(role, `${agent.source} has a routing role`).toBeDefined();
      expect({ model: agent.model, effort: agent.effort }, agent.source).toEqual({
        model: role?.claude.model,
        effort: role?.claude.effort,
      });
    }
  });

  it('ships exactly one Claude agent template per routing role, across every layer', async () => {
    const policy = await realPolicy();
    const names = (await claudeAgentTemplates()).map((agent) => agent.name);
    expect(names.sort()).toEqual(Object.keys(policy.roles).sort());
  });

  it('accepts the shipped Claude agent templates against the shipped policy', async () => {
    const { validateClaudeAgents } = await routing();
    const policy = await realPolicy();
    const agents = await claudeAgentTemplates();
    expect(() => validateClaudeAgents(policy, agents)).not.toThrow();
  });

  it('gives unnamed Claude subagents the policy default in the shipped settings, and never voids the pins', async () => {
    const { validateClaudeSettings } = await routing();
    const policy = await realPolicy();
    const settings = JSON.parse(await text(universal, '.claude', 'settings.json')) as {
      env?: Record<string, string>;
    };
    expect(settings.env?.CLAUDE_CODE_SUBAGENT_MODEL).toBe(policy.unnamed.claude.model);
    for (const variable of FORBIDDEN_VARIABLES) {
      expect(Object.keys(settings.env ?? {})).not.toContain(variable);
    }
    expect(() => validateClaudeSettings(policy, settings)).not.toThrow();
  });

  it('keeps one routing policy file: the Codex-only profile file is gone', () => {
    expect(existsSync(policyPath)).toBe(true);
    expect(existsSync(path.join(agentOs, 'codex-agent-profiles.json'))).toBe(false);
  });

  it('derives Codex profiles from the routing policy in the shape the adapter already validates', async () => {
    const { codexProfilesOf } = await routing();
    const { validateAgentProfiles } = await syncAdapter();
    const policy = await realPolicy();
    const profiles = codexProfilesOf(policy);
    expect(profiles).toEqual({
      default: policy.unnamed.codex,
      agents: Object.fromEntries(
        Object.entries(policy.roles).map(([role, route]) => [role, route.codex]),
      ),
    });
    const sourceAgents = (await claudeAgentTemplates()).map(({ name, source }) => ({
      name,
      source,
    }));
    expect(() => validateAgentProfiles(profiles, sourceAgents)).not.toThrow();
  });

  it('generates each Codex agent profile with the model and effort the routing policy gives its role', async () => {
    const policy = await realPolicy();
    for (const agent of await claudeAgentTemplates()) {
      const codex = policy.roles[agent.name]?.codex;
      expect(codex, `${agent.source} has a Codex route`).toBeDefined();
      const profile = await text(
        agent.layer,
        '.codex',
        'agents',
        `${path.basename(agent.source, '.md')}.toml`,
      );
      expect(profile).toContain(`model = ${JSON.stringify(codex?.model)}`);
      expect(profile).toContain(`model_reasoning_effort = ${JSON.stringify(codex?.effort)}`);
    }
  });

  it('gives unnamed Codex subagents the routing policy default', async () => {
    const policy = await realPolicy();
    const config = await text(universal, '.codex', 'config.toml');
    expect(config).toContain(
      `default_subagent_model = ${JSON.stringify(policy.unnamed.codex.model)}`,
    );
    expect(config).toContain(
      `default_subagent_reasoning_effort = ${JSON.stringify(policy.unnamed.codex.effort)}`,
    );
  });
});

interface CheckRun {
  code: number;
  stderr: string;
}

/** `sync-codex-adapter.mjs --check`, run from a copy so the repo root it resolves is the copy. */
function runCheck(root: string): Promise<CheckRun> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(root, 'scripts', 'sync-codex-adapter.mjs'), '--check'],
      (error, _stdout, stderr) => {
        resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stderr });
      },
    );
  });
}

/** A scratch copy of `scripts/` and `templates/agent-os/`, removed afterwards. */
async function withGeneratorCopy(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'subagent-routing-'));
  try {
    await cp(path.join(repoRoot, 'scripts'), path.join(root, 'scripts'), { recursive: true });
    await cp(agentOs, path.join(root, 'templates', 'agent-os'), { recursive: true });
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Replace `from` with `to`, refusing a mutation that would change nothing. */
async function mutate(file: string, from: string, to: string): Promise<void> {
  const before = await readFile(file, 'utf8');
  expect(before, `${file} carries the text the mutation replaces`).toContain(from);
  await writeFile(file, before.replace(from, to));
}

describe('the adapter check refuses routing drift', () => {
  it('refuses a Claude agent template whose model disagrees with the routing policy', async () => {
    await withGeneratorCopy(async (root) => {
      await mutate(
        path.join(
          root,
          'templates',
          'agent-os',
          'universal',
          '.claude',
          'agents',
          'code-reviewer.md',
        ),
        'model: claude-opus-5',
        'model: claude-sonnet-5',
      );
      const result = await runCheck(root);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/Claude agent code-reviewer pins model claude-sonnet-5/);
    });
  });

  it('reports drift when a generated Codex agent profile no longer carries the policy model', async () => {
    await withGeneratorCopy(async (root) => {
      await mutate(
        path.join(
          root,
          'templates',
          'agent-os',
          'universal',
          '.codex',
          'agents',
          'code-reviewer.toml',
        ),
        'model = "gpt-5.6-sol"',
        'model = "gpt-5.6-terra"',
      );
      const result = await runCheck(root);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/drift/);
      expect(result.stderr).toContain(
        'templates/agent-os/universal/.codex/agents/code-reviewer.toml',
      );
    });
  });

  it('passes an untouched copy, so the two refusals above are not vacuous', async () => {
    await withGeneratorCopy(async (root) => {
      const result = await runCheck(root);
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
    });
  });
});

interface HookWiring {
  hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
}

describe('the routing hooks are wired for Claude Code only', () => {
  const claudeHooks = path.join(universal, '.claude', 'hooks');

  it('wires the call-site model guard on the Agent tool and nowhere else', async () => {
    const settings = JSON.parse(await text(universal, '.claude', 'settings.json')) as HookWiring;
    const guarding = Object.entries(settings.hooks).flatMap(([event, groups]) =>
      groups
        .filter((group) =>
          group.hooks.some((hook) => hook.command.includes('guard-subagent-model.mjs')),
        )
        .map((group) => ({ event, matcher: group.matcher })),
    );
    expect(guarding.length).toBeGreaterThan(0);
    expect(guarding).toEqual(guarding.map(() => ({ event: 'PreToolUse', matcher: 'Agent' })));
    expect(existsSync(path.join(claudeHooks, 'guard-subagent-model.mjs'))).toBe(true);
  });

  it('runs the routing check at session start, beside the rules injector', async () => {
    const settings = JSON.parse(await text(universal, '.claude', 'settings.json')) as HookWiring;
    const commands = (settings.hooks.SessionStart ?? []).flatMap((group) =>
      group.hooks.map((hook) => hook.command),
    );
    expect(commands.some((command) => command.includes('warn-subagent-routing.mjs'))).toBe(true);
    expect(commands.some((command) => command.includes('inject-rules.mjs'))).toBe(true);
    expect(existsSync(path.join(claudeHooks, 'warn-subagent-routing.mjs'))).toBe(true);
  });

  it('keeps both routing hooks out of the Codex projection, which has no Agent tool and no Claude environment', async () => {
    const codexHooks = await text(universal, '.codex', 'hooks.json');
    expect(codexHooks).not.toContain('guard-subagent-model.mjs');
    expect(codexHooks).not.toContain('warn-subagent-routing.mjs');
  });

  it('installs both routing hooks with the process layer', async () => {
    const layers = JSON.parse(await text(universal, 'layers.json')) as { process: string[] };
    expect(layers.process).toContain('.claude/hooks/guard-subagent-model.mjs');
    expect(layers.process).toContain('.claude/hooks/warn-subagent-routing.mjs');
  });
});

describe('capability evidence records what the Claude routing can and cannot pin', () => {
  const evidenceRows = async (): Promise<Array<Record<string, unknown>>> =>
    (
      JSON.parse(await text(repoRoot, 'docs', 'capability-evidence.json')) as {
        rows: Array<Record<string, unknown>>;
      }
    ).rows;

  it('records only rows the evidence-matrix validator accepts', async () => {
    const rows = await evidenceRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(validateEvidenceRow(row), JSON.stringify(row)).toMatchObject({ ok: true });
    }
  });

  it.each([
    'subagent-model-pin',
    'subagent-effort-pin',
    'unnamed-subagent-effort',
    'call-site-model-guard',
  ])('records Claude evidence for the %s mechanism', async (mechanism) => {
    const rows = await evidenceRows();
    expect(rows.some((row) => row.harness === 'claude' && row.mechanism === mechanism)).toBe(true);
  });

  it('records that an unnamed Claude subagent cannot have its effort pinned', async () => {
    const rows = (await evidenceRows()).filter(
      (row) => row.harness === 'claude' && row.mechanism === 'unnamed-subagent-effort',
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((row) => row.status)).toEqual(rows.map(() => 'UNSUPPORTED'));
  });

  it('records the minimum Claude Code version the pins need, and it is the one the session-start check warns below', async () => {
    const evidence = JSON.parse(await text(repoRoot, 'docs', 'capability-evidence.json')) as {
      minimumVersions?: unknown;
    };
    expect(Array.isArray(evidence.minimumVersions), 'a top-level minimumVersions array').toBe(true);
    const claude = ((evidence.minimumVersions ?? []) as Array<Record<string, unknown>>).filter(
      (entry) => entry.harness === 'claude',
    );
    expect(claude).toHaveLength(1);
    const entry = claude[0] ?? {};
    const nonBlank = (value: unknown) => typeof value === 'string' && value.trim() !== '';
    expect(typeof entry.version, 'version is a string').toBe('string');
    expect(nonBlank(entry.why), 'why is not blank').toBe(true);
    expect(nonBlank(entry.source), 'source is not blank').toBe(true);

    const { MINIMUM_CLAUDE_CODE_VERSION } = (await import(
      pathToFileURL(path.join(universal, '.claude', 'hooks', 'warn-subagent-routing.mjs')).href
    )) as { MINIMUM_CLAUDE_CODE_VERSION: string };
    expect(entry.version).toBe(MINIMUM_CLAUDE_CODE_VERSION);
  });

  it('records each measured condition under which a pin does not hold', async () => {
    const claudeRows = (await evidenceRows()).filter((row) => row.harness === 'claude');
    const unsupported = (mechanism: string, surfacePart?: string) =>
      claudeRows.some(
        (row) =>
          row.mechanism === mechanism &&
          row.status === 'UNSUPPORTED' &&
          (surfacePart === undefined ||
            (typeof row.surface === 'string' && row.surface.includes(surfacePart))),
      );
    expect({
      'model pin under CLAUDE_CODE_SUBAGENT_MODEL_FORCE': unsupported(
        'subagent-model-pin',
        'CLAUDE_CODE_SUBAGENT_MODEL_FORCE',
      ),
      'effort pin under CLAUDE_CODE_EFFORT_LEVEL': unsupported(
        'subagent-effort-pin',
        'CLAUDE_CODE_EFFORT_LEVEL',
      ),
      'model pin under a call-site model': unsupported('subagent-model-pin', 'call-site'),
      'per-dispatch effort': unsupported('per-dispatch-effort'),
    }).toEqual({
      'model pin under CLAUDE_CODE_SUBAGENT_MODEL_FORCE': true,
      'effort pin under CLAUDE_CODE_EFFORT_LEVEL': true,
      'model pin under a call-site model': true,
      'per-dispatch effort': true,
    });
  });
});
