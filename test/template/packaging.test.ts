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
  // 60 s: npm through a shell on windows-latest measured past the 15 s default (AR-93).
  it('npm publish --dry-run refuses inside packages/cli', { timeout: 60_000 }, async () => {
    // npm 10 does NOT honor "private": true on --dry-run (measured), so the
    // real lock is a failing prepublishOnly script; private stays as belt.
    // `npm` is a `.cmd` shim on Windows, which execFile cannot run without a
    // shell; the arguments are literal words, so the shell adds no parsing risk.
    await expect(
      exec('npm', ['publish', '--dry-run'], {
        cwd: path.join(repoRoot, 'packages', 'cli'),
        shell: process.platform === 'win32',
      }),
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
  it('prepares 0.6.2 as one release in both package manifests', async () => {
    const root = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
      version: string;
    };
    const inner = JSON.parse(
      await readFile(path.join(repoRoot, 'packages', 'cli', 'package.json'), 'utf8'),
    ) as { version: string };
    expect(root.version).toBe('0.6.2');
    expect(inner.version).toBe(root.version);
  });

  it('puts the 0.6.2 RP-54 hardening fixes first in the changelog', async () => {
    const changelog = await readFile(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
    const first = changelog.match(/^## (\d+\.\d+\.\d+)\n([\s\S]*?)(?=^## \d+\.\d+\.\d+)/m);
    expect(first?.[1]).toBe('0.6.2');
    expect(first?.[2]).toMatch(/security|harden/i);
    expect(first?.[2]).toMatch(/CLAUDE_PROJECT_DIR|repository root/i);
    expect(first?.[2]).toMatch(/Jira[\s\S]*retr|retr[\s\S]*Jira/i);
    expect(first?.[2]).toMatch(
      /doctor-exemptions[\s\S]*rulebook|rulebook[\s\S]*doctor-exemptions/i,
    );
    expect(first?.[2]).toMatch(/lastCompletedTier[\s\S]*board|board[\s\S]*lastCompletedTier/i);
  });

  it('records 0.6.1 as published and leaves only 0.6.2 pending the owner', async () => {
    const plan = await readFile(path.join(repoRoot, 'PLAN.md'), 'utf8');
    expect(plan).toMatch(/Status \(0\.6\.2 prepared, publish pending the owner/);
    expect(plan).toMatch(/0\.6\.1 is `latest`/);
    expect(plan).not.toMatch(/0\.6\.1 prepared|owner publishes `0\.6\.1`/);
    expect(plan).not.toMatch(/`0\.6\.0` is `latest`/);
  });

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

  // npm ships README, LICENSE and package.json without being asked; a CHANGELOG
  // is NOT among them. Someone upgrading from the registry would have no way to
  // see what changed — and this release rewrote the enforcement layer twice.
  it('ships the changelog, and the changelog documents this version', async () => {
    const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
      version: string;
      files: string[];
    };
    expect(pkg.files).toContain('CHANGELOG.md');
    const changelog = await readFile(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
    expect(changelog, `CHANGELOG.md must have an entry for ${pkg.version}`).toContain(
      `## ${pkg.version}`,
    );
    // and the release checklist, so the next release is not reassembled from memory
    expect(changelog).toMatch(/npm pack --dry-run/);
    expect(changelog).toMatch(/2FA|owner/i);
  });

  it('the bin entry keeps its shebang', async () => {
    const source = await readFile(
      path.join(repoRoot, 'packages', 'cli', 'src', 'index.ts'),
      'utf8',
    );
    expect(source.startsWith('#!/usr/bin/env node\n')).toBe(true);
  });
});
