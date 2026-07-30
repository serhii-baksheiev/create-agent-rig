import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectGovernance } from '../src/lib/summary.js';

/**
 * The final screen is counted from the generated tree, so it also has to *name*
 * what it counted. A hook listed as "bash" tells the reader nothing about what
 * is enforced — and this tool sells enforcement, so the screen may not be vague.
 */
describe('governance summary — hooks are named by the invariant they enforce', () => {
  it('renders each hook filename as its mechanism', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gov-'));
    const hooks = path.join(dir, '.claude', 'hooks');
    await mkdir(hooks, { recursive: true });
    for (const file of [
      'guard-core-purity.mjs',
      'guard-web-boundary.mjs',
      'block-no-verify.mjs',
      'guard-bash.mjs',
      'gate-stop-dod.mjs',
    ]) {
      await writeFile(path.join(hooks, file), '');
    }

    // the stack layer drops its DoD config in the same directory
    await writeFile(path.join(hooks, 'dod-checks.json'), '[]');

    const summary = await collectGovernance(dir);
    // A config file counted as an enforced hook makes the screen overstate the
    // enforcement — in a tool whose whole claim is enforcement, that is the one
    // number that may not be inflated.
    expect(summary.hooks).toHaveLength(5);
    expect(summary.hooks.join(' ')).not.toMatch(/json/);
    expect(summary.hooks).toContain('core purity');
    expect(summary.hooks).toContain('web boundary');
    expect(summary.hooks).toContain('no verify');
    // the deny-list guard is about the Never tier, not about the Bash tool
    expect(summary.hooks).toContain('never tier');
    expect(summary.hooks).not.toContain('bash');
  });
});
