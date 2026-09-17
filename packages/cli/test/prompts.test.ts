import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { promptConfirm } from '../src/lib/prompts.js';

describe('promptConfirm — the gate before rewriting somebody else files', () => {
  const ask = (line: string | null): Promise<boolean> => {
    const input = new PassThrough();
    const output = new PassThrough();
    const pending = promptConfirm('Apply?', { input, output, isInteractive: line !== null });
    if (line !== null) input.write(line);
    return pending;
  };

  it('takes only an explicit yes', async () => {
    await expect(ask('y\n')).resolves.toBe(true);
    await expect(ask('YES\n')).resolves.toBe(true);
  });

  it('treats everything else as no — silence, a typo, or an answer to another question', async () => {
    for (const line of ['\n', 'n\n', 'sure\n', 'ye\n']) {
      await expect(ask(line), line).resolves.toBe(false);
    }
  });

  it('never asks a run that cannot answer', async () => {
    await expect(ask(null)).resolves.toBe(false);
  });
});
