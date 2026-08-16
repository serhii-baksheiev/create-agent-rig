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
//
// "Only the load-bearing part" is meant literally, and it used to be a lie —
// this hook injected the whole of autonomy.md while the tool had already
// loaded the same file as project instructions. Every session start, resume
// and compaction paid for the file twice. What survives the cut is what a run
// cannot afford to have compacted away: the tiers (what it may do alone) and
// the stop rules (when stopping is the correct move). The rest of the file is
// reference a session reads when it needs it, so the excerpt names where it is.
import { readFileSync } from 'node:fs';

// The `## ` sections a compacted run cannot work without, matched as a prefix
// so a heading may carry a subtitle ("## Stop rules — by work-state, …").
const KEPT_SECTIONS = ['## Tiers', '## Stop rules'];

/**
 * The excerpt, as whole `## ` sections. Nested `####` blocks that are
 * reference rather than rule are dropped from inside them — the swept-from-
 * outside block sits between Tier 2 and Never, so this cannot be a single
 * slice from the first heading to the last.
 *
 * On anything unexpected it returns the input unchanged: injecting too much
 * is a cost, injecting the wrong thing is a defect.
 */
function excerptAutonomy(markdown) {
  const lines = markdown.split('\n');
  const kept = [];
  let keeping = false;
  let skippingSubsection = false;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      keeping = KEPT_SECTIONS.some((heading) => line.startsWith(heading));
      skippingSubsection = false;
    } else if (keeping && line.startsWith('#### ')) {
      // A `####` inside a kept section is the long-form rationale; the `###`
      // that follows it (Never, say) ends the skip.
      skippingSubsection = true;
    } else if (line.startsWith('### ')) {
      skippingSubsection = false;
    }
    if (keeping && !skippingSubsection) kept.push(line);
  }
  return kept.length > 0 ? kept.join('\n').trim() : markdown;
}

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
      '[agent-os] Autonomy rules refresh — in force regardless of compaction.\n' +
        'Tiers and stop rules below; the rest of the file (the Tier-2 gate sweep, ' +
        'post-deploy verification, the escalation format) is at ' +
        '`.claude/rules/autonomy.md`.\n\n' +
        `${excerptAutonomy(rules)}\n`,
    );
  } catch {
    // no rules file — nothing to inject, never an error
  }
  return 0;
}

process.exit(main());
