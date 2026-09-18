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
