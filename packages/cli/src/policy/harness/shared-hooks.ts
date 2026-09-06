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

/**
 * The environment variable a shared hook reads when it needs the repository
 * root, and therefore the one each harness sets when it runs one.
 *
 * Not every hook needs it: of the eight this rig ships, `guard-rulebook` and
 * `guard-secret-file` read it, both falling back to the working directory.
 * The variable is still part of the wiring contract, because the harness sets
 * it for whichever hook it runs.
 *
 * It carries a harness's name for the same historical reason `.claude/hooks`
 * does — the hooks are shared, so both harnesses speak this one variable — and
 * this module is the one adapter-side file allowed to spell that name for both
 * (`test/template/policy-declaration.test.ts` › "claude is named only by its
 * own adapter, the shared hooks directory and the adapter index"). Stating it
 * here is what lets the other harness's adapter build its generated command
 * without naming a harness that is not its own.
 */
export const SHARED_HOOK_ROOT_ENV = 'CLAUDE_PROJECT_DIR';
