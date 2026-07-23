import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../src/errors.js';
import { loadEnv } from '../src/env.js';

const schema = z.object({
  TABLE_NAME: z.string().min(1),
  QUEUE_URL: z.string().min(1),
});

describe('loadEnv', () => {
  it('returns the typed subset of the environment', () => {
    const env = loadEnv(schema, { TABLE_NAME: 't', QUEUE_URL: 'q', UNRELATED: 'x' });
    expect(env).toEqual({ TABLE_NAME: 't', QUEUE_URL: 'q' });
  });

  it('fails loudly, naming every missing key', () => {
    expect(() => loadEnv(schema, {})).toThrow(AppError);
    expect(() => loadEnv(schema, {})).toThrow(/TABLE_NAME/);
    expect(() => loadEnv(schema, {})).toThrow(/QUEUE_URL/);
  });

  it('rejects empty values', () => {
    expect(() => loadEnv(schema, { TABLE_NAME: '', QUEUE_URL: 'q' })).toThrow(/TABLE_NAME/);
  });
});
