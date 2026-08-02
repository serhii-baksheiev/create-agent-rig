// Dogfooding (PLAN.md phase 5): this repo runs under the agent-os it ships.
// Composes CLAUDE.md + .claude/ from templates/agent-os (universal + node-ts,
// this repo's stack) plus the hand-maintained repo addendum.
//
//   node scripts/sync-agent-os.mjs           # write the composed files
//   node scripts/sync-agent-os.mjs --check   # exit 1 if anything drifted
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const stacks = ['node-ts'].map((s) => path.join(repoRoot, 'templates', 'agent-os', 'stack', s));

const substitute = (content) => content.replaceAll('__PROJECT_NAME__', 'create-agent-rig');

/**
 * This repo's own elevated-tier paths — the ones `detect-missed-gate.mjs` sweeps.
 *
 * The template seeds the block with the generated skeleton's paths (`infra/`,
 * `packages/db/src/`), which do not exist here. Left in place they would declare
 * a gate over nothing, and the sweep would report "clean" while looking nowhere.
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
          const rel = path.relative(baseDir, abs);
          if (rel === 'CLAUDE.md') continue; // handled separately below
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
  out.set(
    'CLAUDE.md',
    withElevatedPaths(substitute(readFileSync(path.join(universal, 'CLAUDE.md'), 'utf8'))) +
      '\n---\n\n' +
      addendum,
  );

  // Repo-specific override: this repo's `pnpm test` is the full e2e (minutes).
  // The DoD stop gate needs the cheap, deterministic loop instead.
  out.set(
    '.claude/hooks/dod-checks.json',
    JSON.stringify(['pnpm lint', 'pnpm typecheck', 'pnpm test:unit']) + '\n',
  );
  return out;
}

const check = process.argv.includes('--check');
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
