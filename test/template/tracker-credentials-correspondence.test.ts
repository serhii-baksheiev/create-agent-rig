// RP-230 follow-up. `doctor.ts`'s `TRACKER_REQUIRED_ENV['jira']` is a
// hand-kept second copy of the required env var NAMES
// `templates/agent-os/universal/.claude/scripts/queue/jira.mjs`'s own
// `requireCredentials` needs — duplicated because that file is template
// payload the CLI copies into a generated project, not a module the
// compiled CLI package can import at runtime (see doctor.ts's own comment
// on `TRACKER_REQUIRED_ENV`). `.claude/rules/invariants.md`, "One
// mechanism, one implementation", requires a correspondence check for
// exactly this shape, going red in both directions.
//
// The two sides are measured two different ways, on purpose:
//
//   - jira.mjs's side is read as TEXT, with an independent regex anchored on
//     `requireCredentials` and its own `const missing = [...]` line. A name
//     added anywhere else in the file is invisible to it — the same class of
//     limit every text parser in correspondence.test.ts carries.
//   - doctor's side is never read as text and the `TRACKER_REQUIRED_ENV`
//     constant is never imported. A jira `queue.json` fixture with every
//     credential env var unset is run through the real `runDoctor`, and the
//     var NAMES are parsed out of the `personal-tracker` check's own `fix`
//     string — doctor's actual reported behaviour is the oracle, not a
//     second reading of the same constant (`.claude/rules/invariants.md`,
//     "the independent-oracle invariant").
//
// Both mutation-direction tests prove the check would go red without
// touching this checkout: each builds its mutated input in a fresh
// `os.tmpdir()` location — a standalone text copy of jira.mjs for the first
// direction, a full copy of `packages/cli/src` with a patched
// `commands/doctor.ts` for the second, imported from that copy so doctor's
// side stays genuinely executed rather than merely re-read. The real
// packages/cli/src tree and the real jira.mjs are never written to.

import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDoctor } from '../../packages/cli/src/commands/doctor.js';
import type { DoctorOptions, DoctorResult } from '../../packages/cli/src/commands/doctor.js';
import { initProject } from '../../packages/cli/src/commands/init.js';
import type { ProviderProcessResult } from '../../packages/cli/src/integrations/spawn.js';
import { removeFixture } from '../helpers/remove-fixture.js';

type RunDoctorFn = (options: DoctorOptions) => Promise<DoctorResult>;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliSrcDir = path.join(repoRoot, 'packages', 'cli', 'src');
const jiraAdapterPath = path.join(
  repoRoot,
  'templates',
  'agent-os',
  'universal',
  '.claude',
  'scripts',
  'queue',
  'jira.mjs',
);

/**
 * The stable PREFIX of `requireCredentials`'s own `const missing = [...]`
 * line — up to the opening bracket only, never the array contents. The
 * anchor has to survive exactly the mutation this file proves it catches
 * (a name added inside the brackets), so it cannot include what is inside
 * them.
 */
const JIRA_MISSING_ANCHOR = 'const missing = [';

/**
 * The literal jira credential array literal inside jira.mjs — the mutation
 * target for the "jira.mjs gains a name" direction. Distinct from the
 * anchor above: this one IS the array contents, and is asserted present
 * (not assumed) before either the parser or a mutation touches it.
 */
const JIRA_ARRAY_LITERAL = "['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN']";

/**
 * The literal `jira: [...]` line inside doctor.ts's `TRACKER_REQUIRED_ENV` —
 * the mutation target for the "doctor gains a name" direction. Doctor's side
 * of the correspondence is never parsed back out of this text (it is
 * measured by running the mutated code — see `missingTrackerVarNamesVia`),
 * so unlike the jira.mjs anchor above this can safely be the full line.
 */
const DOCTOR_JIRA_LINE = "jira: ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'],";

/**
 * The env var NAMES `requireCredentials` requires, parsed from jira.mjs
 * SOURCE TEXT with an independent regex — never an import of the module,
 * and never a restatement of doctor's own `TRACKER_REQUIRED_ENV`. Anchored
 * on the STABLE PREFIX of `requireCredentials`'s own `const missing = [...]`
 * line, so a name added or removed inside the brackets is read, not hidden
 * behind an anchor that would itself have to change first.
 */
function jiraRequiredEnvNamesIn(source: string): string[] {
  const at = source.indexOf(JIRA_MISSING_ANCHOR);
  expect(
    at,
    "jira.mjs no longer carries requireCredentials's own `const missing = [` line this parser keys off",
  ).toBeGreaterThan(-1);
  const openBracket = at + JIRA_MISSING_ANCHOR.length - 1;
  const closeBracket = source.indexOf(']', openBracket);
  const inside = source.slice(openBracket + 1, closeBracket);
  return [...inside.matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1]!);
}

/** Names the offenders in either direction; empty on full correspondence. */
function correspondence(required: readonly string[], reportedMissing: readonly string[]) {
  return {
    unmentioned: required.filter((name) => !reportedMissing.includes(name)),
    unknown: reportedMissing.filter((name) => !required.includes(name)),
  };
}

const passingGuardRunner = async (): Promise<ProviderProcessResult> => ({
  status: 'ok',
  exitCode: 0,
  stdout: '',
  stderr: '',
});

let repo: string;
let home: string;
const cleanupDirs: string[] = [];

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-tracker-corr-'));
  home = await mkdtemp(path.join(tmpdir(), 'caf-tracker-corr-home-'));
});

afterEach(async () => {
  await removeFixture(repo);
  await removeFixture(home);
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop()!;
    await removeFixture(dir);
  }
});

/**
 * The var NAMES doctor's own `personal-tracker` check reports as missing,
 * for a jira `queue.json` with every required env var unset — read from the
 * `fix` string the check prints, on whichever `runDoctor` implementation is
 * passed in (the real one, or a mutated copy's). This is the shared
 * "measurement" both the baseline test and the doctor-side mutation test
 * use, so the two agree on what "doctor's reported names" means.
 */
async function missingTrackerVarNamesVia(runDoctorFn: RunDoctorFn): Promise<string[]> {
  await initProject(repo, { withWorkflow: true });
  const queueDir = path.join(repo, '.claude');
  await mkdir(queueDir, { recursive: true });
  await writeFile(path.join(queueDir, 'queue.json'), `${JSON.stringify({ adapter: 'jira' })}\n`);

  const result = await runDoctorFn({
    cwd: repo,
    args: ['--json'],
    env: { HOME: home, APPDATA: home, PATH: process.env.PATH ?? '' },
    guardRunner: passingGuardRunner,
  });
  const body = JSON.parse(result.stdout) as {
    checks: Array<{ id: string; status: string; fix?: string }>;
  };
  const check = body.checks.find((c) => c.id === 'personal-tracker');
  expect(
    check,
    'doctor must still emit a personal-tracker check for a jira queue.json with no credential env vars set',
  ).toBeTruthy();
  expect(check?.status).toBe('warn');
  const fix = check?.fix ?? '';
  const anchor = 'variable(s): ';
  const at = fix.indexOf(anchor);
  expect(
    at,
    `doctor's personal-tracker fix text changed shape: ${JSON.stringify(fix)}`,
  ).toBeGreaterThan(-1);
  const rest = fix.slice(at + anchor.length);
  const namesPart = rest.endsWith('.') ? rest.slice(0, -1) : rest;
  return namesPart
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/**
 * Copies `packages/cli/src` into a fresh `os.tmpdir()` directory, applies
 * `mutate` to the copy's own `commands/doctor.ts`, and imports `runDoctor`
 * from THAT copy. The real checkout is never written to — only read, to
 * seed the copy.
 *
 * The copy mirrors this repository's own relative layout —
 * `<root>/packages/cli/src/…` beside `<root>/templates/…` and
 * `<root>/package.json` — because `packages/cli/src/templates.ts`'s
 * `templatesRoot()` finds `templates/` (and, from there, `layers.json`,
 * which `initProject`'s manifest step reads) by walking a FIXED number of
 * `..` steps up from its own file, not from any notion of "the repo root".
 * A copy that kept only `src/` resolved that walk straight past `/tmp` to
 * the filesystem root and failed with ENOENT on `/templates/...` — this
 * layout is what makes the copy behave like the real package instead.
 */
async function mutatedDoctorRunDoctor(mutate: (source: string) => string): Promise<RunDoctorFn> {
  const mutRoot = await mkdtemp(path.join(tmpdir(), 'caf-doctor-mut-'));
  cleanupDirs.push(mutRoot);
  const cliRoot = path.join(mutRoot, 'packages', 'cli');
  await cp(cliSrcDir, path.join(cliRoot, 'src'), { recursive: true });
  await cp(path.join(repoRoot, 'templates'), path.join(mutRoot, 'templates'), { recursive: true });
  await cp(path.join(repoRoot, 'package.json'), path.join(mutRoot, 'package.json'));
  const doctorPath = path.join(cliRoot, 'src', 'commands', 'doctor.ts');
  const original = await readFile(doctorPath, 'utf8');
  const mutated = mutate(original);
  expect(mutated, 'setup: the mutation must actually change the copy of doctor.ts').not.toBe(
    original,
  );
  await writeFile(doctorPath, mutated);
  const mod = (await import(pathToFileURL(doctorPath.replace(/\.ts$/, '.js')).href)) as {
    runDoctor: RunDoctorFn;
  };
  return mod.runDoctor;
}

describe("doctor's jira tracker-credential var names correspond to jira.mjs's own requireCredentials (RP-230 follow-up)", () => {
  it('reports full correspondence today: the same three var names on both sides', async () => {
    const required = jiraRequiredEnvNamesIn(await readFile(jiraAdapterPath, 'utf8'));
    expect(required.length, 'sanity: parsed zero names out of jira.mjs').toBeGreaterThan(0);
    const reported = await missingTrackerVarNamesVia(runDoctor);
    expect(correspondence(required, reported)).toEqual({ unmentioned: [], unknown: [] });
  });

  it('reports a name jira.mjs requires that doctor never reports missing (mutation: jira.mjs gains a name, in a /tmp copy)', async () => {
    const original = await readFile(jiraAdapterPath, 'utf8');
    expect(
      original,
      'setup: jira.mjs no longer carries the exact array literal this test mutates',
    ).toContain(JIRA_ARRAY_LITERAL);
    const extraVar = 'JIRA_WORKSPACE_ID';
    const mutatedSource = original.replace(
      JIRA_ARRAY_LITERAL,
      JIRA_ARRAY_LITERAL.replace("'JIRA_API_TOKEN']", `'JIRA_API_TOKEN', '${extraVar}']`),
    );
    expect(mutatedSource).not.toBe(original);

    const mutDir = await mkdtemp(path.join(tmpdir(), 'caf-jira-mut-'));
    cleanupDirs.push(mutDir);
    const mutPath = path.join(mutDir, 'jira.mjs');
    await writeFile(mutPath, mutatedSource);

    const mutatedRequired = jiraRequiredEnvNamesIn(await readFile(mutPath, 'utf8'));
    expect(mutatedRequired).toContain(extraVar);

    // The real, unmutated doctor never heard of this name.
    const reported = await missingTrackerVarNamesVia(runDoctor);
    expect(correspondence(mutatedRequired, reported).unmentioned).toEqual([extraVar]);
  });

  it('reports a name doctor requires that jira.mjs never required (mutation: doctor gains a name, in a /tmp copy of packages/cli/src)', async () => {
    const required = jiraRequiredEnvNamesIn(await readFile(jiraAdapterPath, 'utf8'));
    const extraVar = 'JIRA_WORKSPACE_ID';

    const mutatedRunDoctor = await mutatedDoctorRunDoctor((source) => {
      expect(
        source,
        'setup: doctor.ts no longer carries the exact TRACKER_REQUIRED_ENV jira line this test mutates',
      ).toContain(DOCTOR_JIRA_LINE);
      return source.replace(
        DOCTOR_JIRA_LINE,
        DOCTOR_JIRA_LINE.replace("'JIRA_API_TOKEN'],", `'JIRA_API_TOKEN', '${extraVar}'],`),
      );
    });

    const reported = await missingTrackerVarNamesVia(mutatedRunDoctor);
    expect(reported).toContain(extraVar);
    expect(correspondence(required, reported).unknown).toEqual([extraVar]);
  });
});
