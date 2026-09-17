import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universalDir = path.join(repoRoot, 'templates', 'agent-os', 'universal');

// PLAN.md §4's split criterion, narrowed by RP-177: there is exactly one
// payload now (the per-target skeletons and stack overlays this file used to
// check for composition-neutrality across are retired), so what survives is
// the one invariant that is still true of it — it names no cloud provider,
// no infrastructure vendor, no cloud SDK. A rig that configures agent
// harnesses has no business promising anything about AWS, GCP or Kubernetes.
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
