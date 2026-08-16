import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// The extraction brief's highest-value artifacts (§2, §5): the two sweeps that
// detect the class of failure a run cannot report about itself. Fixtures here
// are written fresh — the brief is explicit that ported fixtures name real paths
// and produce tests that pass against nothing.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptsDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'scripts');
const scriptPath = (name: string) => path.join(scriptsDir, name);
const load = (name: string) => import(pathToFileURL(scriptPath(name)).href);

interface Finding {
  kind: string;
  pr?: number;
  lane?: string;
  queueRef?: string | null;
  elevatedFiles?: string[];
  actions?: string[];
  why?: string;
}

const ELEVATED = ['infra/', 'packages/db/src/', 'services/api/src/handlers/auth.ts'];

/** A merged PR, in the shape `gh pr list --json` returns. */
const pr = (over: Record<string, unknown> = {}) => ({
  number: 1,
  title: 'feat: add a route',
  body: 'Some description.',
  headRefName: 'feat/12-add-a-route',
  mergedAt: '2026-07-20T10:00:00Z',
  url: 'https://example.invalid/pr/1',
  files: ['services/api/src/usecases/create-note.ts'],
  ...over,
});

function run(script: string, args: string[], cwd?: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [scriptPath(script), ...args],
      { cwd: cwd ?? repoRoot },
      (error, stdout, stderr) => {
        resolve({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          out: stdout + stderr,
        });
      },
    );
  });
}

describe('the elevated-path declaration is the single source', () => {
  it('parses every `elevated-paths` block in a document and unions them', async () => {
    const { parseElevatedPaths } = await load('detect-missed-gate.mjs');
    const md = [
      '# Project',
      '```elevated-paths',
      '# comment lines and blanks are ignored',
      'infra/',
      '',
      'packages/db/src/',
      '```',
      'prose',
      '```elevated-paths',
      'services/billing/src/',
      '```',
    ].join('\n');
    expect(parseElevatedPaths(md)).toEqual(['infra/', 'packages/db/src/', 'services/billing/src/']);
  });

  it('returns null when no block exists at all — a blind sweep must be visible', async () => {
    const { parseElevatedPaths } = await load('detect-missed-gate.mjs');
    expect(parseElevatedPaths('# Project\n\nno block here\n')).toBeNull();
  });

  it('reports the missing declaration as its own finding, not as "nothing found"', async () => {
    const { sweep } = await load('detect-missed-gate.mjs');
    const result = sweep({ prs: [pr()], elevatedPaths: null });
    const kinds = (result.findings as Finding[]).map((f) => f.kind);
    expect(kinds).toContain('no-elevated-paths-declared');
    expect(result.findings[0].actions).toContain('journal-line');
  });

  it('the shipped CLAUDE.md declares a non-empty, commented block', async () => {
    const { parseElevatedPaths } = await load('detect-missed-gate.mjs');
    const claudeMd = await readFile(
      path.join(repoRoot, 'templates', 'agent-os', 'universal', 'CLAUDE.md'),
      'utf8',
    );
    const declared = parseElevatedPaths(claudeMd) as string[] | null;
    expect(declared).not.toBeNull();
    expect(declared!.length).toBeGreaterThan(0);
    // and the reader is told it is theirs to extend, not a law they inherited
    expect(claudeMd).toMatch(/extend|add the paths|yours/i);
  });
});

describe('elevatedPathsIn — which files make a change elevated', () => {
  it('matches by path prefix', async () => {
    const { elevatedPathsIn } = await load('detect-missed-gate.mjs');
    expect(elevatedPathsIn(['infra/lib/app-stack.ts', 'README.md'], ELEVATED)).toEqual([
      'infra/lib/app-stack.ts',
    ]);
    expect(elevatedPathsIn(['services/api/src/handlers/auth.ts'], ELEVATED)).toHaveLength(1);
  });

  it('ignores files that provision nothing, whatever directory they sit in', async () => {
    const { elevatedPathsIn } = await load('detect-missed-gate.mjs');
    const inert = [
      'infra/README.md',
      'infra/docs/notes.mdx',
      'infra/test/app-stack.test.ts',
      'packages/db/src/__tests__/helper.ts',
      'packages/db/src/note-model.spec.ts',
    ];
    expect(elevatedPathsIn(inert, ELEVATED)).toEqual([]);
  });

  it('accepts both the string and the {path} shape gh returns', async () => {
    const { elevatedPathsIn } = await load('detect-missed-gate.mjs');
    expect(elevatedPathsIn([{ path: 'infra/lib/x.ts' }], ELEVATED)).toEqual(['infra/lib/x.ts']);
  });

  // The rulebook exemption used to be anchored at the repository root, which is
  // true of a project the tool generates and false of the tool itself: a
  // generator keeps rulebooks under templates/, where every one of them is a
  // .md and was therefore dropped as inert. Two Tier-2 merges here crossed a
  // declared elevated path in prose alone and the sweep reported them clean.
  it('sees a rulebook wherever it sits, not only at the repository root', async () => {
    const { elevatedPathsIn } = await load('detect-missed-gate.mjs');
    const declared = ['templates/agent-os/init/', 'templates/agent-os/universal/.claude/'];
    const rulebook = [
      'templates/agent-os/init/CLAUDE.md',
      'templates/agent-os/universal/.claude/rules/autonomy.md',
      'templates/agent-os/universal/.claude/agents/code-reviewer.md',
      'templates/agent-os/universal/.claude/skills/loop/SKILL.md',
    ];
    expect(elevatedPathsIn(rulebook, declared).sort()).toEqual([...rulebook].sort());
  });

  it('still ignores ordinary prose inside an elevated directory', async () => {
    const { elevatedPathsIn } = await load('detect-missed-gate.mjs');
    const declared = ['infra/', 'templates/agent-os/universal/.claude/'];
    expect(
      elevatedPathsIn(
        [
          'infra/README.md',
          'infra/docs/notes.mdx',
          'templates/agent-os/universal/.claude/scripts/queue/README.md',
        ],
        declared,
      ),
    ).toEqual(['templates/agent-os/universal/.claude/scripts/queue/README.md']);
  });
});

// AR-10: the sweep did not know this rulebook's own verdict words. `pr-ship`
// emits SHIP and HOLD, so a PR body that recorded a real verdict registered as
// no evidence at all, and the weaker `body-claim` observation — "someone says a
// gate ran, go check" — never fired on this project's own PRs.
describe('gateEvidence — the sweep knows the words its own gate produces', () => {
  it('recognises a SHIP or HOLD verdict beside a reviewer name', async () => {
    const { gateEvidence } = await load('detect-missed-gate.mjs');
    expect(gateEvidence({ body: 'Gate: `code-reviewer` returned SHIP.' })).toBe('body-claim');
    expect(gateEvidence({ body: 'code-reviewer: HOLD on two, both closed.' })).toBe('body-claim');
    expect(gateEvidence({ body: 'prose-reviewer — verdict: SHIP' })).toBe('body-claim');
  });

  it('still treats the label as the only thing that suppresses a finding', async () => {
    const { gateEvidence, classifyPr } = await load('detect-missed-gate.mjs');
    // 🔴 The direction this may never move in: a body claim is weaker evidence,
    // never a pass. Widening the vocabulary must not widen the authority.
    expect(gateEvidence({ labels: ['human-review'], body: 'anything' })).toBe('label');
    const claimed = classifyPr(pr({ files: ['infra/x.ts'], body: 'code-reviewer: SHIP' }), {
      elevatedPaths: ELEVATED,
    }) as Finding;
    expect(claimed).not.toBeNull();
    expect(claimed.kind).toBe('missed-gate');
  });

  it('does not call a reviewer name alone a claim', async () => {
    const { gateEvidence } = await load('detect-missed-gate.mjs');
    expect(gateEvidence({ body: 'Ask the code-reviewer about this one.' })).toBe('none');
  });
});

describe('classifyPr — a merged PR that skipped the elevated gate', () => {
  const opts = { elevatedPaths: ELEVATED };

  it('flags an elevated merge with no recorded verdict and no label', async () => {
    const { classifyPr } = await load('detect-missed-gate.mjs');
    const finding = classifyPr(pr({ files: ['infra/lib/app-stack.ts'] }), opts) as Finding;
    expect(finding.kind).toBe('missed-gate');
    expect(finding.elevatedFiles).toEqual(['infra/lib/app-stack.ts']);
    expect(finding.why).toMatch(/no reviewer verdict|no.*verdict/i);
  });

  it('does not flag a change that touched nothing elevated', async () => {
    const { classifyPr } = await load('detect-missed-gate.mjs');
    expect(classifyPr(pr(), opts)).toBeNull();
  });

  it('accepts the human-review label as the recorded gate', async () => {
    const { classifyPr } = await load('detect-missed-gate.mjs');
    for (const labels of [['human-review'], [{ name: 'human-review' }]]) {
      expect(classifyPr(pr({ files: ['infra/x.ts'], labels }), opts)).toBeNull();
    }
  });

  // ⚠️ This expectation was REVERSED by the review pass, deliberately.
  //
  // It used to assert that a reviewer verdict in the PR body suppresses the
  // finding. That was demonstrably exploitable: the body is written by the same
  // actor whose compliance is audited, so `VERDICT: HOLD — code-reviewer listed 3
  // blockers` and an unticked `- [ ] code-reviewer verdict` both silenced the
  // sweep, while writing the truth got you flagged. The test encoded a
  // vulnerability as a requirement; the requirement was wrong, not the test's
  // right to exist. `review-fixes.test.ts` pins the secure behaviour in full.
  it('records a body claim as evidence but never lets it suppress the finding', async () => {
    const { classifyPr } = await load('detect-missed-gate.mjs');
    for (const body of [
      'code-reviewer: clean, no blocking findings.',
      '- security-scanner — verdict: pass',
      'cdk-diff-reviewer returned green.',
    ]) {
      const finding = classifyPr(pr({ files: ['infra/x.ts'], body }), opts) as Finding;
      expect(finding?.kind, body).toBe('missed-gate');
      expect((finding as unknown as { evidence: string }).evidence, body).toBe('body-claim');
    }
  });

  it('reports no evidence at all differently from an unverifiable claim', async () => {
    const { classifyPr } = await load('detect-missed-gate.mjs');
    for (const body of [
      'security-scanner: not applicable here.',
      'code-reviewer skipped — trivial change.',
      'security-scanner did not run (no network).',
    ]) {
      const finding = classifyPr(pr({ files: ['infra/x.ts'], body }), opts) as Finding;
      expect(finding?.kind, body).toBe('missed-gate');
      expect((finding as unknown as { evidence: string }).evidence, body).toBe('none');
    }
  });

  it('honours an epoch so installing the sweep does not indict the past', async () => {
    const { classifyPr } = await load('detect-missed-gate.mjs');
    const old = pr({ files: ['infra/x.ts'], mergedAt: '2026-07-01T00:00:00Z' });
    expect(classifyPr(old, { ...opts, epoch: '2026-07-15T00:00:00Z' })).toBeNull();
    expect(classifyPr(old, opts)).not.toBeNull(); // no epoch → the whole window
  });

  it('ignores a PR that never merged', async () => {
    const { classifyPr } = await load('detect-missed-gate.mjs');
    expect(classifyPr(pr({ files: ['infra/x.ts'], mergedAt: null }), opts)).toBeNull();
  });

  it('never launders an unclassifiable PR into a lane that nobody owns', async () => {
    const { classifyPr } = await load('detect-missed-gate.mjs');
    const queued = classifyPr(
      pr({ files: ['infra/x.ts'], headRefName: 'feat/12-thing', body: 'Closes #12' }),
      opts,
    ) as Finding;
    expect(queued.lane).toBe('queue');
    const external = classifyPr(
      pr({ files: ['infra/x.ts'], headRefName: 'patch-1', body: 'fixes #40' }),
      opts,
    ) as Finding;
    expect(external.lane).toBe('external');
    const orphan = classifyPr(
      pr({ files: ['infra/x.ts'], headRefName: 'patch-1', body: 'no reference at all' }),
      opts,
    ) as Finding;
    expect(orphan.lane).toBe('owner-directed');
  });
});

describe('sweep — escalation grows with the second miss', () => {
  it('comments and journals the first, opens an escalation on the second', async () => {
    const { sweep } = await load('detect-missed-gate.mjs');
    const prs = [
      pr({ number: 1, files: ['infra/a.ts'] }),
      pr({ number: 2, files: ['packages/db/src/b.ts'] }),
    ];
    const findings = sweep({ prs, elevatedPaths: ELEVATED }).findings as Finding[];
    expect(findings).toHaveLength(2);
    expect(findings[0]!.actions).not.toContain('escalation-issue');
    expect(findings[1]!.actions).toContain('escalation-issue');
    expect(findings[0]!.actions).toContain('journal-line');
  });

  it('a clean window reports the count it swept, so silence is distinguishable', async () => {
    const { sweep } = await load('detect-missed-gate.mjs');
    const result = sweep({ prs: [pr(), pr({ number: 2 })], elevatedPaths: ELEVATED });
    expect(result.findings).toEqual([]);
    expect(result.sweptPrs).toBe(2);
  });

  it('survives a malformed record instead of losing the other findings', async () => {
    const { sweep } = await load('detect-missed-gate.mjs');
    const prs = [null, {}, 'nonsense', pr({ number: 9, files: ['infra/a.ts'] })];
    const result = sweep({ prs, elevatedPaths: ELEVATED });
    expect((result.findings as Finding[]).map((f) => f.pr)).toEqual([9]);
  });
});

describe('detect-missed-gate CLI', () => {
  /**
   * Install the scripts into a throwaway project, exactly as generation does, so
   * the CLI test does not depend on which paths the template happens to seed —
   * and so it exercises the real "read the declaration from the project" path.
   */
  async function installedProject(declaredIn: 'claude-md' | 'rules' = 'claude-md') {
    const { mkdir, copyFile } = await import('node:fs/promises');
    const dir = await mkdtemp(path.join(tmpdir(), 'sweep-'));
    await mkdir(path.join(dir, '.claude', 'scripts'), { recursive: true });
    await mkdir(path.join(dir, '.claude', 'rules'), { recursive: true });
    for (const script of ['detect-missed-gate.mjs', 'reconcile-external-prs.mjs']) {
      await copyFile(scriptPath(script), path.join(dir, '.claude', 'scripts', script));
    }
    const block = '```elevated-paths\ninfra/\n```\n';
    await writeFile(path.join(dir, 'CLAUDE.md'), declaredIn === 'claude-md' ? block : '# P\n');
    if (declaredIn === 'rules') {
      await writeFile(path.join(dir, '.claude', 'rules', 'stack.md'), block);
    }
    return dir;
  }

  const runInstalled = (dir: string, script: string, args: string[]) =>
    new Promise<{ code: number; out: string }>((resolve) => {
      execFile(
        process.execPath,
        [path.join(dir, '.claude', 'scripts', script), ...args],
        { cwd: dir },
        (error, stdout, stderr) => {
          resolve({
            code: error ? ((error as { code?: number }).code ?? 1) : 0,
            out: stdout + stderr,
          });
        },
      );
    });

  it('runs offline from a fixture and exits 0 even when it found something', async () => {
    const dir = await installedProject();
    const input = path.join(dir, 'prs.json');
    await writeFile(input, JSON.stringify([pr({ files: ['infra/a.ts'] })]));
    const result = await runInstalled(dir, 'detect-missed-gate.mjs', ['--input', input, '--json']);
    // exit 0 on findings is load-bearing: a sweep that FOUND something must not
    // look like a sweep that BROKE.
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out) as { findings: Finding[] };
    expect(parsed.findings.some((f) => f.kind === 'missed-gate')).toBe(true);
  });

  it('renders a human report naming the elevated files and the next actions', async () => {
    const dir = await installedProject();
    const input = path.join(dir, 'prs.json');
    await writeFile(input, JSON.stringify([pr({ files: ['infra/a.ts'] })]));
    const result = await runInstalled(dir, 'detect-missed-gate.mjs', ['--input', input]);
    expect(result.out).toContain('infra/a.ts');
    expect(result.out).toMatch(/actions:/);
  });

  it('picks up a declaration contributed by a stack rule file, not only CLAUDE.md', async () => {
    // This is the composition the acceptance run exposed: a target without
    // infrastructure must not inherit `infra/`, so the layer that creates it
    // declares it.
    const dir = await installedProject('rules');
    const input = path.join(dir, 'prs.json');
    await writeFile(input, JSON.stringify([pr({ files: ['infra/a.ts'] })]));
    const result = await runInstalled(dir, 'detect-missed-gate.mjs', ['--input', input, '--json']);
    const parsed = JSON.parse(result.out) as { findings: Finding[] };
    expect(parsed.findings.some((f) => f.kind === 'missed-gate')).toBe(true);
  });

  it('a project with no declaration anywhere reports a blind sweep, not a clean one', async () => {
    const { mkdir, copyFile } = await import('node:fs/promises');
    const dir = await mkdtemp(path.join(tmpdir(), 'sweep-'));
    await mkdir(path.join(dir, '.claude', 'scripts'), { recursive: true });
    await copyFile(
      scriptPath('detect-missed-gate.mjs'),
      path.join(dir, '.claude', 'scripts', 'detect-missed-gate.mjs'),
    );
    const input = path.join(dir, 'prs.json');
    await writeFile(input, JSON.stringify([pr({ files: ['infra/a.ts'] })]));
    const result = await runInstalled(dir, 'detect-missed-gate.mjs', ['--input', input, '--json']);
    const parsed = JSON.parse(result.out) as { findings: Finding[] };
    expect(parsed.findings.map((f) => f.kind)).toContain('no-elevated-paths-declared');
  });
});

describe('reconcile-external-prs — the lane the journal never sees', () => {
  it('sorts merged PRs into the three lanes', async () => {
    const { reconcile } = await load('reconcile-external-prs.mjs');
    const result = reconcile({
      prs: [
        pr({ number: 1, headRefName: 'feat/12-queued', body: 'Closes #12' }),
        pr({ number: 2, headRefName: 'patch-1', body: 'fixes #40' }),
        pr({ number: 3, headRefName: 'hotfix', body: 'owner asked for this directly' }),
      ],
      elevatedPaths: ELEVATED,
    });
    expect(result.queue.map((e: { pr: number }) => e.pr)).toEqual([1]);
    expect(result.external.map((e: { pr: number }) => e.pr)).toEqual([2]);
    expect(result.ownerDirected.map((e: { pr: number }) => e.pr)).toEqual([3]);
  });

  it('flags a queue PR whose reference survives only in the branch name', async () => {
    const { reconcile } = await load('reconcile-external-prs.mjs');
    const result = reconcile({
      prs: [pr({ number: 7, headRefName: 'feat/12-queued', body: 'no reference' })],
      elevatedPaths: ELEVATED,
    });
    // never counted as external: misfiling it would corrupt the accounting AND
    // hide the broken convention
    expect(result.queue.map((e: { pr: number }) => e.pr)).toEqual([7]);
    expect((result.findings as Finding[])[0]!.kind).toBe('queue-ref-missing-from-description');
  });

  it('marks an external merge that crossed an elevated path as untrusted origin', async () => {
    const { reconcile } = await load('reconcile-external-prs.mjs');
    const result = reconcile({
      prs: [pr({ number: 2, headRefName: 'patch-1', body: 'fixes #40', files: ['infra/a.ts'] })],
      elevatedPaths: ELEVATED,
    });
    expect(result.external[0].untrustedOrigin).toBe(true);
    expect(result.external[0].elevatedFiles).toEqual(['infra/a.ts']);
  });

  it('proposes an audit record that is born closed and never selectable', async () => {
    const { auditRecordFor } = await load('reconcile-external-prs.mjs');
    const record = auditRecordFor(pr({ number: 2, headRefName: 'patch-1', body: 'fixes #40' }));
    expect(record.labels).toContain('audit');
    expect(record.labels).not.toContain('ready'); // the self-feeding firewall
    expect(record.state).toBe('closed');
    expect(record.body).toMatch(/not work/i);
  });

  it('renders a journal block that says which lane the numbers cover', async () => {
    const { reconcile, renderJournalBlock } = await load('reconcile-external-prs.mjs');
    const block = renderJournalBlock(
      reconcile({
        prs: [pr({ number: 2, headRefName: 'patch-1', body: 'fixes #40', files: ['infra/a.ts'] })],
        elevatedPaths: ELEVATED,
      }),
    );
    expect(block).toContain('external lane');
    expect(block).toMatch(/#2/);
    expect(block).toMatch(/elevated/i);
    expect(block).toMatch(/queue lane/i); // the totals above cover only one lane
  });

  it('imports the elevated set rather than keeping a second copy of it', async () => {
    const source = await readFile(scriptPath('reconcile-external-prs.mjs'), 'utf8');
    expect(source).toMatch(/from '\.\/detect-missed-gate\.mjs'/);
    // a second literal list here would drift, and each copy would keep passing
    expect(source).not.toMatch(/elevated-paths\n/);
  });

  it('runs offline from a fixture', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lane-'));
    const input = path.join(dir, 'prs.json');
    await writeFile(
      input,
      JSON.stringify([pr({ number: 2, headRefName: 'patch-1', body: 'fixes #40' })]),
    );
    const result = await run('reconcile-external-prs.mjs', ['--input', input, '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).external).toHaveLength(1);
  });
});

describe('the CLI entrypoint survives a symlinked path', () => {
  // Found while testing: macOS `tmpdir()` is a symlink (/var → /private/var), and
  // an `isMain` guard that compares the module's REALPATH against the raw argv
  // never matches there. The script then exits 0 having printed nothing — which
  // reads as "no findings", the worst possible failure for a safety sweep. Any
  // project living under a symlinked path hits this.
  it.each([
    'detect-missed-gate.mjs',
    'reconcile-external-prs.mjs',
    'preflight.mjs',
    'queue/index.mjs',
  ])('%s produces output when invoked through a symlink', async (script) => {
    const { mkdir, symlink, copyFile, cp } = await import('node:fs/promises');
    const real = await mkdtemp(path.join(tmpdir(), 'realdir-'));
    const project = path.join(real, 'project');
    await mkdir(path.join(project, '.claude', 'scripts'), { recursive: true });
    await copyFile(
      scriptPath('detect-missed-gate.mjs'),
      path.join(project, '.claude', 'scripts', 'detect-missed-gate.mjs'),
    );
    await copyFile(
      scriptPath('reconcile-external-prs.mjs'),
      path.join(project, '.claude', 'scripts', 'reconcile-external-prs.mjs'),
    );
    await copyFile(
      scriptPath('preflight.mjs'),
      path.join(project, '.claude', 'scripts', 'preflight.mjs'),
    );
    await cp(path.join(scriptsDir, 'queue'), path.join(project, '.claude', 'scripts', 'queue'), {
      recursive: true,
    });
    // The queue CLI reaches OUTSIDE `queue/` for three modules, and a fixture that
    // copies only the directory gets a run that fails on the missing import while
    // still printing something — which is all this test asserts, so the gap hid.
    // It hid TWICE: `run-state.mjs` joined the list as a static import of all
    // three adapters, and this fixture went on passing on an
    // `ERR_MODULE_NOT_FOUND` written to stderr, never reaching the symlinked
    // `isMain` guard it exists to exercise.
    //
    // `git-env.mjs` (from `queue/checkout.mjs`) and `run-state.mjs` (from every
    // adapter) are static, so the CLI does not load at all without them;
    // `run-journal.mjs` is a dynamic import taken only when a run directory is
    // declared, so it fails only for a real rig.
    for (const sibling of ['git-env.mjs', 'run-state.mjs', 'run-journal.mjs']) {
      await copyFile(scriptPath(sibling), path.join(project, '.claude', 'scripts', sibling));
    }
    await writeFile(path.join(project, 'PLAN.md'), '# P\n\n## Agent queue\n\n- do a thing\n');
    await writeFile(path.join(project, 'prs.json'), '[]');

    const link = path.join(real, 'via-symlink');
    await symlink(project, link);

    const args =
      script.startsWith('detect') || script.startsWith('reconcile')
        ? ['--input', path.join(link, 'prs.json')]
        : script.startsWith('queue')
          ? ['next']
          : [];
    const result = await new Promise<{ code: number; out: string }>((resolve) => {
      execFile(
        process.execPath,
        [path.join(link, '.claude', 'scripts', script), ...args],
        { cwd: link },
        (error, stdout, stderr) => {
          resolve({
            code: error ? ((error as { code?: number }).code ?? 1) : 0,
            out: stdout + stderr,
          });
        },
      );
    });
    // The assertion is simply: it ran. Silence here is the bug.
    expect(result.out.trim(), `${script} printed nothing through a symlink`).not.toBe('');
  });
});

describe('a sweep that could not run says so in one line', () => {
  // "Findings are the output, not the status" cuts both ways: a sweep that could
  // not reach the API must be unmistakably different from a clean sweep, and a
  // node stack trace is not a diagnosis.
  it.each(['detect-missed-gate.mjs', 'reconcile-external-prs.mjs'])(
    '%s reports an unreachable CLI instead of throwing',
    async (script) => {
      const emptyPath = await mkdtemp(path.join(tmpdir(), 'nopath-'));
      const result = await new Promise<{ code: number; out: string }>((resolve) => {
        execFile(
          process.execPath,
          [scriptPath(script), '--since', '2026-01-01'],
          { cwd: repoRoot, env: { ...process.env, PATH: emptyPath } },
          (error, stdout, stderr) => {
            resolve({
              code: error ? ((error as { code?: number }).code ?? 1) : 0,
              out: stdout + stderr,
            });
          },
        );
      });
      expect(result.code).toBe(1); // could not run at all — that IS a failure
      expect(result.out).toMatch(/could not/i);
      expect(result.out).not.toMatch(/at ModuleJob|node:internal/); // no stack dump
    },
  );
});

describe('the sweeps are declared where the rules can point at them', () => {
  it('autonomy.md states that the elevated gate is swept from outside a run', async () => {
    const rules = await readFile(
      path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'rules', 'autonomy.md'),
      'utf8',
    );
    expect(rules).toMatch(/detect-missed-gate/);
    // the reason the sweep cannot live inside a run
    expect(rules).toMatch(/will not report it|cannot report/i);
  });

  it('layers.json classifies the scripts as process, so `init` carries them', async () => {
    const manifest = JSON.parse(
      await readFile(
        path.join(repoRoot, 'templates', 'agent-os', 'universal', 'layers.json'),
        'utf8',
      ),
    ) as Record<string, string[]>;
    expect(manifest['process']).toContain('.claude/scripts/detect-missed-gate.mjs');
    expect(manifest['process']).toContain('.claude/scripts/reconcile-external-prs.mjs');
  });
});
