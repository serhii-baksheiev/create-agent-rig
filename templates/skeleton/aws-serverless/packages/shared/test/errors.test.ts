import { describe, expect, it } from 'vitest';
import { AppError, NotFoundError, ValidationError } from '../src/errors.js';

describe('typed errors', () => {
  it('AppError defaults to INTERNAL/500', () => {
    const error = new AppError('boom');
    expect(error.code).toBe('INTERNAL');
    expect(error.statusCode).toBe(500);
    expect(error.name).toBe('AppError');
  });

  it('preserves an explicit cause', () => {
    const cause = new Error('root');
    expect(new AppError('boom', { cause }).cause).toBe(cause);
  });

  it('ValidationError is 400 and carries issues', () => {
    const error = new ValidationError('bad input', ['title: required']);
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe('VALIDATION');
    expect(error.issues).toEqual(['title: required']);
    expect(error).toBeInstanceOf(AppError);
  });

  it('NotFoundError is 404', () => {
    expect(new NotFoundError('nope').statusCode).toBe(404);
  });
});
