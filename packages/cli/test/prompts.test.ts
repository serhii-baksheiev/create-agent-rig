import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { promptTarget } from '../src/lib/prompts.js';

const targets = ['aws-serverless', 'node-service'];

describe('promptTarget', () => {
  it('returns the default without prompting when the input is not a TTY', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chosen = await promptTarget(targets, 'aws-serverless', {
      input,
      output,
      isInteractive: false,
    });
    expect(chosen).toBe('aws-serverless');
    expect(output.read()).toBeNull(); // nothing was written
  });

  it('lets the user pick a target by number', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const pending = promptTarget(targets, 'aws-serverless', {
      input,
      output,
      isInteractive: true,
    });
    input.write('2\n');
    await expect(pending).resolves.toBe('node-service');
    expect(String(output.read())).toContain('node-service');
  });

  it('falls back to the default on empty or invalid input', async () => {
    for (const line of ['\n', 'zzz\n', '99\n']) {
      const input = new PassThrough();
      const output = new PassThrough();
      const pending = promptTarget(targets, 'aws-serverless', {
        input,
        output,
        isInteractive: true,
      });
      input.write(line);
      await expect(pending).resolves.toBe('aws-serverless');
    }
  });

  it('accepts a target by name', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const pending = promptTarget(targets, 'aws-serverless', {
      input,
      output,
      isInteractive: true,
    });
    input.write('node-service\n');
    await expect(pending).resolves.toBe('node-service');
  });
});
