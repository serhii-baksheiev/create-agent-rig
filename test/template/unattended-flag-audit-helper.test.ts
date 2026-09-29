import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { modeBitsDeny, skipUnless } from '../helpers/env.js';
import { removeFixture } from '../helpers/remove-fixture.js';
import { newUnattendedFlags, snapshotUnattendedFlags } from '../helpers/unattended-flag-audit.js';

// RP-271: test/template/queue-board.test.ts armed the checkout-scoped
// unattended flag (`writeUnattended`, unattended-flag.mjs) with a real HOME
// derived from `userInfo().homedir` still in the candidate set — that home is
// never overridable by a fixture's `HOME` env var (stop-flag.mjs's
// `homesOf`), so a test whose assertion threw before its bare `clearUnattended`
// call left a `__PROJECT_NAME__-*-loop-UNATTENDED` file sitting in the
// operator's REAL `~/.claude`.
//
// This is the behaviour test for the audit's own snapshot/diff primitive —
// `test/helpers/unattended-flag-audit.ts`, which the implementation step adds.
// It is exercised here against temporary directories ONLY: nothing in this
// file ever reads or writes the real home.
//
// Independent-oracle rule (`.claude/rules/invariants.md`): this module must
// decide "is this a leaked flag" from the literal, unsubstituted
// `__PROJECT_NAME__-*-loop-UNATTENDED` name every test in this tree writes —
// never by importing `unattended-flag.mjs`'s own `scopedBasename`/`checkoutId`
// hashing to compute the expected name. Every flag file planted below is a
// literal string for exactly that reason.

// RP-288: every home this file creates is tracked here and removed in
// `afterEach`, so a run of this file leaves nothing behind in the OS temp
// directory — the chmod-000 test restores its own home's mode in its own
// `finally` before this cleanup ever touches it (see below).
const createdHomes: string[] = [];

const tempHome = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'unattended-flag-audit-'));
  createdHomes.push(dir);
  return dir;
};

afterEach(async () => {
  const homes = createdHomes.splice(0);
  await Promise.all(homes.map((dir) => removeFixture(dir)));
});

async function plantFlag(home: string, name: string): Promise<string> {
  const dir = path.join(home, '.claude');
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, name);
  await writeFile(target, '{}\n');
  return target;
}

describe('snapshotUnattendedFlags / newUnattendedFlags: the leak-audit primitive', () => {
  it('reports a scoped flag planted in a home after the snapshot was taken', async () => {
    const home = await tempHome();
    const snapshot = await snapshotUnattendedFlags([home]);
    const planted = await plantFlag(home, '__PROJECT_NAME__-0123456789abcdef-loop-UNATTENDED');

    expect(await newUnattendedFlags(snapshot)).toEqual([planted]);
  });

  it('reports the unscoped flag name too', async () => {
    const home = await tempHome();
    const snapshot = await snapshotUnattendedFlags([home]);
    const planted = await plantFlag(home, '__PROJECT_NAME__-loop-UNATTENDED');

    expect(await newUnattendedFlags(snapshot)).toEqual([planted]);
  });

  it('does not report a flag that already existed at snapshot time', async () => {
    const home = await tempHome();
    await plantFlag(home, '__PROJECT_NAME__-0123456789abcdef-loop-UNATTENDED');
    const snapshot = await snapshotUnattendedFlags([home]);

    expect(await newUnattendedFlags(snapshot)).toEqual([]);
  });

  it('does not report a real generated-rig flag name — only the literal template-tree name is audited', async () => {
    const home = await tempHome();
    const snapshot = await snapshotUnattendedFlags([home]);
    await plantFlag(home, 'create-agent-rig-0123456789abcdef-loop-UNATTENDED');

    expect(await newUnattendedFlags(snapshot)).toEqual([]);
  });

  it('does not report an unrelated file dropped into the same .claude directory', async () => {
    const home = await tempHome();
    const snapshot = await snapshotUnattendedFlags([home]);
    await plantFlag(home, '__PROJECT_NAME__-loop-STOP');

    expect(await newUnattendedFlags(snapshot)).toEqual([]);
  });

  it('scans every home in the list, and reports a leak from any of them', async () => {
    const homeA = await tempHome();
    const homeB = await tempHome();
    const snapshot = await snapshotUnattendedFlags([homeA, homeB]);
    const planted = await plantFlag(homeB, '__PROJECT_NAME__-fedcba9876543210-loop-UNATTENDED');

    expect(await newUnattendedFlags(snapshot)).toEqual([planted]);
  });

  it('tolerates a home whose .claude directory does not exist yet, at snapshot and at diff time', async () => {
    const home = await tempHome();
    const snapshot = await snapshotUnattendedFlags([home]);

    expect(await newUnattendedFlags(snapshot)).toEqual([]);
  });

  /**
   * RP-288 — `listFlags` (the private primitive behind both exports above)
   * tolerates ENOENT (no `.claude` yet) but rethrows every other `readdir`
   * error verbatim. A home path that is itself a FILE makes
   * `readdir(<home>/.claude)` fail with ENOTDIR, not ENOENT, on POSIX — a
   * shape that should read the same as "nothing here yet", not as a leak-audit
   * failure severe enough to abort the whole run's setup/teardown.
   */
  it('tolerates a home path that is a FILE, not a directory (ENOTDIR) — treated the same as ENOENT', async () => {
    const parent = await tempHome();
    const fileHome = path.join(parent, 'not-a-directory');
    await writeFile(fileHome, 'this home is a file, not a directory\n');

    await expect(snapshotUnattendedFlags([fileHome])).resolves.toEqual([
      { home: fileHome, existing: new Set() },
    ]);
    await expect(newUnattendedFlags([{ home: fileHome, existing: new Set() }])).resolves.toEqual(
      [],
    );
  });

  /**
   * RP-288 — every OTHER `readdir` error (anything but ENOENT/ENOTDIR) is
   * rethrown today exactly as `fs.readdir` raised it, with no mention of
   * which home the leak audit was even looking at, or that the leak audit is
   * the thing that failed. A run-wide `globalSetup`/teardown failure with a
   * bare `EACCES: permission denied` in it gives an operator nothing to act
   * on. Expected: the error message names the home path AND carries the
   * literal marker `RP-271 leak audit`, so it reads the same as the
   * intentional leak-detection failure `unattended-flag-leak-audit.ts`
   * throws, not as an unrelated crash.
   */
  it('prefixes any other read error with the home path and "RP-271 leak audit"', async (ctx) => {
    skipUnless(ctx, modeBitsDeny().ok, modeBitsDeny().reason);
    const home = await tempHome();
    await mkdir(path.join(home, '.claude'), { recursive: true });
    await chmod(home, 0o000);

    let caught: unknown;
    try {
      await snapshotUnattendedFlags([home]);
    } catch (err) {
      caught = err;
    } finally {
      await chmod(home, 0o700);
    }

    expect(
      caught,
      'snapshotUnattendedFlags should have rejected on the EACCES home',
    ).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(home);
    expect((caught as Error).message).toContain('RP-271 leak audit');
  });
});
