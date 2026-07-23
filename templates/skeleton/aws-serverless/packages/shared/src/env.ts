import type { ZodType } from 'zod';
import { AppError } from './errors.js';

/**
 * Parse the environment through a zod schema, once, at startup. Configuration
 * is invalid → the process fails loudly at boot, not deep inside a request.
 */
export function loadEnv<T>(schema: ZodType<T>, source: Record<string, string | undefined>): T {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new AppError(`invalid environment: ${details}`, { code: 'ENV_INVALID' });
  }
  return parsed.data;
}
