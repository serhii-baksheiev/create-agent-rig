import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger.js';

describe('createLogger', () => {
  it('emits one JSON line per call with level, message, base and call fields', () => {
    const lines: string[] = [];
    const log = createLogger({ service: 'api' }, (line) => lines.push(line));
    log.info('started', { port: 3000 });
    log.error('failed');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({
      level: 'info',
      message: 'started',
      service: 'api',
      port: 3000,
    });
    expect(JSON.parse(lines[1]!)).toMatchObject({ level: 'error', message: 'failed' });
  });
});
