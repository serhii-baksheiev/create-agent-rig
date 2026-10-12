import { parseArgs } from 'node:util';
import { checkFreshness, type ProviderFreshness } from '../integrations/freshness.js';
import { packageVersion } from '../lib/version.js';

export type FreshnessCommandOptions = {
  /** The arguments after `integrations`. */
  args: string[];
  fetch: typeof globalThis.fetch;
};
export type FreshnessCommandResult = { exitCode: number; stdout: string; stderr: string };

/** `create-agent-rig integrations freshness` — read-only, and the CLI's one networked command. */
export async function runFreshnessCommand(
  options: FreshnessCommandOptions,
): Promise<FreshnessCommandResult> {
  // Do not echo an untrusted positional value into terminal diagnostics.
  if (options.args[0] !== 'freshness') {
    return {
      exitCode: 2,
      stdout: '',
      stderr: 'Unknown integrations subcommand: expected freshness.\n',
    };
  }
  let values: { json?: boolean };
  try {
    ({ values } = parseArgs({
      args: options.args.slice(1),
      options: { json: { type: 'boolean' } },
      allowPositionals: false,
    }));
  } catch (error) {
    return { exitCode: 2, stdout: '', stderr: `${(error as Error).message}\n` };
  }
  const report = await checkFreshness({
    fetch: options.fetch,
    userAgent: `create-agent-rig/${await packageVersion()}`,
  });
  const stdout = values.json
    ? `${JSON.stringify(report)}\n`
    : report.providers.map((provider) => `${renderLine(provider)}\n`).join('');
  return { exitCode: 0, stdout, stderr: '' };
}

const LABELS = [
  ['latest', 'latest'],
  ['highestStable', 'highest stable'],
  ['latestRelease', 'latest release'],
  ['highestTag', 'highest tag'],
  ['reason', 'reason'],
] as const;

function renderLine(provider: ProviderFreshness): string {
  const details = [`tested ${provider.tested}`];
  for (const [key, label] of LABELS) {
    const value = provider[key];
    if (value !== undefined) details.push(`${label} ${value}`);
  }
  return `${provider.id}: ${provider.state} (${details.join('; ')})`;
}
