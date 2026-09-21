import { initFileContents } from '../commands/init.js';
import { MANIFEST_REL, parseManifest, sha256 } from '../lib/manifest.js';
import { readBounded } from './verify.js';

export async function inspectWorkflow(options: { repoDir: string }): Promise<{
  status: 'pass' | 'fail';
  reason: 'not-selected' | 'workflow-verified' | 'workflow-integrity-invalid';
}> {
  const failed = { status: 'fail', reason: 'workflow-integrity-invalid' } as const;
  const source = await readBounded(options.repoDir, MANIFEST_REL, 1024 * 1024);
  if (source.status !== 'ok') return failed;
  const manifest = parseManifest(source.bytes.toString('utf8'));
  if (manifest === null) return failed;
  if (!manifest.layers.includes('workflow')) return { status: 'pass', reason: 'not-selected' };
  const expected = await initFileContents(options.repoDir, manifest.project, manifest.layers);
  // Package-owned mechanisms only. No tracker reads, claim rewrites, or execution
  // of repository scripts: the frozen behavior is compared as installed bytes.
  for (const [rel, content] of expected) {
    if (!rel.startsWith('.claude/scripts/')) continue;
    const observed = await readBounded(options.repoDir, rel, 1024 * 1024);
    if (observed.status !== 'ok' || sha256(observed.bytes) !== sha256(content)) return failed;
  }
  return { status: 'pass', reason: 'workflow-verified' };
}
