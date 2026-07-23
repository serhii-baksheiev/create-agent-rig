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
