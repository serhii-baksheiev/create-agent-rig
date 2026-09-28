import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
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

const tempHome = () => mkdtemp(path.join(tmpdir(), 'unattended-flag-audit-'));

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
});
