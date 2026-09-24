import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { stubCommand, type StubHandle } from '../helpers/stub-command.js';

// RP-222 — "Detect duplicate ticket branches and PRs before parallel work".
// Before a controller claims a ticket, or ships a PR for one, it checks whether
// ANOTHER branch or open PR already carries the same ticket id — using only
// bounded, native git/GitHub evidence (`git ls-remote --heads origin`, `gh pr
// list --search`), never a branch registry this rig would have to keep in sync.
//
// This file is written against `.claude/scripts/duplicate-work.mjs` and its two
// wiring points (`layers.json`, the loop/pr-ship skills). This round folds in a
// gate's required fixes on top of the first pass: fail-closed caps on both
// sources, a third `not-applicable` source status (a rig with no `origin`, or
// an `origin` that does not name GitHub, is not stuck waiting on a source that
// can never answer), exit 1 never hiding a verdict that was already computed,
// and a handful of matching/exclusion corrections (`_` as a boundary
// character, cross-repository PRs, a detached HEAD). At the time this file was
// written, none of those required fixes exist in the script yet — that is the
// point of this pass.
//
// The independent oracle (`invariants.md`): every scenario's expected verdict
// comes from what the fixture itself set up — which branches were pushed to a
// REAL bare `origin`, and what a stubbed `gh` was told to answer — never from
// calling the script's own matching function to compute the "expected" value.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universalDir = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const scriptsDir = path.join(universalDir, '.claude', 'scripts');
const scriptPath = (name: string) => path.join(scriptsDir, name);
const load = (name: string) => import(pathToFileURL(scriptPath(name)).href);
const skillPath = (...parts: string[]) =>
  path.join(universalDir, '.claude', 'skills', ...parts, 'SKILL.md');

const { readFile } = await import('node:fs/promises');

// --- git plumbing, following revalidate.test.ts's gitFixture shape ---------

const { withoutGitLocation } = (await import(
  pathToFileURL(path.join(scriptsDir, 'preflight.mjs')).href
)) as {
  withoutGitLocation: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
};

const run = (
  file: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string; out: string }> =>
  new Promise((resolve) => {
    execFile(file, args, { cwd, env }, (error, stdout, stderr) => {
      resolve({
        code: error ? ((error as { code?: number }).code ?? 1) : 0,
        stdout,
        stderr,
        out: stdout + stderr,
      });
    });
  });

const git = async (args: string[], cwd: string): Promise<string> => {
  const result = await run(
    'git',
    ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args],
    cwd,
    withoutGitLocation(),
  );
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.out}`);
  return result.stdout.trim();
};

/** Clone `origin`, create `branch`, commit a trivial file, push it — a second
 *  controller's session, never touching the shared `checkout`'s own HEAD. */
const pushOtherBranch = async (root: string, origin: string, branch: string): Promise<void> => {
  const dir = await mkdtemp(path.join(root, 'other-'));
  await git(['clone', '-q', origin, dir], root);
  await git(['checkout', '-q', '-b', branch], dir);
  await writeFile(path.join(dir, 'note.txt'), `${branch}\n`);
  await git(['add', '-A'], dir);
  await git(['commit', '-q', '-m', `work on ${branch}`], dir);
  await git(['push', '-q', 'origin', branch], dir);
};

/**
 * Write `count` synthetic `refs/heads/<prefix><n>` entries, all pointing at
 * `sha` (a commit that already exists in `bareDir`, reused rather than
 * created `count` times), directly into the bare repo's `packed-refs` file.
 * `git ls-remote` reads the ref database, not the object graph, so this is a
 * fast, offline way to put an origin over the branch cap without spawning git
 * thousands of times or touching the network.
 */
const writeManyRefs = async (
  bareDir: string,
  sha: string,
  count: number,
  prefix: string,
): Promise<void> => {
  let body = '# pack-refs with: peeled fully-peeled sorted\n';
  for (let i = 0; i < count; i += 1) body += `${sha} refs/heads/${prefix}${i}\n`;
  await writeFile(path.join(bareDir, 'packed-refs'), body);
};

const hermeticEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  if (!('RIG_RUN_DIR' in extra)) delete env.RIG_RUN_DIR;
  return env;
};

interface DuplicateWorkMatch {
  source: string;
  ref: string;
  field: string;
  url?: string;
}
interface DuplicateWorkSourceStatus {
  name: string;
  status: string;
}
interface DuplicateWorkResult {
  ticket: string;
  verdict: string;
  matches: DuplicateWorkMatch[];
  sources: DuplicateWorkSourceStatus[];
}

const runCli = (
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; out: string; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      [scriptPath('duplicate-work.mjs'), ...args],
      { cwd, env },
      (error, stdout, stderr) => {
        resolve({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          out: stdout + stderr,
          stdout,
          stderr,
        });
      },
    );
  });

const runCliJson = async (
  cwd: string,
  ticket: string,
  env: NodeJS.ProcessEnv,
): Promise<DuplicateWorkResult> => {
  const result = await runCli(cwd, ['--ticket', ticket, '--json'], env);
  return JSON.parse(result.stdout.trim()) as DuplicateWorkResult;
};

/** A `gh` stub that answers `pr list` with a fixed array, everything else fails. */
const ghListing = (prs: Array<Record<string, unknown>>): Promise<StubHandle> =>
  stubCommand(
    'gh',
    [
      "if (args[0] === 'pr' && args[1] === 'list') {",
      `  return { stdout: ${JSON.stringify(JSON.stringify(prs))} + '\\n' };`,
      '}',
      'return { exitCode: 1 };',
    ].join('\n'),
  );

/**
 * A `gh` stub that answers `pr list` ONLY when invoked with exactly
 * `--limit <expectedLimit>`, refusing (a distinguishable non-zero exit, not a
 * parse failure) otherwise. This is the fixture-level assertion that the cap
 * fix asks `gh` for one row past the page size it treats as "read" —
 * round2.md item 1: "ask `gh` for `--limit 101`".
 */
const ghListingWithLimit = (
  expectedLimit: number,
  prs: Array<Record<string, unknown>>,
): Promise<StubHandle> =>
  stubCommand(
    'gh',
    [
      "if (args[0] === 'pr' && args[1] === 'list') {",
      "  const i = args.indexOf('--limit');",
      `  if (i === -1 || args[i + 1] !== ${JSON.stringify(String(expectedLimit))}) {`,
      "    process.stderr.write('gh stub: expected --limit " +
        expectedLimit +
        ", got ' + (args[i + 1] ?? '(none)') + '\\n');",
      '    return { exitCode: 2 };',
      '  }',
      `  return { stdout: ${JSON.stringify(JSON.stringify(prs))} + '\\n' };`,
      '}',
      'return { exitCode: 1 };',
    ].join('\n'),
  );

/** A `gh` that always fails, the way a missing binary or a network error would
 *  look to a caller reading its exit code and stderr. */
const ghFailing = (): Promise<StubHandle> =>
  stubCommand('gh', "process.stderr.write('gh: command not found\\n'); return { exitCode: 127 };");

describe('matchesTicket — a token match bounded by non-alphanumerics, never fuzzy', () => {
  it.each([
    ['RP-220', 'feat/rp-220-verified-claims', true],
    ['RP-220', 'fix/RP-220', true],
    ['RP-220', 'x (RP-220)', true],
    ['RP-220', 'rp-2200', false],
    ['RP-220', 'rp-22', false],
    ['RP-220', 'xrp-220', false],
    ['RP-220', 'feat/rp-2201-x', false],
    // `_` is itself a boundary, not a continuation of the id's word run — a
    // naive `\b`-based regex treats `_` as a word character (`\w` includes
    // it), so `rp-220_fix` would fail a plain `\bRP-220\b` match even though
    // no reasonable reading takes `220_fix` as one token with `220`.
    // round2.md, "cheap hardening": "`_` is a boundary too".
    ['RP-220', 'feat/rp-220_fix', true],
  ])('matchesTicket(%j, %j) -> %p', async (id, text, expected) => {
    const { matchesTicket } = await load('duplicate-work.mjs');
    expect(matchesTicket(id, text)).toBe(expected);
  });

  // The brief's second id shape: a bare issue number, matched only as `#<n>`
  // in a title or a `<type>/<n>-` branch token — never as a number loose in text.
  it.each([
    ['220', 'fix/220-my-work', true],
    ['220', 'closes #220', true],
    ['220', 'there were 220 of them', false],
    ['220', '2200', false],
  ])('matchesTicket(%j, %j) -> %p (bare issue number)', async (id, text, expected) => {
    const { matchesTicket } = await load('duplicate-work.mjs');
    expect(matchesTicket(id, text)).toBe(expected);
  });
});

describe('classify — precedence and the three source statuses', () => {
  // Independent oracle: these are pure-function calls against hand-built
  // `{ status, refs/items }` inputs — no acquisition, no CLI, no git/gh at
  // all — so the only thing under test is classify()'s own verdict logic.

  it('a match found from a READ source outranks an UNAVAILABLE other source', async () => {
    const { classify } = await load('duplicate-work.mjs');
    const result = classify({
      ticket: 'RP-1',
      ownBranch: 'feat/rp-9999-mine',
      branches: { status: 'unavailable', refs: [] },
      prs: {
        status: 'read',
        items: [{ headRefName: 'other/rp-1-x', title: 'x', url: 'https://example.invalid/pr/1' }],
      },
    });
    expect(result.verdict, JSON.stringify(result)).toBe('duplicate-work');
  });

  it('a NOT-APPLICABLE source contributes no matches and, alone, is still clean', async () => {
    const { classify } = await load('duplicate-work.mjs');
    const result = classify({
      ticket: 'RP-2',
      branches: { status: 'not-applicable', refs: [] },
      prs: { status: 'read', items: [] },
    });
    expect(result.verdict, JSON.stringify(result)).toBe('clean');
  });

  it('both sources not-applicable is still clean, never unverifiable', async () => {
    const { classify } = await load('duplicate-work.mjs');
    const result = classify({
      ticket: 'RP-3',
      branches: { status: 'not-applicable', refs: [] },
      prs: { status: 'not-applicable', items: [] },
    });
    expect(result.verdict, JSON.stringify(result)).toBe('clean');
  });

  it('an UNAVAILABLE source (unlike not-applicable) is unverifiable when nothing matched', async () => {
    const { classify } = await load('duplicate-work.mjs');
    const result = classify({
      ticket: 'RP-4',
      branches: { status: 'not-applicable', refs: [] },
      prs: { status: 'unavailable', items: [] },
    });
    expect(result.verdict, JSON.stringify(result)).toBe('unverifiable');
  });
});

describe('duplicate-work CLI — real git evidence, a stubbed gh', () => {
  let root: string;
  let origin: string;
  let checkout: string;
  const OWN_BRANCH = 'feat/rp-9002-my-work';

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'duplicate-work-'));
    origin = path.join(root, 'origin.git');
    checkout = path.join(root, 'checkout');
    await mkdir(origin);
    await git(['init', '--bare', '-b', 'master'], origin);
    await git(['clone', '-q', origin, checkout], root);
    await writeFile(path.join(checkout, 'README.md'), 'seed\n');
    await git(['add', '-A'], checkout);
    await git(['commit', '-q', '-m', 'seed'], checkout);
    await git(['push', '-q', '-u', 'origin', 'master'], checkout);
    // The shared checkout's own HEAD, pushed to origin — every later scenario
    // runs with this as `git rev-parse --abbrev-ref HEAD`, so it doubles as
    // the fixture for "own branch excluded" and (checked out detached,
    // below) "own branch NOT excluded" without needing a second checkout.
    await git(['checkout', '-q', '-b', OWN_BRANCH], checkout);
    await writeFile(path.join(checkout, 'a.txt'), 'a\n');
    await git(['add', '-A'], checkout);
    await git(['commit', '-q', '-m', 'own work'], checkout);
    await git(['push', '-q', '-u', 'origin', OWN_BRANCH], checkout);
  }, 30_000);

  it('exit 0, verdict clean — no other branch or PR carries the id, both sources read', async () => {
    const gh = await ghListing([]);
    try {
      const result = await runCli(checkout, ['--ticket', 'RP-9001'], hermeticEnv());
      expect(result.code, result.out).toBe(0);
      expect(result.out).toMatch(/clean/i);
    } finally {
      gh.restore();
    }
  });

  it('reports the shape { ticket, verdict, matches, sources } — a non-GitHub origin makes pr not-applicable', async () => {
    // This checkout's `origin` is a local bare-repo PATH, not a URL naming
    // `github.com` — round2.md item 2: "PR source: origin is not a GitHub
    // remote ... -> not-applicable". `gh` is stubbed to answer (it must never
    // be consulted here), so a `pr: read` in the old shape would mean the
    // applicability check never ran at all.
    const gh = await ghListing([]);
    try {
      const parsed = await runCliJson(checkout, 'RP-9012', hermeticEnv());
      expect(parsed.ticket).toBe('RP-9012');
      expect(parsed.verdict).toBe('clean');
      expect(parsed.matches).toEqual([]);
      expect(parsed.sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'branch', status: 'read' }),
          expect.objectContaining({ name: 'pr', status: 'not-applicable' }),
        ]),
      );
    } finally {
      gh.restore();
    }
  });

  it('exit 2, verdict duplicate-work — another branch on origin carries the id', async () => {
    await pushOtherBranch(root, origin, 'feat/rp-9003-another-session');
    const gh = await ghListing([]);
    try {
      const parsed = await runCliJson(checkout, 'RP-9003', hermeticEnv());
      expect(parsed.verdict).toBe('duplicate-work');
      const match = parsed.matches.find((m) => m.source === 'branch');
      expect(match, JSON.stringify(parsed)).toBeDefined();
      expect(match!.ref).toMatch(/rp-9003-another-session/i);
      expect(typeof match!.field).toBe('string');
      expect(match!.field.length).toBeGreaterThan(0);

      const text = await runCli(checkout, ['--ticket', 'RP-9003'], hermeticEnv());
      expect(text.code).toBe(2);
      expect(text.out).toMatch(/re-read/i);
      expect(text.out).toMatch(/take over/i);
      expect(text.out).toMatch(/tracker/i);
      expect(text.out).toMatch(/never start a second/i);
      // Text output quotes a ref via JSON.stringify, not a bare/backticked
      // interpolation — the independent oracle is JSON.stringify itself,
      // computed here by the test, never by the script under test.
      expect(text.out).toContain(JSON.stringify(match!.ref));
    } finally {
      gh.restore();
    }
  });

  it('exit 3, verdict unverifiable — no origin remote at all makes BOTH sources not-applicable (round2 gate decision)', async () => {
    // Deliberate contract change: round 1 shipped "no origin -> exit 3", which
    // code-reviewer's r1 HOLD (checklist item 4) showed makes the default
    // PLAN.md rig — the common case, no `origin` remote at all — unable to
    // ever claim anything, since the check always reports unverifiable. A rig
    // with no `origin` has nothing to compare against for either source
    // (nothing is shared, so no other controller can have pushed a branch or
    // opened a PR against it), so round2.md item 2 replaces the old
    // expectation: no origin is `clean`, with both sources `not-applicable`.
    const noRemote = await mkdtemp(path.join(root, 'no-origin-'));
    await git(['init', '-q', '-b', 'master'], noRemote);
    await writeFile(path.join(noRemote, 'x.txt'), 'x\n');
    await git(['add', '-A'], noRemote);
    await git(['commit', '-q', '-m', 'seed'], noRemote);
    // `gh` is stubbed to fail loudly — it must never even be asked when there
    // is no origin to be a GitHub remote of.
    const gh = await ghFailing();
    try {
      const parsed = await runCliJson(noRemote, 'RP-9010', hermeticEnv());
      expect(parsed.verdict, JSON.stringify(parsed)).toBe('clean');
      expect(parsed.sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'branch', status: 'not-applicable' }),
          expect.objectContaining({ name: 'pr', status: 'not-applicable' }),
        ]),
      );
      const text = await runCli(noRemote, ['--ticket', 'RP-9010'], hermeticEnv());
      expect(text.code, text.out).toBe(0);
    } finally {
      gh.restore();
    }
  });

  it('exit 3, verdict unverifiable — branch source hits the ref cap and fails closed, never a silent slice', async () => {
    // A separate bare origin, over MAX_REFS (5000) real refs, written directly
    // into `packed-refs` — offline and fast (round2.md, cheap hardening:
    // "generating 5,001 refs in a bare repo is acceptable if fast enough").
    // The old (round-1) behaviour sliced silently to the first 5,000 and
    // still reported `read` — security-scanner's r1 HOLD reproduced this as
    // "5,002 heads -> clean exit 0" with the duplicate past the cap. The fix
    // must report `unavailable` instead, never a truncated `read`.
    const capRoot = await mkdtemp(path.join(tmpdir(), 'duplicate-work-cap-'));
    const capOrigin = path.join(capRoot, 'origin.git');
    const capClient = path.join(capRoot, 'client');
    await mkdir(capOrigin);
    await git(['init', '--bare', '-b', 'master'], capOrigin);
    const seed = await mkdtemp(path.join(capRoot, 'seed-'));
    await git(['init', '-q', '-b', 'master'], seed);
    await writeFile(path.join(seed, 'x.txt'), 'x\n');
    await git(['add', '-A'], seed);
    await git(['commit', '-q', '-m', 'seed'], seed);
    await git(['push', '-q', capOrigin, 'master'], seed);
    const sha = await git(['rev-parse', 'master'], seed);
    await writeManyRefs(capOrigin, sha, 5001, 'cap-');

    await mkdir(capClient);
    await git(['init', '-q', '-b', 'master'], capClient);
    await git(['remote', 'add', 'origin', capOrigin], capClient);

    const gh = await ghListing([]);
    try {
      const parsed = await runCliJson(capClient, 'RP-9011', hermeticEnv());
      const branchSource = parsed.sources.find((s) => s.name === 'branch');
      expect(branchSource, JSON.stringify(parsed)).toBeDefined();
      expect(branchSource!.status).toBe('unavailable');
      expect(parsed.verdict).toBe('unverifiable');

      const text = await runCli(capClient, ['--ticket', 'RP-9011'], hermeticEnv());
      expect(text.code, text.out).toBe(3);
    } finally {
      gh.restore();
    }
  }, 30_000);

  it("detached HEAD — own-work exclusion misses, so the checkout's own branch is (mis)reported as a duplicate (pinned current behaviour)", async () => {
    // `git rev-parse --abbrev-ref HEAD` answers the literal string "HEAD" in
    // a detached checkout, which equals no real branch name, so the exact-
    // string exclusion the script documents as a design limit does not
    // recognise this checkout's own pushed branch (OWN_BRANCH) as its own —
    // round2.md, cheap hardening: "detached HEAD ... pin current behaviour".
    const detachedDir = await mkdtemp(path.join(root, 'detached-'));
    await git(['clone', '-q', origin, detachedDir], root);
    await git(['checkout', '-q', `origin/${OWN_BRANCH}`], detachedDir);
    const gh = await ghListing([]);
    try {
      const parsed = await runCliJson(detachedDir, 'RP-9002', hermeticEnv());
      expect(parsed.verdict, JSON.stringify(parsed)).toBe('duplicate-work');
      const match = parsed.matches.find((m) => m.source === 'branch');
      expect(match, JSON.stringify(parsed)).toBeDefined();
      expect(match!.ref).toBe(OWN_BRANCH);
    } finally {
      gh.restore();
    }
  }, 20_000);

  // 🔴 Exit code 1 alone is not evidence of the intended usage refusal: with
  // the script absent, node's own MODULE_NOT_FOUND also exits 1, and a test
  // that stopped at the exit code would "pass" against nothing. The two
  // assertions below rule that out: the output must mention the offending
  // flag/usage, and must NOT be a node stack trace.
  it('exit 1 — no --ticket given', async () => {
    const gh = await ghListing([]);
    try {
      const result = await runCli(checkout, [], hermeticEnv());
      expect(result.code, result.out).toBe(1);
      expect(result.out).not.toMatch(/MODULE_NOT_FOUND|Cannot find module|node:internal/);
      expect(result.out).toMatch(/--ticket|usage/i);
    } finally {
      gh.restore();
    }
  });

  it('exit 1 — an invalid --ticket value that is not a ticket-id or bare issue number shape', async () => {
    const gh = await ghListing([]);
    try {
      const result = await runCli(checkout, ['--ticket', 'not an id!!'], hermeticEnv());
      expect(result.code, result.out).toBe(1);
      expect(result.out).not.toMatch(/MODULE_NOT_FOUND|Cannot find module|node:internal/);
      expect(result.out).toMatch(/--ticket|usage/i);
    } finally {
      gh.restore();
    }
  });

  it('writes one duplicate-work event to events.jsonl when RIG_RUN_DIR is declared (clean path)', async () => {
    const runDir = await mkdtemp(path.join(tmpdir(), 'duplicate-work-run-'));
    const gh = await ghListing([]);
    try {
      const result = await runCli(
        checkout,
        ['--ticket', 'RP-9013'],
        hermeticEnv({ RIG_RUN_DIR: runDir }),
      );
      expect(result.code, result.out).toBe(0);
      const journal = (await load('run-journal.mjs')) as {
        readRun: (input: { runDir: string }) => { events: Array<{ kind: string; data: unknown }> };
      };
      const { events } = journal.readRun({ runDir });
      const own = events.filter((e) => e.kind === 'duplicate-work');
      expect(own, JSON.stringify(events)).toHaveLength(1);
      expect((own[0]!.data as { ticket?: string }).ticket).toBe('RP-9013');
    } finally {
      gh.restore();
    }
  });

  it('writes nothing when RIG_RUN_DIR is undeclared', async () => {
    const gh = await ghListing([]);
    try {
      const result = await runCli(checkout, ['--ticket', 'RP-9014'], hermeticEnv());
      expect(result.code, result.out).toBe(0);
      // No default run-directory convention may be invented under the cwd —
      // silent, like every other optional trace in this rig.
      expect(existsSync(path.join(checkout, '.claude', 'runs'))).toBe(false);
    } finally {
      gh.restore();
    }
  });

  it('writes the duplicate-work event on the DUPLICATE path too, not only when clean', async () => {
    // Round 1's only journal test ran the clean path; round2.md's cheap
    // hardening asks for the duplicate path explicitly, so a journal write
    // that only fires before the verdict is known cannot silently drop the
    // interesting case.
    const runDir = await mkdtemp(path.join(tmpdir(), 'duplicate-work-run-dup-'));
    const gh = await ghListing([]);
    try {
      const result = await runCli(
        checkout,
        ['--ticket', 'RP-9003'],
        hermeticEnv({ RIG_RUN_DIR: runDir }),
      );
      expect(result.code, result.out).toBe(2);
      const journal = (await load('run-journal.mjs')) as {
        readRun: (input: { runDir: string }) => { events: Array<{ kind: string; data: unknown }> };
      };
      const { events } = journal.readRun({ runDir });
      const own = events.filter((e) => e.kind === 'duplicate-work');
      expect(own, JSON.stringify(events)).toHaveLength(1);
      const data = own[0]!.data as { ticket?: string; verdict?: string };
      expect(data.ticket).toBe('RP-9003');
      expect(data.verdict).toBe('duplicate-work');
    } finally {
      gh.restore();
    }
  });

  it("a journal write failure still prints the verdict, and the exit code is the verdict's — never the usage-refusal 1", async () => {
    // round2.md item 3: "Exit 1 never hides a verdict. Print the verdict
    // (text or JSON) BEFORE journalling; a journal write failure is a stderr
    // warning and the exit code stays the verdict's." Round 1's script wrote
    // the stderr warning and called `process.exit(1)` on any non-trace-
    // exhausted journal error, WITHOUT ever printing the verdict — so a
    // caller reading exit 1 could not tell "usage refusal" from "there may or
    // may not be a duplicate, we just don't know".
    //
    // A `RIG_RUN_DIR` that names an existing FILE, not a directory, is a
    // real, non-trace-exhausted refusal from `run-journal.mjs`'s own
    // `recordEvent` (`failure: 'run-dir-missing'`, `isTraceExhausted() ===
    // false`) — an independent oracle, not a stub of the failure this test
    // needs. (A run directory that has already ended was tried first, but
    // `isTraceExhausted` answers `true` for that one, which takes the OTHER,
    // already-correct branch — it does not exercise this bug at all.)
    const runRoot = await mkdtemp(path.join(tmpdir(), 'duplicate-work-run-notadir-'));
    const runDir = path.join(runRoot, 'not-a-directory');
    await writeFile(runDir, 'x\n');

    const gh = await ghListing([]);
    try {
      // RP-9003 already carries a real duplicate branch (pushed above), so
      // the exit code under test is 2 — the verdict's own code — never the
      // usage-refusal 1, and never the accidental-default 0.
      const result = await runCli(
        checkout,
        ['--ticket', 'RP-9003'],
        hermeticEnv({ RIG_RUN_DIR: runDir }),
      );
      expect(result.code, result.out).toBe(2);
      expect(result.out).toMatch(/duplicate-work/i);
    } finally {
      gh.restore();
    }
  });
});

describe('duplicate-work CLI — a GitHub-looking origin', () => {
  // The PR source is only ever consulted when `origin` names GitHub
  // (round2.md item 2), so every PR-focused scenario below needs an origin
  // URL that reads as GitHub — without touching the real network, which a
  // sandboxed or offline run cannot rely on. `bogus://github.com/...` names
  // `github.com` exactly like a real GitHub remote would, and git refuses it
  // LOCALLY and immediately ("git: 'remote-bogus' is not a git command" — no
  // DNS, no TCP, no hang) the moment anything tries to actually reach it, so
  // `git ls-remote --heads origin` (the branch source) fails fast too. These
  // tests only assert on the `pr` source and the overall verdict/exit code,
  // never on the `branch` source's status, for exactly that reason.
  let ghRoot: string;
  let ghCheckout: string;
  const GH_OWN_BRANCH = 'feat/rp-9020-github-fixture';

  beforeAll(async () => {
    ghRoot = await mkdtemp(path.join(tmpdir(), 'duplicate-work-gh-'));
    ghCheckout = path.join(ghRoot, 'checkout');
    await mkdir(ghCheckout);
    await git(['init', '-q', '-b', 'master'], ghCheckout);
    await writeFile(path.join(ghCheckout, 'README.md'), 'seed\n');
    await git(['add', '-A'], ghCheckout);
    await git(['commit', '-q', '-m', 'seed'], ghCheckout);
    await git(['checkout', '-q', '-b', GH_OWN_BRANCH], ghCheckout);
    await git(['remote', 'add', 'origin', 'bogus://github.com/acme/widgets.git'], ghCheckout);
  }, 20_000);

  it("exit 0 — the checkout's own open PR (same repository) is excluded", async () => {
    const gh = await ghListing([
      {
        number: 1,
        title: 'chore: my own work',
        headRefName: GH_OWN_BRANCH,
        url: 'https://example.invalid/acme/widgets/pull/1',
        isCrossRepository: false,
      },
    ]);
    try {
      // Only the `pr` source and its matches are asserted on here — this
      // fixture's `branch` source is deliberately unreachable (see the
      // describe-block header), so the overall verdict/exit code is not a
      // property of the own-PR-exclusion logic this test exists to pin.
      const parsed = await runCliJson(ghCheckout, 'RP-9020', hermeticEnv());
      const prSource = parsed.sources.find((s) => s.name === 'pr');
      expect(prSource?.status, JSON.stringify(parsed)).toBe('read');
      const match = parsed.matches.find((m) => m.source === 'pr');
      expect(match, JSON.stringify(parsed)).toBeUndefined();
    } finally {
      gh.restore();
    }
  });

  it('exit 2 — a FORK PR with the same head branch name is NOT excluded (cross-repository)', async () => {
    // round2.md, cheap hardening: own-PR exclusion also requires the PR not
    // be cross-repository, "so a fork PR with the same branch name is not
    // hidden". `headRefName` alone is not enough to prove "this is my PR" —
    // a fork can name its branch anything, including this checkout's own.
    const gh = await ghListing([
      {
        number: 2,
        title: 'chore: a fork working the same ticket',
        headRefName: GH_OWN_BRANCH,
        url: 'https://example.invalid/someone-else/widgets/pull/2',
        isCrossRepository: true,
      },
    ]);
    try {
      // Same reasoning as the previous test: assert on the `pr` source's own
      // match, not the overall verdict (this fixture's `branch` source is
      // deliberately unreachable — see the describe-block header).
      const parsed = await runCliJson(ghCheckout, 'RP-9020', hermeticEnv());
      const prSource = parsed.sources.find((s) => s.name === 'pr');
      expect(prSource?.status, JSON.stringify(parsed)).toBe('read');
      const match = parsed.matches.find((m) => m.source === 'pr');
      expect(match, JSON.stringify(parsed)).toBeDefined();
      expect(match!.ref).toBe(GH_OWN_BRANCH);
    } finally {
      gh.restore();
    }
  });

  it('exit 2, source pr — an open PR from another branch carries the id in its title', async () => {
    const gh = await ghListing([
      {
        number: 7,
        title: 'fix: add a route (RP-9021)',
        headRefName: 'fix/some-other-branch',
        url: 'https://example.invalid/acme/widgets/pull/7',
        isCrossRepository: false,
      },
    ]);
    try {
      const parsed = await runCliJson(ghCheckout, 'RP-9021', hermeticEnv());
      expect(parsed.verdict).toBe('duplicate-work');
      const match = parsed.matches.find((m) => m.source === 'pr');
      expect(match, JSON.stringify(parsed)).toBeDefined();
      expect(match!.field).toBe('title');
      expect(match!.url).toBe('https://example.invalid/acme/widgets/pull/7');
    } finally {
      gh.restore();
    }
  });

  it("exit 0 — gh's fuzzy search returns a PR whose title/head do not carry the exact token, filtered out client-side", async () => {
    const gh = await ghListing([
      {
        number: 8,
        title: 'chore: unrelated RP-90220 cleanup',
        headRefName: 'chore/rp-90220-cleanup',
        url: 'https://example.invalid/acme/widgets/pull/8',
        isCrossRepository: false,
      },
    ]);
    try {
      // Assert on the `pr` source and its matches only — see the
      // describe-block header on why the overall verdict is not asserted here.
      const parsed = await runCliJson(ghCheckout, 'RP-9022', hermeticEnv());
      const prSource = parsed.sources.find((s) => s.name === 'pr');
      expect(prSource?.status, JSON.stringify(parsed)).toBe('read');
      const match = parsed.matches.find((m) => m.source === 'pr');
      expect(match, JSON.stringify(parsed)).toBeUndefined();
    } finally {
      gh.restore();
    }
  });

  it('exit 3, verdict unverifiable — gh is missing/failing on a GitHub origin, never reported as clean', async () => {
    const gh = await ghFailing();
    try {
      const parsed = await runCliJson(ghCheckout, 'RP-9023', hermeticEnv());
      expect(parsed.verdict).toBe('unverifiable');
      expect(parsed.verdict).not.toBe('clean');
      const prSource = parsed.sources.find((s) => s.name === 'pr');
      expect(prSource, JSON.stringify(parsed)).toBeDefined();
      expect(prSource!.status).toBe('unavailable');

      const text = await runCli(ghCheckout, ['--ticket', 'RP-9023'], hermeticEnv());
      expect(text.code).toBe(3);
    } finally {
      gh.restore();
    }
  });

  it('exit 3 — 101 open PRs is the cap: pr source unavailable, never a silent read of the first 100', async () => {
    // round2.md item 1: "ask gh for --limit 101; 101 rows -> PR source
    // unavailable (cap), never read." The stub only answers when asked with
    // exactly `--limit 101`, so an implementation that still asks for 100
    // (round 1's behaviour) fails this for that reason alone.
    const prs = Array.from({ length: 101 }, (_, i) => ({
      number: i,
      title: `chore: unrelated pr ${i}`,
      headRefName: `chore/unrelated-${i}`,
      url: `https://example.invalid/acme/widgets/pull/${i}`,
      isCrossRepository: false,
    }));
    const gh = await ghListingWithLimit(101, prs);
    try {
      const parsed = await runCliJson(ghCheckout, 'RP-9024', hermeticEnv());
      const prSource = parsed.sources.find((s) => s.name === 'pr');
      expect(prSource, JSON.stringify(parsed)).toBeDefined();
      expect(prSource!.status).toBe('unavailable');
      expect(parsed.verdict).toBe('unverifiable');

      const text = await runCli(ghCheckout, ['--ticket', 'RP-9024'], hermeticEnv());
      expect(text.code, text.out).toBe(3);
    } finally {
      gh.restore();
    }
  });

  it('exit 2 — exactly 100 open PRs is under the cap: pr source stays read, and a real match is still found', async () => {
    const prs = [
      ...Array.from({ length: 99 }, (_, i) => ({
        number: i,
        title: `chore: unrelated pr ${i}`,
        headRefName: `chore/unrelated-${i}`,
        url: `https://example.invalid/acme/widgets/pull/${i}`,
        isCrossRepository: false,
      })),
      {
        number: 999,
        title: 'fix: the real duplicate (RP-9025)',
        headRefName: 'fix/rp-9025-elsewhere',
        url: 'https://example.invalid/acme/widgets/pull/999',
        isCrossRepository: false,
      },
    ];
    expect(prs).toHaveLength(100);
    const gh = await ghListingWithLimit(101, prs);
    try {
      // Assert on the `pr` source and its matches only — see the
      // describe-block header on why the overall verdict is not asserted here.
      const parsed = await runCliJson(ghCheckout, 'RP-9025', hermeticEnv());
      const prSource = parsed.sources.find((s) => s.name === 'pr');
      expect(prSource?.status, JSON.stringify(parsed)).toBe('read');
      const match = parsed.matches.find((m) => m.source === 'pr');
      expect(match, JSON.stringify(parsed)).toBeDefined();
      expect(match!.ref).toBe('fix/rp-9025-elsewhere');
    } finally {
      gh.restore();
    }
  });
});

describe('duplicate-work.mjs is wired into the workflow layer', () => {
  it('layers.json lists the script under the workflow array', async () => {
    const manifest = JSON.parse(
      await readFile(path.join(universalDir, 'layers.json'), 'utf8'),
    ) as Record<string, string[]>;
    expect(manifest['workflow']).toContain('.claude/scripts/duplicate-work.mjs');
  });

  it('the loop skill names duplicate-work.mjs before a claim', async () => {
    const content = await readFile(skillPath('loop'), 'utf8');
    expect(content).toMatch(/duplicate-work\.mjs/);
  });

  it('the pr-ship skill names duplicate-work.mjs as a HOLD blocker before the PR', async () => {
    const content = await readFile(skillPath('pr-ship'), 'utf8');
    expect(content).toMatch(/duplicate-work\.mjs/);
  });

  // The assertions below read only the "Opening" bullet of loop §9 (where
  // round 1 already placed the duplicate-work call) and the "Duplicate work"
  // step of pr-ship (same), not the whole file — `plan-md`, `adapter` and
  // `owner-directed` are common words elsewhere in both skills for unrelated
  // reasons, so a whole-file `.toMatch` would pass today by coincidence and
  // prove nothing about this mechanism's own wiring text.
  describe('loop §9 Opening — the applicability caveat and the any-exit-but-0 rule', () => {
    const openingSection = async (): Promise<string> => {
      const content = await readFile(skillPath('loop'), 'utf8');
      const start = content.indexOf('Before that claim, run');
      const end = content.indexOf('- **Closing:**');
      expect(start, 'anchor "Before that claim, run" not found in loop/SKILL.md').toBeGreaterThan(
        -1,
      );
      expect(end, 'anchor "- **Closing:**" not found in loop/SKILL.md').toBeGreaterThan(start);
      return content.slice(start, end);
    };

    it('says the check is not run under plan-md, whose item ids are list positions', async () => {
      const section = await openingSection();
      expect(section).toMatch(/plan-md/i);
      expect(section).toMatch(/list position/i);
      expect(section).toMatch(/not run/i);
    });

    it('says any exit other than 0 is not clean', async () => {
      const section = await openingSection();
      expect(section).toMatch(/any exit/i);
      expect(section).toMatch(/other than 0/i);
      expect(section).toMatch(/not clean/i);
    });

    it('names escalating through the adapter, and deleting the uncommitted SELECT baseline', async () => {
      const section = await openingSection();
      expect(section).toMatch(/adapter/i);
      expect(section).toMatch(/escalat/i);
      expect(section).toMatch(/uncommitted/i);
      expect(section).toMatch(/baseline/i);
    });
  });

  describe('pr-ship step 1 — anything but 0 is a HOLD, owner-directed branches skip it', () => {
    const step1Section = async (): Promise<string> => {
      const content = await readFile(skillPath('pr-ship'), 'utf8');
      const start = content.indexOf('Duplicate work, before anything else');
      const end = content.indexOf('**The diff first');
      expect(
        start,
        'anchor "Duplicate work, before anything else" not found in pr-ship/SKILL.md',
      ).toBeGreaterThan(-1);
      expect(end, 'anchor "**The diff first" not found in pr-ship/SKILL.md').toBeGreaterThan(start);
      return content.slice(start, end);
    };

    it('says anything but 0 is a HOLD', async () => {
      const section = await step1Section();
      expect(section).toMatch(/anything but 0/i);
      expect(section).toMatch(/HOLD/);
    });

    it('says an owner-directed branch (no ticket id) skips the check', async () => {
      const section = await step1Section();
      expect(section).toMatch(/owner-directed/i);
      expect(section).toMatch(/skip/i);
    });
  });
});
