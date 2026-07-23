/**
 * Typed errors. Every error that crosses a layer boundary is one of these —
 * handlers map them to transport codes without inspecting messages.
 */
export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(
    message: string,
    options: { code?: string; statusCode?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code ?? 'INTERNAL';
    this.statusCode = options.statusCode ?? 500;
  }
}

export class ValidationError extends AppError {
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[] = []) {
    super(message, { code: 'VALIDATION', statusCode: 400 });
    this.issues = issues;
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(message, { code: 'NOT_FOUND', statusCode: 404 });
  }
}
