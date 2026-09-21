import { createInterface } from 'node:readline/promises';
import { runIntegrationsCommand } from './integrations.js';
import type { IntegrationsCliOptions, IntegrationsCliResult } from './integrations.js';
import { REGISTRY } from '../integrations/registry.js';

const PROVIDERS = REGISTRY.map((provider) => provider.id);
const HARNESSES = ['claude-code', 'codex', 'both'] as const;
type WizardStep = 'provider' | 'harness';

export type SetupWizardOptions = {
  cwd: string;
  isTTY: boolean;
  args: string[];
  promptChoice?: (step: WizardStep) => Promise<string | undefined>;
  confirm?: (plan: string) => Promise<boolean>;
  runIntegration?: (options: IntegrationsCliOptions) => Promise<IntegrationsCliResult>;
};

function refused(json: boolean, reason: string): IntegrationsCliResult {
  return {
    exitCode: 1,
    stdout: json
      ? `${JSON.stringify({ schemaVersion: 1, command: 'setup', outcome: 'refused', reason })}\n`
      : '',
    stderr: json ? '' : `setup: ${reason}\n`,
  };
}

function selected(value: string | undefined, choices: readonly string[]): string | undefined {
  if (value === undefined) return undefined;
  const index = Number(value);
  if (Number.isInteger(index) && index >= 1 && index <= choices.length) return choices[index - 1];
  return choices.includes(value) ? value : undefined;
}

async function ask(step: WizardStep): Promise<string | undefined> {
  const choices = step === 'provider' ? PROVIDERS : HARNESSES;
  const label = step === 'provider' ? 'integration provider' : 'harness';
  const display = choices.map((choice, index) => `${index + 1}) ${choice}`).join(', ');
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await readline.question(`Select ${label} (${display}; Enter to cancel): `);
    return answer.trim() === '' ? undefined : answer.trim();
  } finally {
    readline.close();
  }
}

/** Human-only selection surface; mutations remain in the deterministic command. */
export async function runSetupWizard(options: SetupWizardOptions): Promise<IntegrationsCliResult> {
  const json = options.args.includes('--json');
  if (json) return refused(true, 'setup-wizard-requires-an-interactive-terminal');
  if (!options.isTTY) return refused(false, 'setup-wizard-requires-an-interactive-terminal');
  if (options.args.length !== 0) return refused(false, 'setup-wizard-takes-no-options');

  const prompt = options.promptChoice ?? ask;
  const provider = selected(await prompt('provider'), PROVIDERS);
  if (provider === undefined) return { exitCode: 0, stdout: 'setup: cancelled\n', stderr: '' };
  const harness = selected(await prompt('harness'), HARNESSES);
  if (harness === undefined) return { exitCode: 0, stdout: 'setup: cancelled\n', stderr: '' };
  const selectedHarnesses =
    harness === 'both' ? (['claude-code', 'codex'] as const) : ([harness] as const);
  const args = [provider, ...selectedHarnesses.flatMap((item) => ['--harness', item])];
  return (options.runIntegration ?? runIntegrationsCommand)({
    verb: 'add',
    args,
    cwd: options.cwd,
    isTTY: options.isTTY,
    confirm: options.confirm,
  });
}
