import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { gitEnv } from '../../packages/cli/src/lib/git-env.js';
import {
  ANTHROPIC_KEY,
  ATLASSIAN_TOKEN,
  CLOUD_ACCESS_KEY,
  GITHUB_PAT,
  PEM_HEADER,
  SLACK_BOT_TOKEN,
} from './secrets-fixtures.js';
import { runNodeTimed } from '../helpers/child-timing.js';
import { needsGitRoot, onlyOnWindows, skipUnless } from '../helpers/env.js';
import { removeFixture } from '../helpers/remove-fixture.js';

// AR-49(b), the PreToolUse half of the "both layers, one shared module" ruling.
//
// `.gitignore` (half a) stops a credential FILENAME from reaching a commit. It
// cannot stop an agent from writing one in the first place, and it says nothing
// at all about a credential VALUE pasted into an ordinary file — `notes.md`,
// a test fixture, a service module. That is the gap this hook closes, at the
// tool layer, before the write lands.
//
// The hook owns no vocabulary of its own: `isCredentialPath` and
// `findSecretValues` come from `.claude/scripts/lib/secrets.mjs`, which is
// pinned by `secrets-lib.test.ts`. Nothing here re-tests the module — these are
// the HOOK's behaviours: which tools it judges, which direction it fails in,
// and what its refusal is allowed to say out loud.
//
// 🔴 The negative half is the more important half, twice over. A guard that
// fires on `auth.ts`, `session.ts` or `.env.example` gets routed around within
// the week; and a guard that THROWS on a payload it did not expect blocks every
// edit in the session, which `.claude/rules/invariants.md` says gets it deleted
// within the hour. So both directions are pinned, and so is fail-open.

const run = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const hook = path.join(universal, '.claude', 'hooks', 'guard-secret-file.mjs');

interface HookResult {
  code: number;
  stderr: string;
}

/** Feed a synthetic hook payload to the hook, exactly as Claude Code does. */
function runHook(payload: unknown, env: NodeJS.ProcessEnv = {}, cwd?: string): Promise<HookResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [hook],
      { cwd, env: { ...process.env, ...env } },
      (error, _stdout, stderr) => {
        resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stderr });
      },
    );
    if (!child.stdin) return reject(new Error('no stdin'));
    // A hook that decides early and exits closes the pipe under us; that EPIPE
    // is the hook working, not the test failing. The exit code is the subject.
    child.stdin.on('error', () => {});
    child.stdin.write(typeof payload === 'string' ? payload : JSON.stringify(payload));
    child.stdin.end();
  });
}

const write = (filePath: string, content: string) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Write',
  tool_input: { file_path: filePath, content },
});

const edit = (filePath: string, newString: string) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Edit',
  tool_input: { file_path: filePath, old_string: 'x', new_string: newString },
});

const multiEdit = (filePath: string, additions: string[]) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'MultiEdit',
  tool_input: {
    file_path: filePath,
    edits: additions.map((newString) => ({ old_string: 'x', new_string: newString })),
  },
});

const notebookEdit = (filePath: string, newSource: string) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'NotebookEdit',
  tool_input: { notebook_path: filePath, new_source: newSource },
});

const applyPatch = (filePath: string, addition: string) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'apply_patch',
  tool_input: {
    command: ['*** Begin Patch', `*** Add File: ${filePath}`, `+${addition}`, '*** End Patch'].join(
      '\n',
    ),
  },
});

const updatePatch = (filePath: string, before: string, after: string) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'apply_patch',
  tool_input: {
    command: [
      '*** Begin Patch',
      `*** Update File: ${filePath}`,
      '@@',
      `-${before}`,
      `+${after}`,
      '*** End Patch',
    ].join('\n'),
  },
});

// RP-507: Node's Windows `realpathSync.native` expands a valid DOS 8.3 cwd
// alias, while ordinary `realpathSync` can preserve it. The containment guard
// must compare one canonical identity, without making traversal or junction
// escapes admissible as a side effect.
describe('guard-secret-file: accepts an ordinary relative Add from a real Windows 8.3 cwd alias (RP-507)', () => {
  it('keeps ordinary edits writable while preserving credential, traversal, outside, and junction refusals', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const shortCwd = await mkdtemp(path.join(tmpdir(), 'rp507-short-cwd-'));
    const canonicalRoot = realpathSync.native(shortCwd);
    const hasReal83Alias = shortCwd
      .split(/[\\/]/)
      .some((component) => /^[^\\/:]{1,6}~\d+$/i.test(component));
    if (!hasReal83Alias || shortCwd.toLocaleLowerCase() === canonicalRoot.toLocaleLowerCase()) {
      await removeFixture(canonicalRoot);
      ctx.skip(
        'the Windows temporary-directory fixture has no real 8.3 cwd alias that realpathSync.native expands',
      );
      return;
    }

    const outside = await mkdtemp(path.join(tmpdir(), 'rp507-outside-'));
    try {
      await run('git', ['init', '-q', canonicalRoot], { env: gitEnv() });
      await symlink(outside, path.join(canonicalRoot, 'junction-escape'), 'junction');

      const hookEnv = { CLAUDE_PROJECT_DIR: canonicalRoot };
      const longCwdOrdinary = await runHook(
        { ...applyPatch('ordinary-long-cwd.ts', 'export const safe = true;'), cwd: canonicalRoot },
        hookEnv,
        canonicalRoot,
      );
      expect(longCwdOrdinary.code, longCwdOrdinary.stderr).toBe(0);

      const credential = await runHook(
        { ...applyPatch('.env', 'harmless'), cwd: canonicalRoot },
        hookEnv,
        canonicalRoot,
      );
      expect(credential.code, credential.stderr).toBe(2);
      expect(credential.stderr).toMatch(/credential file/i);

      const traversal = await runHook(
        { ...applyPatch('../outside.ts', 'export const unsafe = true;'), cwd: canonicalRoot },
        hookEnv,
        canonicalRoot,
      );
      expect(traversal.code, traversal.stderr).toBe(2);

      const absoluteOutside = await runHook(
        {
          ...applyPatch(path.join(outside, 'outside.ts'), 'export const unsafe = true;'),
          cwd: canonicalRoot,
        },
        hookEnv,
        canonicalRoot,
      );
      expect(absoluteOutside.code, absoluteOutside.stderr).toBe(2);

      const junction = await runHook(
        {
          ...applyPatch('junction-escape/outside.ts', 'export const unsafe = true;'),
          cwd: canonicalRoot,
        },
        hookEnv,
        canonicalRoot,
      );
      expect(junction.code, junction.stderr).toBe(2);

      const shortCwdOrdinary = await runHook(
        { ...applyPatch('ordinary-short-cwd.ts', 'export const safe = true;'), cwd: shortCwd },
        hookEnv,
        shortCwd,
      );
      expect(shortCwdOrdinary.code, shortCwdOrdinary.stderr).toBe(0);

      const shortCwdCredential = await runHook(
        { ...applyPatch('.env', 'harmless'), cwd: shortCwd },
        hookEnv,
        shortCwd,
      );
      expect(shortCwdCredential.code, shortCwdCredential.stderr).toBe(2);
      expect(shortCwdCredential.stderr).toMatch(/credential file/i);

      const shortCwdTraversal = await runHook(
        { ...applyPatch('../outside.ts', 'export const unsafe = true;'), cwd: shortCwd },
        hookEnv,
        shortCwd,
      );
      expect(shortCwdTraversal.code, shortCwdTraversal.stderr).toBe(2);

      const shortCwdAbsoluteOutside = await runHook(
        {
          ...applyPatch(path.join(outside, 'outside.ts'), 'export const unsafe = true;'),
          cwd: shortCwd,
        },
        hookEnv,
        shortCwd,
      );
      expect(shortCwdAbsoluteOutside.code, shortCwdAbsoluteOutside.stderr).toBe(2);

      const shortCwdJunction = await runHook(
        {
          ...applyPatch('junction-escape/outside.ts', 'export const unsafe = true;'),
          cwd: shortCwd,
        },
        hookEnv,
        shortCwd,
      );
      expect(shortCwdJunction.code, shortCwdJunction.stderr).toBe(2);
    } finally {
      await removeFixture(canonicalRoot);
      await removeFixture(outside);
    }
  });
});

describe('guard-secret-file: a real Windows 8.3 alias cannot hide an existing credential file (RP-517)', () => {
  it('refuses the credential alias while allowing the distinct ordinary-file alias', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const root = realpathSync.native(await mkdtemp(path.join(tmpdir(), 'rp517-file-alias-')));
    const credential = path.join(root, '.env.local');
    const ordinary = path.join(root, 'ordinary-long-note.txt');
    const marker = 'harmless disposable audit fixture';
    const shortPath = async (filePath: string) => {
      const escaped = filePath.replaceAll("'", "''");
      const { stdout } = await run('powershell.exe', [
        '-NoProfile',
        '-Command',
        `(New-Object -ComObject Scripting.FileSystemObject).GetFile('${escaped}').ShortPath`,
      ]);
      return stdout.trim();
    };

    try {
      await writeFile(credential, marker);
      await writeFile(ordinary, marker);
      await run('git', ['init', '-q', root], { env: gitEnv() });

      const credentialAlias = await shortPath(credential);
      const ordinaryAlias = await shortPath(ordinary);
      const credentialAliasBase = path.basename(credentialAlias);
      const ordinaryAliasBase = path.basename(ordinaryAlias);
      if (
        credentialAliasBase === path.basename(credential) ||
        ordinaryAliasBase === path.basename(ordinary)
      ) {
        ctx.skip('the Windows fixture did not provide distinct 8.3 aliases for both files');
        return;
      }

      expect(realpathSync.native(credentialAlias)).toBe(realpathSync.native(credential));
      expect(realpathSync.native(ordinaryAlias)).toBe(realpathSync.native(ordinary));
      await expect(readFile(credentialAlias, 'utf8')).resolves.toBe(marker);
      await expect(readFile(ordinaryAlias, 'utf8')).resolves.toBe(marker);

      const hookEnv = { CLAUDE_PROJECT_DIR: root };
      const ordinaryThroughAlias = await runHook(
        { ...updatePatch(ordinaryAliasBase, marker, 'harmless replacement'), cwd: root },
        hookEnv,
        root,
      );
      expect(ordinaryThroughAlias.code, ordinaryThroughAlias.stderr).toBe(0);

      const canonicalCredential = await runHook(
        { ...updatePatch('.env.local', marker, 'harmless replacement'), cwd: root },
        hookEnv,
        root,
      );
      expect(canonicalCredential.code, canonicalCredential.stderr).toBe(2);

      const credentialThroughAlias = await runHook(
        { ...updatePatch(credentialAliasBase, marker, 'harmless replacement'), cwd: root },
        hookEnv,
        root,
      );
      expect(credentialThroughAlias.code, credentialThroughAlias.stderr).toBe(2);
      expect(credentialThroughAlias.stderr).toMatch(/credential file/i);
    } finally {
      await removeFixture(root);
    }
  });
});

describe('guard-secret-file: canonicalizing an 8.3 alias preserves its literal credential policy (RP-517)', () => {
  it('refuses a short alias whose extension is credential-named even when its canonical filename is ordinary', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const root = realpathSync.native(await mkdtemp(path.join(tmpdir(), 'rp517-literal-policy-')));
    const relativeOrdinary = 'ordinary-long-note.jwtcatalog';
    const ordinary = path.join(root, relativeOrdinary);
    const marker = 'harmless disposable audit fixture';
    try {
      await writeFile(ordinary, marker);
      await run('git', ['init', '-q', root], { env: gitEnv() });
      const escaped = ordinary.replaceAll("'", "''");
      const { stdout } = await run('powershell.exe', [
        '-NoProfile',
        '-Command',
        `(New-Object -ComObject Scripting.FileSystemObject).GetFile('${escaped}').ShortPath`,
      ]);
      const alias = stdout.trim();
      const aliasBase = path.basename(alias);
      if (aliasBase === path.basename(ordinary)) {
        ctx.skip('the Windows fixture did not provide a distinct 8.3 alias for the ordinary file');
        return;
      }

      expect(path.extname(relativeOrdinary)).toBe('.jwtcatalog');
      expect(path.extname(aliasBase).toLowerCase()).toBe('.jwt');
      expect(realpathSync.native(alias)).toBe(realpathSync.native(ordinary));
      await expect(readFile(alias, 'utf8')).resolves.toBe(marker);

      const hookEnv = { CLAUDE_PROJECT_DIR: root };
      const canonical = await runHook(
        { ...write(relativeOrdinary, 'harmless replacement'), cwd: root },
        hookEnv,
        root,
      );
      expect(canonical.code, canonical.stderr).toBe(0);

      const shortAlias = await runHook(
        { ...write(aliasBase, 'harmless replacement'), cwd: root },
        hookEnv,
        root,
      );
      expect(shortAlias.code, shortAlias.stderr).toBe(2);
      expect(shortAlias.stderr).toMatch(/credential file/i);
    } finally {
      await removeFixture(root);
    }
  });
});

describe('guard-secret-file: Windows 8.3-looking names retain a safe local identity boundary (RP-517)', () => {
  it('rejects reparse, outside, UNC, device, and drive-relative aliases while allowing an absent ordinary Add', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const root = realpathSync.native(await mkdtemp(path.join(tmpdir(), 'rp517-boundary-root-')));
    const outside = realpathSync.native(
      await mkdtemp(path.join(tmpdir(), 'rp517-boundary-outside-')),
    );
    const outsideCredential = path.join(outside, '.env.local');
    const ordinary = path.join(root, 'ordinary-long-note.txt');
    const marker = 'harmless disposable audit fixture';
    const shortPath = async (filePath: string) => {
      const escaped = filePath.replaceAll("'", "''");
      const { stdout } = await run('powershell.exe', [
        '-NoProfile',
        '-Command',
        `(New-Object -ComObject Scripting.FileSystemObject).GetFile('${escaped}').ShortPath`,
      ]);
      return stdout.trim();
    };

    try {
      await writeFile(outsideCredential, marker);
      await writeFile(ordinary, marker);
      await run('git', ['init', '-q', root], { env: gitEnv() });
      await symlink(outside, path.join(root, 'junction-escape'), 'junction');

      const outsideAlias = await shortPath(outsideCredential);
      const aliasBase = path.basename(outsideAlias);
      const ordinaryAlias = await shortPath(ordinary);
      if (
        aliasBase === path.basename(outsideCredential) ||
        path.basename(ordinaryAlias) === path.basename(ordinary)
      ) {
        ctx.skip('the Windows fixture did not provide distinct 8.3 aliases for both files');
        return;
      }

      const junctionInput = `junction-escape/${aliasBase}`;
      expect(realpathSync.native(outsideAlias)).toBe(realpathSync.native(outsideCredential));
      expect(realpathSync.native(ordinaryAlias)).toBe(realpathSync.native(ordinary));
      expect(realpathSync.native(path.join(root, junctionInput))).toBe(
        realpathSync.native(outsideCredential),
      );
      await expect(access(path.join(root, 'ABSENT~1.TXT'))).rejects.toMatchObject({
        code: 'ENOENT',
      });

      const hookEnv = { CLAUDE_PROJECT_DIR: root };
      const missingOrdinary = await runHook(
        { ...applyPatch('ABSENT~1.TXT', 'export const safe = true;'), cwd: root },
        hookEnv,
        root,
      );
      expect(missingOrdinary.code, missingOrdinary.stderr).toBe(0);

      const uncInput = String.raw`\\rp517-no-such-host\share` + '\\' + aliasBase;
      const deviceInput = String.raw`\\?\C:\rp517` + '\\' + aliasBase;
      const deviceExistingOrdinaryAlias = String.raw`\\?` + '\\' + ordinaryAlias;
      for (const input of [uncInput, deviceInput, deviceExistingOrdinaryAlias]) {
        expect(input).not.toContain('${aliasBase}');
        expect(input).not.toContain('${ordinaryAlias}');
      }
      expect(uncInput.endsWith(aliasBase)).toBe(true);
      expect(deviceInput.endsWith(aliasBase)).toBe(true);
      expect(deviceExistingOrdinaryAlias.endsWith(ordinaryAlias)).toBe(true);

      const unsafeInputs: Array<[string, string]> = [
        ['junction', junctionInput],
        ['outside existing alias', outsideAlias],
        ['UNC', uncInput],
        ['device', deviceInput],
        ['device existing ordinary alias', deviceExistingOrdinaryAlias],
        ['drive-relative', `C:${aliasBase}`],
      ];
      const results = [] as Array<{ label: string; result: HookResult }>;
      for (const [label, filePath] of unsafeInputs) {
        results.push({
          label,
          result: await runHook(
            { ...write(filePath, 'harmless replacement'), cwd: root },
            hookEnv,
            root,
          ),
        });
      }
      expect(
        results.map(({ label, result }) => ({ label, code: result.code })),
        results.map(({ label, result }) => `${label}: ${result.stderr}`).join(', '),
      ).toEqual([
        { label: 'junction', code: 2 },
        { label: 'outside existing alias', code: 2 },
        { label: 'UNC', code: 2 },
        { label: 'device', code: 2 },
        { label: 'device existing ordinary alias', code: 2 },
        { label: 'drive-relative', code: 2 },
      ]);
    } finally {
      await removeFixture(root);
      await removeFixture(outside);
    }
  });
});

interface CredentialAliasFixture {
  root: string;
  marker: string;
  aliasBase: string;
  ordinaryAliasBase: string;
}

const existingCredentialAliasFixture = async (
  ctx: Parameters<typeof skipUnless>[0],
): Promise<CredentialAliasFixture | undefined> => {
  skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
  const root = realpathSync.native(await mkdtemp(path.join(tmpdir(), 'rp517-direct-alias-')));
  const credential = path.join(root, '.env.local');
  const ordinary = path.join(root, 'ordinary-long-note.txt');
  const marker = 'harmless disposable audit fixture';
  try {
    await writeFile(credential, marker);
    await writeFile(ordinary, marker);
    await run('git', ['init', '-q', root], { env: gitEnv() });
    const escaped = credential.replaceAll("'", "''");
    const { stdout } = await run('powershell.exe', [
      '-NoProfile',
      '-Command',
      `(New-Object -ComObject Scripting.FileSystemObject).GetFile('${escaped}').ShortPath`,
    ]);
    const alias = stdout.trim();
    const aliasBase = path.basename(alias);
    const ordinaryEscaped = ordinary.replaceAll("'", "''");
    const { stdout: ordinaryStdout } = await run('powershell.exe', [
      '-NoProfile',
      '-Command',
      `(New-Object -ComObject Scripting.FileSystemObject).GetFile('${ordinaryEscaped}').ShortPath`,
    ]);
    const ordinaryAlias = ordinaryStdout.trim();
    const ordinaryAliasBase = path.basename(ordinaryAlias);
    if (aliasBase === path.basename(credential) || ordinaryAliasBase === path.basename(ordinary)) {
      await removeFixture(root);
      ctx.skip('the Windows fixture did not provide distinct 8.3 aliases for both files');
      return undefined;
    }
    expect(realpathSync.native(alias)).toBe(realpathSync.native(credential));
    expect(realpathSync.native(ordinaryAlias)).toBe(realpathSync.native(ordinary));
    await expect(readFile(alias, 'utf8')).resolves.toBe(marker);
    await expect(readFile(ordinaryAlias, 'utf8')).resolves.toBe(marker);
    return { root, marker, aliasBase, ordinaryAliasBase };
  } catch (error) {
    await removeFixture(root);
    throw error;
  }
};

const withExistingCredentialAlias = async (
  ctx: Parameters<typeof skipUnless>[0],
  assertion: (fixture: CredentialAliasFixture) => Promise<void>,
) => {
  const fixture = await existingCredentialAliasFixture(ctx);
  if (!fixture) return;
  try {
    const ordinary = await runHook(
      {
        ...updatePatch(fixture.ordinaryAliasBase, fixture.marker, 'harmless replacement'),
        cwd: fixture.root,
      },
      { CLAUDE_PROJECT_DIR: fixture.root },
      fixture.root,
    );
    expect(ordinary.code, ordinary.stderr).toBe(0);
    await assertion(fixture);
  } finally {
    await removeFixture(fixture.root);
  }
};

describe('guard-secret-file: direct edit tools retain credential policy through real Windows 8.3 aliases (RP-517)', () => {
  it('refuses every direct edit tool after the ordinary alias remains writable', async (ctx) => {
    await withExistingCredentialAlias(ctx, async ({ root, aliasBase, ordinaryAliasBase }) => {
      const payloads: Array<[string, (filePath: string) => Record<string, unknown>]> = [
        ['Write', (filePath) => write(filePath, 'harmless replacement')],
        ['Edit', (filePath) => edit(filePath, 'harmless replacement')],
        ['MultiEdit', (filePath) => multiEdit(filePath, ['harmless replacement'])],
        ['NotebookEdit', (filePath) => notebookEdit(filePath, 'harmless replacement')],
      ];
      const results = [] as Array<{ tool: string; result: HookResult }>;
      for (const [tool, payloadFor] of payloads) {
        const ordinary = await runHook(
          { ...payloadFor(ordinaryAliasBase), cwd: root },
          { CLAUDE_PROJECT_DIR: root },
          root,
        );
        expect(ordinary.code, `${tool}: ${ordinary.stderr}`).toBe(0);
        results.push({
          tool,
          result: await runHook(
            { ...payloadFor(aliasBase), cwd: root },
            { CLAUDE_PROJECT_DIR: root },
            root,
          ),
        });
      }
      expect(
        results.map(({ tool, result }) => ({ tool, code: result.code })),
        results.map(({ tool, result }) => `${tool}: ${result.stderr}`).join(', '),
      ).toEqual([
        { tool: 'Write', code: 2 },
        { tool: 'Edit', code: 2 },
        { tool: 'MultiEdit', code: 2 },
        { tool: 'NotebookEdit', code: 2 },
      ]);
    });
  });
});

// RP-517 round 3. Direct tools resolve a relative filename from their effective
// cwd. The 8.3 canonicaliser must use that same cwd, rather than treating every
// relative alias as root-relative under CLAUDE_PROJECT_DIR.
describe('guard-secret-file: a direct relative 8.3 alias resolves from its effective Windows cwd (RP-517)', () => {
  let root = '';
  let subdirectory = '';
  let shortSubdirectory = '';
  let credentialAlias = '';
  let ordinaryAlias = '';
  const marker = 'harmless disposable audit fixture';

  const shortPath = async (filePath: string) => {
    const escaped = filePath.replaceAll("'", "''");
    const { stdout } = await run('powershell.exe', [
      '-NoProfile',
      '-Command',
      `(New-Object -ComObject Scripting.FileSystemObject).GetFile('${escaped}').ShortPath`,
    ]);
    return stdout.trim();
  };

  const shortFolderPath = async (directory: string) => {
    const escaped = directory.replaceAll("'", "''");
    const { stdout } = await run('powershell.exe', [
      '-NoProfile',
      '-Command',
      `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${escaped}').ShortPath`,
    ]);
    return stdout.trim();
  };

  beforeEach(async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    root = realpathSync.native(await mkdtemp(path.join(tmpdir(), 'rp517-subdir-alias-')));
    subdirectory = path.join(root, 'subdirectory-with-long-name');
    await mkdir(subdirectory, { recursive: true });
    const credential = path.join(subdirectory, '.env.local');
    const ordinary = path.join(subdirectory, 'ordinary-long-note.txt');
    await writeFile(credential, marker);
    await writeFile(ordinary, marker);
    await run('git', ['init', '-q', root], { env: gitEnv() });

    credentialAlias = path.basename(await shortPath(credential));
    ordinaryAlias = path.basename(await shortPath(ordinary));
    shortSubdirectory = await shortFolderPath(subdirectory);
    if (
      credentialAlias === path.basename(credential) ||
      ordinaryAlias === path.basename(ordinary)
    ) {
      ctx.skip('the Windows fixture did not provide distinct 8.3 aliases for both files');
      return;
    }

    expect(realpathSync.native(path.join(subdirectory, credentialAlias))).toBe(
      realpathSync.native(credential),
    );
    expect(realpathSync.native(path.join(subdirectory, ordinaryAlias))).toBe(
      realpathSync.native(ordinary),
    );
    expect(realpathSync.native(shortSubdirectory)).toBe(realpathSync.native(subdirectory));
    await expect(readFile(path.join(subdirectory, credentialAlias), 'utf8')).resolves.toBe(marker);
    await expect(readFile(path.join(subdirectory, ordinaryAlias), 'utf8')).resolves.toBe(marker);
  });

  afterEach(async () => {
    if (root !== '') await removeFixture(root);
  });

  it('refuses a credential alias from the payload cwd after allowing an ordinary alias there', async () => {
    const hookEnv = { CLAUDE_PROJECT_DIR: root };
    const ordinary = await runHook(
      { ...write(ordinaryAlias, 'harmless replacement'), cwd: subdirectory },
      hookEnv,
      root,
    );
    expect(ordinary.code, ordinary.stderr).toBe(0);

    const credential = await runHook(
      { ...write(credentialAlias, 'harmless replacement'), cwd: subdirectory },
      hookEnv,
      root,
    );
    expect(credential.code, credential.stderr).toBe(2);
    expect(credential.stderr).toMatch(/credential file/i);
  });

  it('refuses a credential alias from the hook process cwd when the payload omits cwd', async () => {
    const hookEnv = { CLAUDE_PROJECT_DIR: root };
    const ordinary = await runHook(
      write(ordinaryAlias, 'harmless replacement'),
      hookEnv,
      subdirectory,
    );
    expect(ordinary.code, ordinary.stderr).toBe(0);

    const credential = await runHook(
      write(credentialAlias, 'harmless replacement'),
      hookEnv,
      subdirectory,
    );
    expect(credential.code, credential.stderr).toBe(2);
    expect(credential.stderr).toMatch(/credential file/i);
  });

  it('refuses a credential alias when the payload cwd is the directory short alias', async (ctx) => {
    skipUnless(
      ctx,
      shortSubdirectory.toLocaleLowerCase() !== subdirectory.toLocaleLowerCase(),
      'the Windows fixture did not provide a distinct 8.3 alias for the subdirectory cwd',
    );
    const hookEnv = { CLAUDE_PROJECT_DIR: root };
    const ordinary = await runHook(
      { ...write(ordinaryAlias, 'harmless replacement'), cwd: shortSubdirectory },
      hookEnv,
      root,
    );
    expect(ordinary.code, ordinary.stderr).toBe(0);

    const credential = await runHook(
      { ...write(credentialAlias, 'harmless replacement'), cwd: shortSubdirectory },
      hookEnv,
      root,
    );
    expect(credential.code, credential.stderr).toBe(2);
    expect(credential.stderr).toMatch(/credential file/i);
  });

  it('keeps an Update from the payload cwd on its resolver-established subdirectory target', async () => {
    const hookEnv = { CLAUDE_PROJECT_DIR: root };
    const ordinary = await runHook(
      { ...updatePatch(ordinaryAlias, marker, 'harmless replacement'), cwd: subdirectory },
      hookEnv,
      root,
    );
    expect(ordinary.code, ordinary.stderr).toBe(0);

    const credential = await runHook(
      { ...updatePatch(credentialAlias, marker, 'harmless replacement'), cwd: subdirectory },
      hookEnv,
      root,
    );
    expect(credential.code, credential.stderr).toBe(2);
    expect(credential.stderr).toMatch(/credential file/i);
  });
});

describe('guard-secret-file: a Windows 8.3 alias keeps credential policy for NTFS alternate data streams (RP-517)', () => {
  it('refuses existing and new credential streams while allowing ordinary alias streams', async (ctx) => {
    const fixture = await existingCredentialAliasFixture(ctx);
    if (!fixture) return;
    const { root, marker, aliasBase, ordinaryAliasBase } = fixture;
    const credentialExistingStream = path.join(root, '.env.local:rp517audit');
    const ordinaryExistingStream = path.join(root, 'ordinary-long-note.txt:rp517audit');
    try {
      await writeFile(credentialExistingStream, marker);
      await writeFile(ordinaryExistingStream, marker);
      const credentialStreamText = await readNamedStreamOrSkip(
        ctx,
        credentialExistingStream,
        'a readable credential-file named stream',
      );
      const ordinaryStreamText = await readNamedStreamOrSkip(
        ctx,
        ordinaryExistingStream,
        'a readable ordinary-file named stream',
      );
      if (credentialStreamText === undefined || ordinaryStreamText === undefined) return;

      const credentialAliasExistingStream = path.join(root, `${aliasBase}:rp517audit`);
      const ordinaryAliasExistingStream = path.join(root, `${ordinaryAliasBase}:rp517audit`);
      expect(credentialStreamText).toBe(marker);
      expect(ordinaryStreamText).toBe(marker);
      await expect(readFile(credentialAliasExistingStream, 'utf8')).resolves.toBe(marker);
      await expect(readFile(ordinaryAliasExistingStream, 'utf8')).resolves.toBe(marker);

      const hookEnv = { CLAUDE_PROJECT_DIR: root };
      const cases: Array<[string, Record<string, unknown>, number]> = [
        [
          'canonical credential existing stream',
          write('.env.local:rp517audit', 'harmless replacement'),
          2,
        ],
        [
          'credential alias existing stream Write',
          write(`${aliasBase}:rp517audit`, 'harmless replacement'),
          2,
        ],
        [
          'credential alias existing stream Edit',
          edit(`${aliasBase}:rp517audit`, 'harmless replacement'),
          2,
        ],
        [
          'credential alias new stream Write',
          write(`${aliasBase}:rp517new`, 'harmless replacement'),
          2,
        ],
        [
          'ordinary alias existing stream',
          write(`${ordinaryAliasBase}:rp517audit`, 'harmless replacement'),
          0,
        ],
        [
          'ordinary alias new stream',
          write(`${ordinaryAliasBase}:rp517new`, 'harmless replacement'),
          0,
        ],
      ];
      const results = [] as Array<{ label: string; expectedCode: number; result: HookResult }>;
      for (const [label, payload, expectedCode] of cases) {
        results.push({
          label,
          expectedCode,
          result: await runHook({ ...payload, cwd: root }, hookEnv, root),
        });
      }
      expect(
        results.map(({ label, result }) => ({ label, code: result.code })),
        results.map(({ label, result }) => `${label}: ${result.stderr}`).join(', '),
      ).toEqual(results.map(({ label, expectedCode }) => ({ label, code: expectedCode })));
    } finally {
      await removeFixture(root);
    }
  });
});

const deny = async (payload: unknown, why: string): Promise<HookResult> => {
  const result = await runHook(payload);
  expect(result.code, `should BLOCK: ${why}\nstderr: ${result.stderr}`).toBe(2);
  return result;
};

const allow = async (payload: unknown, why: string): Promise<HookResult> => {
  const result = await runHook(payload);
  expect(result.code, `should ALLOW: ${why}\nstderr: ${result.stderr}`).toBe(0);
  return result;
};

// RP-463: Codex emits absolute paths in an apply_patch command. A path that
// resolves inside the checkout is not unsafe merely because it is absolute;
// the guard must apply its credential policy after proving containment.
describe('guard-secret-file: accepts a contained absolute apply_patch destination (RP-463)', () => {
  it('allows an absolute in-repository Add path with Unicode source text', async () => {
    const inRepository = path
      .join(repoRoot, 'src', 'caf\u00e9-\u6771\u4eac.ts')
      .replaceAll(path.sep, '/');
    await allow(applyPatch(inRepository, 'export const safe = true;'), 'contained absolute Add');
  });
});

// RP-478: the parser removes its trailing Rust whitespace before it decides
// which pathname to write. Credential policy must judge that same pathname;
// U+FEFF is intentionally absent because the parser retains it as data.
describe('guard-secret-file: trailing Rust header whitespace cannot hide an absolute .env target (RP-478)', () => {
  const credentialPath = path.join(repoRoot, '.env').replaceAll(path.sep, '/');

  it.each([
    ['space', '\u0020'],
    ['tab', '\u0009'],
    ['non-breaking space', '\u00a0'],
    ['NEL', '\u0085'],
    ['line separator', '\u2028'],
    ['paragraph separator', '\u2029'],
  ] as const)(
    'refuses an absolute Add whose .env header ends with Rust whitespace %s',
    async (_label, suffix) => {
      const result = await runHook(
        applyPatch(`${credentialPath}${suffix}`, 'export const safe = true;'),
      );
      expect(result.code, `Rust whitespace ${JSON.stringify(suffix)}: ${result.stderr}`).toBe(2);
    },
  );
});

// RP-463: removals do not write a credential, but an unresolvable removal
// still makes the entire patch unsafe. The global refusal must be considered
// before removal fragments are excluded from credential-content policy.
describe('guard-secret-file: unsafe absolute Delete paths remain global refusals (RP-463)', () => {
  it('refuses an attended Delete of an outside absolute path', async () => {
    const filePath = path.join(tmpdir(), 'rp463-delete-outside.ts').replaceAll(path.sep, '/');
    const result = await runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: { command: `*** Begin Patch\n*** Delete File: ${filePath}\n*** End Patch\n` },
    });
    expect(result.code, result.stderr).toBe(2);
  });

  it('refuses an attended Delete with a redundant absolute traversal segment', async () => {
    const filePath = `${repoRoot.replaceAll('\\', '/')}/src/safe/../delete-outside.ts`;
    const result = await runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: { command: `*** Begin Patch\n*** Delete File: ${filePath}\n*** End Patch\n` },
    });
    expect(result.code, result.stderr).toBe(2);
  });

  it('refuses an attended Delete through an ambiguous UNC path', async () => {
    const result = await runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: {
        command: String.raw`*** Begin Patch
*** Delete File: \\server\share\delete-outside.ts
*** End Patch
`,
      },
    });
    expect(result.code, result.stderr).toBe(2);
  });

  it('refuses an attended Delete through an absolute symlink or junction escape', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'rp463-delete-root-')));
    const outside = await realpath(await mkdtemp(path.join(tmpdir(), 'rp463-delete-outside-')));
    try {
      await run('git', ['init', '-q', root]);
      await mkdir(path.join(root, 'src'), { recursive: true });
      await symlink(
        outside,
        path.join(root, 'src', 'escape'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const escapedPath = path.join(root, 'src', 'escape', 'delete.ts').replaceAll(path.sep, '/');
      const result = await runHook(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'apply_patch',
          tool_input: {
            command: `*** Begin Patch\n*** Delete File: ${escapedPath}\n*** End Patch\n`,
          },
        },
        {},
        root,
      );
      expect(result.code, result.stderr).toBe(2);
    } finally {
      await removeFixture(root);
      await removeFixture(outside);
    }
  });
});

describe('guard-secret-file: an absolute Move source remains subject to containment (RP-463)', () => {
  it('refuses an attended Move whose absolute source is outside the repository even when its destination is safe', async () => {
    const outside = path.join(tmpdir(), 'rp463-move-outside.ts').replaceAll(path.sep, '/');
    const destination = path.join(repoRoot, 'src', 'moved.ts').replaceAll(path.sep, '/');
    const result = await runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: {
        command: `*** Begin Patch\n*** Update File: ${outside}\n*** Move to: ${destination}\n@@\n+export const moved = true;\n*** End Patch\n`,
      },
    });
    expect(result.code, result.stderr).toBe(2);
  });

  it('allows an absolute in-repository Move source with a safe relative destination', async () => {
    const source = path.join(repoRoot, 'package.json').replaceAll(path.sep, '/');
    const result = await runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: {
        command: `*** Begin Patch\n*** Update File: ${source}\n*** Move to: src/moved.ts\n@@\n+export const moved = true;\n*** End Patch\n`,
      },
    });
    expect(result.code, result.stderr).toBe(0);
  });
});

describe('guard-secret-file: Move headers use the same parser boundary as Add and Update (RP-478)', () => {
  it('refuses a Move destination whose absolute .env header ends with a line separator', async () => {
    const source = path.join(repoRoot, 'package.json').replaceAll(path.sep, '/');
    const destination = `${path.join(repoRoot, '.env').replaceAll(path.sep, '/')}\u2028`;
    const result = await runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: {
        command: `*** Begin Patch\n*** Update File: ${source}\n*** Move to: ${destination}\n@@\n+export const moved = true;\n*** End Patch\n`,
      },
    });
    expect(result.code, result.stderr).toBe(2);
  });
});

describe('guard-secret-file: NEL remains conservatively uninspectable (RP-478)', () => {
  it('refuses an absolute Add destination with an uninspectable NEL header', async () => {
    const credentialPath = path.join(repoRoot, '.env').replaceAll(path.sep, '/');
    const result = await runHook(
      applyPatch(`${credentialPath}\u0085`, 'export const safe = true;'),
    );
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toMatch(/cannot safely inspect/i);
  });
});

describe('guard-secret-file: ambiguous Windows path spellings remain outside the repository (RP-463)', () => {
  it('refuses a drive-relative Add path with a repository-relative remedy', async () => {
    const result = await runHook(applyPatch('C:relative\\outside.ts', 'export const safe = true;'));
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toMatch(/repository.relative|relative.*repository/i);
    expect(result.stderr).not.toMatch(/split/i);
  });

  it('refuses a device-namespace Add path with a repository-relative remedy', async () => {
    const result = await runHook(
      applyPatch(String.raw`\\?\C:\outside.ts`, 'export const safe = true;'),
    );
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toMatch(/repository.relative|relative.*repository/i);
    expect(result.stderr).not.toMatch(/split/i);
  });

  it('refuses a UNC Add path with a repository-relative remedy', async () => {
    const result = await runHook(
      applyPatch(String.raw`\\server\share\outside.ts`, 'export const safe = true;'),
    );
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toMatch(/repository.relative|relative.*repository/i);
    expect(result.stderr).not.toMatch(/split/i);
  });
});

// A leading path character is not trailing parser formatting. In particular,
// treating it as whitespace would validate a different pathname from Codex.
describe(
  'guard-secret-file:' + ' absolute-looking leading whitespace stays uninspectable (RP-478)',
  () => {
    let fixtureRoot = '';

    beforeEach(async () => {
      fixtureRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'rp478-leading-root-')));
      await run('git', ['init', '-q', fixtureRoot]);
    });

    afterEach(async () => {
      await removeFixture(fixtureRoot);
    });

    it('refuses an absolute-looking Add header with a literal leading space', async () => {
      const control = path.join(fixtureRoot, 'ordinary-control.ts');
      const result = await runHook(
        applyPatch(` ${control}`, 'export const safe = true;'),
        { CLAUDE_PROJECT_DIR: fixtureRoot },
        fixtureRoot,
      );
      expect(result.code, result.stderr).toBe(2);
      expect(result.stderr).toMatch(/cannot safely inspect/i);
    });
  },
);

describe('guard-secret-file: absolute Unicode containment uses component identity (RP-463)', () => {
  it('refuses an absolute path in the distinct NTFS sibling whose Unicode casing path.relative folds', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const parent = await realpath(await mkdtemp(path.join(tmpdir(), 'rp463-unicode-parent-')));
    const repositoryLexical = path.join(parent, 'repo\u0130');
    const outsideLexical = path.join(parent, 'repoi\u0307');
    try {
      await mkdir(repositoryLexical);
      await mkdir(outsideLexical);
      const repository = realpathSync.native(repositoryLexical);
      const outside = realpathSync.native(outsideLexical);
      expect(repository).not.toBe(outside);
      await run('git', ['init', '-q', repository]);

      const hookEnv = { CLAUDE_PROJECT_DIR: repository };
      const relativeControl = await runHook(
        applyPatch('src/relative-control.ts', 'export const safe = true;'),
        hookEnv,
        repository,
      );
      expect(relativeControl.code, relativeControl.stderr).toBe(0);
      const absoluteControl = await runHook(
        applyPatch(
          path.join(repository, 'src', 'absolute-control.ts'),
          'export const safe = true;',
        ),
        hookEnv,
        repository,
      );
      expect(absoluteControl.code, absoluteControl.stderr).toBe(0);

      const result = await runHook(
        applyPatch(path.join(outside, 'payload.ts'), 'export const safe = true;'),
        hookEnv,
        repository,
      );
      expect(result.code, result.stderr).toBe(2);
      expect(result.stderr).toMatch(/repository.relative|relative.*repository/i);
    } finally {
      await removeFixture(parent);
    }
  });
});

describe('guard-secret-file: Windows alternate-data-stream paths remain uninspectable (RP-463)', () => {
  it('refuses an absolute apply_patch spelling of the .env default data stream', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const fixture = realpathSync.native(await mkdtemp(path.join(tmpdir(), 'rp463-ads-root-')));
    try {
      await run('git', ['init', '-q', fixture]);
      const hookEnv = { CLAUDE_PROJECT_DIR: fixture };
      const relativeControl = await runHook(
        applyPatch('notes-relative.ts', 'export const safe = true;'),
        hookEnv,
        fixture,
      );
      expect(relativeControl.code, relativeControl.stderr).toBe(0);
      const absoluteControl = await runHook(
        applyPatch(path.join(fixture, 'notes-absolute.ts'), 'export const safe = true;'),
        hookEnv,
        fixture,
      );
      expect(absoluteControl.code, absoluteControl.stderr).toBe(0);
      const credentialControl = await runHook(
        applyPatch(path.join(fixture, '.env'), 'export const safe = true;'),
        hookEnv,
        fixture,
      );
      expect(credentialControl.code, credentialControl.stderr).toBe(2);

      const streamPath = path.join(fixture, '.env::$DATA');
      const result = await runHook(
        applyPatch(streamPath, 'export const safe = true;'),
        hookEnv,
        fixture,
      );
      expect(result.code, result.stderr).toBe(2);
      expect(result.stderr.trim()).not.toBe('');
    } finally {
      await removeFixture(fixture);
    }
  });
});

describe('guard-secret-file: BOM path characters remain identity-bearing (RP-478)', () => {
  it('refuses an absolute BOM-suffixed symlink escape through Add', async () => {
    const fixtureRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'rp478-bom-root-')));
    const outsideRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'rp478-bom-outside-')));
    try {
      const outsideFile = path.join(outsideRoot, 'harmless.ts');
      const bomLink = path.join(fixtureRoot, 'escape\ufeff');
      await run('git', ['init', '-q', fixtureRoot]);
      await writeFile(outsideFile, 'export const harmless = true;\n');
      await symlink(outsideFile, bomLink, 'file');
      expect(await realpath(bomLink)).toBe(await realpath(outsideFile));

      const result = await runHook(
        applyPatch(bomLink, 'export const safe = true;'),
        { CLAUDE_PROJECT_DIR: fixtureRoot },
        fixtureRoot,
      );
      expect(result.code, result.stderr).toBe(2);
      expect(result.stderr).toMatch(/cannot safely inspect/i);
    } finally {
      await removeFixture(fixtureRoot);
      await removeFixture(outsideRoot);
    }
  });

  it('refuses a relative BOM-suffixed symlink escape instead of trimming it to a safe sibling', async () => {
    const fixtureRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), 'rp478-relative-bom-root-')),
    );
    const outsideRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), 'rp478-relative-bom-outside-')),
    );
    try {
      const outsideFile = path.join(outsideRoot, 'harmless.ts');
      const ordinaryFile = path.join(fixtureRoot, 'safe.txt');
      const bomLink = path.join(fixtureRoot, 'safe.txt\ufeff');
      await run('git', ['init', '-q', fixtureRoot]);
      await writeFile(ordinaryFile, 'export const ordinary = true;\n');
      await writeFile(outsideFile, 'export const outside = true;\n');
      await symlink(outsideFile, bomLink, 'file');
      expect(await realpath(bomLink)).toBe(await realpath(outsideFile));
      const ordinaryControl = await runHook(
        applyPatch('safe.txt', 'export const safe = true;'),
        { CLAUDE_PROJECT_DIR: fixtureRoot },
        fixtureRoot,
      );
      expect(ordinaryControl.code, ordinaryControl.stderr).toBe(0);
      const result = await runHook(
        applyPatch('safe.txt\ufeff', 'export const safe = true;'),
        { CLAUDE_PROJECT_DIR: fixtureRoot },
        fixtureRoot,
      );
      expect(result.code, result.stderr).toBe(2);
      expect(result.stderr).toMatch(/cannot safely inspect/i);
    } finally {
      await removeFixture(fixtureRoot);
      await removeFixture(outsideRoot);
    }
  });
});

// Synthetic credentials, none of them real. They come from a shared module and
// are ASSEMBLED rather than written literally — a fixture written out in full
// here becomes the scanner's own first finding the moment this file is
// committed, and then blocks the commit that adds it. secrets-fixtures.ts says
// why that is preferred to an exemption list.

describe('guard-secret-file: a credential-named path is refused whatever is in it', () => {
  it('ships as a hook file at the path settings.json names', async () => {
    await expect(access(hook)).resolves.toBeUndefined();
  });

  it.each([
    ['jira.env', 'an env file, the one AR-49(a) was filed for'],
    ['config/secrets/prod.txt', 'the segment arm an ignore rule could not express'],
    ['id_rsa', 'a key with no extension to give it away'],
    ['private.pem', 'key material by extension'],
    ['db.secret', 'a credential word used as the extension'],
  ])('blocks a Write to %s (%s)', async (filePath) => {
    await deny(write(filePath, 'anything at all\n'), filePath);
  });

  it('blocks a Write to a credential path given absolutely, as the tool actually sends it', async () => {
    await deny(write(`${repoRoot}/config/secrets/prod.txt`, 'anything at all\n'), 'absolute path');
  });

  it('blocks apply_patch from adding a credential-named file', async () => {
    await deny(applyPatch('config/secrets/prod.txt', 'documented placeholder'), 'apply_patch path');
  });

  it('names the path it refused and where a credential belongs instead', async () => {
    const result = await deny(write('jira.env', 'anything at all\n'), 'jira.env');
    expect(result.stderr).toContain('jira.env');
    // `.claude/rules/invariants.md`: a refusal that does not say what to do
    // instead is a refusal that gets routed around.
    expect(result.stderr).toMatch(/outside the repo|\.claude\/rules\/[a-z-]+\.md/);
  });
});

// RP-496. `name:stream` is a named NTFS alternate data stream, not part of
// the base filename. Direct Write/Edit cases establish that the current
// fixture volume supports a harmless named stream before judging their paths.
const readNamedStreamOrSkip = async (
  ctx: Parameters<typeof skipUnless>[0],
  filePath: string,
  description: string,
): Promise<string | undefined> => {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (!['ENOENT', 'EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(code ?? '')) throw error;
    ctx.skip(`the Windows fixture filesystem does not support ${description} (${code})`);
    return undefined;
  }
};

const namedNtfsStreamFixture = async (
  ctx: Parameters<typeof skipUnless>[0],
): Promise<string | undefined> => {
  skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);

  const fixture = realpathSync.native(await mkdtemp(path.join(tmpdir(), 'rp496-ads-root-')));
  try {
    await run('git', ['init', '-q', fixture]);
    const base = path.join(fixture, 'safe.txt');
    const stream = `${base}:acceptance`;
    await writeFile(base, 'base control\n');
    await writeFile(stream, 'named-stream control\n');
    const streamText = await readNamedStreamOrSkip(ctx, stream, 'a readable named NTFS stream');
    if (streamText === undefined) {
      await removeFixture(fixture);
      return undefined;
    }
    expect(await readFile(base, 'utf8')).toBe('base control\n');
    expect(streamText).toBe('named-stream control\n');
    return fixture;
  } catch (error) {
    await removeFixture(fixture);
    throw error;
  }
};

describe('guard-secret-file: direct Windows named-stream paths keep credential policy (RP-496)', () => {
  it('refuses a Write to the relative named stream of a credential file', async (ctx) => {
    const fixture = await namedNtfsStreamFixture(ctx);
    if (!fixture) return;
    try {
      const result = await runHook(
        write('.env:acceptance', 'safe\n'),
        { CLAUDE_PROJECT_DIR: fixture },
        fixture,
      );
      expect(result.code, result.stderr).toBe(2);
    } finally {
      await removeFixture(fixture);
    }
  });

  it('refuses a Write to the absolute named stream of a credential file', async (ctx) => {
    const fixture = await namedNtfsStreamFixture(ctx);
    if (!fixture) return;
    try {
      const result = await runHook(
        write(path.join(fixture, '.env:acceptance'), 'safe\n'),
        { CLAUDE_PROJECT_DIR: fixture },
        fixture,
      );
      expect(result.code, result.stderr).toBe(2);
    } finally {
      await removeFixture(fixture);
    }
  });

  it('refuses an Edit to the relative named stream of a credential file', async (ctx) => {
    const fixture = await namedNtfsStreamFixture(ctx);
    if (!fixture) return;
    try {
      const result = await runHook(
        edit('.env:acceptance', 'safe\n'),
        { CLAUDE_PROJECT_DIR: fixture },
        fixture,
      );
      expect(result.code, result.stderr).toBe(2);
    } finally {
      await removeFixture(fixture);
    }
  });

  it('refuses an Edit to the absolute named stream of a credential file', async (ctx) => {
    const fixture = await namedNtfsStreamFixture(ctx);
    if (!fixture) return;
    try {
      const result = await runHook(
        edit(path.join(fixture, '.env:acceptance'), 'safe\n'),
        { CLAUDE_PROJECT_DIR: fixture },
        fixture,
      );
      expect(result.code, result.stderr).toBe(2);
    } finally {
      await removeFixture(fixture);
    }
  });

  it('allows a Write to an ordinary named stream (positive control)', async (ctx) => {
    const fixture = await namedNtfsStreamFixture(ctx);
    if (!fixture) return;
    try {
      const result = await runHook(
        write('safe.txt:acceptance', 'safe\n'),
        { CLAUDE_PROJECT_DIR: fixture },
        fixture,
      );
      expect(result.code, result.stderr).toBe(0);
    } finally {
      await removeFixture(fixture);
    }
  });
});

describe('guard-secret-file: direct Windows named directory streams keep credential policy (RP-496)', () => {
  it('refuses a Write through the default named stream of a secrets directory', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const fixture = realpathSync.native(
      await mkdtemp(path.join(tmpdir(), 'rp496-directory-ads-root-')),
    );
    try {
      const directoryAlias = `secrets::${'$'}INDEX_ALLOCATION`;
      const marker = 'safe directory marker\n';
      await run('git', ['init', '-q', fixture]);
      await mkdir(path.join(fixture, 'secrets'));
      await writeFile(path.join(fixture, 'secrets', 'config'), marker);
      const markerRead = await readNamedStreamOrSkip(
        ctx,
        path.join(fixture, directoryAlias, 'config'),
        'the readable default directory stream',
      );
      if (markerRead === undefined) return;
      expect(markerRead).toBe(marker);

      const result = await runHook(
        write(`${directoryAlias}/config`, 'safe\n'),
        { CLAUDE_PROJECT_DIR: fixture },
        fixture,
      );
      expect(result.code, result.stderr).toBe(2);
    } finally {
      await removeFixture(fixture);
    }
  });

  it('refuses an Edit through the explicit named stream of a secrets directory', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const fixture = realpathSync.native(
      await mkdtemp(path.join(tmpdir(), 'rp496-directory-ads-root-')),
    );
    try {
      const directoryAlias = `secrets:${'$'}I30:${'$'}INDEX_ALLOCATION`;
      const marker = 'safe directory marker\n';
      await run('git', ['init', '-q', fixture]);
      await mkdir(path.join(fixture, 'secrets'));
      await writeFile(path.join(fixture, 'secrets', 'config'), marker);
      const markerRead = await readNamedStreamOrSkip(
        ctx,
        path.join(fixture, directoryAlias, 'config'),
        'the readable explicit directory stream',
      );
      if (markerRead === undefined) return;
      expect(markerRead).toBe(marker);

      const result = await runHook(
        edit(`${directoryAlias}/config`, 'safe\n'),
        { CLAUDE_PROJECT_DIR: fixture },
        fixture,
      );
      expect(result.code, result.stderr).toBe(2);
    } finally {
      await removeFixture(fixture);
    }
  });

  it('refuses a Write through the default named stream of a credentials directory', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const fixture = realpathSync.native(
      await mkdtemp(path.join(tmpdir(), 'rp496-directory-ads-root-')),
    );
    try {
      const directoryAlias = `credentials::${'$'}INDEX_ALLOCATION`;
      const marker = 'safe directory marker\n';
      await run('git', ['init', '-q', fixture]);
      await mkdir(path.join(fixture, 'credentials'));
      await writeFile(path.join(fixture, 'credentials', 'config'), marker);
      const markerRead = await readNamedStreamOrSkip(
        ctx,
        path.join(fixture, directoryAlias, 'config'),
        'the readable default directory stream',
      );
      if (markerRead === undefined) return;
      expect(markerRead).toBe(marker);

      const result = await runHook(
        write(`${directoryAlias}/config`, 'safe\n'),
        { CLAUDE_PROJECT_DIR: fixture },
        fixture,
      );
      expect(result.code, result.stderr).toBe(2);
    } finally {
      await removeFixture(fixture);
    }
  });

  it('refuses an Edit through the explicit named stream of a credentials directory', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const fixture = realpathSync.native(
      await mkdtemp(path.join(tmpdir(), 'rp496-directory-ads-root-')),
    );
    try {
      const directoryAlias = `credentials:${'$'}I30:${'$'}INDEX_ALLOCATION`;
      const marker = 'safe directory marker\n';
      await run('git', ['init', '-q', fixture]);
      await mkdir(path.join(fixture, 'credentials'));
      await writeFile(path.join(fixture, 'credentials', 'config'), marker);
      const markerRead = await readNamedStreamOrSkip(
        ctx,
        path.join(fixture, directoryAlias, 'config'),
        'the readable explicit directory stream',
      );
      if (markerRead === undefined) return;
      expect(markerRead).toBe(marker);

      const result = await runHook(
        edit(`${directoryAlias}/config`, 'safe\n'),
        { CLAUDE_PROJECT_DIR: fixture },
        fixture,
      );
      expect(result.code, result.stderr).toBe(2);
    } finally {
      await removeFixture(fixture);
    }
  });

  it('allows a Write through the default named stream of an ordinary directory', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const fixture = realpathSync.native(
      await mkdtemp(path.join(tmpdir(), 'rp496-directory-ads-root-')),
    );
    try {
      const directoryAlias = `ordinary::${'$'}INDEX_ALLOCATION`;
      const marker = 'safe directory marker\n';
      await run('git', ['init', '-q', fixture]);
      await mkdir(path.join(fixture, 'ordinary'));
      await writeFile(path.join(fixture, 'ordinary', 'config'), marker);
      const markerRead = await readNamedStreamOrSkip(
        ctx,
        path.join(fixture, directoryAlias, 'config'),
        'the readable default directory stream',
      );
      if (markerRead === undefined) return;
      expect(markerRead).toBe(marker);

      const result = await runHook(
        write(`${directoryAlias}/config`, 'safe\n'),
        { CLAUDE_PROJECT_DIR: fixture },
        fixture,
      );
      expect(result.code, result.stderr).toBe(0);
    } finally {
      await removeFixture(fixture);
    }
  });
});

// A `C:relative` path resolves from C:'s current directory, which is the hook
// child's cwd here. It is neither an absolute `C:\\relative` path nor a POSIX
// colon filename. The tests probe each harmless alias from that exact cwd
// before handing its spelling to the guard.
const cDriveFixture = async (
  ctx: Parameters<typeof skipUnless>[0],
): Promise<string | undefined> => {
  skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
  const fixture = realpathSync.native(await mkdtemp(path.join(tmpdir(), 'rp496-c-drive-root-')));
  if (path.parse(fixture).root.toUpperCase() !== 'C:\\') {
    await removeFixture(fixture);
    ctx.skip(`the Windows fixture cwd is on ${path.parse(fixture).root}, not C:`);
    return undefined;
  }
  try {
    await run('git', ['init', '-q', fixture]);
    return fixture;
  } catch (error) {
    await removeFixture(fixture);
    throw error;
  }
};

const readDriveRelativeAliasOrSkip = async (
  ctx: Parameters<typeof skipUnless>[0],
  fixture: string,
  alias: string,
  description: string,
): Promise<string | undefined> => {
  const probe = String.raw`
import { readFile } from 'node:fs/promises';

try {
  process.stdout.write(JSON.stringify({ ok: true, text: await readFile(process.argv[1], 'utf8') }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error?.code }));
}
`;
  const { stdout } = await run(process.execPath, ['--input-type=module', '--eval', probe, alias], {
    cwd: fixture,
  });
  const result = JSON.parse(stdout) as { ok: boolean; text?: string; code?: string };
  if (result.ok) return result.text;
  if (['ENOENT', 'EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(result.code ?? '')) {
    ctx.skip(`the Windows fixture filesystem does not resolve ${description} (${result.code})`);
    return undefined;
  }
  throw new Error(
    `native probe for ${description} failed with ${result.code ?? 'an unknown error'}`,
  );
};

describe('guard-secret-file: drive-relative Windows credential aliases keep credential policy (RP-496)', () => {
  it('refuses a Write through C:secrets::$INDEX_ALLOCATION/config', async (ctx) => {
    const fixture = await cDriveFixture(ctx);
    if (!fixture) return;
    try {
      const alias = `C:secrets::${'$'}INDEX_ALLOCATION/config`;
      const marker = 'safe directory marker\n';
      await mkdir(path.join(fixture, 'secrets'));
      await writeFile(path.join(fixture, 'secrets', 'config'), marker);
      expect(
        await readDriveRelativeAliasOrSkip(
          ctx,
          fixture,
          alias,
          'the drive-relative default stream of a directory',
        ),
      ).toBe(marker);

      const result = await runHook(
        write(alias, 'safe\n'),
        { CLAUDE_PROJECT_DIR: fixture },
        fixture,
      );
      expect(result.code, result.stderr).toBe(2);
    } finally {
      await removeFixture(fixture);
    }
  });

  it('refuses a Write through C:.netrc:acceptance', async (ctx) => {
    const fixture = await cDriveFixture(ctx);
    if (!fixture) return;
    try {
      const alias = 'C:.netrc:acceptance';
      const marker = 'safe named-stream marker\n';
      const absoluteStream = path.join(fixture, '.netrc:acceptance');
      await writeFile(path.join(fixture, '.netrc'), 'safe base file\n');
      await writeFile(absoluteStream, marker);
      expect(await readFile(absoluteStream, 'utf8')).toBe(marker);
      expect(
        await readDriveRelativeAliasOrSkip(ctx, fixture, alias, 'a drive-relative named stream'),
      ).toBe(marker);

      const result = await runHook(
        write(alias, 'safe\n'),
        { CLAUDE_PROJECT_DIR: fixture },
        fixture,
      );
      expect(result.code, result.stderr).toBe(2);
    } finally {
      await removeFixture(fixture);
    }
  });

  it('allows a Write through C:ordinary::$INDEX_ALLOCATION/config', async (ctx) => {
    const fixture = await cDriveFixture(ctx);
    if (!fixture) return;
    try {
      const alias = `C:ordinary::${'$'}INDEX_ALLOCATION/config`;
      const marker = 'safe ordinary directory marker\n';
      await mkdir(path.join(fixture, 'ordinary'));
      await writeFile(path.join(fixture, 'ordinary', 'config'), marker);
      expect(
        await readDriveRelativeAliasOrSkip(
          ctx,
          fixture,
          alias,
          'the drive-relative default stream of an ordinary directory',
        ),
      ).toBe(marker);

      const result = await runHook(
        write(alias, 'safe\n'),
        { CLAUDE_PROJECT_DIR: fixture },
        fixture,
      );
      expect(result.code, result.stderr).toBe(0);
    } finally {
      await removeFixture(fixture);
    }
  });

  it('allows a relative nested named stream whose safe base filename is C', async (ctx) => {
    const fixture = await cDriveFixture(ctx);
    if (!fixture) return;
    try {
      const alias = 'ordinary/C:.netrc';
      const base = path.join(fixture, 'ordinary', 'C');
      const stream = path.join(fixture, 'ordinary', 'C:.netrc');
      const baseMarker = 'safe base marker\n';
      const streamMarker = 'safe named-stream marker\n';
      await mkdir(path.join(fixture, 'ordinary'));
      await writeFile(base, baseMarker);
      await writeFile(stream, streamMarker);
      expect(await readFile(base, 'utf8')).toBe(baseMarker);
      expect(await readFile(stream, 'utf8')).toBe(streamMarker);

      const result = await runHook(
        write(alias, 'safe\n'),
        { CLAUDE_PROJECT_DIR: fixture },
        fixture,
      );
      expect(result.code, result.stderr).toBe(0);
    } finally {
      await removeFixture(fixture);
    }
  });
});

describe('guard-secret-file: a credential value is refused wherever it is being written', () => {
  it.each([
    ['notes.md', CLOUD_ACCESS_KEY],
    ['notes.md', GITHUB_PAT],
    ['packages/core/src/thing.ts', CLOUD_ACCESS_KEY],
    ['packages/core/src/thing.ts', PEM_HEADER],
  ])('blocks a Write to %s carrying a credential value', async (filePath, value) => {
    await deny(write(filePath, `const config = {\n  value: '${value}',\n};\n`), filePath);
  });

  // Proves the hook reads the field the Edit tool actually populates. A hook
  // that only ever looked at `content` would pass every Edit in the session.
  it('blocks an Edit whose new_string carries a credential value', async () => {
    await deny(edit('packages/core/src/thing.ts', `const key = '${GITHUB_PAT}';`), 'Edit');
  });

  it('blocks a MultiEdit when any new_string carries a credential value', async () => {
    await deny(
      multiEdit('packages/core/src/thing.ts', [
        'export const ordinary = true;',
        `export const key = '${GITHUB_PAT}';`,
      ]),
      'MultiEdit',
    );
  });

  it('blocks a NotebookEdit whose new_source carries a credential value', async () => {
    await deny(
      notebookEdit('notebooks/incident.ipynb', `const key = '${GITHUB_PAT}';`),
      'NotebookEdit',
    );
  });

  it('refuses a MultiEdit beyond the fragment cap instead of silently dropping the tail', async () => {
    const additions = Array.from(
      { length: 256 },
      (_, index) => `export const n${index} = ${index};`,
    );
    additions.push(`export const key = '${GITHUB_PAT}';`);

    const result = await deny(
      multiEdit('packages/core/src/thing.ts', additions),
      'MultiEdit over the inspection cap',
    );
    expect(result.stderr).toMatch(/cannot safely inspect|inspection limit|more than 256/i);
    expect(result.stderr).not.toContain(GITHUB_PAT);
  });

  it('blocks apply_patch when an added line carries a credential value', async () => {
    await deny(
      applyPatch('notes.md', `const key = '${GITHUB_PAT}';`),
      'apply_patch credential value',
    );
  });

  it('names which shape it matched and the line it is on', async () => {
    const content = ['first line', 'second line', 'third line', `AWS_KEY=${CLOUD_ACCESS_KEY}`].join(
      '\n',
    );
    const result = await deny(write('notes.md', content), 'aws key on line 4');
    expect(result.stderr).toContain('cloud-access-key');
    expect(result.stderr).toMatch(/line 4\b/);
  });

  // 🔴 The headline of this file. A guard that prints what it found has copied
  // the credential into a hook transcript, a terminal scrollback and a CI log —
  // it has leaked the secret in the act of refusing it.
  it('never prints the credential it found, nor a fragment of it', async () => {
    const content = [
      `ATLASSIAN=${ATLASSIAN_TOKEN}`,
      `GITHUB=${GITHUB_PAT}`,
      `AWS=${CLOUD_ACCESS_KEY}`,
      PEM_HEADER,
    ].join('\n');
    const result = await deny(write('notes.md', content), 'four credentials at once');

    for (const value of [ATLASSIAN_TOKEN, GITHUB_PAT, CLOUD_ACCESS_KEY, PEM_HEADER])
      expect(result.stderr).not.toContain(value);
    // and not a distinctive fragment either, so a "truncated for safety"
    // implementation does not pass this by printing the first half
    for (const value of [ATLASSIAN_TOKEN, GITHUB_PAT, CLOUD_ACCESS_KEY, PEM_HEADER])
      expect(result.stderr).not.toContain(value.slice(0, 12));
  });
});

// 🔴 A payload the normalizer cannot READ is not a payload it may DROP. For an
// `apply_patch` whose `command` is neither a string nor an array of strings,
// `editFragments` returned no fragments at all — and a hook handed no fragments
// finds nothing to refuse, so the credential inside the shape it could not parse
// was written. The over-length branch ten lines above it in the same file already
// answers this situation the other way: a fragment carrying `inspectionRefusal`
// and `appliesToAll`, which every consumer fails closed on.
//
// This is not the fail-open case of `.claude/rules/invariants.md`. That rule is
// about the guard THROWING — an error it cannot reason about. This is a condition
// the guard detected, named in its own diagnostic, and then declined to act on.
describe('guard-secret-file: an apply_patch command it cannot read is refused, not dropped', () => {
  const patchLines = (addition: string) => [
    '*** Begin Patch',
    '*** Add File: notes.md',
    `+${addition}`,
    '*** End Patch',
  ];
  const credentialLine = `AWS_KEY=${CLOUD_ACCESS_KEY}`;
  const withCommand = (command: unknown) => ({
    hook_event_name: 'PreToolUse',
    tool_name: 'apply_patch',
    tool_input: { command },
  });

  it('blocks a credential in a command given as one string', async () => {
    await deny(withCommand(patchLines(credentialLine).join('\n')), 'string command');
  });

  it('blocks a credential in a command given as an array of strings', async () => {
    await deny(withCommand(patchLines(credentialLine)), 'array-of-strings command');
  });

  it('refuses a command array holding a non-string element rather than inspecting nothing', async () => {
    const result = await deny(
      withCommand([
        '*** Begin Patch',
        '*** Add File: notes.md',
        42,
        `+${credentialLine}`,
        '*** End Patch',
      ]),
      'array with one non-string element',
    );
    expect(result.stderr).toMatch(/cannot safely inspect/i);
  });

  it('refuses a command given as an object rather than inspecting nothing', async () => {
    const result = await deny(
      withCommand({ patch: patchLines(credentialLine).join('\n') }),
      'object command',
    );
    expect(result.stderr).toMatch(/cannot safely inspect/i);
  });

  it('names the unreadable command shape as its reason, and still prints no credential', async () => {
    const result = await deny(
      withCommand({ patch: patchLines(credentialLine).join('\n') }),
      'object command',
    );
    expect(result.stderr).toMatch(/shape|form/i);
    // A size refusal and a credential finding are different diagnoses; borrowing
    // either one sends the reader to fix something that is not wrong.
    expect(result.stderr).not.toMatch(/is a credential file/);
    expect(result.stderr).not.toContain(CLOUD_ACCESS_KEY);
  });

  it('leaves a well-formed patch that carries no credential allowed', async (ctx) => {
    skipUnless(ctx, needsGitRoot(repoRoot).ok, needsGitRoot(repoRoot).reason);
    await allow(
      withCommand(patchLines('export const greet = () => "hello";')),
      'ordinary apply_patch',
    );
  });
});

// RP-479. Codex's real parser (`codex-rs/apply-patch/src/streaming_parser.rs`,
// `process_line`) recognises a section header OUTSIDE an `*** Update File:`
// section (patch start, right after an Add File header or its `+` lines,
// right after a Delete File header) after Rust `str::trim()` — leading AND
// trailing whitespace stripped. Before RP-479 `patchFragments`'s header
// regexes were anchored at column 0 (`^\*\*\* …`), so an indented header such
// as `  *** Add File: .env` matched nothing and the credential-named section
// was never inspected — while Codex still wrote it.
describe('guard-secret-file: an indented apply_patch section header still names the file it targets (RP-479)', () => {
  const credentialLine = `DB_PASSWORD=${CLOUD_ACCESS_KEY}`;

  it('refuses a two-space-indented Add File header naming a credential path', async () => {
    const command = [
      '*** Begin Patch',
      '  *** Add File: .env',
      `+${credentialLine}`,
      '*** End Patch',
    ].join('\n');
    const result = await runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: { command },
    });
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toMatch(/credential file/i);
    expect(result.stderr).toContain('.env');
  });

  // NEL, U+3000 and U+2028 are Rust whitespace; JS `trimStart()` keeps NEL,
  // so these cases pin Rust trim semantics rather than "some whitespace".
  it.each([
    ['a tab', '\t'],
    ['a next-line (NEL, U+0085)', '\u0085'],
    ['an ideographic space (U+3000)', '\u3000'],
    ['a line separator (U+2028)', '\u2028'],
    ['a non-breaking space', ' '],
  ] as const)(
    'refuses an Add File header indented with %s naming a credential path',
    async (_label, indent) => {
      const command = [
        '*** Begin Patch',
        `${indent}*** Add File: .env`,
        `+${credentialLine}`,
        '*** End Patch',
      ].join('\n');
      const result = await runHook({
        hook_event_name: 'PreToolUse',
        tool_name: 'apply_patch',
        tool_input: { command },
      });
      expect(result.code, `indent ${JSON.stringify(indent)}: ${result.stderr}`).toBe(2);
      expect(result.stderr).toMatch(/credential file/i);
      expect(result.stderr).toContain('.env');
    },
  );

  // The credential path sits in a SECOND section, after an ordinary first
  // section whose own header was already at column 0 — proving the bug is
  // not merely "the first header of a patch", but every header the parser
  // decides between while `current` already points somewhere else.
  //
  // The second section's content is ordinary, non-credential-shaped text on
  // purpose: before RP-479 the indented header line was silently ignored
  // while `current` still pointed at the FIRST section, so the following `+`
  // line was appended to src/a.txt's own content. A credential-shaped VALUE
  // there would have been caught by the value scanner, for the wrong file and
  // the wrong reason, so this case could not have failed for this defect.
  it('refuses an indented Add File header for a credential path in a second section, after an ordinary first section', async () => {
    const command = [
      '*** Begin Patch',
      '*** Add File: src/a.txt',
      '+export const ordinary = true;',
      '  *** Add File: .env',
      '+export const alsoOrdinary = true;',
      '*** End Patch',
    ].join('\n');
    const result = await runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: { command },
    });
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toMatch(/credential file/i);
    expect(result.stderr).toContain('.env');
  });
});

// RP-479 control, Codex parity. INSIDE an `*** Update File:` section, Codex's
// parser applies only `trim_end()` before classifying a line — a line
// retaining LEADING whitespace is a context line (the ordinary apply_patch
// hunk convention: a line starting with a single space is unchanged context),
// never a header, however much it resembles one. Getting this backwards —
// treating every indented line as a header — would turn an ordinary context
// line that happens to quote `*** Add File: .env` into a phantom write. This
// must stay allowed both before and after the RP-479 fix.
describe('guard-secret-file: a context line that merely resembles a header stays allowed (RP-479 control, Codex parity)', () => {
  let fixtureRoot = '';

  beforeEach(async () => {
    fixtureRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'rp479-context-')));
    await run('git', ['init', '-q', fixtureRoot]);
    await mkdir(path.join(fixtureRoot, 'src'), { recursive: true });
    await writeFile(path.join(fixtureRoot, 'src', 'a.txt'), 'ordinary content\n');
  });

  afterEach(async () => {
    await removeFixture(fixtureRoot);
  });

  it('allows an Update File hunk whose context line merely quotes an indented Add File header', async () => {
    const command = [
      '*** Begin Patch',
      '*** Update File: src/a.txt',
      '@@',
      ' *** Add File: .env',
      '+export const safe = true;',
      '*** End Patch',
    ].join('\n');
    const result = await runHook(
      { hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command } },
      {},
      fixtureRoot,
    );
    expect(result.code, result.stderr).toBe(0);
  });
});

// RP-463: Codex emits absolute paths in an apply_patch command. A path that
// resolves inside the checkout is not unsafe merely because it is absolute;
// the guard must still apply its credential policy to the resulting
// repository-relative destination. Conversely, no path the hook cannot prove
// is inside that checkout gets a "split the patch" answer: reducing a path
// cannot establish containment, so the useful remedy is to name it relative
// to the repository.
describe('guard-secret-file: apply_patch absolute paths are contained before credential policy (RP-463)', () => {
  const patch = (
    verb: 'Add' | 'Update',
    filePath: string,
    addition = 'export const safe = true;',
  ) => ({
    hook_event_name: 'PreToolUse',
    tool_name: 'apply_patch',
    tool_input: {
      command: `*** Begin Patch\n*** ${verb} File: ${filePath}\n+${addition}\n*** End Patch\n`,
    },
  });

  it.each(['Add', 'Update'] as const)(
    'allows an absolute in-repository %s path with Unicode source text',
    async (verb) => {
      const inRepository = path
        .join(repoRoot, 'src', 'caf\u00e9-\u6771\u4eac.ts')
        .replaceAll(path.sep, '/');
      await allow(patch(verb, inRepository), `${verb} through an absolute in-repository path`);
    },
  );

  it('still refuses an absolute in-repository credential destination by its repository-relative policy', async () => {
    const credentialPath = path
      .join(repoRoot, 'config', 'secrets', 'prod.txt')
      .replaceAll(path.sep, '/');
    const result = await deny(patch('Add', credentialPath), 'absolute credential destination');
    expect(result.stderr).toContain('config/secrets/prod.txt');
    expect(result.stderr).toMatch(/credential file/i);
    expect(result.stderr).not.toMatch(/split/i);
  });

  it.each([
    [path.join(tmpdir(), 'rp463-outside.ts').replaceAll(path.sep, '/'), 'outside absolute path'],
    [
      `${repoRoot.replaceAll('\\', '/')}/src/safe/../outside.ts`,
      'absolute path with even an internally redundant traversal segment',
    ],
    ['C:relative\\outside.ts', 'drive-relative path'],
    ['C:\\', 'drive root'],
    [String.raw`\\server\share\outside.ts`, 'UNC path'],
    [String.raw`\\?\C:\outside.ts`, 'device-namespace path'],
  ])(
    'refuses %s (%s) with a repository-relative remedy, never a split remedy',
    async (filePath, label) => {
      const result = await deny(patch('Add', filePath), label);
      expect(result.stderr).toMatch(/repository.relative|relative.*repository/i);
      expect(result.stderr).not.toMatch(/split/i);
    },
  );

  const deletePatch = (filePath: string) => ({
    hook_event_name: 'PreToolUse',
    tool_name: 'apply_patch',
    tool_input: { command: `*** Begin Patch\n*** Delete File: ${filePath}\n*** End Patch\n` },
  });

  it('allows an attended Delete of an absolute ordinary path proved inside this repository', async () => {
    const ordinaryPath = path.join(repoRoot, 'src', 'ordinary.ts').replaceAll(path.sep, '/');
    await allow(deletePatch(ordinaryPath), 'safe absolute removal');
  });

  it('keeps an attended Delete of an in-repository credential path allowed because it writes no secret', async () => {
    const credentialPath = path
      .join(repoRoot, 'config', 'secrets', 'prod.txt')
      .replaceAll(path.sep, '/');
    await allow(deletePatch(credentialPath), 'credential removal is not a credential write');
  });

  it.each([
    [
      path.join(tmpdir(), 'rp463-delete-outside.ts').replaceAll(path.sep, '/'),
      'outside absolute path',
    ],
    [
      `${repoRoot.replaceAll('\\', '/')}/src/safe/../delete-outside.ts`,
      'absolute path with a redundant traversal segment',
    ],
    [String.raw`\\server\share\delete-outside.ts`, 'ambiguous UNC path'],
  ])('refuses an attended Delete of %s (%s)', async (filePath, label) => {
    await deny(deletePatch(filePath), label);
  });

  it('refuses an attended Delete through an absolute symlink or junction escape', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'rp463-delete-root-')));
    const outside = await realpath(await mkdtemp(path.join(tmpdir(), 'rp463-delete-outside-')));
    try {
      await run('git', ['init', '-q', root]);
      await mkdir(path.join(root, 'src'), { recursive: true });
      await symlink(
        outside,
        path.join(root, 'src', 'escape'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const escapedPath = path.join(root, 'src', 'escape', 'delete.ts').replaceAll(path.sep, '/');
      const result = await runHook({ ...deletePatch(escapedPath), cwd: root });
      expect(result.code, result.stderr).toBe(2);
    } finally {
      await removeFixture(root);
      await removeFixture(outside);
    }
  });

  it('refuses an attended Move whose absolute source is outside the repository even when its destination is safe', async () => {
    const outside = path.join(tmpdir(), 'rp463-move-outside.ts').replaceAll(path.sep, '/');
    const destination = path.join(repoRoot, 'src', 'moved.ts').replaceAll(path.sep, '/');
    const result = await runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: {
        command: `*** Begin Patch\n*** Update File: ${outside}\n*** Move to: ${destination}\n@@\n+export const moved = true;\n*** End Patch\n`,
      },
    });
    expect(result.code, result.stderr).toBe(2);
  });

  it('refuses an absolute path in the distinct NTFS sibling whose Unicode casing path.relative folds', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const parent = await realpath(await mkdtemp(path.join(tmpdir(), 'rp463-unicode-parent-')));
    const repositoryLexical = path.join(parent, 'repo\u0130');
    const outsideLexical = path.join(parent, 'repoi\u0307');
    try {
      await mkdir(repositoryLexical);
      await mkdir(outsideLexical);
      const repository = realpathSync.native(repositoryLexical);
      const outside = realpathSync.native(outsideLexical);
      expect(repository).not.toBe(outside);
      await run('git', ['init', '-q', repository]);

      const hookEnv = { CLAUDE_PROJECT_DIR: repository };
      const relativeControl = await runHook(
        patch('Add', 'src/relative-control.ts'),
        hookEnv,
        repository,
      );
      expect(relativeControl.code, relativeControl.stderr).toBe(0);
      const absoluteControl = await runHook(
        patch('Add', path.join(repository, 'src', 'absolute-control.ts')),
        hookEnv,
        repository,
      );
      expect(absoluteControl.code, absoluteControl.stderr).toBe(0);

      const result = await runHook(
        patch('Add', path.join(outside, 'payload.ts')),
        hookEnv,
        repository,
      );
      expect(result.code, result.stderr).toBe(2);
      expect(result.stderr).toMatch(/repository.relative|relative.*repository/i);
    } finally {
      await removeFixture(parent);
    }
  });

  // `filename::$DATA` names the existing file's unnamed default NTFS stream.
  // This is deliberately confined to the spelling reproduced by the direct
  // Windows guard probe. A named alternate stream needs its own measured
  // premise: it is not the same alias and must not be smuggled into this test.
  const denyWindowsDefaultStream = async (
    ctx: Parameters<typeof skipUnless>[0],
    absolute: boolean,
  ) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const fixture = realpathSync.native(await mkdtemp(path.join(tmpdir(), 'rp463-ads-root-')));
    try {
      await run('git', ['init', '-q', fixture]);
      const hookEnv = { CLAUDE_PROJECT_DIR: fixture };
      const relativeControl = await runHook(patch('Add', 'notes-relative.ts'), hookEnv, fixture);
      expect(relativeControl.code, relativeControl.stderr).toBe(0);
      const absoluteControl = await runHook(
        patch('Add', path.join(fixture, 'notes-absolute.ts')),
        hookEnv,
        fixture,
      );
      expect(absoluteControl.code, absoluteControl.stderr).toBe(0);
      const credentialControl = await runHook(
        patch('Add', path.join(fixture, '.env')),
        hookEnv,
        fixture,
      );
      expect(credentialControl.code, credentialControl.stderr).toBe(2);

      const streamPath = absolute ? path.join(fixture, '.env::$DATA') : '.env::$DATA';
      const expectedPath = absolute ? `${fixture}${path.sep}.env::$DATA` : '.env::$DATA';
      expect(streamPath).toBe(expectedPath);
      const result = await runHook(patch('Add', streamPath), hookEnv, fixture);
      expect(result.code, result.stderr).toBe(2);
      expect(
        result.stderr.trim(),
        'a denial must explain how the stream spelling is unsafe',
      ).not.toBe('');
    } finally {
      await removeFixture(fixture);
    }
  };

  it('refuses a Windows relative apply_patch spelling of the .env default data stream', async (ctx) => {
    await denyWindowsDefaultStream(ctx, false);
  });

  it('refuses a Windows absolute apply_patch spelling of the .env default data stream', async (ctx) => {
    await denyWindowsDefaultStream(ctx, true);
  });

  const allowPosixColonPath = async (
    ctx: Parameters<typeof skipUnless>[0],
    filePath: (fixture: string) => string,
  ) => {
    skipUnless(
      ctx,
      process.platform !== 'win32',
      'Windows reserves colon for stream and drive syntax',
    );
    const fixture = realpathSync.native(
      await mkdtemp(path.join(tmpdir(), 'rp463-posix-colon-root-')),
    );
    try {
      await run('git', ['init', '-q', fixture]);
      const hookEnv = { CLAUDE_PROJECT_DIR: fixture };
      const result = await runHook(patch('Add', filePath(fixture)), hookEnv, fixture);
      expect(result.code, result.stderr).toBe(0);
    } finally {
      await removeFixture(fixture);
    }
  };

  it('keeps a POSIX relative colon filename writable', async (ctx) => {
    await allowPosixColonPath(ctx, () => 'notes:metadata.txt');
  });

  it('keeps a POSIX contained absolute colon filename writable', async (ctx) => {
    await allowPosixColonPath(ctx, (fixture) => path.join(fixture, 'notes:metadata.txt'));
  });
});

// RP-478: trailing header whitespace must not hide an in-repository credential
// target from the credential-file rule.
describe('guard-secret-file: absolute apply_patch headers cannot hide credential filenames with trailing whitespace (RP-478)', () => {
  const modes = [
    ['attended', { RIG_UNATTENDED: '0' }],
    ['unattended', { RIG_UNATTENDED: '1' }],
  ] as const;
  const headerWhitespace = [
    ['space', ' '],
    ['tab', '\t'],
    ['non-breaking space', '\u00a0'],
    ['line separator', '\u2028'],
    ['paragraph separator', '\u2029'],
  ] as const;
  // Rust `char::is_whitespace()` as used by Codex 0.161's patch parser. NEL
  // stays conservatively denied below with its existing reason assertion.
  const rustTrailingWhitespace = [
    ['tab', '\u0009'],
    ['line feed', '\u000a'],
    ['vertical tab', '\u000b'],
    ['form feed', '\u000c'],
    ['carriage return', '\u000d'],
    ['space', '\u0020'],
    ['NEL', '\u0085'],
    ['non-breaking space', '\u00a0'],
    ['Ogham space mark', '\u1680'],
    ['en quad', '\u2000'],
    ['em quad', '\u2001'],
    ['en space', '\u2002'],
    ['em space', '\u2003'],
    ['three-per-em space', '\u2004'],
    ['four-per-em space', '\u2005'],
    ['six-per-em space', '\u2006'],
    ['figure space', '\u2007'],
    ['punctuation space', '\u2008'],
    ['thin space', '\u2009'],
    ['hair space', '\u200a'],
    ['line separator', '\u2028'],
    ['paragraph separator', '\u2029'],
    ['narrow non-breaking space', '\u202f'],
    ['medium mathematical space', '\u205f'],
    ['ideographic space', '\u3000'],
  ] as const;
  const credentialPath = path.join(repoRoot, '.env').replaceAll(path.sep, '/');
  const ordinaryPath = path
    .join(repoRoot, 'src', 'ordinary file-\u6771\u4eac.ts')
    .replaceAll(path.sep, '/');
  const existingMoveSource = path.join(repoRoot, 'package.json').replaceAll(path.sep, '/');

  const patch = (verb: 'Add' | 'Update', filePath: string) => ({
    hook_event_name: 'PreToolUse',
    tool_name: 'apply_patch',
    tool_input: {
      command: `*** Begin Patch\n*** ${verb} File: ${filePath}\n+export const safe = true;\n*** End Patch\n`,
    },
  });

  const move = (source: string, destination: string) => ({
    hook_event_name: 'PreToolUse',
    tool_name: 'apply_patch',
    tool_input: {
      command: `*** Begin Patch\n*** Update File: ${source}\n*** Move to: ${destination}\n@@\n+export const moved = true;\n*** End Patch\n`,
    },
  });

  it.each(modes)(
    'allows an absolute ordinary Unicode filename with an internal space in %s mode',
    async (_mode, env) => {
      const result = await runHook(patch('Add', ordinaryPath), env);
      expect(result.code, result.stderr).toBe(0);
    },
  );

  it.each(
    modes.flatMap(([mode, env]) =>
      headerWhitespace.flatMap(([label, suffix]) =>
        (['Add', 'Update'] as const).map((verb) => [verb, label, mode, env, suffix] as const),
      ),
    ),
  )(
    'refuses an absolute %s header whose credential filename ends with %s in %s mode',
    async (verb, label, mode, env, suffix) => {
      const result = await runHook(patch(verb, `${credentialPath}${suffix}`), env);
      expect(result.code, `${verb}, ${label}, ${mode}: ${result.stderr}`).toBe(2);
      expect(result.stderr).toMatch(/credential file/i);
    },
  );

  it.each(
    modes.flatMap(([mode, env]) =>
      headerWhitespace.map(([label, suffix]) => [label, mode, env, suffix] as const),
    ),
  )(
    'refuses a Move destination whose absolute credential filename ends with %s in %s mode',
    async (label, mode, env, suffix) => {
      const result = await runHook(move(existingMoveSource, `${credentialPath}${suffix}`), env);
      expect(result.code, `Move destination, ${label}, ${mode}: ${result.stderr}`).toBe(2);
      expect(result.stderr).toMatch(/credential file/i);
    },
  );

  it.each(rustTrailingWhitespace)(
    'does not allow an absolute credential Add header ending with Rust whitespace %s',
    async (_label, suffix) => {
      const result = await runHook(patch('Add', `${credentialPath}${suffix}`));
      expect(result.code, `Rust whitespace ${JSON.stringify(suffix)}: ${result.stderr}`).toBe(2);
    },
  );

  it.each(modes)(
    'refuses a Move source with an uninspectable absolute NEL header in %s mode',
    async (mode, env) => {
      const result = await runHook(move(`${existingMoveSource}\u0085`, ordinaryPath), env);
      expect(result.code, `Move source, NEL, ${mode}: ${result.stderr}`).toBe(2);
      expect(result.stderr).toMatch(/cannot safely inspect/i);
    },
  );

  it.each(modes)(
    'refuses an Add destination with an uninspectable absolute NEL header in %s mode',
    async (mode, env) => {
      const result = await runHook(patch('Add', `${credentialPath}\u0085`), env);
      expect(result.code, `Add destination, NEL, ${mode}: ${result.stderr}`).toBe(2);
      expect(result.stderr).toMatch(/cannot safely inspect/i);
    },
  );

  it.each(modes)(
    'refuses an Update destination with an uninspectable absolute NEL header in %s mode',
    async (mode, env) => {
      const result = await runHook(patch('Update', `${credentialPath}\u0085`), env);
      expect(result.code, `Update destination, NEL, ${mode}: ${result.stderr}`).toBe(2);
      expect(result.stderr).toMatch(/cannot safely inspect/i);
    },
  );

  it.each(modes)(
    'refuses a Move destination with an uninspectable absolute NEL header in %s mode',
    async (mode, env) => {
      const result = await runHook(move(existingMoveSource, `${credentialPath}\u0085`), env);
      expect(result.code, `Move destination, NEL, ${mode}: ${result.stderr}`).toBe(2);
      expect(result.stderr).toMatch(/cannot safely inspect/i);
    },
  );

  it.each(
    modes.flatMap(
      ([mode, env]) =>
        [
          [
            'id_rsa with space',
            mode,
            env,
            path.join(repoRoot, 'keys', 'id_rsa'),
            ' ',
            'credential file',
          ],
          [
            'cert.pem with NBSP',
            mode,
            env,
            path.join(repoRoot, 'keys', 'cert.pem'),
            '\u00a0',
            'credential file',
          ],
          [
            'cert.pem with NEL',
            mode,
            env,
            path.join(repoRoot, 'keys', 'cert.pem'),
            '\u0085',
            'cannot safely inspect',
          ],
        ] as const,
    ),
  )(
    'refuses %s in %s mode',
    async (label, mode, env, credentialNamedPath, suffix, expectedReason) => {
      const filePath = credentialNamedPath.replaceAll(path.sep, '/') + suffix;
      const result = await runHook(patch('Add', filePath), env);
      expect(result.code, `${label}, ${mode}: ${result.stderr}`).toBe(2);
      expect(result.stderr).toMatch(new RegExp(expectedReason, 'i'));
    },
  );
});

// U+FEFF is deliberately separate from the ordinary header whitespace above:
// the patch parser retains it in a pathname, while JavaScript `trim()` does not.
// Treating it as formatting would resolve a different entry from the one the
// patch writes, which can hide a symlink escape.
describe('guard-secret-file: absolute apply_patch headers retain BOM path characters (RP-478)', () => {
  const modes = [
    ['attended', { RIG_UNATTENDED: '0' }],
    ['unattended', { RIG_UNATTENDED: '1' }],
  ] as const;
  let fixtureRoot = '';
  let outsideRoot = '';
  let bomLink = '';
  let ordinaryBomFile = '';
  let outsideFile = '';

  const patch = (verb: 'Add' | 'Update', filePath: string) => ({
    hook_event_name: 'PreToolUse',
    tool_name: 'apply_patch',
    tool_input: {
      command: `*** Begin Patch\n*** ${verb} File: ${filePath}\n+export const safe = true;\n*** End Patch\n`,
    },
  });

  const move = (source: string, destination: string) => ({
    hook_event_name: 'PreToolUse',
    tool_name: 'apply_patch',
    tool_input: {
      command: `*** Begin Patch\n*** Update File: ${source}\n*** Move to: ${destination}\n@@\n+export const moved = true;\n*** End Patch\n`,
    },
  });

  beforeEach(async () => {
    fixtureRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'rp478-bom-root-')));
    outsideRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'rp478-bom-outside-')));
    outsideFile = path.join(outsideRoot, 'harmless.ts');
    bomLink = path.join(fixtureRoot, 'escape\ufeff');
    ordinaryBomFile = path.join(fixtureRoot, 'harmless\ufeff');
    await run('git', ['init', '-q', fixtureRoot]);
    await writeFile(path.join(fixtureRoot, 'source.ts'), 'export const source = true;\n');
    await writeFile(outsideFile, 'export const harmless = true;\n');
    await writeFile(ordinaryBomFile, 'export const ordinaryBom = true;\n');
    await symlink(outsideFile, bomLink, 'file');
    await symlink(outsideFile, path.join(fixtureRoot, 'harmless'), 'file');
    expect(await realpath(bomLink)).toBe(await realpath(outsideFile));
  });

  afterEach(async () => {
    await removeFixture(fixtureRoot);
    await removeFixture(outsideRoot);
  });

  it.each(modes)(
    'allows a lexical in-repository absolute control without a BOM in %s mode',
    async (_mode, env) => {
      const control = path.join(fixtureRoot, 'ordinary-control.ts');
      const result = await runHook(
        patch('Add', control),
        { ...env, CLAUDE_PROJECT_DIR: fixtureRoot },
        fixtureRoot,
      );
      expect(result.code, result.stderr).toBe(0);
    },
  );

  it.each(modes)(
    'allows an ordinary in-repository filename containing a retained BOM in %s mode',
    async (_mode, env) => {
      const result = await runHook(
        patch('Add', ordinaryBomFile),
        { ...env, CLAUDE_PROJECT_DIR: fixtureRoot },
        fixtureRoot,
      );
      expect(result.code, result.stderr).toBe(0);
    },
  );

  it.each(
    modes.flatMap(([mode, env]) =>
      (['Add', 'Update'] as const).map((verb) => [verb, mode, env] as const),
    ),
  )(
    'refuses an absolute BOM-suffixed symlink escape through %s in %s mode',
    async (verb, mode, env) => {
      const result = await runHook(
        patch(verb, bomLink),
        { ...env, CLAUDE_PROJECT_DIR: fixtureRoot },
        fixtureRoot,
      );
      expect(result.code, `${verb}, ${mode}: ${result.stderr}`).toBe(2);
      expect(result.stderr).toMatch(/cannot safely inspect/i);
    },
  );

  it.each(modes)(
    'refuses an absolute BOM-suffixed symlink escape as a Move destination in %s mode',
    async (mode, env) => {
      const source = path.join(fixtureRoot, 'source.ts');
      const result = await runHook(
        move(source, bomLink),
        { ...env, CLAUDE_PROJECT_DIR: fixtureRoot },
        fixtureRoot,
      );
      expect(result.code, `Move destination, ${mode}: ${result.stderr}`).toBe(2);
      expect(result.stderr).toMatch(/cannot safely inspect/i);
    },
  );

  it.each(modes)(
    'refuses an absolute BOM-suffixed symlink escape as a Move source in %s mode',
    async (mode, env) => {
      const destination = path.join(fixtureRoot, 'ordinary-control.ts');
      const result = await runHook(
        move(bomLink, destination),
        { ...env, CLAUDE_PROJECT_DIR: fixtureRoot },
        fixtureRoot,
      );
      expect(result.code, `Move source, ${mode}: ${result.stderr}`).toBe(2);
      expect(result.stderr).toMatch(/cannot safely inspect/i);
    },
  );

  it.each(modes)(
    'refuses an absolute-looking Add header with a literal leading space in %s mode',
    async (mode, env) => {
      const control = path.join(fixtureRoot, 'ordinary-control.ts');
      const result = await runHook(
        patch('Add', ` ${control}`),
        { ...env, CLAUDE_PROJECT_DIR: fixtureRoot },
        fixtureRoot,
      );
      expect(result.code, `leading space, ${mode}: ${result.stderr}`).toBe(2);
      expect(result.stderr).toMatch(/cannot safely inspect/i);
    },
  );
});

describe('guard-secret-file: the ordinary work of the day stays allowed', () => {
  it('allows a Write to .env.example, which is how a project states what it needs', async () => {
    await allow(write('.env.example', `JIRA_API_TOKEN=${'your-token-here'}\n`), '.env.example');
  });

  it.each(['packages/core/src/auth.ts', 'packages/core/src/session.ts', 'src/tokenizer.ts'])(
    'allows a Write to %s, a security-ish name that is ordinary source',
    async (filePath) => {
      await allow(
        write(filePath, 'export const parse = (input: string) => input.trim();\n'),
        filePath,
      );
    },
  );

  it('allows a Write to test/template/secrets-lib.test.ts — the word is in the basename, not a directory', async () => {
    await allow(
      write('test/template/secrets-lib.test.ts', "describe('the vocabulary', () => {});\n"),
      'secrets in a basename',
    );
  });

  it.each([
    ['Read', { file_path: 'jira.env' }],
    ['Bash', { command: `echo ${CLOUD_ACCESS_KEY} >> notes.md` }],
    ['Grep', { pattern: GITHUB_PAT, path: '.' }],
  ])(
    'allows a %s call carrying the same credential payload — the matcher is edit-only',
    async (toolName, toolInput) => {
      await allow(
        { hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput },
        `${toolName} is not this hook's business`,
      );
    },
  );
});

// `.claude/rules/invariants.md`: "Fail closed on a match, fail open on an
// error." Every case below is a payload the hook did not expect, and every one
// of them must resolve to allow — a crashed guard that blocks everything gets
// deleted within the hour, which costs all the rules at once, not just this one.
describe('guard-secret-file: it fails open on anything it does not understand', () => {
  it('allows a payload that is not JSON at all', async () => {
    await allow('{not json', 'unparseable stdin');
  });

  it('allows a payload with no tool_input at all', async () => {
    await allow({ hook_event_name: 'PreToolUse', tool_name: 'Write' }, 'no tool_input');
  });

  // 🔴 A payload the hook cannot locate is a payload it does not understand —
  // it allows rather than guessing, credential-looking content notwithstanding.
  it('allows a Write whose file_path is missing', async () => {
    await allow(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { content: `KEY=${CLOUD_ACCESS_KEY}\n` },
      },
      'missing file_path',
    );
  });

  it('allows a Write whose file_path is empty', async () => {
    await allow(write('', `KEY=${CLOUD_ACCESS_KEY}\n`), 'empty file_path');
  });

  // Bounded work is the other half of failing open: any input that can make the
  // guard hang is a total bypass of every rule it enforces.
  it('returns promptly on a very large harmless write', async () => {
    // In-child measurement (RP-158): bound the GUARD's own work, not the
    // parent's wall clock around spawning it. See child-timing.test.ts.
    const payload = write(
      'notes.md',
      'ordinary prose about tokens and passwords\n'.repeat(120_000),
    );
    const result = await runNodeTimed(hook, { input: JSON.stringify(payload) });
    expect(
      result.code,
      `should ALLOW: five megabytes of harmless text\nstderr: ${result.stderr}`,
    ).toBe(0);
    expect(result.elapsedMs).toBeLessThan(10_000);
  });
});

// A hook nobody calls is decoration, and a hook installed without the module it
// imports is worse — it throws on a missing import at every single edit.
describe('guard-secret-file: the wiring that makes it run at all', () => {
  it('names every covered edit tool in autonomy.md’s mechanical refusal sentence', async () => {
    const autonomy = await readFile(
      path.join(universal, '.claude', 'rules', 'autonomy.md'),
      'utf8',
    );
    const mechanicalSentence = autonomy.match(/\*\*mechanical\*\*:\s*([\s\S]*?)\.\s*⚠/)?.[1] ?? '';

    expect(mechanicalSentence).toContain('`Write`');
    expect(mechanicalSentence).toContain('`Edit`');
    expect(mechanicalSentence).toContain('`MultiEdit`');
    expect(mechanicalSentence).toContain('`NotebookEdit`');
    expect(mechanicalSentence).toContain('`apply_patch`');
  });

  it('is registered in settings.json under a PreToolUse matcher covering every edit surface', async () => {
    const settings = JSON.parse(
      await readFile(path.join(universal, '.claude', 'settings.json'), 'utf8'),
    ) as { hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> } };

    const groups = settings.hooks.PreToolUse.filter((group) =>
      group.hooks.some((entry) => entry.command.includes('guard-secret-file.mjs')),
    );
    expect(groups, 'no PreToolUse entry runs guard-secret-file.mjs').toHaveLength(1);

    const matcher = groups[0]?.matcher ?? '';
    const tools = matcher.split('|').map((part) => part.trim());
    expect(tools).toContain('Write');
    expect(tools).toContain('Edit');
    expect(tools).toContain('MultiEdit');
    expect(tools).toContain('NotebookEdit');
    expect(tools).toContain('apply_patch');
  });

  it('is classified in layers.json together with the module it imports', async () => {
    const layers = JSON.parse(
      await readFile(path.join(universal, 'layers.json'), 'utf8'),
    ) as Record<string, string[]>;
    // `.claude/scripts/lib/verdict.mjs` is the precedent: a shared module rides
    // in the same layer as the thing that imports it, or `init` installs a hook
    // whose first line is an unresolvable import.
    expect(layers.process).toContain('.claude/hooks/guard-secret-file.mjs');
    expect(layers.process).toContain('.claude/scripts/lib/secrets.mjs');
  });

  it('registers apply_patch and consumes the shared edit normalizer', async () => {
    const settings = JSON.parse(
      await readFile(path.join(universal, '.claude', 'settings.json'), 'utf8'),
    ) as { hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> } };
    const group = settings.hooks.PreToolUse.find((candidate) =>
      candidate.hooks.some((entry) => entry.command.includes('guard-secret-file.mjs')),
    );
    expect(group?.matcher.split('|').map((part) => part.trim())).toContain('apply_patch');

    const source = await readFile(hook, 'utf8');
    expect(source).toMatch(/from ['"]\.\/lib\/edit-input\.mjs['"]/);
    expect(source).toMatch(/editFragments\(input\)/);
  });
});

// `.claude/rules/invariants.md`, "State the limits — and test them": a limits
// comment is the guard's own claim about how far it can be trusted, and nothing
// checks prose, so it drifts — into overstatement, which is the direction that
// gets someone hurt. The hook's header names five limits. These are them.
describe('guard-secret-file: the limits it states, asserted rather than asserted-in-prose', () => {
  it('keeps every named test pointer literally greppable in its referenced test file', async () => {
    const source = await readFile(hook, 'utf8');
    const prose = source
      .split('\n')
      .map((line) => line.replace(/^\s*\/\/ ?/, ''))
      .join('\n');
    const pointers = [
      ...prose.matchAll(/\b(?:see|by)\s+([a-z0-9-]+\.test\.ts)[\s\S]*?›\s*"([^"]+)"/gi),
    ].map(([, file, name]) => ({ file: file!, name: name!.replace(/\s+/g, ' ').trim() }));
    expect(pointers.length, 'the hook names no upstream test pointers').toBeGreaterThan(0);

    const missing: string[] = [];
    for (const { file, name } of pointers) {
      const testSource = await readFile(path.join(repoRoot, 'test', 'template', file), 'utf8');
      if (!testSource.includes(name)) missing.push(`${file} › ${name}`);
    }
    expect(missing, 'test pointers must be literal source substrings').toEqual([]);
  });

  it('does not see a credential split across two edits, because it is shown one fragment at a time', async () => {
    // The halves are innocuous apart and a credential together. Each edit is
    // allowed — not because the guard judged them safe, but because it never
    // sees the file the two of them build. This is the limit every PreToolUse
    // guard in this directory shares, and the layer that covers it is
    // `validate-no-secrets.mjs --staged`, which reads the assembled file.
    const half = CLOUD_ACCESS_KEY.slice(0, 10);
    const rest = CLOUD_ACCESS_KEY.slice(10);
    await allow(edit('src/config.ts', `const a = '${half}';`), 'the first half alone');
    await allow(edit('src/config.ts', `const b = '${rest}';`), 'the second half alone');

    // and the assembled text IS refused, so the two assertions above are a
    // statement about the guard's reach rather than about a weak pattern
    await deny(edit('src/config.ts', `const key = '${half}${rest}';`), 'the two halves together');
  });

  it('states its limits in its own source, where the next reader looks for them', async () => {
    // The comment is load-bearing: a guard whose reach is undocumented gets
    // trusted for cover it does not give. Asserted so deleting the block is a
    // red test rather than a silent loss.
    const source = await readFile(hook, 'utf8');
    expect(source).toMatch(/LIMITS/);
    expect(source).toMatch(/fragment/i);
    expect(source).toMatch(/FAILS OPEN/i);
  });

  it('separates the shapes it refuses from the payloads it still fails open on', async () => {
    const source = await readFile(hook, 'utf8');
    expect(source).toMatch(/There are FIVE:/);

    const limitsBlock = source.match(/There are FIVE:[\s\S]*?(?=\n\/\/ Failing open)/)?.[0] ?? '';
    expect([...limitsBlock.matchAll(/^\/\/ {3}-/gm)]).toHaveLength(5);
    const fragmentCap =
      limitsBlock.split(/^\/\/ {3}-/m).find((entry) => /MultiEdit|256/.test(entry)) ?? '';
    expect(fragmentCap).toMatch(/MultiEdit/i);
    expect(fragmentCap).toMatch(/256/);
    expect(fragmentCap).toMatch(/refus/i);
    expect(fragmentCap).toMatch(/guard-secret-file\.test\.ts/);
    expect(fragmentCap).toMatch(/beyond the fragment cap/i);

    const failOpenLimit =
      source.match(/\/\/ {3}- It FAILS OPEN[\s\S]*?(?=\n\/\/\n\/\/ Failing open)/)?.[0] ?? '';
    // The limit must say REFUSES for a present-but-unreadable command shape —
    // this assertion used to require the opposite, and kept a false claim green
    // after the behaviour was reversed.
    expect(failOpenLimit).toMatch(/refuse/i);
    expect(failOpenLimit).toMatch(/shape/i);
    // and the pointer it carries has to name a test that exists
    expect(failOpenLimit).toMatch(/refuses, rather than failing open/);
  });

  // RP-97, and `.claude/rules/invariants.md`, "One mechanism, one implementation
  // — and one spelling of a fact". The count above is a mechanical fact about the
  // guard, and the guard's header is where it is written. Every prose copy of it
  // is a second writing that nothing keeps in step: `51402e99` raised the header
  // from FOUR to FIVE, the rule and the README kept saying `four`, and the
  // mismatch shipped in 0.6.1, 0.6.2, 0.7.0 and 0.7.1 — a security rule
  // describing its own mechanism wrongly for four releases.
  //
  // So the fix is not `four` → `five`, which would only reset the same clock.
  // The prose points at the header and states no number, and this test is what
  // makes putting the number back observable.
  //
  // ⚠ The two checks below have DIFFERENT surface sets, and that is why they
  // are two tests rather than one. Every live rulebook document that names the
  // guard must state no count; only the three that discuss its limits carry the
  // pointer. One test asserting both scopes would have to name the wider one,
  // and would then claim more than half of it checks — which is the exact
  // overstatement this describe block exists to prevent.
  //
  // 🔴 The surface list is DISCOVERED, not written down. A hand-maintained list
  // of documents is the same defect as a hand-maintained copy of the count, one
  // level up: it goes stale silently, and the file that was added after it was
  // written is the one nobody checks. Two review rounds found exactly that —
  // a three-file list under a name that spoke for the whole rulebook.
  //
  // Historical records are excluded, and for one stated reason: they record what
  // was true when written. `CHANGELOG.md` writes `four` under `## 0.6.0`, and at
  // that release the header really did read FOUR — correcting it would falsify a
  // true record rather than fix a stale copy. The journal and the archived
  // reviews are the same kind of writing. This file's own describe block above
  // writes the count too, next to the assertion that pins it, which is the one
  // place a count belongs outside the guard.
  const HISTORICAL = /^(?:CHANGELOG\.md$|journal\/|docs\/reviews\/)/;

  // 🔴 TRACKED files, not a directory walk. A walk also reads what git ignores —
  // `.claude/runs/<id>/*.md`, the gate reports a previous run left on disk — so
  // the check would depend on local detritus: green in CI, red or green locally
  // depending on what an earlier session happened to write. The rulebook is what
  // is committed.
  const rulebookMarkdown = async () =>
    (await run('git', ['ls-files', '-z', '*.md'], { cwd: repoRoot })).stdout
      .split('\0')
      .filter((file) => file !== '' && !HISTORICAL.test(file));

  // Bullets and paragraphs, so "blind spot" used generically elsewhere in a
  // document is not this test's business — only the prose about this guard is.
  const guardProse = (text: string) =>
    text.split(/\n(?=\s*[-*]\s)|\n\s*\n/).filter((block) => block.includes('guard-secret-file'));

  const describingSurfaces = async () => {
    const surfaces: Array<{ file: string; blocks: string[] }> = [];
    for (const file of await rulebookMarkdown()) {
      const blocks = guardProse(await readFile(path.join(repoRoot, file), 'utf8'));
      if (blocks.length > 0) surfaces.push({ file, blocks });
    }
    return surfaces;
  };

  it('no live rulebook document restates the guard’s limit count', async (ctx) => {
    // The surface set comes from `git ls-files`, so without a repository this
    // would pass having read nothing — named as a skip rather than counted green.
    skipUnless(ctx, needsGitRoot(repoRoot).ok, needsGitRoot(repoRoot).reason);
    // "four blind spots", "5 limits" — a number attached to this guard's reach.
    //
    // 🔴 Cardinals only. The ordinals that were briefly here are gone because
    // the repository writes ordinal POINTERS into a header's numbered list on
    // purpose — the form `invariants.md` asks for, and the opposite of a copied
    // count. `invariants.md`, "Match a rule's precision to the cost of a false
    // positive": a guard that fires on the idiom the rulebook recommends is one
    // an editor routes around. That reading came from a repository-wide grep;
    // under this test's own block filter no such pointer is reachable today, so
    // dropping the ordinals cost this test no live coverage.
    //
    // ⚠ What it does NOT catch, measured rather than guessed: an ordinal, a
    // numeral separated from the noun ("four documented limits"), and a count in
    // a block that does not itself name the guard.
    const copiedCardinality =
      /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:blind[-\s]spots?|limits?)\b/i;

    const surfaces = await describingSurfaces();
    // Discovery that silently found nothing would pass every assertion below.
    // RP-186: the rulebook prose describing this guard lives in the composed
    // AGENTS.md now (canonical) — CLAUDE.md is a short shim and carries none
    // of it.
    expect(
      surfaces.map(({ file }) => file),
      'the walk found no rulebook document describing guard-secret-file at all',
    ).toEqual(expect.arrayContaining(['AGENTS.md', 'README.md', '.claude/rules/autonomy.md']));

    const offenders = surfaces.flatMap(({ file, blocks }) =>
      blocks
        .map((block) => copiedCardinality.exec(block)?.[0])
        .filter((copied): copied is string => Boolean(copied))
        .map((copied) => `${file} restates the count: “${copied}”`),
    );
    expect(
      offenders,
      'a live rulebook document must state no count of its own; the guard header states it',
    ).toEqual([]);
  });

  it('the rule and the README still send the reader to the guard’s own header', async () => {
    // Deleting the sentence would satisfy the check above and lose the reader,
    // so the pointer is pinned too. Wording-tolerant on purpose: any rewrite
    // that still sends them to the guard's own source passes.
    //
    // These three are named rather than discovered, because this is a claim
    // about the three documents that DISCUSS the guard's limits. The other
    // rulebook documents mention the guard without describing its reach, and
    // requiring the pointer of them would demand prose they have no reason to
    // carry — measured: appending them turns this assertion red today.
    const carryTheLimits = [
      path.join('templates', 'agent-os', 'universal', '.claude', 'rules', 'autonomy.md'),
      path.join('.claude', 'rules', 'autonomy.md'),
      'README.md',
    ];
    for (const surface of carryTheLimits) {
      const blocks = guardProse(await readFile(path.join(repoRoot, surface), 'utf8'));
      expect(
        blocks.length,
        `${surface} no longer describes guard-secret-file at all`,
      ).toBeGreaterThan(0);
      // Per block, not against the joined text: with one block per surface today
      // the two are identical, but a surface that later gains a second mention
      // would let one block carrying the pointer satisfy the check for a sibling
      // that had dropped it.
      for (const block of blocks) {
        expect(
          block,
          `${surface} must still point the reader at the guard's own header for its limits`,
        ).toMatch(/own header|its header|the hook(?:'s|’s) own (?:header|source)/i);
      }
    }
  });
});

// RP-214 regression pins. The failure-diagnostician's fix for guard-rulebook
// touches the SHARED `edit-input.mjs` normaliser (a Delete File / Move-to
// section that never surfaces the removed/source path). These three cases
// pass TODAY, for unrelated reasons of guard-secret-file's own — it is about
// credential paths and values, not about who may remove a path from the
// rulebook — and must keep passing exactly as they do now once that shared
// normaliser changes.
describe('guard-secret-file: apply_patch removal shapes stay unchanged (RP-214 regression pins)', () => {
  let pinRoot: string;

  beforeEach(async () => {
    pinRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'secret-pin-')));
    await run('git', ['init', '-q', pinRoot]);
  });

  afterEach(async () => {
    await removeFixture(pinRoot);
  });

  it('regression pin: a standalone Delete File of .env is allowed — removing a credential file is not this guard’s business', async () => {
    await writeFile(path.join(pinRoot, '.env'), 'HARMLESS=true\n');
    const result = await runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      cwd: pinRoot,
      tool_input: {
        command: '*** Begin Patch\n*** Delete File: .env\n*** End Patch\n',
      },
    });
    expect(result.code, result.stderr).toBe(0);
  });

  it('regression pin: an Update+Move of an existing harmless .env to src/ok.txt is allowed', async () => {
    await writeFile(path.join(pinRoot, '.env'), 'HARMLESS=true\n');
    const result = await runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      cwd: pinRoot,
      tool_input: {
        command:
          '*** Begin Patch\n*** Update File: .env\n*** Move to: src/ok.txt\n@@\n+// moved\n*** End Patch\n',
      },
    });
    expect(result.code, result.stderr).toBe(0);
  });

  it('regression pin: an Update+Move whose DESTINATION is .env is still refused', async () => {
    await mkdir(path.join(pinRoot, 'src'), { recursive: true });
    await writeFile(path.join(pinRoot, 'src', 'a.txt'), 'ordinary file\n');
    const result = await runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      cwd: pinRoot,
      tool_input: {
        command:
          '*** Begin Patch\n*** Update File: src/a.txt\n*** Move to: .env\n@@\n+// moved\n*** End Patch\n',
      },
    });
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toContain('.env');
  });
});

// RP-244 regression pin. `isCredentialPath` (`.claude/scripts/lib/secrets.mjs`)
// judges the BASENAME of the path `editFragments` reports, split on `/`
// after folding backslashes to slashes — whatever prefix precedes that
// basename. A Win32 verbatim (`\\?\C:\…`) or device-namespace (`\\.\C:\…`)
// spelling still carries the real basename intact even though
// `normalisePath` (`edit-input.mjs`) mangles the prefix ahead of it
// (`/?/C:/…`, `/C:/…`) — unlike `guard-rulebook`, which judges the whole
// path against a rulebook PREFIX and is fooled by exactly that mangling.
// This guard must stay unaffected once `edit-input.mjs` is fixed, and this
// pin runs on every platform because it is a string match against a literal
// payload, not a filesystem resolution.
describe('guard-secret-file: a Win32 verbatim spelling of a credential file is still blocked (RP-244 regression pin)', () => {
  it.each([
    [String.raw`\\?\C:\Users\x\rig\jira.env`, 'verbatim, backslash form'],
    ['//?/C:/Users/x/rig/jira.env', 'verbatim, forward-slash form'],
    [String.raw`\\.\C:\Users\x\rig\jira.env`, 'device namespace, backslash form'],
    // RP-244 round 2: the basename this guard judges survives the round-2
    // bugs too — a doubled separator after the `?`, and any UNC spelling —
    // for the same reason it survived round 1's: `isCredentialPath` only
    // ever looks at the last path segment.
    [String.raw`\\?\\C:\Users\x\rig\jira.env`, 'verbatim, doubled separator after the ?'],
    [String.raw`\\?\UNC\localhost\c$\Users\x\rig\jira.env`, 'verbatim UNC admin share'],
    [String.raw`\\server\share\rig\jira.env`, 'a genuine (non-verbatim) UNC path'],
  ])('blocks a Write to %s (%s)', async (filePath) => {
    await deny(write(filePath, 'anything at all\n'), filePath);
  });
});

describe('guard-secret-file: a checkout is judged by its repo-relative path', () => {
  // A project living under a directory called `secrets` is an ordinary thing —
  // `~/secrets/work/app`. If the guard judged the ABSOLUTE path it would refuse
  // every edit in that checkout, and be uninstalled the same day.
  it.each([
    ['/tmp/secrets/project', 'without a trailing slash'],
    ['/tmp/secrets/project/', 'with a trailing slash'],
  ])('judges the repo-relative path even when the project directory is given %s', async (dir) => {
    const result = await runHook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: {
          file_path: '/tmp/secrets/project/src/index.ts',
          content: 'export const greet = () => "hello";\n',
        },
      },
      { CLAUDE_PROJECT_DIR: dir },
    );
    expect(result.code, `an ordinary edit was refused\n${result.stderr}`).toBe(0);
  });

  it('still refuses a credential directory INSIDE the project, whatever the project is called', async () => {
    const result = await runHook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: {
          file_path: '/tmp/secrets/project/config/secrets/prod.txt',
          content: 'nothing special\n',
        },
      },
      { CLAUDE_PROJECT_DIR: '/tmp/secrets/project/' },
    );
    expect(result.code, result.stderr).toBe(2);
  });
});

// RP-480. Before this fix `patchFragments` collected a Move's hunk lines only
// after an `@@` line, while Codex's `UpdateFile` mode in
// `codex-rs/apply-patch/src/streaming_parser.rs` opens a chunk on the first
// context, added, removed or empty line. A Move with no `@@` therefore wrote
// its `+` line to the destination while the scanned fragment was the unchanged
// source.
describe('guard-secret-file: a Move hunk opens implicitly without `@@`, matching Codex (RP-480)', () => {
  let fixtureRoot = '';

  beforeEach(async () => {
    fixtureRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'rp480-move-root-')));
    await run('git', ['init', '-q', fixtureRoot]);
    await mkdir(path.join(fixtureRoot, 'src'), { recursive: true });
    await writeFile(path.join(fixtureRoot, 'src', 'a.txt'), 'hello\n');
  });

  afterEach(async () => {
    await removeFixture(fixtureRoot);
  });

  const movePatch = (hunkLines: string[]) =>
    [
      '*** Begin Patch',
      '*** Update File: src/a.txt',
      '*** Move to: src/b.txt',
      ...hunkLines,
      '*** End Patch',
    ].join('\n');

  const moveCommand = (hunkLines: string[]) => ({
    hook_event_name: 'PreToolUse',
    tool_name: 'apply_patch',
    tool_input: { command: movePatch(hunkLines) },
  });

  it('refuses a Move credential addition with no `@@` header, for the same reason the `@@` spelling gets', async () => {
    const credentialLine = `+aws_access_key_id = ${CLOUD_ACCESS_KEY}`;

    const withHeader = await runHook(moveCommand(['@@', credentialLine]), {}, fixtureRoot);
    expect(withHeader.code, withHeader.stderr).toBe(2);
    expect(withHeader.stderr).toContain('cloud-access-key');

    const withoutHeader = await runHook(moveCommand([credentialLine]), {}, fixtureRoot);
    expect(withoutHeader.code, withoutHeader.stderr).toBe(2);
    expect(withoutHeader.stderr).toContain('cloud-access-key');
    expect(withoutHeader.stderr).toContain('src/b.txt');
  });

  it('refuses a Move credential addition preceded by a matching context line, with no `@@` header', async () => {
    const credentialLine = `+aws_access_key_id = ${CLOUD_ACCESS_KEY}`;

    const result = await runHook(moveCommand([' hello', credentialLine]), {}, fixtureRoot);

    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toContain('cloud-access-key');
    expect(result.stderr).toContain('src/b.txt');
  });

  it('allows a Move addition that carries no credential, with no `@@` header (control)', async () => {
    const result = await runHook(moveCommand(['+export const ordinary = true;']), {}, fixtureRoot);
    expect(result.code, result.stderr).toBe(0);
  });

  it('allows a context-only Move with no `@@` header whose context matches the source (control)', async () => {
    const result = await runHook(moveCommand([' hello']), {}, fixtureRoot);
    expect(result.code, result.stderr).toBe(0);
  });

  it('allows a Move with no hunk lines at all, a pure rename (control, pins current behaviour)', async () => {
    const result = await runHook(moveCommand([]), {}, fixtureRoot);
    expect(result.code, result.stderr).toBe(0);
  });
});

// RP-481. Codex's apply_patch matches an Update's context with Unicode
// punctuation normalisation and then writes the patch's own context text, so a
// context line can carry a credential into the file. The non-move fragment held
// only the `+` lines.
describe('guard-secret-file: a non-move Update scans its context lines too (RP-481)', () => {
  let fixtureRoot = '';

  beforeEach(async () => {
    fixtureRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'rp481-update-root-')));
    await run('git', ['init', '-q', fixtureRoot]);
    await mkdir(path.join(fixtureRoot, 'src'), { recursive: true });
    await writeFile(
      path.join(fixtureRoot, 'src', 'a.txt'),
      `token = ${ANTHROPIC_KEY.replaceAll('-', '\u2010')}\n`,
    );
  });

  afterEach(async () => {
    await removeFixture(fixtureRoot);
  });

  const updateCommand = (hunkLines: string[]) => ({
    hook_event_name: 'PreToolUse',
    tool_name: 'apply_patch',
    tool_input: {
      command: [
        '*** Begin Patch',
        '*** Update File: src/a.txt',
        ...hunkLines,
        '*** End Patch',
      ].join('\n'),
    },
  });

  it('refuses a context line that carries a credential, with an ordinary addition after it', async () => {
    const result = await runHook(
      updateCommand(['@@', ` token = ${ANTHROPIC_KEY}`, '+export const ordinary = true;']),
      {},
      fixtureRoot,
    );
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toContain('src/a.txt');
  });

  it('refuses a context-only Update whose context carries a credential', async () => {
    const result = await runHook(
      updateCommand(['@@', ` token = ${ANTHROPIC_KEY}`]),
      {},
      fixtureRoot,
    );
    expect(result.code, result.stderr).toBe(2);
  });

  it('allows an Update whose context and addition carry no credential (control)', async () => {
    const result = await runHook(
      updateCommand(['@@', ' const before = 1;', '+export const ordinary = true;']),
      {},
      fixtureRoot,
    );
    expect(result.code, result.stderr).toBe(0);
  });
});

// RP-482. Codex's `UpdateFile` mode in
// `codex-rs/apply-patch/src/streaming_parser.rs` records an empty line inside a
// chunk as an empty context line. `patchFragments` dropped it, so a Move whose
// context spans a blank source line was refused as not matching.
describe('guard-secret-file: an empty hunk line is empty context, matching Codex (RP-482)', () => {
  let fixtureRoot = '';

  beforeEach(async () => {
    fixtureRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'rp482-move-root-')));
    await run('git', ['init', '-q', fixtureRoot]);
    await mkdir(path.join(fixtureRoot, 'src'), { recursive: true });
    await writeFile(path.join(fixtureRoot, 'src', 'a.txt'), 'first\n\nsecond\n');
  });

  afterEach(async () => {
    await removeFixture(fixtureRoot);
  });

  const moveCommand = (hunkLines: string[]) => ({
    hook_event_name: 'PreToolUse',
    tool_name: 'apply_patch',
    tool_input: {
      command: [
        '*** Begin Patch',
        '*** Update File: src/a.txt',
        '*** Move to: src/b.txt',
        ...hunkLines,
        '*** End Patch',
      ].join('\n'),
    },
  });

  it('allows a Move whose context spans a blank source line, with and without `@@`', async () => {
    const withHeader = await runHook(
      moveCommand(['@@', ' first', '', ' second', '+export const ordinary = true;']),
      {},
      fixtureRoot,
    );
    expect(withHeader.code, withHeader.stderr).toBe(0);

    const withoutHeader = await runHook(
      moveCommand([' first', '', ' second', '+export const ordinary = true;']),
      {},
      fixtureRoot,
    );
    expect(withoutHeader.code, withoutHeader.stderr).toBe(0);
  });

  it('still refuses a credential added after a blank context line', async () => {
    const result = await runHook(
      moveCommand([' first', '', ' second', `+aws_access_key_id = ${CLOUD_ACCESS_KEY}`]),
      {},
      fixtureRoot,
    );
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toContain('cloud-access-key');
  });

  it('refuses a Move whose blank context line meets a non-blank source line (control)', async () => {
    const result = await runHook(moveCommand([' first', '', ' third']), {}, fixtureRoot);
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toContain('context does not match');
  });

  // Codex retries a chunk whose context ends in an empty line without that line
  // when the first search fails, so these apply natively (codex-cli 0.161.0).
  it.each([
    ['a trailing blank hunk line', 'first\nsecond\n', ['@@', ' first', '+added', '']],
    [
      'a trailing blank hunk line, source without a final newline',
      'first\nsecond',
      ['@@', ' first', '+added', ''],
    ],
    [
      'a blank line before `@@`, source without a final newline',
      'first\nsecond',
      ['', '@@', ' first', '+added'],
    ],
  ])(
    'allows a Move with %s that the source has no blank line for',
    async (_label, source, hunkLines) => {
      await writeFile(path.join(fixtureRoot, 'src', 'a.txt'), source);
      const result = await runHook(moveCommand(hunkLines), {}, fixtureRoot);
      expect(result.code, result.stderr).toBe(0);
    },
  );

  it('still refuses a credential added in a hunk that ends in a blank line', async () => {
    await writeFile(path.join(fixtureRoot, 'src', 'a.txt'), 'first\nsecond\n');
    const result = await runHook(
      moveCommand(['@@', ' first', `+aws_access_key_id = ${CLOUD_ACCESS_KEY}`, '']),
      {},
      fixtureRoot,
    );
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toContain('cloud-access-key');
  });
});

// RP-485. Codex's `seek_sequence` in `codex-rs/apply-patch/src/seek_sequence.rs`
// retries a chunk's context after trimEnd, then trim, then trim plus Unicode
// punctuation normalisation. An exact-only search refused such a Move although
// Codex applies it.
describe("guard-secret-file: a Move whose context matches only after Codex's fuzzy fallback (RP-485)", () => {
  let fixtureRoot = '';

  beforeEach(async () => {
    fixtureRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'rp485-move-root-')));
    await run('git', ['init', '-q', fixtureRoot]);
    await mkdir(path.join(fixtureRoot, 'src'), { recursive: true });
  });

  afterEach(async () => {
    await removeFixture(fixtureRoot);
  });

  const source = (text: string) => writeFile(path.join(fixtureRoot, 'src', 'a.txt'), text);
  const moveCommand = (hunkLines: string[]) => ({
    hook_event_name: 'PreToolUse',
    tool_name: 'apply_patch',
    tool_input: {
      command: [
        '*** Begin Patch',
        '*** Update File: src/a.txt',
        '*** Move to: src/b.txt',
        ...hunkLines,
        '*** End Patch',
      ].join('\n'),
    },
  });

  it('allows a Move whose context differs only by trailing whitespace', async () => {
    await source('first   \nsecond\n');
    const result = await runHook(
      moveCommand(['@@', ' first', '+export const ordinary = true;']),
      {},
      fixtureRoot,
    );
    expect(result.code, result.stderr).toBe(0);
  });

  it('allows a Move whose context differs only by leading and trailing whitespace', async () => {
    await source('  first \nsecond\n');
    const result = await runHook(
      moveCommand(['@@', ' first', '+export const ordinary = true;']),
      {},
      fixtureRoot,
    );
    expect(result.code, result.stderr).toBe(0);
  });

  it('allows a Move whose context matches only after Codex normalises typographic punctuation', async () => {
    await source('say “hi” — now\nsecond\n');
    const result = await runHook(
      moveCommand(['@@', ' say "hi" - now', '+export const ordinary = true;']),
      {},
      fixtureRoot,
    );
    expect(result.code, result.stderr).toBe(0);
  });

  it('still refuses a credential added in a fuzzy-matched Move', async () => {
    await source('first   \nsecond\n');
    const result = await runHook(
      moveCommand(['@@', ' first', `+aws_access_key_id = ${CLOUD_ACCESS_KEY}`]),
      {},
      fixtureRoot,
    );
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toContain('cloud-access-key');
  });

  it('still refuses a Move whose context matches under no fallback pass', async () => {
    await source('first\nsecond\n');
    const result = await runHook(
      moveCommand(['@@', ' firsT', '+export const ordinary = true;']),
      {},
      fixtureRoot,
    );
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toContain('context does not match');
  });

  it('the fuzzy passes still exhaust the shared move context comparison budget', async () => {
    // The exact pass spends ~1.2M of the 2M comparisons without a match; the
    // trimEnd pass would match only at the last line and runs out first.
    await source(`${'same\n'.repeat(1_199)}needle   \n`);
    const result = await runHook(
      moveCommand(['@@', ...Array<string>(999).fill(' same'), ' needle']),
      {},
      fixtureRoot,
    );
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toContain('move context comparison budget was exhausted');
  });

  it('charges the fuzzy passes per character, refusing a long-line source before the work grows (RP-485)', async () => {
    // 500 lines of ~2,000 characters (~1 MB, under the 1 MiB move source cap);
    // each hunk names one line's id, found only by the trim pass, so every hunk
    // trims every long line while being charged one unit per line.
    const pad = ' '.repeat(1000);
    const ids = Array.from({ length: 500 }, (_, i) => `L${String(i).padStart(4, '0')}`);
    await source(ids.map((id) => `${pad}${id}${pad}\n`).join(''));
    const result = await runHook(
      moveCommand(ids.flatMap((id) => ['@@', ` ${id}`])),
      {},
      fixtureRoot,
    );
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toContain('move context comparison budget was exhausted');
  });
});

// RP-484. Codex matches Move context fuzzily from a moving cursor, while the
// guard rebuilt the destination by exact match from the top, so a removal could
// take the real credential in the guard's rebuild and a lookalike in Codex's
// output. Every line Codex writes comes from the source or from the patch's
// context and added lines, so the scanned fragment carries both.
describe('guard-secret-file: a Move fragment covers every line Codex can write (RP-484)', () => {
  let fixtureRoot = '';

  beforeEach(async () => {
    fixtureRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'rp484-move-root-')));
    await run('git', ['init', '-q', fixtureRoot]);
    await mkdir(path.join(fixtureRoot, 'src'), { recursive: true });
  });

  afterEach(async () => {
    await removeFixture(fixtureRoot);
  });

  const moveCommand = (hunkLines: string[]) => ({
    hook_event_name: 'PreToolUse',
    tool_name: 'apply_patch',
    tool_input: {
      command: [
        '*** Begin Patch',
        '*** Update File: src/a.txt',
        '*** Move to: src/b.txt',
        ...hunkLines,
        '*** End Patch',
      ].join('\n'),
    },
  });

  const lookalikeHeader = PEM_HEADER.replace(' PRIVATE', ' PRIVATE');

  it('refuses a removal that matches the exact header while Codex removes its lookalike', async () => {
    await writeFile(
      path.join(fixtureRoot, 'src', 'a.txt'),
      `${PEM_HEADER}\nA\n${lookalikeHeader}\n`,
    );
    const result = await runHook(
      moveCommand(['@@', ' A', '+b', '@@', `-${PEM_HEADER}`]),
      {},
      fixtureRoot,
    );
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toContain('src/b.txt');
  });

  it('refuses a removal of an inserted header while Codex removes the source lookalike', async () => {
    await writeFile(path.join(fixtureRoot, 'src', 'a.txt'), `A\n${lookalikeHeader}\n`);
    const result = await runHook(
      moveCommand(['@@', ' A', `+${PEM_HEADER}`, '@@', `-${PEM_HEADER}`]),
      {},
      fixtureRoot,
    );
    expect(result.code, result.stderr).toBe(2);
  });

  it('refuses a removal with a trailing blank line that Codex applies to a lookalike', async () => {
    const lookalikeKey = `token = ${ANTHROPIC_KEY.replaceAll('-', '‐')}`;
    await writeFile(
      path.join(fixtureRoot, 'src', 'a.txt'),
      `${lookalikeKey}\n\nmiddle\ntoken = ${ANTHROPIC_KEY}\n`,
    );
    const result = await runHook(moveCommand([`-token = ${ANTHROPIC_KEY}`, '']), {}, fixtureRoot);
    expect(result.code, result.stderr).toBe(2);
  });

  it('allows an ordinary Move whose source and patch carry no credential (control)', async () => {
    await writeFile(path.join(fixtureRoot, 'src', 'a.txt'), 'A\nB\n');
    const result = await runHook(moveCommand(['@@', ' A', '-B', '+C']), {}, fixtureRoot);
    expect(result.code, result.stderr).toBe(0);
  });
});

// RP-483. Regression shapes for the RP-479..RP-484 apply_patch fixes. Tests
// named fail-closed pin known over-refusals rather than credential writes.
describe('guard-secret-file: Codex apply_patch parity shapes (RP-483)', () => {
  let fixtureRoot = '';

  beforeEach(async () => {
    fixtureRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'rp483-parity-root-')));
    await run('git', ['init', '-q', fixtureRoot]);
    await mkdir(path.join(fixtureRoot, 'src'), { recursive: true });
  });

  afterEach(async () => {
    await removeFixture(fixtureRoot);
  });

  const source = (text: string) => writeFile(path.join(fixtureRoot, 'src', 'a.txt'), text);
  const patch = (lines: string[], newline = '\n') => ({
    hook_event_name: 'PreToolUse',
    tool_name: 'apply_patch',
    tool_input: { command: ['*** Begin Patch', ...lines, '*** End Patch'].join(newline) },
  });
  const update = (hunk: string[], newline = '\n') =>
    patch(['*** Update File: src/a.txt', ...hunk], newline);
  const move = (hunk: string[], newline = '\n') =>
    patch(['*** Update File: src/a.txt', '*** Move to: src/b.txt', ...hunk], newline);
  const dashLookalike = (value: string) => value.replaceAll('-', '‐');
  const keyLine = `token = ${ANTHROPIC_KEY}`;

  describe('a non-move Update writes its context lines', () => {
    it.each([
      ['an implicit chunk with no `@@`', [` ${keyLine}`, '+ordinary']],
      ['a second hunk whose context carries it', ['@@', ' first', '+x', '@@', ` ${keyLine}`]],
      ['a PEM header context line', ['@@', ` ${PEM_HEADER}`]],
      ['a Slack token context line', ['@@', ` slack = ${SLACK_BOT_TOKEN}`]],
    ])('refuses %s', async (_label, hunk) => {
      await source(
        `first\n${dashLookalike(keyLine)}\n${dashLookalike(PEM_HEADER)}\nslack = ${dashLookalike(SLACK_BOT_TOKEN)}\n`,
      );
      const result = await runHook(update(hunk), {}, fixtureRoot);
      expect(result.code, result.stderr).toBe(2);
    });

    it('refuses a context line before `*** End of File` that matches the last line', async () => {
      await source(`first\n${dashLookalike(keyLine)}\n`);
      const result = await runHook(
        update(['@@', ` ${keyLine}`, '*** End of File']),
        {},
        fixtureRoot,
      );
      expect(result.code, result.stderr).toBe(2);
    });

    it('refuses a CRLF patch whose context carries it', async () => {
      await source(`${dashLookalike(keyLine)}\r\n`);
      const result = await runHook(update(['@@', ` ${keyLine}`, '+x'], '\r\n'), {}, fixtureRoot);
      expect(result.code, result.stderr).toBe(2);
    });

    it('allows a credential that only the `@@` change-context header names, which Codex does not write', async () => {
      await source(`${dashLookalike(keyLine)}\nafter\n`);
      const result = await runHook(update([`@@ ${keyLine}`, ' after', '+x']), {}, fixtureRoot);
      expect(result.code, result.stderr).toBe(0);
    });

    it('refuses a context line that repeats a credential already in the file (fail-closed: the credential is already there)', async () => {
      await source(`${keyLine}\nafter\n`);
      const result = await runHook(update(['@@', ` ${keyLine}`, ' after', '+x']), {}, fixtureRoot);
      expect(result.code, result.stderr).toBe(2);
    });
  });

  describe('a Move writes every source and patch line Codex can match', () => {
    it.each([
      ['a CRLF patch', `${PEM_HEADER}\r\nA\r\n${dashLookalike(PEM_HEADER)}\r\n`, '\r\n'],
      [
        'an LF patch whose lookalike uses Unicode dashes',
        `${PEM_HEADER}\nA\n${dashLookalike(PEM_HEADER)}\n`,
        '\n',
      ],
    ])('refuses a lookalike removal in %s', async (_label, text, newline) => {
      await source(text);
      const result = await runHook(
        move(['@@', ' A', '+b', '@@', `-${PEM_HEADER}`], newline),
        {},
        fixtureRoot,
      );
      expect(result.code, result.stderr).toBe(2);
    });

    it('refuses a credential added before `*** End of File`', async () => {
      await source('first\nlast\n');
      const result = await runHook(
        move(['@@', ' last', `+${keyLine}`, '*** End of File']),
        {},
        fixtureRoot,
      );
      expect(result.code, result.stderr).toBe(2);
    });

    it('refuses a credential in the third hunk of a multi-hunk Move', async () => {
      await source('one\ntwo\nthree\n');
      const result = await runHook(
        move(['@@', ' one', '+a', '@@', ' two', '+b', '@@', ' three', `+${keyLine}`]),
        {},
        fixtureRoot,
      );
      expect(result.code, result.stderr).toBe(2);
    });

    it('refuses a credential inserted by a hunk whose trailing-empty retry empties its context', async () => {
      await source('first\nsecond');
      const result = await runHook(move(['@@', `+${keyLine}`, '']), {}, fixtureRoot);
      expect(result.code, result.stderr).toBe(2);
    });

    it('refuses a Move that removes the source credential (fail-closed: Codex writes none)', async () => {
      await source(`${keyLine}\nB\n`);
      const result = await runHook(move(['@@', `-${keyLine}`, ' B']), {}, fixtureRoot);
      expect(result.code, result.stderr).toBe(2);
    });

    it('reports a source credential at its source line number', async () => {
      await source(`${keyLine}\nB\n`);
      const result = await runHook(move(['@@', `-${keyLine}`, ' B']), {}, fixtureRoot);
      expect(result.code, result.stderr).toBe(2);
      expect(result.stderr).toContain('on line 1 of');
    });

    it('refuses a credential in the context of a Move whose source is missing (fail-closed: Codex applies nothing)', async () => {
      const result = await runHook(move(['@@', ` ${keyLine}`]), {}, fixtureRoot);
      expect(result.code, result.stderr).toBe(2);
    });

    it('refuses a credential at the very end of a maximum-size Move: a 1 MiB source plus a 1 MiB patch', async () => {
      // The context names the source's unique last line, so both the rebuild
      // and the scanned superset carry the credential at their very end.
      const last = 'z'.repeat(1023);
      await source(`${`${'x'.repeat(1023)}\n`.repeat(1023)}${last}\n`);
      const head = [
        '*** Begin Patch',
        '*** Update File: src/a.txt',
        '*** Move to: src/b.txt',
        '@@',
        ` ${last}`,
      ];
      const tail = [`+${keyLine}`, '*** End Patch'];
      const added = `+${'y'.repeat(999)}`;
      const fixed = [...head, ...tail].join('\n').length + 1;
      const addedLines = Array<string>(Math.floor((1024 * 1024 - fixed) / (added.length + 1))).fill(
        added,
      );
      const command = [...head, ...addedLines, ...tail].join('\n');
      expect(command.length).toBeLessThanOrEqual(1024 * 1024);
      expect(command.length).toBeGreaterThan(1024 * 1024 - 1024);
      const result = await runHook(
        { hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command } },
        {},
        fixtureRoot,
      );
      expect(result.code, result.stderr).toBe(2);
      expect(result.stderr).toContain('anthropic-key');
      expect(result.stderr).not.toContain('cannot safely inspect');
    });
  });
});
