import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

  // The seeded elevated paths belong to the generated skeleton (infra/,
  // packages/db/src/) and do not exist here. Left as-is they would declare a
  // gate over nothing — dogfooding that describes another repo is worse than no
  // dogfooding, because the sweep would report "clean" while looking nowhere.
  it('declares elevated paths that actually exist in THIS repo', async () => {
    // Imported through a URL: the hook/script tree ships as plain .mjs with no
    // declarations, and a fabricated .d.ts for a template file would rot.
    const detector = (await import(
      pathToFileURL(
        path.join(repoRoot, 'templates/agent-os/universal/.claude/scripts/detect-missed-gate.mjs'),
      ).href
    )) as { parseElevatedPaths: (md: string) => string[] | null };
    const claudeMd = await readFile(path.join(repoRoot, 'CLAUDE.md'), 'utf8');
    const declared = detector.parseElevatedPaths(claudeMd);
    expect(declared).not.toBeNull();
    expect(declared!.length).toBeGreaterThan(0);

    const { access } = await import('node:fs/promises');
    for (const declaredPath of declared!) {
      await expect(
        access(path.join(repoRoot, declaredPath)),
        `declared elevated path does not exist: ${declaredPath}`,
      ).resolves.toBeUndefined();
    }
    // and the enforcement layer itself is elevated here: weakening a hook is
    // precisely the change that must never slip through unreviewed
    expect(declared).toContain('templates/agent-os/universal/.claude/hooks/');
  });

  it('the blocking hooks are active in this repo', async () => {
    const settings = JSON.parse(
      await readFile(path.join(repoRoot, '.claude', 'settings.json'), 'utf8'),
    ) as { hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> } };
    const commands = settings.hooks.PreToolUse.flatMap((h) => h.hooks.map((x) => x.command));
    expect(commands.some((c) => c.includes('block-no-verify.mjs'))).toBe(true);
  });
});
