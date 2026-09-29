import { describe, expect, it } from 'vitest';
import { wrapSystemError } from '../src/lib/system-error.js';

/**
 * RP-289 — `wrapSystemError` is the shared decision `init.ts`'s and
 * `upgrade.ts`'s own `catch (error) { throw wrapSystemError(error, ...) }`
 * blocks around `atomicWriteInRepo` route every thrown value through: a Node
 * system error — an object carrying a STRING `code` — is wrapped, with the
 * original set as `cause`; anything else — a non-Error thrown value, or a
 * genuine programming error such as a `TypeError` — is returned completely
 * unchanged, same identity, so a caller can `throw` whatever this returns
 * without ever losing a non-system error's type or its stack.
 *
 * `init.ts` and `upgrade.ts` build the wrapped message identically —
 * `` `Refusing to write "AGENTS.md": ${message}` `` — so this helper takes
 * the caller's own message-building `wrap` function rather than a message or
 * a path: it only ever decides WHETHER to wrap and what `cause` to attach,
 * never how the final Error is worded — the wording itself stays at each
 * call site.
 *
 * This file is the helper's own contract, in isolation, with a hand-built
 * `wrap`. `system-error-call-sites.test.ts` is the complementary proof that
 * `initProject` and `applyUpgrade` actually route their real
 * `atomicWriteInRepo` failures through this exact helper, rather than
 * wrapping unconditionally — a mocked `atomicWriteInRepo` throwing a
 * `TypeError` and a coded `Error` reach the caller the way this file's own
 * cases 1 and 3 say they must.
 */
describe('wrapSystemError', () => {
  const wrapWithAgentsMdPrefix = (message: string, options: { cause: unknown }): Error =>
    new Error(`Refusing to write "AGENTS.md": ${message}`, options);

  it('returns a TypeError unchanged — same identity, never wrapped', () => {
    const error = new TypeError('boom');

    const result = wrapSystemError(error, wrapWithAgentsMdPrefix);

    expect(result).toBe(error);
  });

  it('returns a non-Error thrown string unchanged', () => {
    const error = 'boom';

    const result = wrapSystemError(error, wrapWithAgentsMdPrefix);

    expect(result).toBe(error);
  });

  it('returns a non-Error thrown plain object unchanged', () => {
    const error = {};

    const result = wrapSystemError(error, wrapWithAgentsMdPrefix);

    expect(result).toBe(error);
  });

  it('wraps a Node system error (a string `code`), the wrap carries the original as `cause`, and the wrapped message contains the original message', () => {
    const error = Object.assign(new Error("EACCES: permission denied, open '/tmp/x'"), {
      code: 'EACCES',
    });

    const result = wrapSystemError(error, wrapWithAgentsMdPrefix);

    expect(result).not.toBe(error);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error & { cause?: unknown }).cause).toBe(error);
    expect((result as Error).message).toContain(error.message);
  });

  it('does not wrap an error whose `code` is present but not a string', () => {
    const error = Object.assign(new Error('odd'), { code: 42 });

    const result = wrapSystemError(error, wrapWithAgentsMdPrefix);

    expect(result).toBe(error);
  });
});
