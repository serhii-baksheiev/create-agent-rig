import { describe, expect, it } from 'vitest';
import { wrapSystemError } from '../src/lib/system-error.js';

/**
 * RP-289 — the "a TypeError reaches the caller unwrapped" proof, pinned as a
 * pure-function contract instead of a new production seam (coordinator
 * decision, replacing the seam-based approach this file's sibling
 * `agents-md-region-hardening.test.ts` already covers for the mode fix and
 * the `cause` fix): `init.ts`'s and `upgrade.ts`'s own `catch (error) { throw
 * new InitError/UpgradeError(...) }` blocks around `atomicWriteInRepo`
 * currently wrap ANY thrown value — a non-Error yields `message: undefined`,
 * and a genuine programming error (a `TypeError`) loses its identity and its
 * stack. `wrapSystemError` is the extracted decision the fix will route both
 * call sites through: a Node system error — an object carrying a STRING
 * `code` — is wrapped, with the original set as `cause`; anything else is
 * returned completely unchanged, same identity, so a caller can `throw`
 * whatever this returns without ever losing a non-system error's type.
 *
 * `init.ts` (`commands/init.ts:692`) and `upgrade.ts` (`commands/
 * upgrade.ts:1443`) build the wrapped message BYTE-IDENTICALLY today —
 * `` `Refusing to write "AGENTS.md": ${(error as
 * NodeJS.ErrnoException).message}` `` — so this helper takes the caller's own
 * message-building `wrap` function rather than a message or a path: it only
 * ever decides WHETHER to wrap and what `cause` to attach, never how the
 * final Error is worded — the one place that wording lives stays each
 * call site, unchanged.
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
