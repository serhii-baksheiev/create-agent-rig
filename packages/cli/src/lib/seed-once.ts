import type { RigManifest } from './manifest.js';

/**
 * Install-relative paths `init` writes at most ONCE, ever — and from that
 * moment on are the user's own document, never diffed against a template,
 * never rewritten, and never recreated once removed (RP-257).
 *
 * `PLAN.md` is the one member today: it ships with the process layer (every
 * rig has it — `templates/agent-os/universal/layers.json`), but it is the
 * live Agent/Operator queue from the instant it lands, meant to be hand-
 * edited (the template's own header: "Keep entries one line each ... Delete
 * done items"). Byte-owning it the way every other rig-owned file is owned —
 * comparing it against the manifest-recorded install hash — turns the
 * FIRST legitimate queue edit into a permanent `content-drift` warning
 * (`doctor`), an unresolvable `conflict` (`upgrade`), or a silent overwrite of
 * real, unfinished entries the moment a newer release ships different
 * template text.
 *
 * `init`, `upgrade`, `uninstall` and `doctor` all consult this ONE list
 * rather than each hard-coding "PLAN.md" separately
 * (`.claude/rules/invariants.md`, "one spelling of a fact"). `uninstall` and
 * `doctor` need no special case of their own at all: both already treat
 * anything recorded in the manifest's `kept` map — never `files` — as the
 * user's own, unconditionally (see the reuse this list depends on in
 * {@link priorSeedHash}'s own doc comment).
 */
export const SEED_ONCE: readonly string[] = ['PLAN.md'];

export function isSeedOncePath(rel: string): boolean {
  return SEED_ONCE.includes(rel);
}

/**
 * The hash a seed-once path was last recorded under, from EITHER manifest
 * bucket — `undefined` only when this path has never been seeded at all.
 *
 * `kept` is read first: it is where a seed-once path lives from the moment
 * `init`/`upgrade` first migrate it there (this release's own shape). `files`
 * is the fallback: a manifest written before RP-257 (`PLAN.md` was an
 * ordinary, byte-owned entry there, exactly like any other process-layer
 * file) still counts as "seeded" — the file exists, the rig wrote it once,
 * and that history must not read as "never seeded" the first time a
 * pre-RP-257 rig runs `init` or `upgrade` again. Both callers that need this
 * distinction (`init.ts`'s `recordInstall`, `upgrade.ts`'s `planUpgrade`) read
 * it from here rather than re-deriving the same two-bucket fallback twice.
 */
export function priorSeedHash(manifest: RigManifest | null, rel: string): string | undefined {
  return manifest?.kept?.[rel] ?? manifest?.files[rel];
}
