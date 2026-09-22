import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { needsGit, skipUnless } from '../helpers/env.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const read = (file: string): Promise<string> => readFile(path.join(repoRoot, file), 'utf8');

describe('RP-177 repository contract after removing application scaffolding', () => {
  it('keeps the documented ./demo.sh entry point executable', async (ctx) => {
    // The executable bit a clone receives is the one git records, so that is
    // what is read: a file-system mode bit does not exist on Windows, and
    // asserting one there failed the windows-e2e lane on every run since the
    // RP-177 merge.
    skipUnless(ctx, needsGit(repoRoot).ok, needsGit(repoRoot).reason);
    const readme = await read('README.md');
    const staged = execFileSync('git', ['ls-files', '--stage', '--', 'demo.sh'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(readme).toMatch(/^\.\/demo\.sh\b/m);
    expect(staged).toMatch(/^100755 /);
  });

  it('does not make pnpm or a generated workspace a requirement for installing the rig', async () => {
    const readme = await read('README.md');
    const requirements = readme.split(/^## Requirements\s*$/m)[1]?.split(/^## /m)[0];
    // The README's Requirements bullet is asserted against the root
    // manifest's own floor, not a literal, so the two can never drift
    // silently the way they did when RP-184 raised engines.node to >=22
    // without this test noticing.
    const pkg = JSON.parse(await read('package.json')) as { engines?: { node?: string } };
    const engineMajor = pkg.engines?.node?.match(/^>=\s*(\d+)/)?.[1];

    expect(requirements).toBeDefined();
    expect(
      engineMajor,
      `package.json engines.node is not a >=<major> floor: ${pkg.engines?.node}`,
    ).toBeDefined();
    expect(requirements).toMatch(new RegExp(`Node\\s*≥\\s*${engineMajor}\\b`));
    expect(requirements).not.toMatch(/\bpnpm\b/i);
    expect(requirements).not.toMatch(/generated workspace/i);
  });

  it('publishes each Codex guard once and omits the retired architecture-guards label', async () => {
    const adapter = JSON.parse(await read('.codex/hooks.json')) as {
      hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
    };
    const commands = Object.values(adapter.hooks ?? {})
      .flatMap((groups) => groups)
      .flatMap((group) => group.hooks ?? [])
      .map((hook) => hook.command ?? '');
    const guardPaths = commands.flatMap((command) =>
      [...command.matchAll(/\.claude\/hooks\/(guard-[a-z-]+\.mjs)/g)].map((match) => match[1]!),
    );

    expect(new Set(guardPaths).size).toBe(guardPaths.length);
    expect(JSON.stringify(adapter)).not.toMatch(/architecture-guards/i);
  });

  it('does not describe retired scope and app substitutions as dormant machinery', async () => {
    const rulebook = await read('CLAUDE.md');

    expect(rulebook).not.toMatch(/__PROJECT_SCOPE__.*@app\/.*dormant/i);
    expect(rulebook).not.toMatch(/substitution and its reversal stay/i);
  });
});
