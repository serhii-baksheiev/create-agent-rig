import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// PLAN.md phase 5: this repo runs under its own agent-os. CLAUDE.md and
// .claude/ are composed from templates/agent-os (universal + node-ts) by
// scripts/sync-agent-os.mjs; any drift between the templates and the checked-in
// copies fails here.
describe('dogfooding: the tool repo runs its own agent-os', () => {
  it('CLAUDE.md and .claude/ are in sync with templates/agent-os', async () => {
    await expect(
      exec(process.execPath, [path.join(repoRoot, 'scripts', 'sync-agent-os.mjs'), '--check']),
    ).resolves.toBeTruthy();
  });

  it('the composed CLAUDE.md names this repo and keeps the repo addendum', async () => {
    const claudeMd = await readFile(path.join(repoRoot, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('create-agent-rig');
    expect(claudeMd).toContain('generator repo addendum');
    // The universal-derived part is fully substituted. (The addendum below the
    // marker legitimately *documents* the token names, so it is exempt.)
    const [universalPart] = claudeMd.split('generator repo addendum');
    expect(universalPart).not.toContain('__PROJECT_NAME__');
  });

  it('the blocking hooks are active in this repo', async () => {
    const settings = JSON.parse(
      await readFile(path.join(repoRoot, '.claude', 'settings.json'), 'utf8'),
    ) as { hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> } };
    const commands = settings.hooks.PreToolUse.flatMap((h) => h.hooks.map((x) => x.command));
    expect(commands.some((c) => c.includes('block-no-verify.mjs'))).toBe(true);
  });
});
