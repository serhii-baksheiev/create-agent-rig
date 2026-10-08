// RP-312 slice (a): the item-owned append-only record mechanism RP-340 built
// inside `delegated-decision.mjs` (`decisionsPathFor`, `ensureDirSegment`/
// `ensureDecisionsDir`, `appendDecisionRecord`, `readDecisionsFile`) is being
// extracted, behaviour-neutrally, into a shared workflow-layer module so a
// later RP-312 slice can persist artifact evidence per item in
// `.rig/evidence/<ticket>.jsonl` without a second copy of the same
// filesystem-safety logic (`invariants.md`'s "one mechanism, one
// implementation"). `delegated-decision.mjs` was rewired to import the
// extracted functions from this module; only its own test file
// (`test/template/delegated-decision.test.ts`) was untouched by this slice
// and stays the regression net.
//
// This file pins the new module's contract on its own:
//
//   ITEM_RECORD_KINDS                                    -> readonly ['decisions', 'evidence']
//   itemRecordPathFor(projectRoot, kind, ticket)          -> string   (throws on an unsafe kind/ticket)
//   ensureItemRecordDir(projectRoot, kind)                -> string   (throws on a symlink/non-directory)
//   appendItemRecordLine(path, line)                      -> void     (throws on a symlink/hard link/directory)
//   readItemRecordFile(path, { maxBytes })                -> { exists: false } | { exists: true, text }
//
// The module exists (merged in PR #427); this file pins its contract,
// including two cases advisories flagged on that PR that were not yet
// pinned: an unbounded `readItemRecordFile` when `maxBytes` is missing or
// unusable, and `ensureItemRecordDir`'s refusal of an unknown kind.
//
// Independent-oracle rule (`invariants.md`): every expected path below is
// built with `path.join` by hand, never computed by calling the module under
// test — so a test can never be satisfied merely by the module checking its
// own work.
import { execFile, execFileSync } from 'node:child_process';
import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fifosAvailable, skipUnless, symlinksAvailable } from '../helpers/env.js';
import { GITHUB_PAT } from './secrets-fixtures.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universalDir = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const modulePath = path.join(universalDir, '.claude', 'scripts', 'lib', 'item-records.mjs');

type ExistsResult = { exists: false } | { exists: true; text: string };

type ItemRecordsModule = {
  ITEM_RECORD_KINDS: readonly string[];
  itemRecordPathFor: (projectRoot: string, kind: string, ticket: string) => string;
  ensureItemRecordDir: (projectRoot: string, kind: string) => string;
  appendItemRecordLine: (filePath: string, line: string) => void;
  readItemRecordFile: (filePath: string, options: { maxBytes: number }) => ExistsResult;
};

const loadModule = (): Promise<ItemRecordsModule> =>
  import(pathToFileURL(modulePath).href) as Promise<ItemRecordsModule>;

/** A fresh, empty project directory — never the worktree running this suite. */
const newProjectDir = async (): Promise<string> =>
  realpath(await mkdtemp(path.join(tmpdir(), 'item-records-project-')));

const newOutsideDir = async (): Promise<string> =>
  mkdtemp(path.join(tmpdir(), 'item-records-outside-'));

// The tested child must fail before this bound. It exercises the real initial
// open after a regular pathname is atomically replaced with a FIFO; a longer
// wait would conceal the blocking-open regression instead of describing it.
const ITEM_RECORD_FIFO_CHILD_TIMEOUT_MS = 3_000;

type ChildResult = { code: number; out: string; killed: boolean };

const runFifoChild = (args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<ChildResult> =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      args,
      { cwd, env, timeout: ITEM_RECORD_FIFO_CHILD_TIMEOUT_MS, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        resolve({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          out: stdout + stderr,
          killed: Boolean((error as { signal?: string } | null)?.signal),
        });
      },
    );
  });

describe('item-records.mjs — ITEM_RECORD_KINDS', () => {
  it('names exactly decisions and evidence, and is frozen', async () => {
    const { ITEM_RECORD_KINDS } = await loadModule();
    expect(ITEM_RECORD_KINDS).toEqual(['decisions', 'evidence']);
    expect(Object.isFrozen(ITEM_RECORD_KINDS)).toBe(true);
  });
});

describe('item-records.mjs — itemRecordPathFor', () => {
  it('builds <projectRoot>/.rig/<kind>/<ticket>.jsonl for "decisions"', async () => {
    const { itemRecordPathFor } = await loadModule();
    expect(itemRecordPathFor('/repo', 'decisions', 'RP-312')).toBe(
      path.join('/repo', '.rig', 'decisions', 'RP-312.jsonl'),
    );
  });

  it('builds <projectRoot>/.rig/<kind>/<ticket>.jsonl for "evidence"', async () => {
    const { itemRecordPathFor } = await loadModule();
    expect(itemRecordPathFor('/repo', 'evidence', 'RP-312')).toBe(
      path.join('/repo', '.rig', 'evidence', 'RP-312.jsonl'),
    );
  });

  it('throws on a kind ITEM_RECORD_KINDS does not name', async () => {
    const { itemRecordPathFor } = await loadModule();
    expect(() => itemRecordPathFor('/repo', 'claims', 'RP-312')).toThrow(/^item-records:/);
  });

  const UNSAFE_TICKETS = ['../x', 'a/b', '.hidden', '', `T${'0'.repeat(65)}`];
  it.each(UNSAFE_TICKETS)('throws on the unsafe ticket %j', async (ticket) => {
    const { itemRecordPathFor } = await loadModule();
    expect(() => itemRecordPathFor('/repo', 'decisions', ticket)).toThrow(/^item-records:/);
  });

  it('accepts a ticket at exactly the 64-character bound', async () => {
    const { itemRecordPathFor } = await loadModule();
    const ticket = `T${'0'.repeat(63)}`;
    expect(ticket).toHaveLength(64);
    expect(() => itemRecordPathFor('/repo', 'decisions', ticket)).not.toThrow();
  });

  const WINDOWS_DEVICE_NAMES = ['CON', 'con', 'NUL', 'AUX', 'PRN', 'COM1', 'LPT9'];
  it.each(WINDOWS_DEVICE_NAMES)(
    'throws on the Windows reserved device name %j used as a ticket id',
    async (ticket) => {
      const { itemRecordPathFor } = await loadModule();
      expect(() => itemRecordPathFor('/repo', 'decisions', ticket)).toThrow(/^item-records:/);
    },
  );

  it('throws on a credential-shaped ticket id, assembled at runtime', async () => {
    const { itemRecordPathFor } = await loadModule();
    expect(() => itemRecordPathFor('/repo', 'decisions', GITHUB_PAT)).toThrow(/^item-records:/);
  });
});

describe('item-records.mjs — ensureItemRecordDir', () => {
  it('creates .rig and .rig/<kind> one segment at a time, returning the absolute dir path', async () => {
    const dir = await newProjectDir();
    const { ensureItemRecordDir } = await loadModule();
    const result = ensureItemRecordDir(dir, 'decisions');
    expect(result).toBe(path.join(dir, '.rig', 'decisions'));
    expect(await readdir(dir)).toContain('.rig');
    expect(await readdir(path.join(dir, '.rig'))).toContain('decisions');
  });

  it('returns the same path on a second call', async () => {
    const dir = await newProjectDir();
    const { ensureItemRecordDir } = await loadModule();
    const first = ensureItemRecordDir(dir, 'evidence');
    const second = ensureItemRecordDir(dir, 'evidence');
    expect(second).toBe(first);
    expect(second).toBe(path.join(dir, '.rig', 'evidence'));
  });

  it('refuses when .rig itself is a symlink to a directory outside the project', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    const dir = await newProjectDir();
    const outside = await newOutsideDir();
    await symlink(
      outside,
      path.join(dir, '.rig'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const { ensureItemRecordDir } = await loadModule();
    expect(() => ensureItemRecordDir(dir, 'decisions')).toThrow();
    expect(await readdir(outside)).toEqual([]);
  });

  it('refuses when .rig/<kind> is a symlink to a directory outside the project', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    const dir = await newProjectDir();
    await mkdir(path.join(dir, '.rig'), { recursive: true });
    const outside = await newOutsideDir();
    await symlink(
      outside,
      path.join(dir, '.rig', 'evidence'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const { ensureItemRecordDir } = await loadModule();
    expect(() => ensureItemRecordDir(dir, 'evidence')).toThrow();
    expect(await readdir(outside)).toEqual([]);
  });

  it('refuses when .rig is a regular file', async () => {
    const dir = await newProjectDir();
    await writeFile(path.join(dir, '.rig'), 'not a directory\n');

    const { ensureItemRecordDir } = await loadModule();
    expect(() => ensureItemRecordDir(dir, 'decisions')).toThrow();
  });

  it('refuses when .rig/<kind> is a regular file', async () => {
    const dir = await newProjectDir();
    await mkdir(path.join(dir, '.rig'), { recursive: true });
    await writeFile(path.join(dir, '.rig', 'decisions'), 'not a directory\n');

    const { ensureItemRecordDir } = await loadModule();
    expect(() => ensureItemRecordDir(dir, 'decisions')).toThrow();
  });

  const UNKNOWN_KINDS = ['../x', 'claims', ''];
  it.each(UNKNOWN_KINDS)('refuses the unknown kind %j, creating nothing at all', async (kind) => {
    const dir = await newProjectDir();
    const { ensureItemRecordDir } = await loadModule();

    expect(() => ensureItemRecordDir(dir, kind)).toThrow(/^item-records:/);

    await expect(readdir(path.join(dir, '.rig'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(path.join(dir, 'x'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('item-records.mjs — appendItemRecordLine', () => {
  it('creates the file when absent and writes the line verbatim', async () => {
    const dir = await newProjectDir();
    const { ensureItemRecordDir, appendItemRecordLine } = await loadModule();
    const recordsDir = ensureItemRecordDir(dir, 'decisions');
    const filePath = path.join(recordsDir, 'RP-1.jsonl');

    appendItemRecordLine(filePath, '{"a":1}\n');

    expect(await readFile(filePath, 'utf8')).toBe('{"a":1}\n');
  });

  it('appends on a later call rather than overwriting', async () => {
    const dir = await newProjectDir();
    const { ensureItemRecordDir, appendItemRecordLine } = await loadModule();
    const recordsDir = ensureItemRecordDir(dir, 'decisions');
    const filePath = path.join(recordsDir, 'RP-1.jsonl');

    appendItemRecordLine(filePath, '{"a":1}\n');
    appendItemRecordLine(filePath, '{"a":2}\n');

    expect(await readFile(filePath, 'utf8')).toBe('{"a":1}\n{"a":2}\n');
  });

  it(
    'refuses promptly without appending when a checked regular record becomes a FIFO before the first append open',
    async (ctx) => {
      const fifos = fifosAvailable();
      skipUnless(ctx, fifos.ok, fifos.reason);
      const dir = await newProjectDir();
      const { ensureItemRecordDir } = await loadModule();
      const recordsDir = ensureItemRecordDir(dir, 'decisions');
      const filePath = path.join(recordsDir, 'RP-1.jsonl');
      const oldFile = `${filePath}.before-fifo`;
      const fifo = `${filePath}.fifo`;
      const trace = path.join(dir, '.fifo-trace');
      const preload = path.join(dir, 'swap-before-first-append-open.mjs');
      const runner = path.join(dir, 'append-record.mjs');
      const original = '{"original":"first inode"}\n';
      await writeFile(filePath, original);
      execFileSync('mkfifo', [fifo]);
      await writeFile(
        preload,
        [
          "import { appendFileSync, renameSync } from 'node:fs';",
          "import { createRequire, syncBuiltinESMExports } from 'node:module';",
          "const fs = createRequire(import.meta.url)('node:fs');",
          'const originalLstatSync = fs.lstatSync;',
          'const target = process.env.RP455_FIFO_TARGET;',
          'const oldFile = process.env.RP455_FIFO_OLD_FILE;',
          'const fifo = process.env.RP455_FIFO_FILE;',
          'const trace = process.env.RP455_FIFO_TRACE;',
          'let targetLstats = 0;',
          'fs.lstatSync = (...args) => {',
          '  const stat = originalLstatSync(...args);',
          '  if (args[0] === target && ++targetLstats === 1) {',
          '    renameSync(target, oldFile);',
          '    renameSync(fifo, target);',
          "    appendFileSync(trace, 'record-replaced-with-fifo-after-initial-lstat\\n');",
          '  }',
          '  return stat;',
          '};',
          'syncBuiltinESMExports();',
        ].join('\n'),
      );
      await writeFile(
        runner,
        [
          `import { appendItemRecordLine } from ${JSON.stringify(pathToFileURL(modulePath).href)};`,
          'try {',
          '  appendItemRecordLine(process.env.RP455_FIFO_TARGET, "{\\"new\\":true}\\n");',
          '} catch (error) {',
          '  process.stderr.write(String(error));',
          '  process.exitCode = 1;',
          '}',
        ].join('\n'),
      );

      const result = await runFifoChild(['--import', pathToFileURL(preload).href, runner], dir, {
        ...process.env,
        RP455_FIFO_TARGET: filePath,
        RP455_FIFO_OLD_FILE: oldFile,
        RP455_FIFO_FILE: fifo,
        RP455_FIFO_TRACE: trace,
      });

      expect(await readFile(trace, 'utf8')).toBe('record-replaced-with-fifo-after-initial-lstat\n');
      expect(result.killed, result.out).toBe(false);
      expect(result.code, result.out).toBe(1);
      expect(result.out).toMatch(/unreadable|changed under the check/i);
      expect(await readFile(oldFile, 'utf8')).toBe(original);
      expect(await readdir(recordsDir)).toEqual(['RP-1.jsonl', 'RP-1.jsonl.before-fifo']);
    },
    ITEM_RECORD_FIFO_CHILD_TIMEOUT_MS + 5_000,
  );

  it('refuses without appending when the checked regular file is replaced before the append open', async () => {
    const dir = await newProjectDir();
    const { ensureItemRecordDir } = await loadModule();
    const recordsDir = ensureItemRecordDir(dir, 'decisions');
    const filePath = path.join(recordsDir, 'RP-1.jsonl');
    const replacement = `${filePath}.replacement`;
    const oldFile = `${filePath}.before-swap`;
    const trace = path.join(dir, '.swap-trace');
    const preload = path.join(dir, 'swap-before-append-open.mjs');
    const runner = path.join(dir, 'append-record.mjs');
    const original = '{"original":"first inode"}\n';
    const replacementBytes = '{"replacement":"second inode"}\n';
    await writeFile(filePath, original);
    await writeFile(replacement, replacementBytes);
    await writeFile(
      preload,
      [
        "import { appendFileSync, renameSync } from 'node:fs';",
        "import { createRequire, syncBuiltinESMExports } from 'node:module';",
        "const fs = createRequire(import.meta.url)('node:fs');",
        'const originalOpenSync = fs.openSync;',
        'const target = process.env.RP451_SWAP_TARGET;',
        'const replacement = process.env.RP451_SWAP_REPLACEMENT;',
        'const oldFile = process.env.RP451_SWAP_OLD_FILE;',
        'const trace = process.env.RP451_SWAP_TRACE;',
        'let swapped = false;',
        'fs.openSync = (...args) => {',
        '  if (!swapped && args[0] === target) {',
        '    renameSync(target, oldFile);',
        '    renameSync(replacement, target);',
        "    appendFileSync(trace, 'swapped-before-append-open\\n');",
        '    swapped = true;',
        '  }',
        '  return originalOpenSync(...args);',
        '};',
        'syncBuiltinESMExports();',
      ].join('\n'),
    );
    await writeFile(
      runner,
      [
        `import { appendItemRecordLine } from ${JSON.stringify(pathToFileURL(modulePath).href)};`,
        'try {',
        '  appendItemRecordLine(process.env.RP451_SWAP_TARGET, "{\\"new\\":true}\\n");',
        '} catch (error) {',
        '  process.stderr.write(String(error));',
        '  process.exitCode = 1;',
        '}',
      ].join('\n'),
    );

    const result = await runFifoChild(['--import', pathToFileURL(preload).href, runner], dir, {
      ...process.env,
      RP451_SWAP_TARGET: filePath,
      RP451_SWAP_REPLACEMENT: replacement,
      RP451_SWAP_OLD_FILE: oldFile,
      RP451_SWAP_TRACE: trace,
    });

    expect(result.killed, result.out).toBe(false);
    expect(result.code, result.out).toBe(1);
    expect(result.out).toMatch(/changed under the check/i);
    expect(await readFile(trace, 'utf8')).toBe('swapped-before-append-open\n');
    expect(await readFile(filePath, 'utf8')).toBe(replacementBytes);
    expect(await readFile(oldFile, 'utf8')).toBe(original);
  });

  it('refuses a symlink to a file outside the project, leaving the outside file untouched', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    const dir = await newProjectDir();
    const { ensureItemRecordDir, appendItemRecordLine } = await loadModule();
    const recordsDir = ensureItemRecordDir(dir, 'decisions');
    const outsideDir = await newOutsideDir();
    const outsideFile = path.join(outsideDir, 'victim.jsonl');
    const original = 'outside-original\n';
    await writeFile(outsideFile, original);
    const filePath = path.join(recordsDir, 'RP-1.jsonl');
    await symlink(outsideFile, filePath);

    expect(() => appendItemRecordLine(filePath, '{"a":1}\n')).toThrow();
    expect(await readFile(outsideFile, 'utf8')).toBe(original);
  });

  it('refuses a hard link to a file outside the project, leaving neither name changed', async () => {
    const dir = await newProjectDir();
    const { ensureItemRecordDir, appendItemRecordLine } = await loadModule();
    const recordsDir = ensureItemRecordDir(dir, 'decisions');
    const outsideDir = await newOutsideDir();
    const outsideFile = path.join(outsideDir, 'victim.jsonl');
    const original = 'outside-original\n';
    await writeFile(outsideFile, original);
    const filePath = path.join(recordsDir, 'RP-1.jsonl');
    await link(outsideFile, filePath);

    expect(() => appendItemRecordLine(filePath, '{"a":1}\n')).toThrow();
    expect(await readFile(outsideFile, 'utf8')).toBe(original);
    expect(await readFile(filePath, 'utf8')).toBe(original);
  });

  it('refuses when the path is a directory', async () => {
    const dir = await newProjectDir();
    const { ensureItemRecordDir, appendItemRecordLine } = await loadModule();
    const recordsDir = ensureItemRecordDir(dir, 'decisions');
    const dirPath = path.join(recordsDir, 'RP-1.jsonl');
    await mkdir(dirPath);

    expect(() => appendItemRecordLine(dirPath, '{"a":1}\n')).toThrow();
  });
});

describe('item-records.mjs — readItemRecordFile', () => {
  it('reports exists: false for an absent file', async () => {
    const dir = await newProjectDir();
    const { readItemRecordFile } = await loadModule();
    const filePath = path.join(dir, '.rig', 'decisions', 'RP-1.jsonl');

    expect(readItemRecordFile(filePath, { maxBytes: 1024 })).toEqual({ exists: false });
  });

  it('reads a regular file within the bound', async () => {
    const dir = await newProjectDir();
    const { ensureItemRecordDir, readItemRecordFile } = await loadModule();
    const recordsDir = ensureItemRecordDir(dir, 'decisions');
    const filePath = path.join(recordsDir, 'RP-1.jsonl');
    await writeFile(filePath, '{"a":1}\n');

    expect(readItemRecordFile(filePath, { maxBytes: 1024 })).toEqual({
      exists: true,
      text: '{"a":1}\n',
    });
  });

  it('reads a file of exactly maxBytes', async () => {
    const dir = await newProjectDir();
    const { ensureItemRecordDir, readItemRecordFile } = await loadModule();
    const recordsDir = ensureItemRecordDir(dir, 'decisions');
    const filePath = path.join(recordsDir, 'RP-1.jsonl');
    const text = 'x'.repeat(16);
    await writeFile(filePath, text);

    expect(readItemRecordFile(filePath, { maxBytes: 16 })).toEqual({ exists: true, text });
  });

  it('refuses a file larger than maxBytes whole, naming the byte bound in the message', async () => {
    const dir = await newProjectDir();
    const { ensureItemRecordDir, readItemRecordFile } = await loadModule();
    const recordsDir = ensureItemRecordDir(dir, 'decisions');
    const filePath = path.join(recordsDir, 'RP-1.jsonl');
    await writeFile(filePath, 'x'.repeat(17));

    expect(() => readItemRecordFile(filePath, { maxBytes: 16 })).toThrow(/16/);
  });

  // `readItemRecordFile`'s own type signature requires `{ maxBytes: number }`,
  // but the cases below are exactly the ones a caller — or a mistake in one —
  // can still produce at runtime: a missing option, a non-numeric value, or a
  // value `fstat`'s `size > maxBytes` comparison cannot use as a bound. Each
  // one is cast past the type on purpose; the production code is what must
  // reject it, not the compiler.
  type LooseReadItemRecordFile = (filePath: string, options?: unknown) => ExistsResult;
  const callLoosely = (fn: ItemRecordsModule['readItemRecordFile']) =>
    fn as unknown as LooseReadItemRecordFile;

  const BAD_MAX_BYTES: Array<[string, unknown]> = [
    ['missing from the options object', {}],
    ['NaN', { maxBytes: NaN }],
    ['Infinity', { maxBytes: Infinity }],
    ['negative', { maxBytes: -1 }],
    ['non-integer', { maxBytes: 1.5 }],
    ['a numeric string', { maxBytes: '10' }],
    ['options object itself missing', undefined],
  ];

  it.each(BAD_MAX_BYTES)(
    'throws naming maxBytes, before reading any byte, when maxBytes is %s',
    async (_label, options) => {
      const dir = await newProjectDir();
      const { ensureItemRecordDir, readItemRecordFile } = await loadModule();
      const recordsDir = ensureItemRecordDir(dir, 'decisions');
      const filePath = path.join(recordsDir, 'RP-1.jsonl');
      await writeFile(filePath, 'x'.repeat(400_000));

      expect(() => callLoosely(readItemRecordFile)(filePath, options)).toThrow(
        /^item-records:.*maxBytes/,
      );
    },
  );

  it.each(BAD_MAX_BYTES)(
    'throws naming maxBytes for an absent file too, when maxBytes is %s (the argument is checked first)',
    async (_label, options) => {
      const dir = await newProjectDir();
      const { readItemRecordFile } = await loadModule();
      const filePath = path.join(dir, '.rig', 'decisions', 'RP-1.jsonl');

      expect(() => callLoosely(readItemRecordFile)(filePath, options)).toThrow(
        /^item-records:.*maxBytes/,
      );
    },
  );

  it('reads an empty file whole when maxBytes is 0', async () => {
    const dir = await newProjectDir();
    const { ensureItemRecordDir, readItemRecordFile } = await loadModule();
    const recordsDir = ensureItemRecordDir(dir, 'decisions');
    const filePath = path.join(recordsDir, 'RP-1.jsonl');
    await writeFile(filePath, '');

    expect(readItemRecordFile(filePath, { maxBytes: 0 })).toEqual({ exists: true, text: '' });
  });

  it('refuses a 1-byte file when maxBytes is 0', async () => {
    const dir = await newProjectDir();
    const { ensureItemRecordDir, readItemRecordFile } = await loadModule();
    const recordsDir = ensureItemRecordDir(dir, 'decisions');
    const filePath = path.join(recordsDir, 'RP-1.jsonl');
    await writeFile(filePath, 'x');

    expect(() => readItemRecordFile(filePath, { maxBytes: 0 })).toThrow(/0/);
  });

  it("refuses a symlink to a regular file elsewhere, never the target's own content", async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    const dir = await newProjectDir();
    const { ensureItemRecordDir, readItemRecordFile } = await loadModule();
    const recordsDir = ensureItemRecordDir(dir, 'decisions');
    const outsideDir = await newOutsideDir();
    const outsideFile = path.join(outsideDir, 'target.jsonl');
    await writeFile(outsideFile, '{"a":1}\n');
    const filePath = path.join(recordsDir, 'RP-1.jsonl');
    await symlink(outsideFile, filePath);

    expect(() => readItemRecordFile(filePath, { maxBytes: 1024 })).toThrow();
  });

  it('refuses a directory in place of the file', async () => {
    const dir = await newProjectDir();
    const { ensureItemRecordDir, readItemRecordFile } = await loadModule();
    const recordsDir = ensureItemRecordDir(dir, 'decisions');
    const dirPath = path.join(recordsDir, 'RP-1.jsonl');
    await mkdir(dirPath);

    expect(() => readItemRecordFile(dirPath, { maxBytes: 1024 })).toThrow();
  });

  it('refuses a FIFO with no writer rather than blocking inside open()', async (ctx) => {
    const fifos = fifosAvailable();
    skipUnless(ctx, fifos.ok, fifos.reason);
    const dir = await newProjectDir();
    const { ensureItemRecordDir, readItemRecordFile } = await loadModule();
    const recordsDir = ensureItemRecordDir(dir, 'decisions');
    const fifoPath = path.join(recordsDir, 'RP-1.jsonl');
    execFileSync('mkfifo', [fifoPath]);

    expect(() => readItemRecordFile(fifoPath, { maxBytes: 1024 })).toThrow();
  }, 8_000);

  it(
    'refuses promptly when a checked regular record becomes a FIFO before the first read open',
    async (ctx) => {
      const fifos = fifosAvailable();
      skipUnless(ctx, fifos.ok, fifos.reason);
      const dir = await newProjectDir();
      const { ensureItemRecordDir } = await loadModule();
      const recordsDir = ensureItemRecordDir(dir, 'decisions');
      const filePath = path.join(recordsDir, 'RP-1.jsonl');
      const oldFile = `${filePath}.before-fifo`;
      const fifo = `${filePath}.fifo`;
      const trace = path.join(dir, '.fifo-trace');
      const preload = path.join(dir, 'swap-before-first-read-open.mjs');
      const runner = path.join(dir, 'read-record.mjs');
      const original = '{"original":"first inode"}\n';
      await writeFile(filePath, original);
      execFileSync('mkfifo', [fifo]);
      await writeFile(
        preload,
        [
          "import { appendFileSync, renameSync } from 'node:fs';",
          "import { createRequire, syncBuiltinESMExports } from 'node:module';",
          "const fs = createRequire(import.meta.url)('node:fs');",
          'const originalLstatSync = fs.lstatSync;',
          'const target = process.env.RP455_FIFO_TARGET;',
          'const oldFile = process.env.RP455_FIFO_OLD_FILE;',
          'const fifo = process.env.RP455_FIFO_FILE;',
          'const trace = process.env.RP455_FIFO_TRACE;',
          'let targetLstats = 0;',
          'fs.lstatSync = (...args) => {',
          '  const stat = originalLstatSync(...args);',
          '  if (args[0] === target && ++targetLstats === 1) {',
          '    renameSync(target, oldFile);',
          '    renameSync(fifo, target);',
          "    appendFileSync(trace, 'record-replaced-with-fifo-after-initial-lstat\\n');",
          '  }',
          '  return stat;',
          '};',
          'syncBuiltinESMExports();',
        ].join('\n'),
      );
      await writeFile(
        runner,
        [
          `import { readItemRecordFile } from ${JSON.stringify(pathToFileURL(modulePath).href)};`,
          'try {',
          '  readItemRecordFile(process.env.RP455_FIFO_TARGET, { maxBytes: 1024 });',
          '} catch (error) {',
          '  process.stderr.write(String(error));',
          '  process.exitCode = 1;',
          '}',
        ].join('\n'),
      );

      const result = await runFifoChild(['--import', pathToFileURL(preload).href, runner], dir, {
        ...process.env,
        RP455_FIFO_TARGET: filePath,
        RP455_FIFO_OLD_FILE: oldFile,
        RP455_FIFO_FILE: fifo,
        RP455_FIFO_TRACE: trace,
      });

      expect(await readFile(trace, 'utf8')).toBe('record-replaced-with-fifo-after-initial-lstat\n');
      expect(result.killed, result.out).toBe(false);
      expect(result.code, result.out).toBe(1);
      expect(result.out).toMatch(/not a regular file|unreadable/i);
      expect(await readFile(oldFile, 'utf8')).toBe(original);
      expect(await readdir(recordsDir)).toEqual(['RP-1.jsonl', 'RP-1.jsonl.before-fifo']);
    },
    ITEM_RECORD_FIFO_CHILD_TIMEOUT_MS + 5_000,
  );
});
