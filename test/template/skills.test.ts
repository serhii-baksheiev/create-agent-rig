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

  it('is scoped to what the skeleton provisions, and calls a vacuous result "no signal"', async () => {
    const content = await readFile(
      skillPath('stack', 'aws-cdk', '.claude', 'skills', 'post-deploy-verify'),
      'utf8',
    );
    // the deploy job's conclusion is the primary, always-available signal
    expect(content).toMatch(/deploy job.*primary|primary.*signal/i);
    // freshness cross-check kept; DLQ depth kept
    expect(content).toMatch(/UPDATE_COMPLETE/);
    expect(content).toMatch(/DLQ/);
    // the honesty rule: empty metric = no invocations = "no signal", not a pass
    expect(content).toMatch(/no signal/i);
    expect(content).toMatch(/no invocations/i);
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

// extraction brief §3 Tier A: the worktree lifecycle carries the mechanism and
// almost no domain — but the host-specific paths and Windows notes are domain.
describe('worktree-task skill (universal) — isolation per task, host-agnostic', () => {
  const read = () => readFile(skillPath('universal', '.claude', 'skills', 'worktree-task'), 'utf8');

  it('exists and states both halves of the lifecycle', async () => {
    const content = await read();
    const fm = frontmatterOf(content);
    expect(fm['name']).toBe('worktree-task');
    expect(fm['allowed-tools']).toBeTruthy();
    expect(content).toMatch(/git worktree add/);
    expect(content).toMatch(/git worktree remove/);
    expect(content).toMatch(/git worktree prune/);
  });

  it('names the gotchas that make the cleanup non-obvious', async () => {
    const content = await read();
    expect(content).toMatch(/absolute/i); // stale cwd nests worktrees in dead paths
    expect(content).toMatch(/cd out|cd OUT/i); // remove fails from inside
    expect(content).toMatch(/another session|other session/i); // concurrent sessions
  });

  it('carries no host-specific absolute path — the domain that must not travel', async () => {
    const content = await read();
    expect(content).not.toMatch(/[A-Z]:\//); // C:/Users/...
    expect(content).not.toMatch(/\/Users\/[a-z]/i);
    expect(content).not.toMatch(/\/home\/[a-z]/i);
    expect(content).not.toMatch(/windows/i);
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

  // extraction brief §3 Tier A: the journal template. A journal with no stated
  // fields decays into a diary — and the fields are what a later reader (or a
  // sweep) can actually cross-check.
  it('states the journal entry fields, so an entry can be incomplete on purpose', async () => {
    const plan = await readFile(
      path.join(repoRoot, 'templates', 'agent-os', 'universal', 'PLAN.md'),
      'utf8',
    );
    expect(plan).toContain('## Journal');
    for (const field of ['done', 'escalated', 'stopped at', 'queue hygiene']) {
      expect(plan.toLowerCase(), field).toContain(field);
    }
    // a field the session cannot observe stays visibly empty, never estimated
    expect(plan).toMatch(/never estimate|not estimated|visibly empty/i);
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
