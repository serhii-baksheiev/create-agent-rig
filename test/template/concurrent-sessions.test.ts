import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { validateEvidenceRow } from '../../packages/cli/src/policy/core/evidence-matrix.js';
import type { EvidenceRow } from '../../packages/cli/src/policy/core/evidence-matrix.js';

// RP-120, narrowed to the Rig's own state: which parts of it two sessions on
// one machine share, which of the shared part is protected, and the ruling that
// follows — `docs/decisions/concurrent-sessions.md`. The item asked for one test
// per mechanism found shared AND unprotected, not one per mechanism that was
// fine, so the mechanisms already pinned elsewhere are cited from the record
// rather than re-tested here: a close inside a worktree lands in the main
// checkout (`queue.test.ts` › "records a close made inside a worktree into the
// main checkout"), an unparseable state file is refused rather than read as
// "nothing closed" (`queue.test.ts` › "refuses a state file holding %s"), and
// the flag is scoped per checkout (`unattended-flag.test.ts` › "scopes on/off to
// --root so concurrent checkout CLIs do not share a flag").
//
// What this file pins is the part that was measured and never written down as
// a test: the gate-round counter's lossy race, the flag's silent overwrite in
// one directory, and the capability rows the ruling publishes — validated
// through the same `validateEvidenceRow` every other row goes through, and held
// in correspondence with the record's table in both directions.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const scriptsDir = path.join(universal, '.claude', 'scripts');
const load = (rel: string) => import(pathToFileURL(path.join(scriptsDir, rel)).href);
const RECORD = path.join(repoRoot, 'docs', 'decisions', 'concurrent-sessions.md');

interface Exit {
  code: number;
  stdout: string;
  stderr: string;
}

const run = (args: string[], env: NodeJS.ProcessEnv): Promise<Exit> =>
  new Promise((resolve) => {
    execFile(process.execPath, args, { env }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });

describe('racing gate-round callers lose increments but never the counter file', () => {
  // The header of gate-rounds.mjs states the measurement — eight concurrent
  // calls recorded four — and accepts it: the loss is bounded and in the
  // generous direction, and what was worth fixing was the crash a fixed temp
  // name produced for the losers. Nothing pinned either half. This does: every
  // caller exits 0, the file is always a parseable counter, the count is at
  // least one and at most the number of callers, and no temp file survives.
  it('eight concurrent recordGateRound calls all exit 0 and leave one parseable counter between one and eight', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'concurrent-rounds-'));
    const roundsPath = path.join(dir, 'gate-rounds.json');
    const moduleUrl = pathToFileURL(path.join(scriptsDir, 'queue', 'gate-rounds.mjs')).href;
    const program = [
      `const { recordGateRound } = await import(${JSON.stringify(moduleUrl)});`,
      `recordGateRound({ roundsPath: ${JSON.stringify(roundsPath)}, branch: 'fix/race' });`,
    ].join('\n');
    const callers = 8;
    try {
      const results = await Promise.all(
        Array.from({ length: callers }, () =>
          run(['--input-type=module', '--eval', program], process.env),
        ),
      );

      expect(
        results.map((r) => r.code),
        results.map((r) => r.stderr).join('\n'),
      ).toEqual(Array.from({ length: callers }, () => 0));
      const counter = JSON.parse(await readFile(roundsPath, 'utf8')) as Record<string, number>;
      expect(counter['fix/race']).toBeGreaterThanOrEqual(1);
      expect(counter['fix/race']).toBeLessThanOrEqual(callers);
      expect(await readdir(dir)).toEqual(['gate-rounds.json']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('two sessions in one directory share one unattended flag, and nothing refuses the second', () => {
  const scriptPath = path.join(scriptsDir, 'unattended-flag.mjs');
  let home = '';

  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
    home = '';
  });

  // The flag is named by the checkout's real path, so a second session in the
  // SAME directory writes the same file — `on` does not look before it writes,
  // so the second item silently replaces the first, and the second session's
  // `off` disarms the first. `verify` sees the mismatch; nothing prevents it.
  // That is the measured reason the ruling marks same-directory concurrency
  // UNSUPPORTED rather than degraded.
  //
  // The flag writer mirrors a scoped flag into every home it knows — HOME and
  // the account's real home — so a failed assertion before the final `off`
  // would leave a fixture flag in the operator's `~/.claude/`. The `finally`
  // removes every candidate the module itself would read, as
  // unattended-flag.test.ts does for the same reason.
  it('a second `on` in the same checkout replaces the first item, verify for the first item then refuses, and one `off` disarms both', async () => {
    const { readUnattended, unattendedFlags } = (await load('unattended-flag.mjs')) as {
      readUnattended: (env?: NodeJS.ProcessEnv) => { on: boolean; item?: string };
      unattendedFlags: (env?: NodeJS.ProcessEnv) => string[];
    };
    home = await mkdtemp(path.join(tmpdir(), 'same-dir-'));
    const checkout = path.join(home, 'checkout');
    await mkdir(checkout, { recursive: true });
    const env = { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: checkout };
    const cli = (args: string[]) => run([scriptPath, ...args], env);

    try {
      expect((await cli(['on', '--root', checkout, '--item', 'RP-FIRST'])).code).toBe(0);
      const second = await cli(['on', '--root', checkout, '--item', 'RP-SECOND']);
      expect(second.code, second.stderr).toBe(0);
      expect(readUnattended(env)).toMatchObject({ on: true, item: 'RP-SECOND' });

      const verify = await cli(['verify', '--root', checkout, '--item', 'RP-FIRST']);
      expect(verify.code).not.toBe(0);
      expect(verify.stderr).toMatch(/RP-FIRST/);
      expect(verify.stderr).toMatch(/RP-SECOND/);

      expect((await cli(['off', '--root', checkout])).code).toBe(0);
      expect(readUnattended(env)).toEqual({ on: false });
    } finally {
      await Promise.all(unattendedFlags(env).map((candidate) => rm(candidate, { force: true })));
    }
  });
});

// The rows the ruling publishes. They are the capability-contract entries the
// item asked for (RP-36's `EvidenceRow`, since no registry of rows exists to
// append to), and they go through the same validator every other row does.
//
// Measured with Claude Code sessions on the Windows host RP-120's evidence came
// from (`claude --version` 2.1.263; the race probe ran at the time below); the
// Rig mechanisms named are harness-neutral, but a Codex row is a separate
// measurement and is not claimed here.
const OBSERVED_AT = '2026-09-07T23:58:00+04:00';
const ROW_BASE = {
  harness: 'claude',
  harnessVersion: '2.1.263',
  os: 'win32',
  observedAt: OBSERVED_AT,
};

const CONCURRENT_SESSIONS_ROWS: readonly EvidenceRow[] = [
  {
    ...ROW_BASE,
    surface: 'concurrent-sessions/cross-repository',
    mechanism: 'unattended-flag',
    observableSignal:
      'each checkout arms a flag file named by the hash of its own real path; only the kill switch is shared between repositories, by design',
    status: 'SUPPORTED',
    evidencePointer:
      'test/template/unattended-flag.test.ts › "scopes on/off to --root so concurrent checkout CLIs do not share a flag"',
  },
  {
    ...ROW_BASE,
    surface: 'concurrent-sessions/linked-worktree',
    mechanism: 'queue-state',
    observableSignal:
      'a close in a linked worktree writes the main-checkout tier, but a selector that read the prior tier can still take an elevated item after that close',
    status: 'DEGRADED',
    downgradeReason:
      'queue.state.json is shared with the main checkout but a selection snapshots it before listing candidates, with no arbitration against a concurrent close; gate-rounds.json is also shared and its read-modify-write can lose increments in the generous direction',
    evidencePointer:
      'test/template/queue.test.ts › "a selector holding a pre-close snapshot can still take an elevated item after another worktree closes one"',
  },
  {
    ...ROW_BASE,
    surface: 'concurrent-sessions/same-directory',
    mechanism: 'unattended-flag',
    observableSignal:
      'the second session `on` replaces the first session item and allow-list without refusal, and its `off` disarms both',
    status: 'UNSUPPORTED',
    downgradeReason:
      'one working tree, one flag file and one board selector with no ownership check between sessions; the worktree-task skill is the supported shape',
    evidencePointer:
      'test/template/concurrent-sessions.test.ts › "a second `on` in the same checkout replaces the first item, verify for the first item then refuses, and one `off` disarms both"',
  },
];

const POINTER = /^(\S+\.test\.(?:ts|mjs)) › "(.+)"$/;

describe('the concurrent-sessions rows are capability-contract rows, and the record says what they say', () => {
  it('every row validates as an EvidenceRow', () => {
    for (const row of CONCURRENT_SESSIONS_ROWS) {
      const verdict = validateEvidenceRow(row);
      expect(verdict.ok, `${row.surface}: ${JSON.stringify(verdict)}`).toBe(true);
    }
  });

  it('every evidence pointer names a test file this repository has and a test it declares', async () => {
    for (const row of CONCURRENT_SESSIONS_ROWS) {
      const match = POINTER.exec(row.evidencePointer);
      expect(match, row.evidencePointer).not.toBeNull();
      const [, file, title] = match!;
      const target = path.join(repoRoot, file!);
      expect(existsSync(target), `${row.surface} points at ${file}, which is not here`).toBe(true);
      expect(await readFile(target, 'utf8'), `${file} declares no test titled ${title}`).toContain(
        title!,
      );
    }
  });

  // The record carries the same rows as a table, which is a second copy of a
  // mechanical fact — so the correspondence is checked in both directions
  // (`rules/invariants.md`, "one mechanism, one implementation"): a surface the
  // record names that no row carries, and a row the record does not name, both
  // go red. The table's first cell is the surface, its last is the status.
  it('the decision record tables exactly the surfaces above with the same statuses', async () => {
    expect(
      existsSync(RECORD),
      'docs/decisions/concurrent-sessions.md is the ruling; it is not here',
    ).toBe(true);
    const source = await readFile(RECORD, 'utf8');
    const tabled = new Map<string, string>();
    for (const line of source.split('\n')) {
      if (!line.startsWith('| `concurrent-sessions/')) continue;
      const cells = line.split('|').map((cell) => cell.trim().replace(/^`|`$/g, ''));
      tabled.set(cells[1]!, cells.at(-2)!);
    }
    const declared = new Map(CONCURRENT_SESSIONS_ROWS.map((row) => [row.surface, row.status]));

    expect([...tabled.entries()].sort()).toEqual([...declared.entries()].sort());
  });

  it('the record names every evidence pointer the rows carry, so the reader can find the proof from the prose', async () => {
    const source = await readFile(RECORD, 'utf8');
    for (const row of CONCURRENT_SESSIONS_ROWS) {
      const title = POINTER.exec(row.evidencePointer)![2]!;
      expect(source, `${row.surface}: the record does not cite "${title}"`).toContain(title);
    }
  });
});
