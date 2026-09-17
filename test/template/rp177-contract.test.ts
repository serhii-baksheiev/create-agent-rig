import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const read = (file: string): Promise<string> => readFile(path.join(repoRoot, file), 'utf8');

describe('RP-177 repository contract after removing application scaffolding', () => {
  it('keeps the documented ./demo.sh entry point executable', async () => {
    const [readme, metadata] = await Promise.all([
      read('README.md'),
      stat(path.join(repoRoot, 'demo.sh')),
    ]);

    expect(readme).toMatch(/^\.\/demo\.sh\b/m);
    expect(metadata.mode & 0o111).not.toBe(0);
  });

  it('does not make pnpm or a generated workspace a requirement for installing the rig', async () => {
    const readme = await read('README.md');
    const requirements = readme.split(/^## Requirements\s*$/m)[1]?.split(/^## /m)[0];

    expect(requirements).toBeDefined();
    expect(requirements).toMatch(/Node\s*≥\s*20/);
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
});
