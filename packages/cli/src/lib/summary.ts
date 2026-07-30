import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Palette } from './colors.js';

/**
 * The final screen reports what landed as governance — counted from the
 * generated tree, never hardcoded (CLI polish brief §2). A summary that lies
 * about enforcement would be worse than none in a tool that sells enforcement.
 */
export interface GovernanceSummary {
  rules: string[];
  agents: string[];
  hooks: string[];
  skills: string[];
}

const names = async (dir: string, strip: RegExp): Promise<string[]> => {
  try {
    return (await readdir(dir)).map((entry) => entry.replace(strip, '')).sort();
  } catch {
    return [];
  }
};

/**
 * Hooks whose filename names the *tool* they intercept rather than the
 * invariant they enforce. Stripping the prefix would print "bash", which tells
 * the reader nothing — and a screen that sells enforcement may not be vague.
 */
const HOOK_LABELS: Readonly<Record<string, string>> = {
  'guard-bash': 'never tier',
};

export async function collectGovernance(projectDir: string): Promise<GovernanceSummary> {
  const claude = path.join(projectDir, '.claude');
  return {
    rules: await names(path.join(claude, 'rules'), /\.md$/),
    agents: await names(path.join(claude, 'agents'), /\.md$/),
    hooks: (await names(path.join(claude, 'hooks'), /\.mjs$/)).map(
      // guard-core-purity → "core purity": the mechanism, not the filename
      (hook) => HOOK_LABELS[hook] ?? hook.replace(/^(guard|block)-/, '').replaceAll('-', ' '),
    ),
    skills: await names(path.join(claude, 'skills'), /$^/),
  };
}

export function renderSummary(
  projectName: string,
  target: string,
  dirArg: string,
  summary: GovernanceSummary,
  p: Palette,
): string {
  const row = (label: string, count: number, detail: string, note = '') => {
    const tag = note ? `  ${note}` : '';
    return `  ${label.padEnd(8)}${String(count).padEnd(3)}${tag.padEnd(note ? 11 : 0)}  ${p.dim(detail)}`;
  };

  return [
    `Created  ${p.accent(projectName)}  ${p.dim('·')}  ${target}`,
    '',
    row('Rules', summary.rules.length, '.claude/rules/'),
    row('Agents', summary.agents.length, summary.agents.join(', ')),
    row('Hooks', summary.hooks.length, summary.hooks.join(', '), 'enforced'),
    row('Skills', summary.skills.length, summary.skills.join(', ')),
    '',
    'Next',
    p.dim(`  cd ${dirArg}`),
    p.dim('  pnpm install'),
    p.dim('  pnpm check'),
    '',
  ].join('\n');
}
