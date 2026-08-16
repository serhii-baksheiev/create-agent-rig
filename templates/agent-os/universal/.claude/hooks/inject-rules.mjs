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
// whole rulebook.
//
// What "the load-bearing part" means here, exactly: the preamble (which
// carries the tie-break — round the tier UP when it is unclear), the tiers,
// and the stop rules. What it drops is reference a session reads when it needs
// it, and the banner names the file so a run knows where to look.
//
// ⚠ The saving rests on an assumption this repository cannot enforce: that the
// tool already loads `.claude/rules/*.md` as project instructions, so injecting
// the whole file pays for it twice. That is harness behaviour, observable but
// not pinned here. Where it does not hold, this excerpt is a plain subtraction
// — which is why the cut keeps whole sections and errs toward injecting more.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// The `## ` sections a compacted run cannot work without, matched as a prefix
// so a heading may carry a subtitle ("## Stop rules — by work-state, …").
const KEPT_SECTIONS = ['## Tiers', '## Stop rules'];

// Regions the rule file marks as not worth injecting. The marker is explicit
// and lives in the rule file itself, where the person editing it can see it —
// an earlier version keyed on heading level instead, which made "what every
// session is governed by" a silent consequence of a formatting choice.
const SKIP_OPEN = '<!-- inject:skip -->';
const SKIP_CLOSE = '<!-- /inject:skip -->';

const FENCE = '```';

/**
 * The excerpt: the preamble, plus each kept `## ` section whole, minus any
 * explicitly skip-marked region. Fenced code is data, not structure, so a
 * heading or a marker inside a fence is left alone.
 *
 * It returns the input UNCHANGED — injecting everything — whenever the file
 * does not look the way this function expects: a kept heading missing, or a
 * skip region left open. Partial output is the dangerous answer, because a
 * governance section can go missing with nothing to notice it; a run that gets
 * the whole file has only paid twice.
 */
export function excerptAutonomy(markdown) {
  const lines = markdown.split('\n');
  const kept = [];
  const seen = new Set();
  let keeping = true; // the preamble, until the first `## `
  let skipping = false;
  let fenced = false;

  for (const line of lines) {
    if (line.trimStart().startsWith(FENCE)) {
      fenced = !fenced;
    } else if (!fenced) {
      const trimmed = line.trim();
      if (trimmed === SKIP_OPEN) {
        skipping = true;
        continue;
      }
      if (trimmed === SKIP_CLOSE) {
        skipping = false;
        continue;
      }
      if (line.startsWith('## ')) {
        const heading = KEPT_SECTIONS.find((candidate) => line.startsWith(candidate));
        if (heading) seen.add(heading);
        keeping = Boolean(heading);
      }
    }
    if (keeping && !skipping) kept.push(line);
  }

  if (skipping || seen.size !== KEPT_SECTIONS.length) return markdown;
  return kept.join('\n').trim();
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
        'Below: the tiers and the stop rules. NOT below, and at ' +
        '`.claude/rules/autonomy.md` when you need them: how the Tier-2 gate is ' +
        'swept from outside, post-deploy verification, and the escalation ' +
        'format.\n\n' +
        `${excerptAutonomy(rules)}\n`,
    );
  } catch {
    // no rules file — nothing to inject, never an error
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
