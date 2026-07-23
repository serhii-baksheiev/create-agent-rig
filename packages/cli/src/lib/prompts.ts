import { createInterface } from 'node:readline';

export interface PromptStreams {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** False in pipes/CI — the default is returned silently. */
  isInteractive: boolean;
}

/**
 * Pick a target interactively: by number, by name, or Enter for the default.
 * Anything unrecognised falls back to the default — generation should never
 * dead-end on a typo.
 */
export function promptTarget(
  targets: readonly string[],
  defaultTarget: string,
  streams: PromptStreams,
): Promise<string> {
  if (!streams.isInteractive) {
    return Promise.resolve(defaultTarget);
  }
  const menu = targets
    .map((name, index) => `  ${index + 1}. ${name}${name === defaultTarget ? ' (default)' : ''}`)
    .join('\n');
  const rl = createInterface({ input: streams.input, output: streams.output });
  return new Promise((resolve) => {
    rl.question(`Target:\n${menu}\nChoose [1-${targets.length}]: `, (answer) => {
      rl.close();
      const trimmed = answer.trim();
      const byNumber = targets[Number.parseInt(trimmed, 10) - 1];
      const byName = targets.find((name) => name === trimmed);
      resolve(byName ?? byNumber ?? defaultTarget);
    });
  });
}
