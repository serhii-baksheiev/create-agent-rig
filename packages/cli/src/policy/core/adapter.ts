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
   * Every command this harness generates to run `hookPath`, keyed by the field
   * of a hook entry it belongs to, with the accepted spellings for that field.
   *
   * Keyed rather than flat because a surface can ship MORE THAN ONE command per
   * hook and run a different one per platform. Reading only the first is a false
   * `SUPPORTED`: replacing just the other spelling in the file this rig ships
   * left every policy reading enforced while the guard no longer ran on that
   * platform. So an entry counts as running the hook only when EVERY field
   * named here is present and matches — › "refuses a %s entry in which any one
   * field that harness generates carries a different command".
   *
   * A field this map does not name is ignored, which is what keeps `type` and
   * a timeout out of the comparison: › "still reads a %s entry carrying a
   * command field that harness generates nothing for, because the rule is about
   * the fields it does".
   *
   * The list per field allows a harness to accept more than one generated
   * spelling; today each declares one. Adapter and shipped snapshot are held
   * equal in both directions by `test/template/policy-coverage.test.ts` (absent
   * in a generated rig) › "the %s snapshot wires %s with exactly the spelling
   * that adapter generates, in every field it generates one for".
   */
  commands: Readonly<Record<string, readonly string[]>>;
}

export interface HarnessAdapter {
  /** The adapter's own id; it is what a decision record's `harness` field carries. */
  harness: string;
  /** Repo-relative path of the harness's hook-wiring snapshot. */
  surfaceFile: string;
  nativeSurfaceOf(policy: PolicyDeclaration): NativeHookSurface;
}
