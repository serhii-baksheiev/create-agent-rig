import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
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
      '.rig-manifest.json',
      'packages/cli/dist/index.js',
      'dist/bundle.js',
      'packages/core/src/schema.generated.ts',
      'test/__snapshots__/render.test.ts.snap',
    ]) {
      // Its drift is already caught by a check that costs nothing, so paying a
      // model for it buys no information.
      expect(classifyFile(file), file).toBe('derived');
    }
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
      files: ['.rig-manifest.json', 'packages/cli/dist/index.js'],
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
    const result = route({ files: ['README.md', 'dist/bundle.js'], elevatedPaths: ELEVATED });
    expect(result.lane).toBe('fast-path');
    expect(result.reviewers).toEqual(['prose-reviewer']);
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

describe('the router does provably bounded work', () => {
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
    // The cheap lanes are an addition, never a subtraction from the expensive one:
    // the sentence that ties `model` to `code-reviewer` has to survive the change.
    const tied = text
      .split(/\n\s*\n/)
      .some((block) => /\bmodel\b/.test(block) && /code-reviewer/.test(block));
    expect(tied, 'no passage ties the model lane to the code-reviewer gate').toBe(true);
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
