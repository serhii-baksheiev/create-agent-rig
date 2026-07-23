import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// agent-os v2 brief §2b Tier A: the infra rules gate deploys on a CDK diff
// review — that agent must exist, in the stack layer, mechanically read-only.
describe('cdk-diff-reviewer agent (stack/aws-cdk)', () => {
  const agentPath = path.join(
    repoRoot,
    'templates',
    'agent-os',
    'stack',
    'aws-cdk',
    '.claude',
    'agents',
    'cdk-diff-reviewer.md',
  );

  it('exists with constrained frontmatter (no write tools)', async () => {
    const content = await readFile(agentPath, 'utf8');
    expect(content).toMatch(/^---\nname: cdk-diff-reviewer\n/);
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(content)![1]!;
    const tools = /^tools:(.*)$/m.exec(frontmatter)?.[1] ?? '';
    expect(tools.trim().length).toBeGreaterThan(0);
    expect(tools).not.toMatch(/Write|Edit/);
  });

  it('reviews by named rule: blockers first, IAM and data-loss in scope', async () => {
    const content = await readFile(agentPath, 'utf8');
    expect(content).toMatch(/BLOCKER/i);
    expect(content).toMatch(/IAM/);
    expect(content).toMatch(/RemovalPolicy|removal policy/i);
  });

  it('the aws-cdk rules actually reference the agent (rule ⇄ implementation)', async () => {
    const rules = await readFile(
      path.join(
        repoRoot,
        'templates',
        'agent-os',
        'stack',
        'aws-cdk',
        '.claude',
        'rules',
        'aws-cdk.md',
      ),
      'utf8',
    );
    expect(rules).toContain('cdk-diff-reviewer');
  });
});
