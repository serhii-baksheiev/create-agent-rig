import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const skillPath = (...parts: string[]) =>
  path.join(repoRoot, 'templates', 'agent-os', ...parts, 'SKILL.md');

function frontmatterOf(content: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  expect(match, 'skill must start with YAML frontmatter').toBeTruthy();
  const fields: Record<string, string> = {};
  for (const line of match![1]!.split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return fields;
}

// agent-os v2 brief §1–§3: ship the two skills without which a stated rule has
// no implementation, with frontmatter as *enforcement*, not documentation.
describe('post-deploy-verify skill (stack/aws-cdk)', () => {
  it('exists in the aws-cdk stack layer and produces the autonomy verdict', async () => {
    const content = await readFile(
      skillPath('stack', 'aws-cdk', '.claude', 'skills', 'post-deploy-verify'),
      'utf8',
    );
    expect(content).toMatch(/HEALTHY/);
    expect(content).toMatch(/REGRESSION/);
    expect(content).toMatch(/revert/i);
  });

  it('is mechanically constrained: forked context, read-only tool set', async () => {
    const content = await readFile(
      skillPath('stack', 'aws-cdk', '.claude', 'skills', 'post-deploy-verify'),
      'utf8',
    );
    const fm = frontmatterOf(content);
    expect(fm['name']).toBe('post-deploy-verify');
    expect(fm['context']).toBe('fork');
    expect(fm['allowed-tools']).toBeTruthy();
    expect(fm['allowed-tools']).not.toMatch(/Write|Edit/);
  });
});

describe('loop skill (universal) — the driver the autonomy tiers were waiting for', () => {
  it('exists, selects from the queue, and REFUSES to invent work', async () => {
    const content = await readFile(skillPath('universal', '.claude', 'skills', 'loop'), 'utf8');
    const fm = frontmatterOf(content);
    expect(fm['name']).toBe('loop');
    expect(content).toMatch(/Agent queue/);
    expect(content).toMatch(/Operator queue/);
    // the load-bearing stop condition: queue empty → end, do not improvise
    expect(content).toMatch(/queue.*empty/i);
    expect(content).toMatch(/do not invent work/i);
    expect(content).toMatch(/journal/i);
  });
});

describe('PLAN.md queue convention (universal)', () => {
  it('ships both queues so work has a stated origin', async () => {
    const plan = await readFile(
      path.join(repoRoot, 'templates', 'agent-os', 'universal', 'PLAN.md'),
      'utf8',
    );
    expect(plan).toContain('## Agent queue');
    expect(plan).toContain('## Operator queue');
    expect(plan).toMatch(/__PROJECT_NAME__/);
  });
});

describe('pr-ship skill (universal)', () => {
  it('exists in universal and states the gate + verdict', async () => {
    const content = await readFile(skillPath('universal', '.claude', 'skills', 'pr-ship'), 'utf8');
    expect(content).toMatch(/SHIP/);
    expect(content).toMatch(/HOLD/);
    expect(content).toMatch(/code-reviewer/);
    expect(content).toMatch(/security-scanner/);
  });

  it('carries an allowed-tools constraint', async () => {
    const content = await readFile(skillPath('universal', '.claude', 'skills', 'pr-ship'), 'utf8');
    const fm = frontmatterOf(content);
    expect(fm['name']).toBe('pr-ship');
    expect(fm['allowed-tools']).toBeTruthy();
  });
});
