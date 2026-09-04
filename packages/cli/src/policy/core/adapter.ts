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
   * The exact command strings this harness generates to run `hookPath`.
   *
   * The probe compares a wired command against these instead of parsing it.
   * That is the whole of how "is this hook wired?" is decided, and it exists
   * because the parser it replaced lost three gate rounds running: each fix
   * closed one class of false `SUPPORTED` and opened another, until the shape
   * that defeated it turned out to be the rig's own derived command. Comparing
   * against generated output has no grammar to lose to.
   *
   * A list because a harness may accept more than one generated spelling (a
   * format change, say); today each declares one. An adapter and the snapshot
   * this rig ships must agree, which is checked in both directions by
   * `test/template/policy-coverage.test.ts` (absent in a generated rig) ›
   * "the %s snapshot wires %s with exactly the command that adapter generates".
   */
  commands: readonly string[];
}

export interface HarnessAdapter {
  /** The adapter's own id; it is what a decision record's `harness` field carries. */
  harness: string;
  /** Repo-relative path of the harness's hook-wiring snapshot. */
  surfaceFile: string;
  nativeSurfaceOf(policy: PolicyDeclaration): NativeHookSurface;
}
