/** Minimal structured logger: one JSON object per line on stdout. */
export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function createLogger(
  base: Record<string, unknown> = {},
  write: (line: string) => void = (line) => process.stdout.write(line + '\n'),
): Logger {
  const emit = (level: string, message: string, fields?: Record<string, unknown>) => {
    write(JSON.stringify({ level, message, ...base, ...fields }));
  };
  return {
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}
