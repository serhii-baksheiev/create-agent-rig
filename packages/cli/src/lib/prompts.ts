import { createInterface } from 'node:readline';

export interface PromptStreams {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** False in pipes/CI — the default is returned silently. */
  isInteractive: boolean;
}

/**
 * A yes/no gate before something irreversible. **The default is no**, and a
 * non-interactive caller gets `false` without being asked — the same rule the
 * rest of this CLI follows: never guess for a run that cannot answer.
 *
 * Unlike the target prompt, an unrecognised answer is *not* forgiving: the
 * question is asked before rewriting files in somebody's repository, and "I
 * did not understand you" must not resolve to "go ahead".
 */
export function promptConfirm(question: string, streams: PromptStreams): Promise<boolean> {
  if (!streams.isInteractive) return Promise.resolve(false);
  const rl = createInterface({ input: streams.input, output: streams.output });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
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
