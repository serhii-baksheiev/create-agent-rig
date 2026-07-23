import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universalDir = path.join(repoRoot, 'templates', 'agent-os', 'universal');

// PLAN.md §4 split criterion: a rule is universal iff it can be applied without
// knowing where the project is hosted. §8 item 4 makes this a mechanical check.
const PROVIDER_TERMS = [
  'aws',
  'amazon',
  'dynamo',
  'cdk',
  'lambda',
  'sqs',
  'sns',
  's3',
  'cognito',
  'cloudwatch',
  'cloudformation',
  'terraform',
  'gcp',
  'google cloud',
  'azure',
  'kubernetes',
  'docker',
];

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const p = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(p) : Promise.resolve([p]);
    }),
  );
  return files.flat();
}

describe('agent-os/universal is stack-neutral', () => {
  it('mentions no provider, no infrastructure vendor, no cloud SDK', async () => {
    const files = await walk(universalDir);
    expect(files.length).toBeGreaterThan(0);
    const offences: string[] = [];
    for (const file of files) {
      const content = (await readFile(file, 'utf8')).toLowerCase();
      for (const term of PROVIDER_TERMS) {
        // match whole-ish words to avoid false positives inside other words
        const re = new RegExp(`(^|[^a-z0-9])${term}([^a-z0-9]|$)`, 'i');
        if (re.test(content)) {
          offences.push(`${path.relative(universalDir, file)}: "${term}"`);
        }
      }
    }
    expect(offences).toEqual([]);
  });
});

describe('agent-os/stack layers exist for composition', () => {
  it('ships node-ts and aws-cdk stack rules', async () => {
    for (const stack of ['node-ts', 'aws-cdk']) {
      const rules = await readdir(
        path.join(repoRoot, 'templates', 'agent-os', 'stack', stack, '.claude', 'rules'),
      );
      expect(rules.length).toBeGreaterThan(0);
    }
  });
});

// Phase 9: layers must claim disjoint paths — an overlap would be silently
// resolved by copy order, which is exactly the failure mode we refuse.
describe('layer ownership per target', () => {
  const layersOf = (target: string, stacks: string[]) => [
    { name: `skeleton/${target}`, dir: path.join(repoRoot, 'templates', 'skeleton', target) },
    { name: 'universal', dir: universalDir },
    ...stacks.map((s) => ({
      name: `stack/${s}`,
      dir: path.join(repoRoot, 'templates', 'agent-os', 'stack', s),
    })),
  ];

  const MATRIX = [
    { target: 'aws-serverless', stacks: ['node-ts', 'aws-cdk'] },
    { target: 'node-service', stacks: ['node-ts'] },
  ];

  it('no two layers claim the same generated path, in any target', async () => {
    const { listTree } = await import('../../packages/cli/src/lib/copy-tree.js');
    const { detectCollisions, ALLOWED_OVERWRITES } =
      await import('../../packages/cli/src/lib/composition.js');
    for (const { target, stacks } of MATRIX) {
      const layers = [];
      for (const layer of layersOf(target, stacks)) {
        layers.push({ name: layer.name, files: await listTree(layer.dir) });
      }
      expect(detectCollisions(layers, ALLOWED_OVERWRITES), target).toEqual([]);
    }
  });

  it('the expected owners hold their signature paths', async () => {
    const { listTree } = await import('../../packages/cli/src/lib/copy-tree.js');
    const skeleton = await listTree(path.join(repoRoot, 'templates', 'skeleton', 'node-service'));
    const universal = await listTree(universalDir);
    const nodeTs = await listTree(path.join(repoRoot, 'templates', 'agent-os', 'stack', 'node-ts'));

    expect(skeleton).toContain('package.json');
    expect(skeleton).toContain('README.md');
    expect(universal).toContain('CLAUDE.md');
    expect(universal).toContain('.claude/settings.json');
    expect(nodeTs).toContain('.claude/rules/node-ts.md');
    // the seam: the skeleton never ships agent-os files, and vice versa
    expect(skeleton.some((f) => f.startsWith('.claude/'))).toBe(false);
    expect(universal.some((f) => f.endsWith('package.json'))).toBe(false);
  });
});
