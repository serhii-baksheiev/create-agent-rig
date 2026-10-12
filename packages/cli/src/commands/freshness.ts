import { checkFreshness } from '../integrations/freshness.js';
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
  const report = await checkFreshness({
    fetch: options.fetch,
    userAgent: `create-agent-rig/${await packageVersion()}`,
  });
  return { exitCode: 0, stdout: `${JSON.stringify(report)}\n`, stderr: '' };
}
