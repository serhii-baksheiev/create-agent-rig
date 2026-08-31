// AR-137: two duplicated mechanical facts, each with one source and a
// two-direction correspondence check against the prose that must restate it.
//
// Limits, stated: the points parser reads exactly the `loop` and `pr-ship`
// skills, by the spellings `--point X` / `point: X` — a point named elsewhere,
// or spelled otherwise, is invisible to it. The floor parser needs the
// `**Reviewer fan-out.**` anchor and the `- \`lane\` → …` bullet shape; if either
// moves, the parse fails by a named assertion rather than passing on nothing.
// That is the maintenance cost of the check, and it is the whole of it.
//
// It runs off the Windows lane: it imports revalidate.mjs and decision-router.mjs,
// which do not load there (their own tests sit in the same exclusion list).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// AR-137 (RX5): correspondence checks are the DEFAULT for a mechanical fact that
// exists in more than one place. Two facts are pinned here, each in BOTH
// directions — a name the script knows that the prose never mentions is as red
// as a name the prose mentions that no script knows — and each correspondence
// function is exercised on a mutated copy inside the test, so "the check would
// catch it" is measured rather than claimed.
//
// Fact 1: the revalidation POINTS (`revalidate.mjs`, `revalidation-report.mjs`,
//         the `loop` and `pr-ship` skills).
// Fact 2: the lane → reviewer floor (`decision-router.mjs`, the `pr-ship` skill).
//
// No subprocesses: file reads and module imports only.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const scriptsDir = path.join(universal, '.claude', 'scripts');
const skillsDir = path.join(universal, '.claude', 'skills');

const read = (file: string) => readFile(file, 'utf8');
const load = <T>(file: string): Promise<T> =>
  import(pathToFileURL(path.join(scriptsDir, file)).href) as Promise<T>;

interface PointsModule {
  POINTS: readonly string[];
  REVALIDATES: readonly string[];
}

interface Router {
  LANES: readonly string[];
  reviewersForLane(lane: string): string[];
  route(input: Record<string, unknown>): { lane: string; reviewers: string[] };
}

const ELEVATED = ['packages/db/src/', '.claude/', '.github/workflows/', 'infra/'];

// --- Fact 1: the correspondence, as a function so a mutated copy can be checked ---

const POINT_MENTION = /(?:--point |point: )([A-Z][A-Z_]*)/g;

const pointMentionsIn = (prose: string): string[] =>
  [...prose.matchAll(POINT_MENTION)].map((m) => m[1]!);

/** Names the offenders in either direction; empty on full correspondence. */
const pointsCorrespondence = (points: readonly string[], prose: string) => {
  const mentioned = new Set(pointMentionsIn(prose));
  return {
    unmentioned: points.filter((p) => !mentioned.has(p)),
    unknown: [...mentioned].filter((name) => !points.includes(name)),
  };
};

// --- Fact 2: the same shape for the reviewer floor ---

const AGENT_NAME = /\b([a-z]+-(?:reviewer|scanner))\b/g;

/** The `- \`<lane>\` → …` bullets under "Reviewer fan-out" in pr-ship, by lane. */
const floorBulletsIn = (prose: string): Map<string, string> => {
  const start = prose.indexOf('**Reviewer fan-out.**');
  expect(start, 'pr-ship must carry the "Reviewer fan-out" step').toBeGreaterThan(-1);
  const section = prose.slice(start).split(/\n\s*\n/)[1] ?? '';
  const bullets = new Map<string, string>();
  for (const m of section.matchAll(/^\s*- `([a-z-]+)` → ([^\n]*(?:\n(?!\s*- `)[^\n]*)*)/gm)) {
    bullets.set(m[1]!, m[2]!);
  }
  return bullets;
};

const floorCorrespondence = (
  lanes: readonly string[],
  floorOf: (lane: string) => string[],
  prose: string,
) => {
  const bullets = floorBulletsIn(prose);
  const offenders: string[] = [];
  for (const lane of lanes) {
    const text = bullets.get(lane);
    if (text === undefined) {
      offenders.push(`${lane}: no bullet`);
      continue;
    }
    const named = [...new Set([...text.matchAll(AGENT_NAME)].map((m) => m[1]!))].sort();
    const expected = [...floorOf(lane)].sort();
    if (JSON.stringify(named) !== JSON.stringify(expected)) {
      offenders.push(`${lane}: prose names [${named}] but the floor is [${expected}]`);
    }
  }
  for (const lane of bullets.keys()) {
    if (!lanes.includes(lane)) offenders.push(`${lane}: not a lane the router knows`);
  }
  return offenders;
};

describe('fact 1 — the revalidation points have one source', () => {
  it('exports POINTS and derives REVALIDATES as POINTS without SELECT', async () => {
    const { POINTS, REVALIDATES } = await load<PointsModule>('lib/revalidation-points.mjs');
    expect(POINTS).toEqual(['SELECT', 'BEFORE_PR', 'BEFORE_CLOSE']);
    expect(Object.isFrozen(POINTS)).toBe(true);
    expect(REVALIDATES).toEqual(POINTS.filter((p) => p !== 'SELECT'));
    expect(Object.isFrozen(REVALIDATES)).toBe(true);
  });

  it('is listed in the process manifest (layers.json)', async () => {
    const manifest = JSON.parse(await read(path.join(universal, 'layers.json'))) as unknown;
    expect(JSON.stringify(manifest)).toContain('".claude/scripts/lib/revalidation-points.mjs"');
  });

  it('revalidate.mjs and revalidation-report.mjs import the list instead of spelling it', async () => {
    for (const file of ['revalidate.mjs', 'revalidation-report.mjs']) {
      const source = await read(path.join(scriptsDir, file));
      expect(source, file).toMatch(
        /import\s*\{[^}]*\}\s*from\s*'\.\/lib\/revalidation-points\.mjs'/,
      );
      // no second copy of the fact: an array literal of point names is the drift
      expect(source, file).not.toMatch(/\[\s*'(SELECT|BEFORE_PR|BEFORE_CLOSE)'/);
    }
  });

  it('the two scripts still export what they exported, now by way of the module', async () => {
    const points = await load<PointsModule>('lib/revalidation-points.mjs');
    const revalidate = await load<{ POINTS: readonly string[] }>('revalidate.mjs');
    const report = await load<{ POINTS: readonly string[] }>('revalidation-report.mjs');
    expect(revalidate.POINTS).toEqual(points.REVALIDATES);
    expect(report.POINTS).toEqual(points.POINTS);
  });

  it('every point the module knows is named by the loop or pr-ship skill, and vice versa', async () => {
    const { POINTS } = await load<PointsModule>('lib/revalidation-points.mjs');
    const prose =
      (await read(path.join(skillsDir, 'loop', 'SKILL.md'))) +
      '\n' +
      (await read(path.join(skillsDir, 'pr-ship', 'SKILL.md')));
    expect(pointsCorrespondence(POINTS, prose)).toEqual({ unmentioned: [], unknown: [] });
  });

  it('reports a point named in prose that no script knows (mutation: BEFORE_MERGE)', async () => {
    const { POINTS } = await load<PointsModule>('lib/revalidation-points.mjs');
    const prose = await read(path.join(skillsDir, 'loop', 'SKILL.md'));
    const mutated = `${prose}\nnode .claude/scripts/revalidate.mjs --point BEFORE_MERGE --ticket X\n`;
    expect(pointsCorrespondence(POINTS, mutated).unknown).toEqual(['BEFORE_MERGE']);
  });

  it('reports a point the module knows that no prose mentions (mutation: extended POINTS)', async () => {
    const { POINTS } = await load<PointsModule>('lib/revalidation-points.mjs');
    const prose =
      (await read(path.join(skillsDir, 'loop', 'SKILL.md'))) +
      '\n' +
      (await read(path.join(skillsDir, 'pr-ship', 'SKILL.md')));
    const extended = [...POINTS, 'AFTER_DEPLOY'];
    expect(pointsCorrespondence(extended, prose).unmentioned).toEqual(['AFTER_DEPLOY']);
  });
});

describe('fact 2 — the lane → reviewer floor has one source', () => {
  it('exports reviewersForLane with the floor of each lane', async () => {
    const { reviewersForLane } = await load<Router>('decision-router.mjs');
    expect(reviewersForLane('deterministic')).toEqual([]);
    expect(reviewersForLane('fast-path')).toEqual(['prose-reviewer']);
    expect(reviewersForLane('model')).toEqual(['code-reviewer']);
  });

  it("route()'s reviewers are a superset of the routed lane's floor", async () => {
    const { reviewersForLane, route } = await load<Router>('decision-router.mjs');
    const fixtures = [
      { files: ['README.md', 'docs/guide.txt'], lane: 'fast-path' },
      { files: ['packages/core/src/note.ts'], lane: 'model' },
    ];
    for (const { files, lane } of fixtures) {
      const result = route({ files, elevatedPaths: ELEVATED });
      expect(result.lane, files.join()).toBe(lane);
      for (const reviewer of reviewersForLane(lane)) {
        expect(result.reviewers, `${lane} floor`).toContain(reviewer);
      }
    }
  });

  it('the pr-ship fan-out bullets name exactly the floor of each lane, and only known lanes', async () => {
    const { LANES, reviewersForLane } = await load<Router>('decision-router.mjs');
    const prose = await read(path.join(skillsDir, 'pr-ship', 'SKILL.md'));
    expect(floorCorrespondence(LANES, reviewersForLane, prose)).toEqual([]);
  });

  it('reports a reviewer added to a bullet the floor does not include (mutation: prose)', async () => {
    const { LANES, reviewersForLane } = await load<Router>('decision-router.mjs');
    const prose = await read(path.join(skillsDir, 'pr-ship', 'SKILL.md'));
    const mutated = prose.replace(
      '- `fast-path` → launch `prose-reviewer`',
      '- `fast-path` → launch `prose-reviewer` and `security-scanner`',
    );
    expect(mutated).not.toBe(prose);
    const offenders = floorCorrespondence(LANES, reviewersForLane, mutated);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toMatch(/^fast-path: .*security-scanner/);
  });

  it('reports a floor widened in the mapping that the prose does not carry (mutation: mapping)', async () => {
    const { LANES, reviewersForLane } = await load<Router>('decision-router.mjs');
    const prose = await read(path.join(skillsDir, 'pr-ship', 'SKILL.md'));
    const widened = (lane: string) =>
      lane === 'model' ? ['code-reviewer', 'prose-reviewer'] : reviewersForLane(lane);
    const offenders = floorCorrespondence(LANES, widened, prose);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toMatch(/^model: /);
  });
});

describe('fact 3 — the run directory reaches a command one way, and the skill says which', () => {
  // RP-63. The loop skill promised that "every command in this skill can also
  // take the run directory per invocation". Measured: one of the five does.
  // `unattended-flag.mjs` parses `--run-dir`; `decision-router.mjs`,
  // `queue/index.mjs`, `revalidate.mjs` and `run-state.mjs` read
  // `process.env.RIG_RUN_DIR` and nothing else. A session that believed the
  // promise passed a flag that was silently ignored, which is how a routing
  // step recorded nothing and `verdict.mjs coverage` would have called the
  // round unreadable for want of a route.
  //
  // So the fact — WHICH commands accept the flag — gets a correspondence check
  // rather than a sentence. The measurement is the source; the prose restates
  // it; both directions are red.
  //
  // Limit, stated: a script "accepts --run-dir" here means the literal string
  // `--run-dir` appears in its source. A flag reached by an alias, or assembled
  // at runtime, is invisible to this — the same class of limit the points
  // parser above carries, and for the same reason.
  const RUN_DIR_COMMANDS = [
    'decision-router.mjs',
    'queue/index.mjs',
    'revalidate.mjs',
    'run-state.mjs',
    'unattended-flag.mjs',
  ] as const;

  /** The commands whose source really carries the flag. */
  const measureFlagAcceptors = async (): Promise<string[]> => {
    const accepting: string[] = [];
    for (const command of RUN_DIR_COMMANDS) {
      const source = await read(path.join(scriptsDir, ...command.split('/')));
      if (source.includes('--run-dir')) accepting.push(command);
    }
    return accepting.sort();
  };

  /**
   * The commands the skill NAMES as taking the flag, read from the one
   * sentence that carries the fact. The anchor is deliberate: a free-standing
   * list somewhere else in the document would drift from this one.
   */
  const ACCEPTORS_ANCHOR = '`--run-dir` is taken by';
  const flagAcceptorsNamedIn = (prose: string): string[] => {
    const at = prose.indexOf(ACCEPTORS_ANCHOR);
    if (at === -1) return [];
    // To the end of the paragraph, not to the first full stop: every command
    // name here ends in `.mjs`, so a sentence-terminator scan stops inside the
    // first name it meets and reads none of them at all.
    const paragraph = prose.slice(at).split(/\n\s*\n/)[0]!;
    return [...paragraph.matchAll(/`([A-Za-z0-9/._-]+\.mjs)`/g)].map((m) => m[1]!).sort();
  };

  const flagCorrespondence = (accepting: readonly string[], prose: string) => {
    const named = flagAcceptorsNamedIn(prose);
    return {
      unmentioned: accepting.filter((c) => !named.includes(c)),
      unknown: named.filter((c) => !accepting.includes(c)),
    };
  };

  const loopSkill = () => read(path.join(skillsDir, 'loop', 'SKILL.md'));

  it('does not promise the flag on every command, which four of the five never had', async () => {
    const prose = await loopSkill();
    expect(
      prose.replace(/\s+/g, ' '),
      'the loop skill still promises the run directory per invocation on every command',
    ).not.toContain('every command in this skill can also take the run directory per invocation');
  });

  it('names RIG_RUN_DIR as the mechanism every command reads', async () => {
    expect(
      (await loopSkill()).replace(/\s+/g, ' '),
      'the loop skill must name the environment variable as the cross-command mechanism',
    ).toContain('`RIG_RUN_DIR` is the one mechanism every command in this skill reads');
  });

  it('names exactly the commands that take --run-dir, and only those', async () => {
    expect(flagCorrespondence(await measureFlagAcceptors(), await loopSkill())).toEqual({
      unmentioned: [],
      unknown: [],
    });
  });

  it('reports a command named as taking the flag that does not (mutation: prose)', async () => {
    const prose = (await loopSkill()).replace(
      ACCEPTORS_ANCHOR,
      `${ACCEPTORS_ANCHOR} \`run-state.mjs\` and`,
    );
    expect(flagCorrespondence(await measureFlagAcceptors(), prose).unknown).toEqual([
      'run-state.mjs',
    ]);
  });

  it('reports a command that gained the flag while the prose did not (mutation: measurement)', async () => {
    const accepting = [...(await measureFlagAcceptors()), 'revalidate.mjs'].sort();
    expect(flagCorrespondence(accepting, await loopSkill()).unmentioned).toEqual([
      'revalidate.mjs',
    ]);
  });
});

describe('the rule — "One mechanism, one implementation" makes correspondence the default', () => {
  const bullet = async () => {
    const rule = await read(path.join(universal, '.claude', 'rules', 'invariants.md'));
    const start = rule.indexOf('- **One mechanism, one implementation.**');
    expect(start, 'the bullet must still exist').toBeGreaterThan(-1);
    // the bullet's paragraph: up to the next blank line
    return rule.slice(start).split(/\n\s*\n/)[0]!;
  };

  it('states the fallback for a fact that cannot be imported: check both directions', async () => {
    expect(await bullet()).toMatch(/both directions|two-direction|either direction/);
  });

  it('puts the check before the prose or memory that would otherwise carry the fact', async () => {
    expect(await bullet()).toMatch(/before (adding |writing )?(prose|a comment|memory)/i);
  });

  it('points at this test file and quotes a test name from it', async () => {
    const text = await bullet();
    expect(text).toContain('test/template/correspondence.test.ts');
    expect(text).toMatch(
      /"(every point the module knows is named by the loop or pr-ship skill, and vice versa|the pr-ship fan-out bullets name exactly the floor of each lane, and only known lanes)"/,
    );
  });
});
