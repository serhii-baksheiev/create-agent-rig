/**
 * The contract a harness adapter satisfies (RP-76).
 *
 * The core knows that a harness exists and has a hook-wiring surface; it does
 * not know any harness's name, event vocabulary, tool names or paths. Those
 * belong to the adapter, one module per harness under `../harness/`, and
 * adding a harness means adding one such module and registering it — pinned in
 * `test/template/policy-declaration.test.ts` under "adding a harness touches
 * adapters only", whose two tests name exactly the files that may mention each
 * harness. Their names carry the harness words this file may not, which is why
 * the describe is cited here rather than either test.
 *
 * An adapter is a mapping, not a compiler: given a declaration it names the
 * event, matcher and hook path the harness wires for it. The correspondence
 * between that answer and the snapshot the rig actually ships is a test, in
 * both directions, in the same file.
 */

import type { PolicyDeclaration } from './declaration.js';

export interface NativeHookSurface {
  /** The harness's own name for "before the operation". */
  event: string;
  /** The harness's own tool matcher for the policy's operations. */
  matcher: string;
  /** Repo-relative path of the hook file the harness runs. */
  hookPath: string;
  /**
   * The shell variable names this harness legitimately roots its own hook
   * paths at, without the `$`.
   *
   * The probe strips one of THESE prefixes before comparing a command's
   * argument to `hookPath`, and no others. Stripping any `$VAR/` instead
   * collapsed every tree onto one string, so a hook file rooted at an
   * unrelated variable — a home directory, a temporary directory — was
   * indistinguishable from the repository's own and read SUPPORTED: a false
   * pass on the one question the contract exists to answer.
   * The list belongs to the adapter because the core may not name a harness's
   * variables, and it is per-surface because the two harnesses do not agree on
   * one. Pinned in `packages/cli/test/policy-coverage.test.ts` (absent in a
   * generated rig) › "reads a hook under %s rooted at %s as UNSUPPORTED,
   * because that tree is not the one the harness runs from".
   */
  hookRootVariables: readonly string[];
}

export interface HarnessAdapter {
  /** The adapter's own id; it is what a decision record's `harness` field carries. */
  harness: string;
  /** Repo-relative path of the harness's hook-wiring snapshot. */
  surfaceFile: string;
  nativeSurfaceOf(policy: PolicyDeclaration): NativeHookSurface;
}
