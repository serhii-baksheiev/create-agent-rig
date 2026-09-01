/**
 * The shell-executing tools this rulebook's Never-tier guards must see.
 *
 * ONE list, because two spellings of the same fact disagree eventually and the
 * copy nobody is looking at is the one that is wrong (`.claude/rules/invariants.md`,
 * "One mechanism, one implementation"). `.claude/settings.json` cannot import
 * this — it is data, not code — so the correspondence is held by a test rather
 * than by generation: `test/template/shell-tools.test.ts` reads both and refuses
 * a tool named here that some shell guard's matcher omits, or a tool in that
 * matcher this file does not name. That test lives in the generator and is
 * absent in a generated rig.
 *
 * 🔴 **Wiring is not behaviour, and certifying only the wiring is how the gap
 * this file was written to close survived its own PR.** The matcher was widened
 * while both guards still opened with a literal `tool_name !== 'Bash'` and
 * returned allow, so every Never-tier rule and the kill switch stayed
 * bypassable on the other surface — with the configuration tests green.
 * The guards therefore IMPORT this list rather than restating it, and the same
 * test file now spawns them. It is absent in a generated rig, like the one
 * above: `test/template/shell-tools.test.ts`
 * › "guard-bash reaches its verdict on every shell tool, not just the one it
 * was written for" and
 * › "block-no-verify reaches its verdict on every shell tool"
 * run one refusal and one positive control per entry below, so a surface added
 * here without being honoured goes red.
 *
 * ── Why this exists (RP-65) ─────────────────────────────────────────────────
 *
 * `settings.json` wired `block-no-verify` and `guard-bash` under the matcher
 * `Bash` alone. Measured on the live harness: `git commit --no-verify --dry-run`
 * was BLOCKED through the `Bash` tool and RAN through the `PowerShell` tool, in
 * the same session and the same checkout. On that surface the Never tier and the
 * kill switch were prose.
 *
 * ── Why an enumerated list and not a wildcard ───────────────────────────────
 *
 * A matcher that admitted anything would hand these guards tools that execute
 * nothing — and a guard that fires on a non-shell tool is one somebody turns
 * off. Adding a surface is a deliberate edit here, which is also where the
 * reason for each entry is written down.
 *
 * ── What widening the matcher does NOT buy ──────────────────────────────────
 *
 * 🔴 The same RULES now run on both surfaces; the PARSING is not thereby
 * identical. `guard-bash` tokenises POSIX shell — quoting, separators, wrappers
 * — and PowerShell's syntax is its own. A command whose danger is visible only
 * after PowerShell-specific parsing can read differently there.
 *
 * 🔴 **And the kill switch is narrower than it sounds.** It matches a command
 * NAME, so it refuses the operation only when the operation is spelled that
 * way. Measured with the brake armed: `gh pr merge …` is refused on both
 * surfaces; `gh.exe pr merge …`, `Start-Process gh -ArgumentList …` and
 * `Remove-Item -Recurse -Force C:\` are allowed. The `.exe` spelling is
 * allowed under `Bash` as well, so the bound belongs to the rule set and not
 * to the widened matcher.
 *
 * That gap is also why `guard-bash.mjs` keeps its name. A rename would promise
 * a parity the parser does not have, and it would break every installed rig's
 * manifest for a word.
 */

/**
 * The tool names KNOWN to run a shell command — a hand-maintained list.
 *
 * - `Bash` — the POSIX surface these guards were written for.
 * - `PowerShell` — the Windows-native surface, measured to bypass them before
 *   RP-65. A harness that does not expose it simply never matches the name.
 *
 * 🔴 **Nothing checks this list against the harness, and that is the direction
 * the defect came from.** The tests derive their expectations FROM this
 * constant, so what they guard is list → matcher → verdict. The opposite
 * direction — harness → list — is guarded by nobody. A harness that gains a
 * third shell tool leaves every test green and the Never tier inert on it,
 * which is exactly what `PowerShell` did until somebody measured it by hand.
 * Over-listing is safe (an unexposed name never matches); under-listing is
 * the whole bug, and it is invisible until a person edits this file.
 */
export const SHELL_TOOLS = Object.freeze(['Bash', 'PowerShell']);

/** The `matcher` value `settings.json` must carry for the shell guards. */
export const SHELL_TOOL_MATCHER = SHELL_TOOLS.join('|');
