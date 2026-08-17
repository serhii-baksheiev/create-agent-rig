import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// AR-65: the seven gate specs make the same promise — end with exactly one
// fenced ```json block of the shape `lib/verdict.mjs` defines. The promise is
// asserted in two different suites (agents.test.ts for the four agents,
// skills.test.ts for the three skills), so the MECHANICS of reading a spec and
// of asking the module which words a gate may return live here once.
//
// 🔴 The vocabulary is imported, never re-listed. A second copy of "what
// `check-premises` may return" would drift from the module the moment either
// side changed, and the copy nobody is looking at is the one that is wrong
// (`.claude/rules/invariants.md`, "one mechanism, one implementation").

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const agentOs = path.join(repoRoot, 'templates', 'agent-os');

/**
 * Every gate that returns a verdict, and the spec that defines it — the
 * TEMPLATE copy, never the synced `.claude/` one: the template is the source
 * and an assertion against the copy would pass on a stale sync.
 */
export const GATE_SPEC_PATHS: Readonly<Record<string, string>> = {
  'code-reviewer': path.join(agentOs, 'universal', '.claude', 'agents', 'code-reviewer.md'),
  'prose-reviewer': path.join(agentOs, 'universal', '.claude', 'agents', 'prose-reviewer.md'),
  'security-scanner': path.join(agentOs, 'universal', '.claude', 'agents', 'security-scanner.md'),
  'cdk-diff-reviewer': path.join(
    agentOs,
    'stack',
    'aws-cdk',
    '.claude',
    'agents',
    'cdk-diff-reviewer.md',
  ),
  'pr-ship': path.join(agentOs, 'universal', '.claude', 'skills', 'pr-ship', 'SKILL.md'),
  'check-premises': path.join(
    agentOs,
    'universal',
    '.claude',
    'skills',
    'check-premises',
    'SKILL.md',
  ),
  'post-deploy-verify': path.join(
    agentOs,
    'stack',
    'aws-cdk',
    '.claude',
    'skills',
    'post-deploy-verify',
    'SKILL.md',
  ),
};

export const readGateSpec = (gate: string): Promise<string> => {
  const specPath = GATE_SPEC_PATHS[gate];
  if (specPath === undefined) throw new Error(`no spec path is declared for the gate \`${gate}\``);
  return readFile(specPath, 'utf8');
};

/**
 * The fenced ```json blocks a spec ships, parsed.
 *
 * A block tagged `json` that is not JSON is reported as itself rather than as a
 * bare SyntaxError — the reader needs to know WHICH example in WHICH spec is
 * malformed, not that something somewhere failed to parse.
 */
export function verdictExamplesIn(content: string, label: string): Record<string, unknown>[] {
  const blocks = [...content.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => match[1] ?? '');
  return blocks.map((raw, index) => {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error(`fenced json block #${index + 1} in ${label} is not JSON:\n${raw}`);
    }
  });
}

/**
 * The words `lib/verdict.mjs` lets this gate return.
 *
 * 🔴 A gate the universal vocabulary does not name falls back to the shared
 * list, because that is exactly what the module does with it. The module ships
 * in the stack-neutral layer, so a gate belonging to one stack
 * (`cdk-diff-reviewer`) cannot be named there — `composition.test.ts` refuses a
 * provider term in `universal/` — and it reaches the schema as an unknown gate.
 * Asserting the shared list for it keeps this test honest about what the
 * mechanism checks, rather than pinning a per-gate rule nothing enforces.
 */
export async function verdictWordsFor(gate: string): Promise<readonly string[]> {
  const modulePath = path.join(agentOs, 'universal', '.claude', 'scripts', 'lib', 'verdict.mjs');
  const { GATE_VOCABULARY, VERDICT_WORDS } = (await import(pathToFileURL(modulePath).href)) as {
    GATE_VOCABULARY: Readonly<Record<string, readonly string[]>>;
    VERDICT_WORDS: readonly string[];
  };
  return GATE_VOCABULARY[gate] ?? VERDICT_WORDS;
}
