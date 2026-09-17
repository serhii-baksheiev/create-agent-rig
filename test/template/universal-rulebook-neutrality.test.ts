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
});
