import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// The elevated-path declaration this repo publishes, read the way the sweep
// reads it. Imported through a URL for the same reason as below: the script
// ships as plain .mjs with no type declarations.
type Detector = {
  parseElevatedPaths: (md: string) => string[] | null;
  elevatedPathsIn: (files: string[], elevatedPaths: string[]) => string[];
};

const loadDetector = async (): Promise<Detector> =>
  (await import(
    pathToFileURL(
      path.join(repoRoot, 'templates/agent-os/universal/.claude/scripts/detect-missed-gate.mjs'),
    ).href
  )) as Detector;

const loadDeclaredPaths = async (): Promise<string[]> => {
  const detector = await loadDetector();
  const claudeMd = await readFile(path.join(repoRoot, 'CLAUDE.md'), 'utf8');
  const declared = detector.parseElevatedPaths(claudeMd);
  expect(declared).not.toBeNull();
  return declared!;
};

// PLAN.md phase 5: this repo runs under its own agent-os. CLAUDE.md and
// .claude/ are composed from templates/agent-os (universal + node-ts) by
// scripts/sync-agent-os.mjs; any drift between the templates and the checked-in
// copies fails here.
describe('dogfooding: the tool repo runs its own agent-os', () => {
  it('CLAUDE.md and .claude/ are in sync with templates/agent-os', async () => {
    await expect(
      exec(process.execPath, [path.join(repoRoot, 'scripts', 'sync-agent-os.mjs'), '--check']),
    ).resolves.toBeTruthy();
  });

  it('the composed CLAUDE.md names this repo and keeps the repo addendum', async () => {
    const claudeMd = await readFile(path.join(repoRoot, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('create-agent-rig');
    expect(claudeMd).toContain('generator repo addendum');
    // The universal-derived part is fully substituted. (The addendum below the
    // marker legitimately *documents* the token names, so it is exempt.)
    const [universalPart] = claudeMd.split('generator repo addendum');
    expect(universalPart).not.toContain('__PROJECT_NAME__');
  });

  // The seeded elevated paths belong to the generated skeleton
  // (packages/db/src/), which does not exist here. Left as-is it would declare a
  // gate over nothing — dogfooding that describes another repo is worse than no
  // dogfooding, because the sweep would report "clean" while looking nowhere.
  it('declares elevated paths that actually exist in THIS repo', async () => {
    // Imported through a URL: the hook/script tree ships as plain .mjs with no
    // declarations, and a fabricated .d.ts for a template file would rot.
    const detector = (await import(
      pathToFileURL(
        path.join(repoRoot, 'templates/agent-os/universal/.claude/scripts/detect-missed-gate.mjs'),
      ).href
    )) as { parseElevatedPaths: (md: string) => string[] | null };
    const claudeMd = await readFile(path.join(repoRoot, 'CLAUDE.md'), 'utf8');
    const declared = detector.parseElevatedPaths(claudeMd);
    expect(declared).not.toBeNull();
    expect(declared!.length).toBeGreaterThan(0);

    const { access } = await import('node:fs/promises');
    for (const declaredPath of declared!) {
      await expect(
        access(path.join(repoRoot, declaredPath)),
        `declared elevated path does not exist: ${declaredPath}`,
      ).resolves.toBeUndefined();
    }
    // and the enforcement layer itself is elevated here: weakening a hook is
    // precisely the change that must never slip through unreviewed
    expect(declared).toContain('templates/agent-os/universal/.claude/hooks/');
  });

  // AR-12. A file that carries its own ```elevated-paths``` block is a
  // declaration source: the sweep unions every such block into the list it
  // gates on. So a merge that DELETES such a block silently un-declares
  // whatever it declared, and the sweep afterwards reports "clean" while
  // looking nowhere. The only thing that makes that merge visible is the
  // declaring file itself sitting under a declared elevated path.
  //
  // The sharp case is templates/agent-os/stack/aws-cdk/.claude/rules/aws-cdk.md:
  // its block declares `infra/` for every generated AWS project.
  it('declares both stack rulebooks, one of which declares elevated paths itself', async () => {
    const declared = await loadDeclaredPaths();

    expect(declared).toContain('templates/agent-os/stack/aws-cdk/.claude/rules/');
    expect(declared).toContain('templates/agent-os/stack/node-ts/.claude/rules/');
  });

  it('declares every file that declares elevated paths of its own', async () => {
    const declared = await loadDeclaredPaths();
    const detector = await loadDetector();

    // One pass over the tracked markdown files: `git ls-files` never descends
    // into node_modules or .git, so the work is bounded by what is committed.
    // Only .md is scanned, because only a .md can be a declaration SOURCE the
    // sweep reads: `readDeclaredPaths` parses CLAUDE.md and .claude/rules/*.md
    // and nothing else. The one .mjs that matters is scripts/sync-agent-os.mjs,
    // whose ELEVATED_PATHS is this repo's authoritative list — it is not scanned
    // here and does not need to be, because `scripts/` is itself declared. Move
    // that list elsewhere and this reasoning has to move with it.
    const { stdout } = await exec('git', ['ls-files', '*.md'], { cwd: repoRoot });
    const markdownFiles = stdout.split('\n').filter(Boolean);

    const declaringFiles: string[] = [];
    for (const relFile of markdownFiles) {
      // The root CLAUDE.md is skipped, and NOT because the assertion would be
      // circular — it would simply fail: no declared path covers it. It is
      // exempt because three other mechanisms already cover it, and adding it to
      // the list would be a fourth. It is GENERATED by sync-agent-os.mjs, so a
      // hand-edit fails the drift check in CI; a legitimate edit goes through
      // `scripts/`, which IS declared; and deleting its block entirely makes the
      // sweep emit `no-elevated-paths-declared` rather than fall silent.
      if (relFile === 'CLAUDE.md') continue;
      const content = await readFile(path.join(repoRoot, relFile), 'utf8');
      if (content.includes('```elevated-paths')) declaringFiles.push(relFile);
    }
    expect(declaringFiles.length).toBeGreaterThan(0);

    // Coverage is asked of the sweep itself rather than re-implemented here.
    // A hand-rolled prefix match would drift from `elevatedPathsIn` — and it
    // would miss the half that matters: a path can be declared and still be
    // dropped as inert, which is exactly how `.md` rulebooks were once
    // invisible to this gate.
    for (const relFile of declaringFiles) {
      expect(
        detector.elevatedPathsIn([relFile], declared).length > 0,
        `file declares elevated paths but is not itself under a declared elevated path — ` +
          `deleting its block would un-declare them and the sweep would report clean: ${relFile}`,
      ).toBe(true);
    }
  });

  it('the blocking hooks are active in this repo', async () => {
    const settings = JSON.parse(
      await readFile(path.join(repoRoot, '.claude', 'settings.json'), 'utf8'),
    ) as { hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> } };
    const commands = settings.hooks.PreToolUse.flatMap((h) => h.hooks.map((x) => x.command));
    expect(commands.some((c) => c.includes('block-no-verify.mjs'))).toBe(true);
  });
});
