import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initFileContents, initProject } from '../../packages/cli/src/commands/init.js';
import { applyUpgrade, planUpgrade } from '../../packages/cli/src/commands/upgrade.js';
import type { UpgradePlan, UpgradeVerdict } from '../../packages/cli/src/commands/upgrade.js';
import type { HashHistory } from '../../packages/cli/src/lib/history.js';
import { agentOsInstallSet } from '../../packages/cli/src/lib/install-set.js';
import { readManifest, sha256, writeManifest } from '../../packages/cli/src/lib/manifest.js';
import { TARGETS } from '../../packages/cli/src/lib/targets.js';
import type { Target } from '../../packages/cli/src/lib/targets.js';
import { templatesRoot } from '../../packages/cli/src/templates.js';

/**
 * RP-173 acceptance: `create` (every target), `init`, and `upgrade` from a rig
 * installed before the pins all end with Claude agents pinned to the routing
 * policy — and an upgrade replaces an untouched agent while leaving an edited
 * one alone. Expected values are read from the policy, never restated.
 *
 * It lives beside the other template tests, not under packages/cli/test,
 * because the decision record that ships with the rig cites it by name.
 */

interface Route {
  model: string;
  effort: string;
}

interface RoutingPolicy {
  unnamed: { claude: { model: string } };
  roles: Record<string, { claude: Route }>;
}

const routingPolicy = async (): Promise<RoutingPolicy> =>
  JSON.parse(
    await readFile(path.join(templatesRoot(), 'agent-os', 'subagent-routing.json'), 'utf8'),
  ) as RoutingPolicy;

let repo: string;

const CODE_REVIEWER = '.claude/agents/code-reviewer.md';
const SETTINGS = '.claude/settings.json';

const abs = (rel: string): string => path.join(repo, ...rel.split('/'));
const read = (rel: string): Promise<string> => readFile(abs(rel), 'utf8');
const write = async (rel: string, content: string): Promise<void> => {
  await mkdir(path.dirname(abs(rel)), { recursive: true });
  await writeFile(abs(rel), content);
};

const verdictFor = (plan: UpgradePlan, rel: string): UpgradeVerdict | undefined =>
  plan.actions.find((a) => a.rel === rel)?.verdict;

/** The rig as `init` leaves it: files installed, manifest written. */
async function installRig(): Promise<void> {
  await initProject(repo, {});
}

/** Rewrite one installed file AND the manifest entry — "the release changed it". */
async function pretendInstalled(rel: string, content: string): Promise<void> {
  await write(rel, content);
  const manifest = await readManifest(repo);
  if (manifest === null) throw new Error('fixture: no manifest');
  manifest.files[rel] = sha256(content);
  await writeManifest(repo, manifest);
}

const emptyHistory: HashHistory = { versions: [], files: {} };

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

/** An agent file as a 0.8.x rig installed it: no `model:` and no `effort:` line. */
const withoutPins = (content: string): string =>
  content
    .split('\n')
    .filter((line) => !/^(model|effort):/.test(line))
    .join('\n');

const isAgentFile = (rel: string): boolean => /^\.claude\/agents\/[^/]+\.md$/.test(rel);

/** Every agent file is pinned to the claude route of the role its frontmatter names. */
function expectPinned(policy: RoutingPolicy, agents: Array<{ rel: string; content: string }>) {
  expect(agents.length).toBeGreaterThan(0);
  for (const agent of agents) {
    const fields = frontmatterOf(agent.content);
    const role = policy.roles[fields.get('name') ?? ''];
    expect(role, `${agent.rel} names a routing role`).toBeDefined();
    expect({ model: fields.get('model'), effort: fields.get('effort') }, agent.rel).toEqual({
      model: role?.claude.model,
      effort: role?.claude.effort,
    });
  }
}

const ctxFor = (target: Target) => ({
  projectName: 'routing-probe',
  projectScope: 'routing-probe',
  region: target.defaultRegion ?? '',
});

const installSetOf = async (target: Target) =>
  (await agentOsInstallSet(target.stacks, ctxFor(target))).map((file) => ({
    rel: file.rel.replaceAll('\\', '/'),
    content: file.content,
  }));

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-subagent-routing-'));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('create installs Claude agents pinned to the routing policy', () => {
  it.each(Object.entries(TARGETS))(
    'pins every Claude agent the %s target installs to its routing role',
    async (_name, target) => {
      const files = await installSetOf(target);
      expectPinned(
        await routingPolicy(),
        files.filter((file) => isAgentFile(file.rel)),
      );
    },
  );

  it('installs the CDK diff reviewer with every target that composes the aws-cdk stack', async () => {
    const cdkTargets = Object.values(TARGETS).filter((target) => target.stacks.includes('aws-cdk'));
    expect(cdkTargets.length).toBeGreaterThan(0);
    for (const target of cdkTargets) {
      const rels = (await installSetOf(target)).map((file) => file.rel);
      expect(rels).toContain('.claude/agents/cdk-diff-reviewer.md');
    }
  });

  it.each(Object.entries(TARGETS))(
    'gives unnamed Claude subagents the policy default in the settings the %s target installs',
    async (_name, target) => {
      const settings = (await installSetOf(target)).find((file) => file.rel === SETTINGS);
      expect(settings, `${SETTINGS} is installed`).toBeDefined();
      const parsed = JSON.parse(settings?.content ?? '{}') as { env?: Record<string, string> };
      expect(parsed.env?.CLAUDE_CODE_SUBAGENT_MODEL).toBe(
        (await routingPolicy()).unnamed.claude.model,
      );
    },
  );
});

describe('init installs Claude agents pinned to the routing policy', () => {
  it('pins every Claude agent init installs to its routing role', async () => {
    const contents = await initFileContents(repo);
    const agents = [...contents]
      .filter(([rel]) => isAgentFile(rel))
      .map(([rel, content]) => ({ rel, content }));
    expectPinned(await routingPolicy(), agents);
  });

  it('gives unnamed Claude subagents the policy default in the settings init installs', async () => {
    const contents = await initFileContents(repo);
    const parsed = JSON.parse(contents.get(SETTINGS) ?? '{}') as { env?: Record<string, string> };
    expect(parsed.env?.CLAUDE_CODE_SUBAGENT_MODEL).toBe(
      (await routingPolicy()).unnamed.claude.model,
    );
  });
});

describe('upgrade from a rig installed before the pins', () => {
  it('replaces an untouched pre-pin agent with the pinned one', async () => {
    await installRig();
    await pretendInstalled(CODE_REVIEWER, withoutPins(await read(CODE_REVIEWER)));

    const plan = await planUpgrade(repo, { history: emptyHistory });
    expect(verdictFor(plan, CODE_REVIEWER)).toBe('update');

    await applyUpgrade(repo, plan);
    const role = (await routingPolicy()).roles['code-reviewer'];
    const fields = frontmatterOf(await read(CODE_REVIEWER));
    expect(fields.get('model')).toBe(role?.claude.model);
    expect(fields.get('effort')).toBe(role?.claude.effort);
  });

  it('reports a pre-pin agent the user edited as a conflict and leaves its bytes alone', async () => {
    await installRig();
    const edited = `${withoutPins(await read(CODE_REVIEWER))}\nA line this project added.\n`;
    await write(CODE_REVIEWER, edited);

    const plan = await planUpgrade(repo, { history: emptyHistory });
    const action = plan.actions.find((a) => a.rel === CODE_REVIEWER);
    expect(action?.verdict).toBe('conflict');
    expect(action?.reason).toBeTruthy();

    await applyUpgrade(repo, plan);
    expect(await read(CODE_REVIEWER)).toBe(edited);
  });
});
