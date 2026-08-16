import { execFile } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

// AR3-5: the decision router — the dispatcher that decides WHICH gate a change
// deserves, in ascending order of cost (deterministic → fast-path → model), with
// risk flags escalating ahead of all three and one journal line per verdict at
// every gate.
//
// It is deliberately NOT `pr-ship`. `pr-ship` is the merge-time gate and it always
// runs the expensive path; this decides whether the expensive path is warranted at
// all, because today there is no cheap lane for docs/no-code work.
//
// 🔴 The direction a defect points here is not symmetric, and the tests below are
// written around that: routing an expensive change into a cheap lane loses the
// review; routing a cheap change into the expensive lane only costs tokens. So
// every "falls through to `model`" case (an unknown classification, a rulebook
// file, a risk flag) is pinned, and the cheap lanes are pinned narrowly.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const scriptsDir = path.join(universal, '.claude', 'scripts');
const modulePath = path.join(scriptsDir, 'decision-router.mjs');

// The child processes below get an explicit environment from the shipped helper,
// never a hand-rolled second copy of the list (`invariants.md`: one mechanism, one
// implementation). An inherited relative `GIT_INDEX_FILE` is a live scar here.
const { withoutGitLocation } = (await import(
  pathToFileURL(path.join(scriptsDir, 'git-env.mjs')).href
)) as { withoutGitLocation: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv };

const journal = (await import(pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href)) as {
  readRun: (input: { runDir: string }) => {
    decisions: Array<Record<string, unknown>>;
    events: Array<Record<string, unknown>>;
    ended: boolean;
  };
};

interface RiskFlag {
  flag: string;
  files: string[];
  why: string;
}

interface GateLine {
  gate: string;
  verdict: string;
  why: string;
}

interface Routed {
  lane: string;
  reviewers: string[];
  gates: GateLine[];
  risks: RiskFlag[];
  why: string;
}

interface Router {
  LANES: readonly string[];
  GATES: readonly string[];
  VERDICTS: readonly string[];
  RISK_FLAGS: readonly string[];
  classifyFile(file: unknown): string;
  riskFlagsIn(files: unknown, options?: { elevatedPaths?: readonly string[] }): RiskFlag[];
  route(input: Record<string, unknown>): Routed;
}

/**
 * Loaded lazily, inside each test, exactly as `run-journal.test.ts` does — nothing
 * here pins the module to a sync or an async implementation, and a load failure is
 * reported per behaviour rather than as one collection error.
 */
const load = async (): Promise<Router> =>
  (await import(pathToFileURL(modulePath).href)) as unknown as Router;

const source = (): Promise<string> => readFile(modulePath, 'utf8');

/** The declaration the route tests share; the shape a generated project ships. */
const ELEVATED = ['packages/db/src/', '.claude/', '.github/workflows/', 'infra/'];

const tempDirs: string[] = [];
const temp = async (prefix: string): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * The refusal, whichever way it arrives. A sync `throw` and a rejected promise are
 * both a refusal; "returned a value" is not, and is reported as itself.
 */
const refusalFrom = async (call: () => unknown): Promise<Error> => {
  let outcome: unknown;
  try {
    outcome = await call();
  } catch (error) {
    return error as Error;
  }
  throw new Error(`expected a refusal, but the call returned ${JSON.stringify(outcome)}`);
};

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Both streams, for assertion messages that only need something readable. */
  out: string;
}

/**
 * One child run of the router CLI, with the two streams KEPT APART: the lane is a
 * value on stdout and a diagnosis is on stderr, and concatenating them makes the
 * two outcomes this suite must distinguish look identical.
 */
const runCli = (args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<CliResult> =>
  new Promise((resolve) => {
    execFile(process.execPath, [modulePath, ...args], { cwd, env }, (error, stdout, stderr) => {
      resolve({
        code: error ? ((error as { code?: number }).code ?? 1) : 0,
        stdout,
        stderr,
        out: stdout + stderr,
      });
    });
  });

describe('the vocabulary is closed, ordered and frozen', () => {
  it('names the three lanes in ascending order of cost', async () => {
    const { LANES } = await load();
    expect([...LANES]).toEqual(['deterministic', 'fast-path', 'model']);
    expect(Object.isFrozen(LANES)).toBe(true);
  });

  it('evaluates risk flags ahead of all three lanes', async () => {
    const { GATES } = await load();
    // The order IS the contract: a risk flag that were evaluated after the cheap
    // lanes could not escalate anything — the change would already be routed.
    expect([...GATES]).toEqual(['risk-flags', 'deterministic', 'fast-path', 'model']);
    expect(Object.isFrozen(GATES)).toBe(true);
  });

  it('names every verdict a gate may return', async () => {
    const { VERDICTS } = await load();
    expect([...VERDICTS]).toEqual(['clear', 'escalate', 'route', 'decline', 'skipped']);
    expect(Object.isFrozen(VERDICTS)).toBe(true);
  });

  it('names every risk flag that can escalate a change', async () => {
    const { RISK_FLAGS } = await load();
    expect([...RISK_FLAGS]).toEqual(['elevated-path', 'security-surface', 'test-removed']);
    expect(Object.isFrozen(RISK_FLAGS)).toBe(true);
  });
});

describe('classifyFile — what kind of file this is', () => {
  it('calls a mechanically generated artifact derived', async () => {
    const { classifyFile } = await load();
    for (const file of [
      'packages/cli/dist/index.js',
      'dist/bundle.js',
      'packages/core/src/schema.generated.ts',
    ]) {
      // Its drift is already caught by a check that costs nothing, so paying a
      // model for it buys no information.
      expect(classifyFile(file), file).toBe('derived');
    }
  });

  it('does NOT call a test snapshot derived — a snapshot is the behaviour claim', async () => {
    const { classifyFile } = await load();
    // 🔴 It was `derived` for one review round, which put a snapshot rewrite on
    // the lane that launches no reviewer. A snapshot is not generator output
    // whose drift a check catches: it is rewritten by the test run that then
    // passes by construction, so routing it cheaply is weakening a test.
    expect(classifyFile('test/__snapshots__/render.test.ts.snap')).toBe('code');
  });

  it('calls ordinary documentation prose', async () => {
    const { classifyFile } = await load();
    for (const file of ['README.md', 'docs/notes.mdx', 'NOTES.txt', 'PLAN.md']) {
      expect(classifyFile(file), file).toBe('prose');
    }
  });

  it('calls a rulebook document code, because here the prose IS the implementation', async () => {
    const { classifyFile } = await load();
    for (const file of [
      'CLAUDE.md',
      'templates/agent-os/universal/CLAUDE.md',
      '.claude/rules/autonomy.md',
      'templates/agent-os/universal/.claude/skills/loop/SKILL.md',
      '.claude/agents/code-reviewer.md',
    ]) {
      // 🔴 The single most expensive misroute available: a change that rewrites
      // the autonomy tiers is a `.md`, and a router that reads extensions would
      // hand it to the prose lane.
      expect(classifyFile(file), file).toBe('code');
    }
  });

  it('calls every source, config and test file code', async () => {
    const { classifyFile } = await load();
    for (const file of [
      'packages/core/src/note.ts',
      'package.json',
      'services/api/test/create-note.test.ts',
      '.github/workflows/ci.yml',
      'scripts/prepare.mjs',
    ]) {
      expect(classifyFile(file), file).toBe('code');
    }
  });

  it('calls a path it cannot read unknown rather than guessing a kind', async () => {
    const { classifyFile } = await load();
    for (const file of ['', '   ', null, undefined, 42, {}, []]) {
      expect(classifyFile(file), JSON.stringify(file)).toBe('unknown');
    }
  });
});

describe('riskFlagsIn — what escalates ahead of the ladder', () => {
  it('fires elevated-path on a file the declaration covers', async () => {
    const { riskFlagsIn } = await load();
    const flags = riskFlagsIn(['infra/lib/app-stack.ts', 'src/note.ts'], {
      elevatedPaths: ELEVATED,
    });
    expect(flags.map((f) => f.flag)).toEqual(['elevated-path']);
    expect(flags[0]?.files).toEqual(['infra/lib/app-stack.ts']);
    expect(flags[0]?.why).toBeTruthy();
  });

  it('reads the elevated set through detect-missed-gate rather than a second copy', async () => {
    const { riskFlagsIn } = await load();
    // Behavioural half of "one mechanism, one implementation": `elevatedPathsIn`
    // exempts inert prose inside an elevated directory and recognises a rulebook
    // wherever it sits. A reimplementation here would drift from both, and each
    // copy would keep passing its own tests.
    expect(
      riskFlagsIn(['infra/README.md'], { elevatedPaths: ELEVATED }).map((f) => f.flag),
    ).toEqual([]);
    expect(
      riskFlagsIn(['.claude/rules/autonomy.md'], { elevatedPaths: ELEVATED })[0]?.files,
    ).toEqual(['.claude/rules/autonomy.md']);
  });

  it('imports the elevated set instead of keeping a second copy of it', async () => {
    expect(await source()).toMatch(
      /import\s*\{[^}]*elevatedPathsIn[^}]*\}\s*from\s*['"]\.\/detect-missed-gate\.mjs['"]/,
    );
  });

  it('fires security-surface on a dependency manifest or a lockfile', async () => {
    const { riskFlagsIn } = await load();
    for (const file of ['package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock']) {
      // A dependency change is the supply chain; it is never a cheap lane.
      expect(
        riskFlagsIn([file], { elevatedPaths: [] }).map((f) => f.flag),
        file,
      ).toEqual(['security-surface']);
    }
  });

  it('fires security-surface on a path that names auth, secrets or sessions', async () => {
    const { riskFlagsIn } = await load();
    for (const file of [
      'services/api/src/handlers/auth.ts',
      'src/auth/index.ts',
      'config/secrets.json',
      'packages/shared/src/credentials.ts',
      'src/token.ts',
      'src/session.ts',
      'apps/web/src/permissions.ts',
    ]) {
      expect(
        riskFlagsIn([file], { elevatedPaths: [] }).map((f) => f.flag),
        file,
      ).toEqual(['security-surface']);
    }
  });

  it('does not call a word that merely contains those letters a security surface', async () => {
    const { riskFlagsIn } = await load();
    // A router that escalates everything routes nothing: the whole value of the
    // cheap lanes is that ordinary work reaches them. `tokenizer` and `authoring`
    // are the two shapes this repository actually contains.
    for (const file of ['packages/core/src/tokenizer.ts', 'docs/authoring-guide.txt']) {
      expect(riskFlagsIn([file], { elevatedPaths: [] }), file).toEqual([]);
    }
  });

  it('fires test-removed only when a test file was actually removed', async () => {
    const { riskFlagsIn } = await load();
    for (const file of [
      'packages/core/test/note.test.ts',
      'src/note.spec.js',
      'tests/helpers/build.ts',
      '__tests__/helper.ts',
    ]) {
      const flags = riskFlagsIn([{ path: file, status: 'removed' }], { elevatedPaths: [] });
      expect(
        flags.map((f) => f.flag),
        file,
      ).toEqual(['test-removed']);
      expect(flags[0]?.files, file).toEqual([file]);
    }
  });

  it('does not fire test-removed on a test that was merely changed', async () => {
    const { riskFlagsIn } = await load();
    // Deleting a test is the one edit the rulebook calls Never; editing one is
    // the ordinary motion of TDD, and confusing the two escalates every task.
    expect(
      riskFlagsIn([{ path: 'packages/core/test/note.test.ts', status: 'modified' }], {
        elevatedPaths: [],
      }),
    ).toEqual([]);
    expect(riskFlagsIn(['packages/core/test/note.test.ts'], { elevatedPaths: [] })).toEqual([]);
  });

  it('does not fire test-removed on a removed file that is not a test', async () => {
    const { riskFlagsIn } = await load();
    expect(
      riskFlagsIn([{ path: 'src/note.ts', status: 'removed' }], { elevatedPaths: [] }).map(
        (f) => f.flag,
      ),
    ).toEqual([]);
  });

  it('accepts plain strings and status records in the same list', async () => {
    const { riskFlagsIn } = await load();
    const flags = riskFlagsIn(
      [
        'src/note.ts',
        { path: 'packages/core/test/note.test.ts', status: 'removed' },
        'package.json',
        { path: 'infra/lib/app-stack.ts', status: 'modified' },
      ],
      { elevatedPaths: ELEVATED },
    );
    const { RISK_FLAGS } = await load();
    expect([...new Set(flags.map((f) => f.flag))].sort()).toEqual(
      ['elevated-path', 'security-surface', 'test-removed'].sort(),
    );
    // no flag reported twice, and nothing outside the closed vocabulary
    expect(flags).toHaveLength(new Set(flags.map((f) => f.flag)).size);
    for (const flag of flags) expect(RISK_FLAGS).toContain(flag.flag);
  });

  it('reports no risk for a list with nothing risky in it', async () => {
    const { riskFlagsIn } = await load();
    expect(riskFlagsIn(['README.md', 'src/note.ts'], { elevatedPaths: ELEVATED })).toEqual([]);
    // the absence-is-not-a-change refusal belongs to `route`, not here
    expect(riskFlagsIn([], { elevatedPaths: ELEVATED })).toEqual([]);
  });
});

describe('route — the ladder in ascending order of cost', () => {
  const verdictOf = (result: Routed, gate: string): string | undefined =>
    result.gates.find((line) => line.gate === gate)?.verdict;

  it('routes a change that only touches derived artifacts to the deterministic lane', async () => {
    const { route } = await load();
    const result = route({
      // The lane that launches NO reviewer needs git to say the file was drift.
      // A status-less entry has not been measured, and unmeasured is not
      // `modified` — see the status test below.
      files: [
        { path: 'dist/bundle.js', status: 'modified' },
        { path: 'packages/cli/dist/index.js', status: 'modified' },
      ],
      elevatedPaths: ELEVATED,
    });
    expect(result.lane).toBe('deterministic');
    expect(result.reviewers).toEqual([]);
    expect(verdictOf(result, 'risk-flags')).toBe('clear');
    expect(verdictOf(result, 'deterministic')).toBe('route');
    // the two costlier gates were never reached, and say so
    expect(verdictOf(result, 'fast-path')).toBe('skipped');
    expect(verdictOf(result, 'model')).toBe('skipped');
  });

  it('routes ordinary documentation to the fast path with the prose reviewer', async () => {
    const { route } = await load();
    const result = route({ files: ['README.md', 'docs/notes.mdx'], elevatedPaths: ELEVATED });
    expect(result.lane).toBe('fast-path');
    expect(result.reviewers).toEqual(['prose-reviewer']);
    expect(verdictOf(result, 'deterministic')).toBe('decline');
    expect(verdictOf(result, 'fast-path')).toBe('route');
    expect(verdictOf(result, 'model')).toBe('skipped');
  });

  it('keeps derived files in the fast path when prose travels with them', async () => {
    const { route } = await load();
    const result = route({
      files: ['README.md', { path: 'dist/bundle.js', status: 'modified' }],
      elevatedPaths: ELEVATED,
    });
    expect(result.lane).toBe('fast-path');
    expect(result.reviewers).toEqual(['prose-reviewer']);
  });

  it('will not let one .md carry an untrusted derived file into the fast path', async () => {
    const { route } = await load();
    // 🔴 The regression this pins was introduced by the fix for the previous
    // test's sibling: `deterministic` learned to require a trusted status, the
    // file moved into a new counter, and `fast-path` never read it. Measured
    // consequence — adding `src/x.generated.ts` beside one `.md` edit routed to
    // `fast-path`, whose only reviewer is scoped to documents that instruct
    // agents. Adding a derived-looking filename was a one-line way to drop
    // `code-reviewer`.
    for (const derived of [
      { path: 'src/payments.generated.ts', status: 'added' },
      { path: 'apps/web/dist/main.js', status: 'added' },
      'src/payments.generated.ts', // no status at all: the `--files` form
    ]) {
      const result = route({ files: ['docs/notes.md', derived], elevatedPaths: ELEVATED });
      expect(result.lane, JSON.stringify(derived)).toBe('model');
      expect(result.reviewers).toContain('code-reviewer');
    }
  });

  it('says WHICH count refused the cheap lane, rather than a reason that is false', async () => {
    const { route } = await load();
    // The gate lines are the only record of why a cheap gate declined, and for
    // one round they said "not every changed file is a derived artifact" about
    // a change where every file was one.
    const result = route({
      files: [{ path: 'dist/bundle.js', status: 'added' }],
      elevatedPaths: ELEVATED,
    });
    expect(result.lane).toBe('model');
    const declined = result.gates.find((g) => g.gate === 'deterministic');
    expect(declined?.verdict).toBe('decline');
    expect(declined?.why).toMatch(/status/i);
    expect(declined?.why).not.toMatch(/not every changed file is a derived artifact/);
    expect(result.why).toMatch(/status/i);
  });

  it('routes code to the model lane with the code reviewer first', async () => {
    const { route } = await load();
    const result = route({ files: ['packages/core/src/note.ts'], elevatedPaths: ELEVATED });
    expect(result.lane).toBe('model');
    expect(result.reviewers).toEqual(['code-reviewer']);
    expect(verdictOf(result, 'deterministic')).toBe('decline');
    expect(verdictOf(result, 'fast-path')).toBe('decline');
    expect(verdictOf(result, 'model')).toBe('route');
  });

  it('adds the prose reviewer when the model lane also carries a document', async () => {
    const { route } = await load();
    const result = route({
      files: ['packages/core/src/note.ts', 'README.md'],
      elevatedPaths: ELEVATED,
    });
    expect(result.reviewers).toEqual(['code-reviewer', 'prose-reviewer']);
  });

  it('never gives a rulebook change the prose fast lane', async () => {
    const { route } = await load();
    // `CLAUDE.md` is not under any declared elevated prefix here, so nothing
    // escalates it — it reaches the model lane on its CLASSIFICATION alone. That
    // is the property under test: rulebook prose is implementation.
    const result = route({ files: ['CLAUDE.md'], elevatedPaths: ELEVATED });
    expect(result.risks).toEqual([]);
    expect(result.lane).toBe('model');
    expect(result.reviewers).toEqual(['code-reviewer', 'prose-reviewer']);
  });

  it('sends a file it could not classify to the model lane', async () => {
    const { route } = await load();
    expect(route({ files: [42], elevatedPaths: ELEVATED }).lane).toBe('model');
    // and one unreadable entry is enough to take the whole change out of a cheap
    // lane — an unknown is not a small change, it is an unmeasured one.
    expect(route({ files: ['README.md', { path: null }], elevatedPaths: ELEVATED }).lane).toBe(
      'model',
    );
  });
});

describe('a risk flag escalates ahead of the three lanes', () => {
  it('sends a change to the model lane when any flag fired', async () => {
    const { route } = await load();
    const result = route({
      files: ['docs/notes.md', 'package.json'],
      elevatedPaths: ELEVATED,
    });
    expect(result.risks.map((r) => r.flag)).toEqual(['security-surface']);
    expect(result.lane).toBe('model');
    expect(result.gates[0]).toMatchObject({ gate: 'risk-flags', verdict: 'escalate' });
  });

  it('escalates a rulebook document that sits under a declared elevated path', async () => {
    const { route } = await load();
    const result = route({ files: ['.claude/rules/autonomy.md'], elevatedPaths: ELEVATED });
    expect(result.risks.map((r) => r.flag)).toEqual(['elevated-path']);
    expect(result.lane).toBe('model');
  });

  it('shows the two cheap gates as skipped rather than omitting them', async () => {
    const { route, GATES } = await load();
    const result = route({ files: ['docs/notes.md', 'package.json'], elevatedPaths: ELEVATED });

    // 🔴 An absent gate line is indistinguishable from a declined one, and from a
    // gate that crashed. The reader of a trace has to be able to tell "not
    // evaluated, because the change escalated" from "evaluated and said no".
    const cheap = result.gates.filter((line) => ['deterministic', 'fast-path'].includes(line.gate));
    expect(cheap.map((line) => line.verdict)).toEqual(['skipped', 'skipped']);
    for (const line of cheap) expect(line.why).toMatch(/risk|escalat/i);
    expect(result.gates.map((line) => line.gate)).toEqual([...GATES]);
  });

  it('reports the same flags the risk function reports on its own', async () => {
    const { route, riskFlagsIn } = await load();
    const files = [
      'package.json',
      { path: 'packages/core/test/note.test.ts', status: 'removed' },
      'infra/lib/app-stack.ts',
    ];
    // One mechanism, one implementation: the ladder must not carry its own second
    // opinion about what is risky.
    expect(route({ files, elevatedPaths: ELEVATED }).risks).toEqual(
      riskFlagsIn(files, { elevatedPaths: ELEVATED }),
    );
  });
});

describe('every verdict is a gate line, in gate order, from the closed vocabulary', () => {
  it.each([
    ['.rig-manifest.json'],
    ['README.md'],
    ['packages/core/src/note.ts'],
    ['package.json'],
    ['.claude/rules/autonomy.md'],
    [42],
  ])('%s produces one line per gate', async (file) => {
    const { route, GATES, VERDICTS } = await load();
    const result = route({ files: [file], elevatedPaths: ELEVATED });

    expect(result.gates.map((line) => line.gate)).toEqual([...GATES]);
    for (const line of result.gates) {
      expect(VERDICTS, `${String(file)} → ${line.gate}`).toContain(line.verdict);
      expect(line.why, `${String(file)} → ${line.gate}`).toBeTruthy();
    }
    // the lane is the gate that routed, never a fourth answer beside the lines
    expect(result.gates.find((line) => line.verdict === 'route')?.gate).toBe(result.lane);
    expect(result.why).toBeTruthy();
  });
});

describe('an absent file list is refused, never routed', () => {
  it.each([[undefined], [{}], [{ files: [] }], [{ files: null }], [{ files: 'a.md' }]])(
    'refuses %j',
    async (input) => {
      const { route } = await load();
      const error = await refusalFrom(() => route(input as Record<string, unknown>));
      // Same shape as `recordCompletedTier`: an absence and a zero look identical
      // in a count and mean opposite things, so the router refuses rather than
      // guessing the cheap answer — which is the one that would be wrong.
      expect(error.message).toMatch(/file/i);
      expect(error.message).toMatch(/absence|not a cheap|refus/i);
    },
  );
});

describe('a library caller cannot reach the permissive answer the CLI refuses', () => {
  it("refuses to route without the project's declared elevated paths", async () => {
    const { route } = await load();
    for (const elevatedPaths of [undefined, [], null]) {
      const error = await refusalFrom(() =>
        route({ files: ['README.md'], elevatedPaths } as Record<string, unknown>),
      );
      // With no declaration the flag is not EVALUATED, and the gate line would
      // have read `risk-flags clear — no risk flag fired`: an absence dressed
      // as a pass, in the file whose whole argument is that those must differ.
      expect(error.message).toMatch(/elevated/i);
    }
  });
});

describe('the router does provably bounded work', () => {
  it('splits a hundred thousand capitals without a quadratic pass', { timeout: 5000 }, async () => {
    const { route } = await load();
    // 🔴 The bounded-work test below fed an all-LOWERCASE path, so it never
    // entered the acronym-splitting branch — and that branch was quadratic:
    // 8k capitals took 93ms, 32k took 1.5s, 100k took 14s. A path component
    // that long needs no checkout: `git mktree` puts it in a tree and
    // `git diff --name-status` hands it back.
    const result = route({
      files: [`src/${'A'.repeat(100_000)}.ts`],
      elevatedPaths: ELEVATED,
    });
    expect(result.lane).toBe('model');
  });

  it(
    'routes five thousand files and a hundred-thousand-character path in one call',
    {
      timeout: 5000,
    },
    async () => {
      const { route } = await load();
      const files = Array.from({ length: 5000 }, (_, i) => `packages/core/src/note-${i}.ts`);
      files.push(`${'a'.repeat(100_000)}.ts`);

      // 🔴 Not "is it fast enough on realistic input" but "can any input make it do
      // unbounded work at all". An unbounded spread throws RangeError; a quadratic
      // pass hangs past the timeout. Both are the same defect in a dispatcher that
      // decides what gets reviewed.
      const result = route({ files, elevatedPaths: ELEVATED });
      expect(result.lane).toBe('model');
    },
  );
});

describe('the CLI prints the lane and never encodes it in the exit code', () => {
  const env = (): NodeJS.ProcessEnv => {
    const base = withoutGitLocation();
    delete base['RIG_RUN_DIR'];
    return base;
  };

  it('prints the route as JSON for a cheap change', async () => {
    const dir = await temp('router-');
    const result = await runCli(['--files', 'README.md,docs/notes.mdx', '--json'], dir, env());

    expect(result.code, result.out).toBe(0);
    const parsed = JSON.parse(result.stdout) as Routed;
    expect(parsed.lane).toBe('fast-path');
    expect(parsed.reviewers).toEqual(['prose-reviewer']);
  });

  it('exits 0 for an expensive change too, because 0 means the router ran', async () => {
    const dir = await temp('router-');
    const result = await runCli(['--files', 'package.json', '--json'], dir, env());

    // 🔴 The exit code says the ROUTER ran; it never says the lane was cheap. A
    // caller that chains on `&&` reads "escalate to the model" as "go ahead".
    expect(result.code, result.out).toBe(0);
    expect((JSON.parse(result.stdout) as Routed).lane).toBe('model');
  });

  it('documents in the source that the lane is on stdout and must not be chained on', async () => {
    const text = await source();
    // A limit stated in prose is the file's own claim about how far it can be
    // trusted, and nothing checks prose — so the claim itself is asserted.
    expect(text).toMatch(/&&/);
    expect(text).toMatch(/stdout/);
    expect(text).toMatch(/\bexit[^\n]{0,80}\b0\b/i);
  });

  it('refuses an empty file list with a diagnosis on stderr and nothing on stdout', async () => {
    const dir = await temp('router-');
    for (const value of ['', ',,']) {
      const result = await runCli(['--files', value, '--json'], dir, env());
      expect(result.code, result.out).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/file/i);
      expect(result.stderr).not.toMatch(/at ModuleJob|node:internal/); // no stack dump
    }
  });

  it('spawns git for the derived file list with an explicit, sanitised environment', async () => {
    const text = await source();
    // The git path is not exercised against a real repository here — a router test
    // must not depend on a remote. What IS mechanical is the call site: a process
    // started under a git hook inherits an absolute GIT_DIR, and a child that keeps
    // it reports the file list of ANOTHER repository. Observed in this repo as junk
    // commits on two branches.
    expect(text).toMatch(
      /import\s*\{[^}]*withoutGitLocation[^}]*\}\s*from\s*['"][^'"]*git-env\.mjs['"]/,
    );
    const calls = [...text.matchAll(/(?:execFileSync|execFile|spawnSync|spawn)\(\s*'git',/g)];
    expect(calls.length, 'the CLI must derive the file list from git').toBeGreaterThan(0);
    for (const call of calls) {
      const window = text.slice(call.index ?? 0, (call.index ?? 0) + 400).split('\n\n')[0]!;
      expect(window, 'git spawned with the inherited environment').toMatch(
        /env:\s*withoutGitLocation\(/,
      );
      // argv array, never a command string — a path from a queue item is untrusted
      expect(window, 'git spawned through a shell command string').toMatch(/'git',\s*\[/);
    }
  });
});

describe('the router writes one journal line per gate verdict', () => {
  it('appends a decision for every gate, in gate order, into the declared run directory', async () => {
    const { GATES } = await load();
    const dir = await temp('router-');
    const runDir = await temp('run-');

    const result = await runCli(['--files', 'docs/notes.md', '--json'], dir, {
      ...withoutGitLocation(),
      RIG_RUN_DIR: runDir,
    });
    expect(result.code, result.out).toBe(0);

    const { decisions } = journal.readRun({ runDir });
    // One line per gate — including the ones that were skipped. A trace that
    // records only the gate that routed cannot show what the router considered,
    // and "no line" is exactly how a silently disabled gate looks.
    expect(decisions.map((d) => d['gate'])).toEqual(GATES.map((gate) => `review-routing:${gate}`));
    expect(decisions.map((d) => d['seq'])).toEqual([1, 2, 3, 4]);

    const routed = JSON.parse(result.stdout) as Routed;
    expect(decisions.map((d) => d['verdict'])).toEqual(routed.gates.map((line) => line.verdict));
  });

  it('writes nothing anywhere when no run directory is declared', async () => {
    const dir = await temp('router-');
    const env = withoutGitLocation();
    delete env['RIG_RUN_DIR'];

    const result = await runCli(['--files', 'docs/notes.md', '--json'], dir, env);

    expect(result.code, result.out).toBe(0);
    const inProject = await readdir(dir, { recursive: true });
    expect(inProject.filter((entry) => entry.endsWith('.jsonl'))).toEqual([]);
    // and no default directory inside the template tree — a session's trace
    // committed into the thing this repo ships is the failure mode.
    await expect(stat(path.join(universal, '.claude', 'runs'))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Review round 1 — every block below reproduces a finding from the gate fan-out
// on this branch. Each one is a bug the module shipped with, written as the test
// that fails against it.
// ---------------------------------------------------------------------------

describe('parseNameStatus — the diff format the router actually reads', () => {
  interface Parsed {
    path: string;
    status: string;
  }
  const parse = async (raw: string): Promise<Parsed[]> => {
    const { parseNameStatus } = (await import(pathToFileURL(modulePath).href)) as unknown as {
      parseNameStatus: (raw: string) => Parsed[];
    };
    return parseNameStatus(raw);
  };

  it('maps every status letter git emits', async () => {
    expect(await parse('A\0a.ts\0M\0b.ts\0D\0c.ts\0T\0d.ts\0')).toEqual([
      { path: 'a.ts', status: 'added' },
      { path: 'b.ts', status: 'modified' },
      { path: 'c.ts', status: 'removed' },
      { path: 'd.ts', status: 'modified' },
    ]);
  });

  it('splits on NUL, so a path containing a newline stays one path', async () => {
    // Without `-z` and a NUL split this arrives as two junk paths, and an
    // elevated file stops looking elevated. Same defect `-z` exists to prevent
    // for octal-escaped non-ASCII names.
    expect(await parse('M\0src/we\nird.ts\0')).toEqual([
      { path: 'src/we\nird.ts', status: 'modified' },
    ]);
  });

  it('records BOTH halves of a rename, because the source is a deletion', async () => {
    // 🔴 The finding, in one line: `R100\0from\0to\0` and the parser kept only
    // `to`. The source path of a rename IS a deletion and it is the only place
    // that deletion appears in the diff — so a rename could carry a test out of
    // the suite and a hook out of `.claude/` with nothing left for any flag to
    // see.
    expect(await parse('R100\0test/foo.test.ts\0docs/foo.md\0')).toEqual([
      { path: 'test/foo.test.ts', status: 'removed' },
      { path: 'docs/foo.md', status: 'renamed' },
    ]);
  });

  it('records only the destination of a copy, because a copy deletes nothing', async () => {
    expect(await parse('C100\0src/a.ts\0src/b.ts\0')).toEqual([
      { path: 'src/b.ts', status: 'copied' },
    ]);
  });

  it('always advances, so a truncated or malformed record cannot hang it', async () => {
    // A truncated rename keeps the half it DID read, as the removal it is —
    // dropping it would be the permissive answer on malformed input, which is
    // the direction this module refuses everywhere else.
    expect(await parse('R100\0only-one-field\0')).toEqual([
      { path: 'only-one-field', status: 'removed' },
    ]);
    expect(await parse('\0\0\0')).toEqual([]);
    expect(await parse('')).toEqual([]);
    expect(await parse('M\0')).toEqual([]);
  });
});

describe('a rename cannot smuggle a change past the risk flags', () => {
  it('fires test-removed when a rename carries a test out of the suite', async () => {
    const { riskFlagsIn, route } = await load();
    const renamed = [
      { path: 'packages/core/test/note.test.ts', status: 'removed' },
      { path: 'docs/note.md', status: 'renamed' },
    ];
    expect(riskFlagsIn(renamed, { elevatedPaths: ELEVATED }).map((f) => f.flag)).toEqual([
      'test-removed',
    ]);
    expect(route({ files: renamed, elevatedPaths: ELEVATED }).lane).toBe('model');
  });

  it('fires elevated-path when a rename carries a hook out of an elevated directory', async () => {
    const { route } = await load();
    const result = route({
      files: [
        { path: '.claude/hooks/guard-bash.mjs', status: 'removed' },
        { path: 'docs/guard.md', status: 'renamed' },
      ],
      elevatedPaths: ELEVATED,
    });
    expect(result.risks.map((r) => r.flag)).toContain('elevated-path');
    expect(result.lane).toBe('model');
  });
});

describe('the cheap lanes cannot be unlocked by choosing a filename', () => {
  it('refuses the deterministic lane to a derived-looking file that was ADDED', async () => {
    const { route } = await load();
    // A derived artifact earns the no-reviewer lane because a check catches its
    // drift against a generator. An ADDED one has no prior output to have
    // drifted from, so the justification does not hold and the name alone is
    // the author's choice.
    expect(
      route({
        files: [{ path: 'src/payments.generated.ts', status: 'added' }],
        elevatedPaths: ELEVATED,
      }).lane,
    ).toBe('model');
    for (const status of ['added', 'copied', 'renamed']) {
      expect(
        route({ files: [{ path: 'dist/bundle.js', status }], elevatedPaths: ELEVATED }).lane,
        status,
      ).toBe('model');
    }
    // and a status-less entry is unmeasured, which is not the same as `modified`
    expect(route({ files: ['dist/bundle.js'], elevatedPaths: ELEVATED }).lane).toBe('model');
    // a MODIFIED one still reaches it — the cheap lane is narrowed, not deleted
    for (const status of ['modified', 'removed']) {
      expect(
        route({ files: [{ path: 'dist/bundle.js', status }], elevatedPaths: ELEVATED }).lane,
        status,
      ).toBe('deterministic');
    }
  });

  it('treats a dependency manifest from any ecosystem as a security surface', async () => {
    const { riskFlagsIn } = await load();
    // `init` installs this layer into a repo whose shape is unknown, and `.txt`
    // is otherwise prose — so this one is downgraded rather than merely missed.
    for (const file of ['requirements.txt', 'constraints.txt']) {
      expect(
        riskFlagsIn([file], { elevatedPaths: [] }).map((f) => f.flag),
        file,
      ).toEqual(['security-surface']);
    }
  });

  it('catches the dependency-manifest names an exact set cannot hold', async () => {
    const { riskFlagsIn } = await load();
    // Same defect class as `requirements.txt`, one round later: `.txt` is the
    // only prose extension a manifest uses, so a miss here does not merely fail
    // to escalate — it downgrades a supply-chain edit to the prose lane.
    for (const file of [
      'requirements-dev.txt',
      'dev-requirements.txt',
      'requirements/base.txt',
      'deploy/requirements/prod.txt',
    ]) {
      expect(
        riskFlagsIn([file], { elevatedPaths: [] }).map((f) => f.flag),
        file,
      ).toEqual(['security-surface']);
    }
    // and an ordinary `.txt` is still prose
    expect(riskFlagsIn(['docs/notes.txt'], { elevatedPaths: [] })).toEqual([]);
  });

  it('treats a file that IS a credential as a security surface', async () => {
    const { riskFlagsIn } = await load();
    for (const file of [
      '.env',
      '.env.production',
      'certs/server.pem',
      'certs/tls.key',
      '.npmrc',
      '.netrc',
      'infra/id_rsa',
    ]) {
      expect(
        riskFlagsIn([file], { elevatedPaths: [] }).map((f) => f.flag),
        file,
      ).toEqual(['security-surface']);
    }
  });

  it('splits an all-caps acronym as well as an ordinary camel hump', async () => {
    const { riskFlagsIn } = await load();
    // `([a-z0-9])([A-Z])` alone needs a lowercase char first, so `JWTVerify`
    // produced no word at all while `authService` did.
    for (const file of ['src/AUTHService.ts', 'src/JWTVerify.ts', 'src/OAuthClient.ts']) {
      expect(
        riskFlagsIn([file], { elevatedPaths: [] }).map((f) => f.flag),
        file,
      ).toEqual(['security-surface']);
    }
  });

  it('names more of the words a security-relevant path uses', async () => {
    const { riskFlagsIn } = await load();
    for (const file of [
      'src/api-keys.ts',
      'src/password-reset.ts',
      'packages/shared/src/jwt.ts',
      'src/oauth/callback.ts',
      'src/crypto.ts',
    ]) {
      expect(
        riskFlagsIn([file], { elevatedPaths: [] }).map((f) => f.flag),
        file,
      ).toEqual(['security-surface']);
    }
    // and still not on a word that merely starts with those letters
    expect(riskFlagsIn(['packages/core/src/tokenizer.ts'], { elevatedPaths: [] })).toEqual([]);
    expect(riskFlagsIn(['src/keyboard.ts'], { elevatedPaths: [] })).toEqual([]);
  });
});

describe('the CLI runs when it is reached through a symlink', () => {
  it('prints the route instead of exiting 0 having printed nothing', async () => {
    const dir = await temp('router-link-');
    const link = path.join(dir, 'router-link.mjs');
    await symlink(modulePath, link);

    const env = withoutGitLocation();
    delete env['RIG_RUN_DIR'];
    const result = await new Promise<CliResult>((resolve) => {
      execFile(
        process.execPath,
        [link, '--files', 'README.md', '--json'],
        { cwd: dir, env },
        (error, stdout, stderr) => {
          resolve({
            code: error ? ((error as { code?: number }).code ?? 1) : 0,
            stdout,
            stderr,
            out: stdout + stderr,
          });
        },
      );
    });

    // 🔴 The failure this replaces is the worst shape available for this file:
    // exit 0 with empty stdout is indistinguishable from a router that ran, and
    // the gate reads the lane off stdout. Every sibling CLI in this directory
    // compares realpaths for exactly this reason.
    expect(result.code, result.out).toBe(0);
    expect(result.stdout, 'the CLI produced no output through a symlink').not.toBe('');
    expect((JSON.parse(result.stdout) as Routed).lane).toBe('fast-path');
  });

  it('compares realpaths, the same way every sibling CLI in this directory does', async () => {
    expect(await source()).toMatch(/realpathSync/);
  });
});

describe('a revision the router will not hand to git', () => {
  it('refuses a base or head that git would read as an option', async () => {
    const dir = await temp('router-rev-');
    const env = withoutGitLocation();
    delete env['RIG_RUN_DIR'];
    for (const flag of ['--base', '--head']) {
      // `${base}...${head}` is one argv element with no `--` ahead of it, so a
      // leading `-` is parsed by git as an option: `--base --output=/tmp/x`
      // really does make git write a file.
      const result = await runCli([flag, '--output=/tmp/router-should-not-exist'], dir, env);
      expect(result.code, result.out).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/revision/i);
    }
  });
});

describe('a project that declares no elevated path is refused, never routed', () => {
  it('exits non-zero with a diagnosis rather than reporting the flag as clear', async () => {
    // 🔴 The trace said `risk-flags clear — no risk flag fired` for a project
    // where `elevated-path` was never evaluated at all. An unknown that reads as
    // a pass is the one failure a gate's own journal must not produce.
    const project = await temp('router-nodecl-');
    const scripts = path.join(project, '.claude', 'scripts');
    await mkdir(scripts, { recursive: true });
    for (const name of [
      'decision-router.mjs',
      'detect-missed-gate.mjs',
      'git-env.mjs',
      'run-journal.mjs',
    ]) {
      await copyFile(path.join(scriptsDir, name), path.join(scripts, name));
    }
    await writeFile(path.join(project, 'CLAUDE.md'), '# a project that declares nothing\n');

    const env = withoutGitLocation();
    delete env['RIG_RUN_DIR'];
    const result = await new Promise<CliResult>((resolve) => {
      execFile(
        process.execPath,
        [path.join(scripts, 'decision-router.mjs'), '--files', 'README.md', '--json'],
        { cwd: project, env },
        (error, stdout, stderr) => {
          resolve({
            code: error ? ((error as { code?: number }).code ?? 1) : 0,
            stdout,
            stderr,
            out: stdout + stderr,
          });
        },
      );
    });

    expect(result.code, result.out).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/elevated/i);
  });
});

// A router with no call site routes nothing. These are the correspondence tests
// the rulebook requires when one fact lives in two artifacts.
describe('the gate skill and the rules point at the router', () => {
  const skill = (): Promise<string> =>
    readFile(path.join(universal, '.claude', 'skills', 'pr-ship', 'SKILL.md'), 'utf8');
  const workflow = (): Promise<string> =>
    readFile(path.join(universal, '.claude', 'rules', 'workflow.md'), 'utf8');

  it('pr-ship names the router and the script that runs it', async () => {
    const text = await skill();
    expect(text).toMatch(/decision-router/);
    expect(text).toMatch(/\.claude\/scripts\/decision-router\.mjs/);
  });

  it('pr-ship still runs code-reviewer whenever the lane is model', async () => {
    const text = await skill();
    // 🔴 Twice now this test has been weaker than its own comment. Round 1 split
    // on paragraphs and asked whether ANY block mentioned both words, which the
    // change's own commentary satisfied. Round 2 anchored on the first
    // ``model``-prefixed fragment — which fell through to the launch bullet, so
    // deleting the lane-table entry stayed green while the comment claimed
    // otherwise. Each assertion is now anchored to a DISTINCT bullet, and the
    // count is asserted, so a fall-through cannot satisfy both.
    const flat = text.replace(/[ \t]*\n[ \t]*/g, ' ');
    const bullets = flat.split(/\s-\s/);

    // (a) the lane-table entry: `— everything else` is the em-dash description
    // form the table uses, and the launch bullet uses `→` instead.
    const laneEntry = bullets.filter((part) => /^`model`\s*—/.test(part.trimStart()));
    expect(laneEntry, 'the skill lists no `model` lane entry').toHaveLength(1);
    expect(laneEntry[0], 'the `model` lane entry does not name code-reviewer').toMatch(
      /code-reviewer/,
    );
    expect(laneEntry[0]).toMatch(/always/i);

    // (b) the launch instruction, a different bullet using the arrow form
    const launch = bullets.filter((part) => /^`model`\s*(→|->)/.test(part.trimStart()));
    expect(launch, 'no launch instruction names the `model` lane').toHaveLength(1);
    expect(launch[0]).toMatch(/code-reviewer/);
    expect(launch[0]).toMatch(/launch/i);
  });

  it('pr-ship keeps the conditional triggers lane-independent', async () => {
    const text = await skill();
    // The narrowing that nearly shipped: scoping step 4's body to `model` made
    // `security-scanner` unreachable on every cheap lane — including on the
    // router's own stated blind spot, a secret pasted into a `.md`.
    expect(text).toMatch(/lane-independent/i);
    expect(text).toMatch(/may only ADD|may only \*ADD\*|may only \*\*ADD\*\*|may only add/i);
    expect(text).toMatch(/security-scanner/);
  });

  it('pr-ship names what the cheap lanes give up', async () => {
    const text = await skill();
    // A narrowing the document does not mention is the false-confidence failure
    // this layer names for itself. `code-reviewer` carries two checks that are
    // not about code, and dropping it drops them.
    expect(text).toMatch(/give up|gives up|gave up/i);
    expect(text).toMatch(/contradicts the item|contract drift/i);
  });

  it('pr-ship passes the base it resolved, rather than trusting origin/HEAD', async () => {
    const text = await skill();
    // `origin/HEAD` is set by `git clone` and not by `git init` + `git remote
    // add` — the shape `init/` targets. Worse than failing: a base that is
    // merely different routes a narrower file set than the gate reviews.
    const invocation = text
      .split('\n')
      .find((l) => l.includes('decision-router.mjs') && l.includes('node '));
    expect(invocation, 'the skill never shows how to run the router').toBeTruthy();
    expect(invocation, 'the documented invocation does not pass a base').toMatch(/--base/);
  });

  it('pr-ship says an exit code of 1 is not a lane', async () => {
    const text = await skill();
    expect(text).toMatch(/exit 1|exit code of 1|`1`/i);
    expect(text).toMatch(/nothing was routed|not a lane/i);
  });

  it('CLAUDE.md no longer claims code-reviewer runs before every PR', async () => {
    // The map is the document a session reads first, and it was the one artifact
    // still stating the pre-router rule — two answers to one question, with the
    // wrong one in the more prominent place.
    for (const layer of ['universal', 'init']) {
      const text = await readFile(
        path.join(repoRoot, 'templates', 'agent-os', layer, 'CLAUDE.md'),
        'utf8',
      );
      expect(text, `${layer}/CLAUDE.md still says "before every PR"`).not.toMatch(
        /code-reviewer` before every PR/,
      );
      expect(text, `${layer}/CLAUDE.md never mentions the router`).toMatch(/decision-router/);
    }
  });

  it('pr-ship spells the ladder with the same lane names the router exports', async () => {
    const { LANES } = await load();
    const text = await skill();
    // Parsed out of the prose, not asserted as a literal: two artifacts naming the
    // same lanes must be checked against each other, or the day one is renamed the
    // skill keeps instructing a lane that no longer exists.
    const ladders = text
      .split('\n')
      .filter((line) => /→|->/.test(line))
      .map((line) =>
        line
          .split(/→|->/)
          .map((part) => part.replace(/[`*_]/g, '').trim())
          .filter((part) => /^[a-z][a-z-]*$/.test(part)),
      );
    expect(ladders, 'the skill spells no lane ladder at all').toContainEqual([...LANES]);
  });

  it('workflow.md states the ladder and that risk flags escalate ahead of it', async () => {
    const text = await workflow();
    for (const lane of ['deterministic', 'fast-path', 'model']) {
      expect(text, `workflow.md never names the ${lane} lane`).toMatch(new RegExp(lane));
    }
    expect(text).toMatch(/risk flag/i);
    expect(text).toMatch(/escalat/i);
    expect(text).toMatch(/decision-router/);
  });
});
