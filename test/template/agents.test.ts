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

// The change under review claims to implement a queue item. Nothing in the
// checklist made "it implements something else" a finding — so a change that
// silently re-aimed its own task passed review on the strength of being
// well-built. The premise check catches a false item; this catches a true item
// the change walked away from.
describe('code-reviewer agent (universal) — the change must be the change that was asked for', () => {
  const agentPath = path.join(
    repoRoot,
    'templates',
    'agent-os',
    'universal',
    '.claude',
    'agents',
    'code-reviewer.md',
  );

  it('blocks on a change that contradicts the item it claims to implement', async () => {
    const content = await readFile(agentPath, 'utf8');
    const blocking = content.slice(content.indexOf('## Checklist'), content.indexOf('## Advisory'));
    expect(blocking).toMatch(/contradict/i);
    expect(blocking).toMatch(/queue item|the item|the task/i);
    // and the verdict is to report it, not to reconcile the two by hand —
    // the refusal is the load-bearing half, so pin it rather than "report"
    expect(blocking).toMatch(/report/i);
    expect(blocking).toMatch(/never reconcile|do not reconcile/i);
    // a reviewer handed only a diff must say the item is missing, not guess
    expect(blocking).toMatch(/not (handed|supplied)|no item/i);
  });

  it('keeps the checklist it already had — this adds one item, it rewrites none', async () => {
    const content = await readFile(agentPath, 'utf8');
    for (const item of [
      'Boundary violations',
      'Test integrity',
      'Error handling',
      'Contract drift',
      'Autonomy breaches',
    ]) {
      expect(content, item).toContain(item);
    }
  });
});

// In this layer prose IS the implementation: a rule that overstates its own
// enforcement, or points at a hook that no longer exists, fails exactly like
// broken code — silently, and in the direction of false confidence.
describe('prose-reviewer agent (universal) — the rulebook is code here', () => {
  const agentPath = path.join(
    repoRoot,
    'templates',
    'agent-os',
    'universal',
    '.claude',
    'agents',
    'prose-reviewer.md',
  );
  const read = () => readFile(agentPath, 'utf8');

  it('exists, read-only, and reports with file:line like the other gates', async () => {
    const content = await read();
    expect(content).toMatch(/^---\nname: prose-reviewer\n/);
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(content)![1]!;
    const tools = /^tools:(.*)$/m.exec(frontmatter)?.[1] ?? '';
    expect(tools.trim().length).toBeGreaterThan(0);
    expect(tools).not.toMatch(/Write|Edit/);
    expect(content).toMatch(/file:line/);
    expect(content).toMatch(/BLOCKER/i);
  });

  // 🔴 AR-68: the norm that turns the most common blocker class into a rule.
  // The counts and their limits live in the decision record this norm cites —
  // `docs/decisions/unbacked-prose-is-a-blocker.md`. The short form: on the PR that
  // produced the norm, the run's own unbacked prose was the largest class of blocking
  // finding, each item decidable from the diff and each costing a reviewer round. So
  // it is a blocker BY RULE, which is what lets `check-premises` catch it before this
  // agent is ever launched.
  it('blocks an unbacked behaviour claim by rule, and says what backing looks like', async () => {
    const content = await read();
    expect(content).toMatch(/unbacked|nothing backs it|no test behind it/i);
    // the two acceptable forms, per invariants.md "State the limits"
    expect(content).toMatch(/generated/i);
    expect(content).toMatch(/pointer to (a|the) test/i);
  });

  it('states the boundary that keeps it from becoming a style gate', async () => {
    const content = await read();
    expect(content).toMatch(/not a (literary|copy) editor/i);
    // the explicit non-finding: prose that merely reads badly
    expect(content).toMatch(/clumsy|awkward|inelegant/i);
  });

  it('blocks on the six failures that make a rulebook lie', async () => {
    const content = await read();
    // scoped to the blocking section: demoting an item to advisory, or losing
    // the checklist and keeping the narrative, must fail this
    const blocking = content.slice(content.indexOf('## Checklist'), content.indexOf('## Advisory'));
    expect(blocking.length).toBeGreaterThan(0);
    // 🔴 The count is asserted, because the name of this test was "five" while the
    // checklist had six — the exact drift class the new item 5 is about, sitting in
    // the test that guards it. A numbered list and a prose count in the same repo
    // disagree eventually; here the list wins and the test reads it.
    const items = [...blocking.matchAll(/^\d+\. \*\*/gm)];
    expect(items.length, 'one assertion below per checklist item').toBe(6);
    expect(blocking).toMatch(/overstat/i); // a claim the mechanism does not support
    expect(blocking).toMatch(/dead (reference|link)|no longer exists/i);
    expect(blocking).toMatch(/contradict/i); // two rule files disagreeing
    expect(blocking).toMatch(/stale/i); // stated limits that drifted
    // and the one the release note forgot it had: domain leaking into a layer
    // that claims to be neutral
    expect(blocking).toMatch(/must not travel|vendor|tracker key/i);
    // the newest: a factual claim about behaviour with nothing behind it
    expect(blocking).toMatch(/unbacked/i);
    expect(blocking).toMatch(/by\s+\*\*rule\*\*|blocker \*\*by\s+rule\*\*|by rule/i);
  });

  // The failure this agent is most likely to cause itself: a confident BLOCKER
  // on the adapter seam that exists to name the vendor it adapts.
  it('does not fire on a seam built to name a vendor', async () => {
    const content = await read();
    expect(content).toMatch(/seam .*not a leak|not a leak/i);
  });

  it('states the limit that applies to itself — nothing launches it', async () => {
    const content = await read();
    expect(content).toMatch(/nothing launches you|nothing makes this run/i);
    // and it must say so even when the overstatement is about itself
    expect(content).toMatch(/convention, not a mechanism|claim, not a guarantee/i);
  });

  it('is reachable — a gate nothing calls is decoration', async () => {
    const workflow = await readFile(
      path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'rules', 'workflow.md'),
      'utf8',
    );
    expect(workflow).toContain('prose-reviewer');
    const prShip = await readFile(
      path.join(
        repoRoot,
        'templates',
        'agent-os',
        'universal',
        '.claude',
        'skills',
        'pr-ship',
        'SKILL.md',
      ),
      'utf8',
    );
    expect(prShip).toContain('prose-reviewer');
  });
});
