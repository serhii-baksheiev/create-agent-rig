import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude');

describe('universal rulebook neutrality after the stack layers are retired', () => {
  it('does not require a removed stack layer to supply infrastructure review or merge commands', async () => {
    const workflow = await readFile(path.join(universal, 'rules', 'workflow.md'), 'utf8');
    const prFlow = workflow.slice(workflow.indexOf('## PR flow'), workflow.indexOf('## PR policy'));

    expect(prFlow).not.toMatch(/stack\/\*/i);
    expect(prFlow).not.toMatch(/infrastructure review/i);
    expect(prFlow).not.toMatch(
      /concrete command.*stack-specific|stack-specific.*concrete command/i,
    );
  });

  it('keeps code-reviewer and test-writer architecture-neutral', async () => {
    const [reviewer, testWriter] = await Promise.all([
      readFile(path.join(universal, 'agents', 'code-reviewer.md'), 'utf8'),
      readFile(path.join(universal, 'agents', 'test-writer.md'), 'utf8'),
    ]);

    for (const specification of [reviewer, testWriter]) {
      expect(specification).not.toMatch(/\bhandlers?\b/i);
      expect(specification).not.toMatch(/\busecases?\b/i);
    }
    expect(reviewer).not.toMatch(/\bSDK\b/i);
    expect(reviewer).not.toMatch(/owning module/i);
  });

  it('does not make an application-specific pure core a universal Definition-of-Done requirement', async () => {
    const workflow = await readFile(path.join(universal, 'rules', 'workflow.md'), 'utf8');
    const definitionOfDone = workflow.slice(workflow.indexOf('## Definition of Done'));

    expect(definitionOfDone).not.toMatch(/core still pure/i);
    expect(definitionOfDone).not.toMatch(/cross-layer imports/i);
  });

  it('does not require a post-deploy runtime check when the universal install declares no deployable target', async () => {
    const workflow = await readFile(path.join(universal, 'rules', 'workflow.md'), 'utf8');

    expect(workflow).not.toMatch(/verify the deployed surface is healthy/i);
    expect(workflow).not.toMatch(/target's post-deploy verdict/i);
  });

  // RP-398: the Mechanical TDD evidence contract (RP-305/RP-306) was an owner
  // scope correction, removed from the 1.2.0 release contract before it
  // shipped. Ordinary TDD discipline — the Red/Green/Refactor motion this
  // section opens with — stays; only the pointer to the removed contract
  // goes.
  it('workflow.md names no mechanical TDD evidence contract', async () => {
    const workflow = await readFile(path.join(universal, 'rules', 'workflow.md'), 'utf8');

    expect(workflow).toContain('TDD is the default motion');
    expect(workflow).not.toMatch(/tdd-evidence\.md/);
  });

  // RP-448: "How you work" step 2 must tell test-writer to write, for every
  // rule the item states, at least one test that rule ALONE decides — every
  // other check on the path passes, so deleting or loosening that one rule
  // is what turns the test red. Matched robustly against the section body
  // rather than an exact sentence, so a reword that keeps the substance
  // still passes.
  it('tells test-writer to write one test per rule that only that rule decides, and that loosening it turns the test red', async () => {
    const testWriter = await readFile(path.join(universal, 'agents', 'test-writer.md'), 'utf8');
    const howYouWork =
      testWriter.slice(
        testWriter.indexOf('## How you work'),
        testWriter.indexOf('## Judgment lines'),
      ) || '';

    expect(
      howYouWork.length,
      'the How you work section must exist and be non-empty',
    ).toBeGreaterThan(0);
    expect(howYouWork).toMatch(/every rule/i);
    expect(howYouWork).toMatch(/only because of that rule/i);
    expect(howYouWork).toMatch(/turns? the test red/i);
  });

  // RP-448: step 4 (report back) must list the rule-to-test pairs the new
  // per-rule tests establish, not just "which tests you added".
  it('has test-writer report back the rule-to-test pairs', async () => {
    const testWriter = await readFile(path.join(universal, 'agents', 'test-writer.md'), 'utf8');
    const howYouWork =
      testWriter.slice(
        testWriter.indexOf('## How you work'),
        testWriter.indexOf('## Judgment lines'),
      ) || '';

    expect(howYouWork).toMatch(/rule-to-test/i);
  });

  // RP-448: the Codex projection is generated verbatim from this Claude spec
  // body (sync-codex-adapter.mjs), so the same two phrases must survive into
  // developer_instructions — codex.test.ts's own sync check only catches
  // DRIFT between the two files, not an instruction absent from both.
  it('carries the same per-rule-test instruction and rule-to-test report-back in the Codex projection', async () => {
    const codexProfile = await readFile(
      path.join(universal, '..', '.codex', 'agents', 'test-writer.toml'),
      'utf8',
    );

    expect(codexProfile).toMatch(/only because of that rule/i);
    expect(codexProfile).toMatch(/rule-to-test/i);
  });
});
