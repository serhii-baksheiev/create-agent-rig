import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Extraction brief §3 Tier C / §6.7: the AWS-shaped artifacts go behind the
// existing target flag. They are good and they are AWS — so they live in
// stack/aws-cdk and never in universal.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const stack = path.join(repoRoot, 'templates', 'agent-os', 'stack', 'aws-cdk');
const read = (...parts: string[]) => readFile(path.join(...parts), 'utf8');

function frontmatterOf(content: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  expect(match, 'must start with YAML frontmatter').toBeTruthy();
  const fields: Record<string, string> = {};
  for (const line of match![1]!.split('\n')) {
    const index = line.indexOf(':');
    if (index > 0) fields[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return fields;
}

describe('ro-debug skill — read-only runtime investigation', () => {
  const skill = () => read(stack, '.claude', 'skills', 'ro-debug', 'SKILL.md');

  it('is read-only by construction, not by intention', async () => {
    const fm = frontmatterOf(await skill());
    expect(fm['name']).toBe('ro-debug');
    expect(fm['allowed-tools']).toBeTruthy();
    expect(fm['allowed-tools']).not.toMatch(/Write|Edit/);
  });

  it('diagnoses from the remote default branch, not a stale local copy', async () => {
    const content = await skill();
    // reading stale local code has produced confidently-wrong diagnoses
    expect(content).toMatch(/origin\//);
    expect(content).toMatch(/stale/i);
    expect(content).toMatch(/fetch (does not|is not)/i);
  });

  it('calls an empty metric "no signal", never a pass', async () => {
    const content = await skill();
    expect(content).toMatch(/no signal/i);
    expect(content).toMatch(/no invocations|vacuous/i);
  });

  it('names the stale-evidence trap: a stack status persists from the last deploy', async () => {
    const content = await skill();
    expect(content).toMatch(/UPDATE_COMPLETE/);
    expect(content).toMatch(/stale evidence|persists/i);
    // the authoritative signal instead
    expect(content).toMatch(/deploy (job|run)/i);
  });

  it('names the DLQ-age trap, which is an API-shaped mistake and not a judgement call', async () => {
    const content = await skill();
    // ApproximateAgeOfOldestMessage is a CloudWatch metric, NOT an SQS attribute
    expect(content).toMatch(/ApproximateAgeOfOldestMessage/);
    expect(content).toMatch(/metric.*not.*attribute|not.*attribute/i);
  });

  it('distinguishes an infrastructure flake from a code regression', async () => {
    const content = await skill();
    expect(content).toMatch(/flake/i);
  });

  it('escalates instead of widening its own permissions', async () => {
    const content = await skill();
    expect(content).toMatch(/escalate/i);
    expect(content).toMatch(/never work around|do not work around|is the point/i);
  });

  it('is honest that the skeleton does not provision the read-only role', async () => {
    const content = await skill();
    // A skill that assumes a resource the template never created is exactly the
    // leaked-domain failure the brief warns about (§7).
    expect(content).toMatch(/does not provision|not provisioned|owner action/i);
  });

  it('carries no host-, account- or project-specific identifier', async () => {
    const content = await skill();
    expect(content).not.toMatch(/\b\d{12}\b/); // an AWS account id
    expect(content).not.toMatch(/arn:aws:[a-z]+:[a-z0-9-]+:\d{12}/); // a real ARN
    expect(content).not.toMatch(/\/Users\/[a-z]/i);
  });

  it('names the skeleton’s own resources, so the recipes run as written', async () => {
    const content = await skill();
    expect(content).toMatch(/__REGION__/); // substituted at generation
    expect(content).toMatch(/notes|Notes/); // the skeleton's table/queue family
  });
});

describe('the aws-cdk rules gained the transferable AWS knowledge', () => {
  const rules = () => read(stack, '.claude', 'rules', 'aws-cdk.md');

  it('forbids moving a stateful construct between stacks', async () => {
    const content = await rules();
    // CloudFormation deletes and recreates it: this is data loss, not a refactor
    expect(content).toMatch(/stateful/i);
    expect(content).toMatch(/data loss|deletes and recreates|recreate/i);
  });

  it('names the per-stack resource ceiling and how to split without data loss', async () => {
    const content = await rules();
    expect(content).toMatch(/500|resource (limit|ceiling)/i);
    expect(content).toMatch(/stateless/i);
    expect(content).toMatch(/cross-stack/i);
  });

  it('puts SDK clients at module top level, and says why', async () => {
    const content = await rules();
    expect(content).toMatch(/module (top level|scope)/i);
    expect(content).toMatch(/warm|reus/i); // container reuse across invocations
  });

  it('keeps fleet-wide function defaults in one place', async () => {
    const content = await rules();
    expect(content).toMatch(/fleet|defaults in one|one place/i);
  });

  it('points at ro-debug for a runtime question', async () => {
    const content = await rules();
    expect(content).toMatch(/ro-debug/);
  });

  it('still fits on one page — agent-os must be able to lose rules, not only gain them', async () => {
    const content = await rules();
    // PLAN.md §10: no append-only rule growth. A stack rulebook nobody finishes
    // reading enforces nothing.
    expect(content.split('\n').length).toBeLessThan(140);
  });
});

// Found by the brief's §7 acceptance run: `infra/` seeded in universal's
// elevated-paths block is declared into node-service too, which has no infra/.
// A gate declared over a directory that does not exist reports "clean" while
// looking nowhere — the exact leaked-domain failure §7 says to check for.
describe('elevated paths are declared per target, and every one exists there', () => {
  const MATRIX = [
    { target: 'aws-serverless', stacks: ['node-ts', 'aws-cdk'] },
    { target: 'node-service', stacks: ['node-ts'] },
  ];

  it('the declaration is composed from the layers, not seeded once for every shape', async () => {
    const { parseElevatedPaths } = await import(
      (await import('node:url')).pathToFileURL(
        path.join(repoRoot, 'templates/agent-os/universal/.claude/scripts/detect-missed-gate.mjs'),
      ).href
    );
    const { access } = await import('node:fs/promises');

    for (const { target, stacks } of MATRIX) {
      const sources = [
        path.join(repoRoot, 'templates', 'agent-os', 'universal', 'CLAUDE.md'),
        ...stacks.flatMap((s) => [
          path.join(repoRoot, 'templates', 'agent-os', 'stack', s, '.claude', 'rules', `${s}.md`),
        ]),
      ];
      const declared: string[] = [];
      for (const source of sources) {
        const parsed = (parseElevatedPaths as (md: string) => string[] | null)(await read(source));
        if (parsed) declared.push(...parsed);
      }

      expect(declared.length, target).toBeGreaterThan(0);
      for (const declaredPath of declared) {
        await expect(
          access(path.join(repoRoot, 'templates', 'skeleton', target, declaredPath)),
          `${target} declares ${declaredPath}, which does not exist in that skeleton`,
        ).resolves.toBeUndefined();
      }
    }
  });

  it('the aws-cdk layer is what contributes infra/', async () => {
    const { parseElevatedPaths } = await import(
      (await import('node:url')).pathToFileURL(
        path.join(repoRoot, 'templates/agent-os/universal/.claude/scripts/detect-missed-gate.mjs'),
      ).href
    );
    const parse = parseElevatedPaths as (md: string) => string[] | null;
    expect(parse(await read(stack, '.claude', 'rules', 'aws-cdk.md'))).toContain('infra/');
    expect(
      parse(await read(repoRoot, 'templates', 'agent-os', 'universal', 'CLAUDE.md')),
    ).not.toContain('infra/');
  });

  it('the sweeps read every layer’s declaration, not only CLAUDE.md', async () => {
    for (const script of ['detect-missed-gate.mjs', 'reconcile-external-prs.mjs']) {
      const source = await read(
        repoRoot,
        'templates',
        'agent-os',
        'universal',
        '.claude',
        'scripts',
        script,
      );
      expect(source, script).toMatch(/rules/);
    }
  });
});

describe('the AWS layer stays behind the target flag', () => {
  it('universal never mentions the read-only debugging skill', async () => {
    const universalSkills = path.join(
      repoRoot,
      'templates',
      'agent-os',
      'universal',
      '.claude',
      'skills',
    );
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(universalSkills)).not.toContain('ro-debug');
  });

  it('the node-service target composes without it', async () => {
    // node-service = universal + node-ts only; aws-cdk is not in its layer set.
    const { listTree } = await import('../../packages/cli/src/lib/copy-tree.js');
    const nodeTs = await listTree(path.join(repoRoot, 'templates', 'agent-os', 'stack', 'node-ts'));
    expect(nodeTs.some((file) => file.includes('ro-debug'))).toBe(false);
  });
});
