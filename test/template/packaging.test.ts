import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Publish brief §8: exactly one package is publishable — the root one.
describe('the inner package is locked against publication', () => {
  it('npm publish --dry-run refuses inside packages/cli', async () => {
    // npm 10 does NOT honor "private": true on --dry-run (measured), so the
    // real lock is a failing prepublishOnly script; private stays as belt.
    await expect(
      exec('npm', ['publish', '--dry-run'], { cwd: path.join(repoRoot, 'packages', 'cli') }),
    ).rejects.toThrow(/BLOCKED/);
  });

  it('packages/cli is marked private', async () => {
    const pkg = JSON.parse(
      await readFile(path.join(repoRoot, 'packages', 'cli', 'package.json'), 'utf8'),
    );
    expect(pkg.private).toBe(true);
  });
});

// Publish brief §4: the manifest is the npm landing page.
describe('the root manifest is publish-complete', () => {
  it('has the publishable identity and the npm-facing fields', async () => {
    const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('create-agent-rig');
    expect(pkg.private).toBeUndefined();
    expect(pkg.bin).toEqual({ 'create-agent-rig': 'packages/cli/dist/index.js' });
    expect(pkg.type).toBe('module');
    expect(pkg.engines?.node).toBeTruthy();
    expect(pkg.license).toBe('MIT');
    expect(pkg.description?.length).toBeGreaterThan(20);
    expect(pkg.keywords?.length).toBeGreaterThan(2);
    expect(pkg.files).toContain('templates');
  });

  it('ships a LICENSE file matching the declared license', async () => {
    const license = await readFile(path.join(repoRoot, 'LICENSE'), 'utf8');
    expect(license).toContain('MIT License');
  });

  it('the bin entry keeps its shebang', async () => {
    const source = await readFile(
      path.join(repoRoot, 'packages', 'cli', 'src', 'index.ts'),
      'utf8',
    );
    expect(source.startsWith('#!/usr/bin/env node\n')).toBe(true);
  });
});
