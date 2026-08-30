import { execFile, execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { shortNameSpelling, skipUnless } from '../helpers/env.js';
import { gitEnv } from '../../packages/cli/src/lib/git-env.js';

/**
 * AR-51 — `editFragments` is the one normaliser every edit guard reads through,
 * and it knew Write, Edit and apply_patch only. A MultiEdit or a NotebookEdit
 * returned `[]`, which every consumer reads as "nothing to inspect" — so a
 * `Date.now()` reached the core through MultiEdit while the purity guard said
 * it had looked.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const hooksDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'hooks');

interface Fragment {
  filePath: string;
  fragment: string;
  inspectionRefusal?: string;
  appliesToAll?: boolean;
}

const load = () =>
  import(pathToFileURL(path.join(hooksDir, 'lib', 'edit-input.mjs')).href) as Promise<{
    editFragments: (input: unknown) => Fragment[];
  }>;

const multiEdit = (filePath: string, edits: unknown) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'MultiEdit',
  tool_input: { file_path: filePath, edits },
});

describe('editFragments: MultiEdit and NotebookEdit are edit surfaces too', () => {
  it('yields one fragment per MultiEdit edit, each carrying the new text under the file path', async () => {
    const { editFragments } = await load();
    const fragments = editFragments(
      multiEdit('packages/core/src/x.ts', [
        { old_string: 'a', new_string: 'b' },
        { old_string: 'c', new_string: 'd' },
      ]),
    );
    expect(fragments).toEqual([
      { filePath: 'packages/core/src/x.ts', fragment: 'b' },
      { filePath: 'packages/core/src/x.ts', fragment: 'd' },
    ]);
  });

  it('normalises the MultiEdit file path the way it does for Write', async () => {
    const { editFragments } = await load();
    const [fragment] = editFragments(
      multiEdit('./packages\\core\\src\\x.ts', [{ old_string: 'a', new_string: 'b' }]),
    );
    expect(fragment?.filePath).toBe('packages/core/src/x.ts');
  });

  it('yields one fragment for a NotebookEdit: notebook_path and new_source', async () => {
    const { editFragments } = await load();
    const fragments = editFragments({
      hook_event_name: 'PreToolUse',
      tool_name: 'NotebookEdit',
      tool_input: { notebook_path: 'notes/x.ipynb', new_source: 'print(1)' },
    });
    expect(fragments).toEqual([{ filePath: 'notes/x.ipynb', fragment: 'print(1)' }]);
  });

  it('yields nothing for a MultiEdit whose edits is not an array', async () => {
    const { editFragments } = await load();
    expect(editFragments(multiEdit('packages/core/src/x.ts', 'not-a-list'))).toEqual([]);
  });
});

describe('the existing guards see a MultiEdit', () => {
  it('guard-core-purity blocks a clock call reaching the core through MultiEdit', async () => {
    const result = await new Promise<{ code: number; stderr: string }>((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [path.join(hooksDir, 'guard-core-purity.mjs')],
        { env: { ...process.env } },
        (error, _stdout, stderr) => {
          resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stderr });
        },
      );
      if (!child.stdin) return reject(new Error('no stdin'));
      child.stdin.write(
        JSON.stringify(
          multiEdit(path.join(repoRoot, 'packages/core/src/x.ts'), [
            { old_string: 'a', new_string: 'const t = Date.now();' },
          ]),
        ),
      );
      child.stdin.end();
    });
    expect(result.code, result.stderr).toBe(2);
  });
});

/**
 * RP-54, the half that was never converted. `patchFragments` derives the two
 * paths it compares from DIFFERENT sources: the root from `git rev-parse
 * --show-toplevel`, which answers in the LONG form however it was invoked, and
 * the working directory from plain `realpathSync`, which normalises separators
 * and leaves a Windows 8.3 short name (`SERHII~1`, `RUNNER~1`) standing. Two
 * spellings of one directory then fail the containment check, `patchCwd` goes
 * null, and every apply_patch is refused as if its destination were somewhere
 * else entirely.
 *
 * That is the same defect PR #149 fixed in `guard-rulebook.mjs` and
 * `unattended-flag.mjs` by canonicalising with `realpathSync.native`; here it
 * still travels through the shared library into all four edit guards. Pinned
 * as an OUTCOME — a legitimate patch is inspected — so the fix is free to be
 * any canonicalisation that makes the two spellings meet.
 *
 * Where the volume offers one spelling only, the fixture cannot be built and
 * the case skips with that reason; it is sharp exactly where the defect is
 * reachable.
 */
describe('editFragments: an 8.3 cwd is a spelling of the repository, not a foreign directory', () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: README.md',
    '*** Move to: README2.md',
    '@@',
    ' hello',
    '+world',
    '*** End Patch',
  ].join('\n');

  const applyPatchAt = (cwd: string) => ({
    hook_event_name: 'PreToolUse',
    tool_name: 'apply_patch',
    tool_input: { command: patch },
    cwd,
  });

  /** A checkout of its own: the case is about how its cwd is SPELLED. */
  let checkout: string;
  beforeAll(async () => {
    checkout = realpathSync.native(await mkdtemp(path.join(tmpdir(), 'rp54-eight-three-')));
    // gitEnv(): an inherited GIT_DIR would point `git init` at the repository
    // running the suite instead of this scratch checkout.
    execFileSync('git', ['init', '-q'], { cwd: checkout, env: gitEnv() });
    await writeFile(path.join(checkout, 'README.md'), 'hello\n');
  });
  afterAll(async () => {
    await rm(checkout, { recursive: true, force: true });
  });

  it('inspects a patch whose cwd is the 8.3 spelling of the repository root', async (ctx) => {
    const short = shortNameSpelling(checkout);
    skipUnless(ctx, short.ok, short.reason);
    const { editFragments } = await load();

    const fragments = editFragments(applyPatchAt(short.spelling));

    expect(
      fragments.map((fragment) => fragment.inspectionRefusal).filter(Boolean),
      `spellings: ${short.spelling} vs ${checkout}`,
    ).toEqual([]);
    expect(fragments).toEqual([{ filePath: 'README2.md', fragment: 'hello\nworld\n' }]);
  });

  it('reads the same patch identically under either spelling of one directory', async (ctx) => {
    const short = shortNameSpelling(checkout);
    skipUnless(ctx, short.ok, short.reason);
    const { editFragments } = await load();

    expect(editFragments(applyPatchAt(short.spelling))).toEqual(
      editFragments(applyPatchAt(checkout)),
    );
  });

  it('leaves guard-secret-file allowing an ordinary patch under the 8.3 spelling', async (ctx) => {
    const short = shortNameSpelling(checkout);
    skipUnless(ctx, short.ok, short.reason);

    const result = await runGuardSecretFile(applyPatchAt(short.spelling));

    expect(result.code, result.stderr).toBe(0);
  });
});

/** Feed a synthetic payload to the real hook, exactly as the harness does. */
const runGuardSecretFile = (payload: unknown): Promise<{ code: number; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [path.join(hooksDir, 'guard-secret-file.mjs')],
      { env: { ...process.env } },
      (error, _stdout, stderr) => {
        resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stderr });
      },
    );
    if (!child.stdin) return reject(new Error('no stdin'));
    // A hook that decides early closes the pipe under us; that EPIPE is the hook
    // working, not the test failing. The exit code is the subject.
    child.stdin.on('error', () => {});
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });

/**
 * RP-54, the arm that is a BYPASS rather than a refusal — and the distinction is
 * the whole reason this block exists next to the one above it.
 *
 * `guard-secret-file` has two arms: a credential VALUE in the text, and a
 * credential PATH by its name (`.env`, `credentials/`, `id_ed25519`, from
 * `.claude/scripts/lib/secrets.mjs`). The path arm exists precisely because
 * content matching is incomplete — it is the arm that answers before there is
 * any content to read.
 *
 * On Windows with 8.3 name creation on, that arm is turned off BY SPELLING
 * ALONE. `repositoryPatchPath` resolves the patch destination with plain
 * `realpathSync`, which normalises separators and leaves an 8.3 component
 * standing; `realpathSync.native` expands it. So the fragment's `filePath`
 * comes back as `ENV~1`, and the guard — which canonicalises nothing itself and
 * matches literal text — sees a filename that is in no vocabulary. Measured at
 * `9b16503` in a scratch checkout holding a real `.env`: `*** Update File:
 * .env` exits 2, `*** Update File: ENV~1` exits 0 with nothing on stderr, and
 * the same pair for `credentials/config.ts` against `CREDEN~1/config.ts`.
 *
 * Scope, so the reach is not read narrower than it is: `destinationPath =
 * current.moveTo ?? current.sourcePath`, so an ordinary `*** Update File:`
 * takes this route — a `*** Move to:` is not required, and every probe above
 * used the ordinary form.
 *
 * Pinned as an OUTCOME — the guard refuses the credential path — so the fix is
 * free to be any canonicalisation that makes the two spellings meet, and not a
 * statement about which fs call makes it so.
 *
 * Where the volume offers one spelling only, the alias cannot be built and the
 * case skips with that reason; it is sharp exactly where the bypass is
 * reachable.
 */
describe('guard-secret-file: an 8.3 alias is a spelling of a credential path, not a different file', () => {
  /**
   * A checkout of its own, holding both shapes the bypass was measured on: a
   * dot-leading credential FILE (never 8.3-conformant, so it reliably has an
   * alias) and a credential DIRECTORY SEGMENT.
   */
  let checkout: string;
  beforeAll(async () => {
    checkout = realpathSync.native(await mkdtemp(path.join(tmpdir(), 'rp54-credential-8dot3-')));
    // gitEnv(): an inherited GIT_DIR would point `git init` at the repository
    // running the suite instead of this scratch checkout.
    execFileSync('git', ['init', '-q'], { cwd: checkout, env: gitEnv() });
    // Innocuous content throughout: the PATH arm is the subject, and a
    // credential-shaped value would let the other arm answer for it.
    await writeFile(path.join(checkout, '.env'), 'hello\n');
    await mkdir(path.join(checkout, 'credentials'));
    await writeFile(path.join(checkout, 'credentials', 'config.ts'), 'hello\n');
  });
  afterAll(async () => {
    await rm(checkout, { recursive: true, force: true });
  });

  /** The 8.3 alias of one entry in the checkout, as a bare name. */
  const aliasOf = (relative: string) => shortNameSpelling(path.join(checkout, relative));

  const updatePatch = (destination: string) =>
    [
      '*** Begin Patch',
      `*** Update File: ${destination}`,
      '@@',
      ' hello',
      '+world',
      '*** End Patch',
    ].join('\n');

  const patchTo = (destination: string) => ({
    hook_event_name: 'PreToolUse',
    tool_name: 'apply_patch',
    // The cwd is the LONG spelling on purpose: only the destination inside the
    // patch is short, so nothing but the destination's resolution is on trial.
    tool_input: { command: updatePatch(destination) },
    cwd: checkout,
  });

  // The control. It passes today, and it is what makes a failure of the two
  // cases below a statement about the SPELLING rather than about the fixture.
  it.for(['.env', 'credentials/config.ts'])(
    'refuses a patch to %s, written the way the repository spells it',
    async (destination) => {
      const result = await runGuardSecretFile(patchTo(destination));
      expect(result.code, `${destination} was not refused\n${result.stderr}`).toBe(2);
      expect(result.stderr).toContain('is a credential file');
    },
  );

  it('refuses a patch to the 8.3 alias of a credential file', async (ctx) => {
    const alias = aliasOf('.env');
    skipUnless(ctx, alias.ok, alias.reason);
    const destination = path.basename(alias.spelling);

    const result = await runGuardSecretFile(patchTo(destination));

    expect(result.code, `${destination} (.env) was allowed\n${result.stderr}`).toBe(2);
  });

  it('refuses a patch under the 8.3 alias of a credential directory', async (ctx) => {
    const alias = aliasOf('credentials');
    skipUnless(ctx, alias.ok, alias.reason);
    const destination = `${path.basename(alias.spelling)}/config.ts`;

    const result = await runGuardSecretFile(patchTo(destination));

    expect(
      result.code,
      `${destination} (credentials/config.ts) was allowed\n${result.stderr}`,
    ).toBe(2);
  });

  // A refusal naming `ENV~1` sends the reader looking for a file that does not
  // appear in their checkout — `.claude/rules/invariants.md`: a refusal that
  // cannot be acted on is one that gets routed around.
  it('names the credential file the way the repository spells it, not the alias it was handed', async (ctx) => {
    const alias = aliasOf('.env');
    skipUnless(ctx, alias.ok, alias.reason);

    const result = await runGuardSecretFile(patchTo(path.basename(alias.spelling)));

    expect(result.stderr).toContain('".env"');
  });

  it('reads one patch identically under either spelling of its destination', async (ctx) => {
    const alias = aliasOf('.env');
    skipUnless(ctx, alias.ok, alias.reason);
    const { editFragments } = await load();

    expect(editFragments(patchTo(path.basename(alias.spelling)))).toEqual(
      editFragments(patchTo('.env')),
    );
  });
});
