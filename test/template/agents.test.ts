import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { readGateSpec, verdictExamplesIn, verdictWordsFor } from './verdict-spec.js';

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
  // An unbacked behaviour claim is a blocker BY RULE — the finding is the absence of
  // backing, not a disproof — which is what lets `check-premises` catch it before this
  // agent is ever launched. The norm is `.claude/rules/invariants.md`, "State the
  // limits".
  it('blocks an unbacked behaviour claim by rule, and says what backing looks like', async () => {
    const content = await read();
    expect(content).toMatch(/unbacked|nothing backs it|no test behind it/i);
    // the two acceptable forms, per invariants.md "State the limits"
    expect(content).toMatch(/generated/i);
    expect(content).toMatch(/pointer to (a|the) test/i);
  });

  it('allows an absent upstream test only for an unchanged generator-authored hook', async () => {
    const content = await read();
    const checklist = content.slice(
      content.indexOf('## Checklist'),
      content.indexOf('## Advisory'),
    );

    expect(checklist).toMatch(/generator-authored hook/i);
    expect(checklist).toMatch(/(?:upstream|generator)[^.]{0,80}tests?[^.]{0,120}absent locally/i);
    expect(checklist).toMatch(/hook[^.]{0,80}header[^.]{0,120}absent locally/i);
    expect(checklist).toMatch(/only while[^.]{0,120}(?:unchanged|untouched)[^.]{0,80}downstream/i);
    expect(checklist).toMatch(
      /(?:edit|change)[^.]{0,120}(?:downstream|current diff)[^.]{0,160}(?:local test|test is yours|exception (?:expires|ends|no longer applies))/i,
    );
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
    // 🔴 The count is read from the list rather than written in the test's name. This
    // change takes the checklist from five items to six (the new one goes in at
    // position 5, domain-leakage moves to 6), and the name said "five" until it did —
    // so the next one will not have to remember to rename anything.
    const items = [...blocking.matchAll(/^\d+\. \*\*/gm)];
    expect(items.length, 'the checklist is six items; add an assertion with a seventh').toBe(6);
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

// AR-65: a reviewer's verdict stops being prose the calling session
// pattern-matches by eye. Each of these agents ends its report with exactly one
// fenced ```json block of the shape `lib/verdict.mjs` defines, so `pr-ship` can
// check "one verdict per run" and "a stop names a blocker" instead of reading
// for them. The three gate SKILLS make the same promise — their half of this is
// in `skills.test.ts`.
describe('every reviewing agent ends with one machine-readable verdict', () => {
  const REVIEWERS = ['code-reviewer', 'prose-reviewer', 'security-scanner', 'cdk-diff-reviewer'];

  it.each(REVIEWERS)('%s asks for exactly one fenced json block', async (gate) => {
    const content = await readGateSpec(gate);
    // "exactly one" is the load-bearing half: two blocks is two verdicts, and a
    // reader that takes either one is choosing a verdict for the reviewer.
    expect(content).toMatch(/exactly one[\s\S]{0,80}json/i);
  });

  it.each(REVIEWERS)('%s shows an example verdict that names itself', async (gate) => {
    const content = await readGateSpec(gate);
    const examples = verdictExamplesIn(content, gate);
    expect(examples, `${gate} ships no fenced json example`).not.toHaveLength(0);

    // The gate field is copied from the example by whoever follows the spec, so
    // an example naming a DIFFERENT gate teaches every run to mislabel itself.
    const own = examples.filter((example) => example['gate'] === gate);
    expect(own, `no example in ${gate} carries \`"gate": "${gate}"\``).not.toHaveLength(0);

    const allowed = await verdictWordsFor(gate);
    for (const example of own) {
      expect(allowed, `${gate} shows a word it may not return`).toContain(example['verdict']);
    }
  });
});
