import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Publish brief §9: a target's config files must not mention another target's
// artifacts. A stale ignore line today is a stale rule or dependency tomorrow —
// exactly the cross-target bleed the two-layer split exists to prevent.
const FOREIGN_MARKERS: Record<string, RegExp> = {
  // nothing CDK/infra-shaped belongs in the no-cloud target
  'node-service': /cdk\.out|\binfra\b|aws/i,
  // the spool/var runtime layout belongs to node-service only
  'aws-serverless': /\bvar\/|spool/i,
};

const SHARED_LOOKING_FILES = ['gitignore', '.npmignore', 'eslint.config.mjs', 'vitest.config.ts'];

describe('no cross-target bleed in shared-looking files', () => {
  for (const [target, foreign] of Object.entries(FOREIGN_MARKERS)) {
    it(`${target} mentions nothing belonging to another target`, async () => {
      const offences: string[] = [];
      for (const file of SHARED_LOOKING_FILES) {
        const abs = path.join(repoRoot, 'templates', 'skeleton', target, file);
        const content = await readFile(abs, 'utf8').catch(() => '');
        content.split('\n').forEach((line, index) => {
          if (foreign.test(line)) offences.push(`${file}:${index + 1}: ${line.trim()}`);
        });
      }
      expect(offences).toEqual([]);
    });
  }
});
