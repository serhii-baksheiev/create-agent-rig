// SessionStart hook: the autonomy rules survive compaction and resumes.
//
// Long sessions compact their context, and project rules are exactly what
// gets dropped — an unattended run would finish the night without the tiers
// and stop rules that were supposed to govern it. SessionStart is one of the
// few events whose stdout is added to the context Claude sees, and it re-runs
// on resume and after compaction (source: "resume" / "compact"), so this
// refreshes instead of going stale.
//
// The injected content is deliberately STATELESS — rules, never facts about
// the moment (mid-session injections are replayed on resume, so timestamps
// or SHAs here would lie). And it is only the load-bearing part, not the
// whole rulebook: CLAUDE.md is already loaded by the tool itself.
import { readFileSync } from 'node:fs';

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return 0;
  }
  if (input.hook_event_name !== 'SessionStart') return 0;

  try {
    const rules = readFileSync(new URL('../rules/autonomy.md', import.meta.url), 'utf8');
    process.stdout.write(
      `[agent-os] Autonomy rules refresh — in force regardless of compaction:\n\n${rules}\n`,
    );
  } catch {
    // no rules file — nothing to inject, never an error
  }
  return 0;
}

process.exit(main());
