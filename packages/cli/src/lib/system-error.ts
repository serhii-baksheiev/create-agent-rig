/**
 * Decides whether a thrown value is a Node system error — an object carrying
 * a string `code` — and if so wraps it via the caller-supplied `wrap`
 * function, attaching the original as `cause`. Anything else — including a
 * genuine programming error such as a `TypeError`, or a non-Error thrown
 * value — is returned completely unchanged (same identity), so a caller can
 * `throw wrapSystemError(error, wrap)` without ever losing a non-system
 * error's type or stack.
 *
 * `wrap` only ever decides the final message's wording (each call site keeps
 * that); this helper decides WHETHER to wrap and what `cause` to attach.
 */
export function wrapSystemError(
  error: unknown,
  wrap: (message: string, options: { cause: unknown }) => Error,
): unknown {
  if (typeof error !== 'object' || error === null) return error;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string') return error;
  const message = (error as { message?: unknown }).message;
  return wrap(typeof message === 'string' ? message : String(message), { cause: error });
}
