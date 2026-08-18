// Dogfooding (PLAN.md phase 5): this repo runs under the agent-os it ships.
// Composes CLAUDE.md + .claude/ from templates/agent-os (universal + node-ts,
// this repo's stack) plus the hand-maintained repo addendum.
//
//   node scripts/sync-agent-os.mjs           # write the composed files
//   node scripts/sync-agent-os.mjs --check   # exit 1 if anything drifted
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncCodexAdapters } from './sync-codex-adapter.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const stacks = ['node-ts'].map((s) => path.join(repoRoot, 'templates', 'agent-os', 'stack', s));
const check = process.argv.includes('--check');

// Claude files are the authoring surface; refresh (or verify) their native
// Codex projections before composing this repository's dogfood copy.
syncCodexAdapters({ check });

const substitute = (content) => content.replaceAll('__PROJECT_NAME__', 'create-agent-rig');

/**
 * This repo's own elevated-tier paths — the ones `detect-missed-gate.mjs` sweeps.
 *
 * The template seeds the block with the generated skeleton's paths
 * (`packages/db/src/`, `.claude/`, `.github/workflows/`), and the first of those
 * does not exist here. Left in place it would declare a gate over nothing, and
 * the sweep would report "clean" while looking nowhere.
 * So dogfooding replaces the block rather than appending a second one: one list,
 * one home, and every entry a real directory in this tree.
 */
const ELEVATED_PATHS = [
  '.github/workflows/', // what runs on every push, and what deploys
  'scripts/', // prepare + the dogfooding sync itself
  'package.json', // the publish manifest: files, bin, version
  'templates/agent-os/universal/.claude/hooks/', // the enforcement layer
  'templates/agent-os/universal/.claude/scripts/', // and the sweeps that watch it
  'templates/agent-os/universal/.claude/settings.json', // the hook wiring
  'templates/agent-os/init/', // the map and overrides every `init`ed repo gets
  // The gates themselves. An agent spec or a driver skill decides what gets
  // blocked and what gets waved through, so a merge that quietly re-scopes one
  // disarms the review layer as surely as unwiring a hook does.
  //
  // Declared only now, because until the sweep learned to see a rulebook
  // outside the repository root these two lines would have matched nothing —
  // a declaration that reports "clean" while looking nowhere is worse than an
  // honest gap.
  'templates/agent-os/universal/.claude/agents/',
  'templates/agent-os/universal/.claude/skills/',
  'templates/agent-os/universal/.agents/',
  'templates/agent-os/universal/.codex/',
  'templates/agent-os/universal/AGENTS.md',
  // The rules themselves: the autonomy tiers and the Never list are authored
  // here, and the sweep's own reason for exempting the rulebook from "inert" is
  // "a merged PR rewriting the autonomy tiers". That text lives in this repo.
  'templates/agent-os/universal/.claude/rules/',
  'templates/agent-os/universal/CLAUDE.md',
  '.agents/',
  '.codex/',
  'AGENTS.md',
  // The rationale extracted out of those rules (AR-63). Declaring it is only
  // half of what it needs: `.md` is inert to the sweep unless the path counts
  // as rulebook, so `isDecisionRecord` in `detect-missed-gate.mjs` is the other
  // half, and a declaration without it reports clean over every record.
  //
  // BOTH the source and the synced copy, which departs from the convention of
  // the lines above (`.claude/` and the root `CLAUDE.md` are synced too, and
  // only their sources are declared). The reason is the reader, not the sweep:
  // `elevatedPathsIn` compares with a start-anchored `startsWith`, so neither
  // path covers the other, and a decision record is the one synced artifact a
  // human is expected to open at its root path — a finding naming only the
  // template source would send them to the file they were not reading.
  'templates/agent-os/universal/docs/decisions/',
  'docs/decisions/',
  // Same categories, one layer down: a stack layer's gates and DoD config are
  // no less load-bearing for being target-specific.
  'templates/agent-os/stack/aws-cdk/.claude/agents/',
  'templates/agent-os/stack/aws-cdk/.claude/skills/',
  'templates/agent-os/stack/node-ts/.claude/hooks/',
  // The stack rulebooks. `aws-cdk.md` is the sharp one: it carries its OWN
  // `elevated-paths` block declaring `infra/`, and it is the only declaration of
  // `infra/` a generated AWS project has. Delete that block and every later
  // merge under `infra/` matches no declared path, so the sweep reports clean —
  // not because nothing is declared (that case it shouts about, as
  // `no-elevated-paths-declared`) but because the one line that covered
  // infrastructure is gone. A file that is a declaration source has to be
  // covered by a declaration itself.
  'templates/agent-os/stack/aws-cdk/.claude/rules/',
  'templates/agent-os/stack/node-ts/.claude/rules/',
];

const withElevatedPaths = (claudeMd) =>
  claudeMd.replace(
    /```elevated-paths\n[\s\S]*?```/,
    `\`\`\`elevated-paths\n${ELEVATED_PATHS.join('\n')}\n\`\`\``,
  );

/** target path (repo-relative) -> composed content */
function compose() {
  const out = new Map();

  const addTree = (baseDir) => {
    if (!existsSync(baseDir)) throw new Error(`missing template dir: ${baseDir}`);
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(abs);
        else if (entry.isFile()) {
          const rel = path.relative(baseDir, abs).replaceAll('\\', '/');
          if (rel === 'CLAUDE.md' || rel === 'AGENTS.md') continue; // handled separately below
          if (rel === 'layers.json') continue; // init-manifest, not project content
          if (rel === 'PLAN.md') continue; // this repo has its own owner-authored plan
          out.set(rel, substitute(readFileSync(abs, 'utf8')));
        }
      }
    };
    walk(baseDir);
  };

  addTree(universal);
  for (const stack of stacks) addTree(stack);

  const addendum = readFileSync(path.join(repoRoot, '.claude', 'CLAUDE.addendum.md'), 'utf8');
  const repositoryMap =
    withElevatedPaths(substitute(readFileSync(path.join(universal, 'CLAUDE.md'), 'utf8'))) +
    '\n---\n\n' +
    addendum;
  out.set('CLAUDE.md', repositoryMap);
  out.set('AGENTS.md', repositoryMap);

  // Repo-specific override: this repo's `pnpm test` is the full e2e (minutes).
  // The DoD stop gate needs the cheap, deterministic loop instead.
  out.set(
    '.claude/hooks/dod-checks.json',
    JSON.stringify(['pnpm lint', 'pnpm typecheck', 'pnpm test:unit']) + '\n',
  );
  // Repo-specific override, same class as the one above: this repo's queue lives
  // on a Jira board, while a generated project must stay on the zero-setup
  // `plan-md` default — it has no Jira, no credentials and no board of ours.
  //
  // Why an override rather than editing the file in place: `.claude/queue.json`
  // is COMPOSED from the template, so an in-place edit is drift and `--check`
  // fails. And why not exempt the file from composition instead — the obvious
  // alternative: an exempted file is one the drift check stops reading, which is
  // precisely the silent divergence `--check` exists to catch.
  //
  // It DERIVES rather than replaces: the two keys this repo decides are set over
  // whatever the template ships, so a key added there later (a schema version, a
  // state-file path, new default options) reaches this repo on the next sync
  // instead of being silently dropped by a literal.
  out.set(
    '.claude/queue.json',
    JSON.stringify(
      {
        ...JSON.parse(out.get('.claude/queue.json')),
        adapter: 'jira',
        options: { project: 'AR' },
      },
      null,
      2,
    ) + '\n',
  );
  return out;
}

const composed = compose();
const drifted = [];

for (const [rel, content] of composed) {
  const target = path.join(repoRoot, rel);
  if (check) {
    const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
    if (current !== content) drifted.push(rel);
  } else {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
    console.log(`synced ${rel}`);
  }
}

if (check && drifted.length > 0) {
  console.error(
    `agent-os drift detected in:\n${drifted.map((f) => `  - ${f}`).join('\n')}\n` +
      'Edit templates/agent-os (or .claude/CLAUDE.addendum.md) and run: node scripts/sync-agent-os.mjs',
  );
  process.exit(1);
}
