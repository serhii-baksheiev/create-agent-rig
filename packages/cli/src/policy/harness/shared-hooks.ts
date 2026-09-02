/**
 * The one directory every harness runs its hook files from. The rulebook's
 * `.claude/` directory keeps its historical name but holds the shared rules,
 * hooks, scripts and agent specifications for both harnesses (`CLAUDE.md`,
 * "One operating system, two harnesses"), so a hook path is the same string
 * whichever adapter names it. Stated once, here, and imported by each adapter
 * — one spelling of one fact (`rules/invariants.md`, "One mechanism, one
 * implementation").
 */

export const SHARED_HOOKS_DIR = '.claude/hooks';
