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
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The `## ` sections a compacted run cannot work without, matched as a prefix
// so a heading may carry a subtitle ("## Stop rules — by work-state, …").
const KEPT_SECTIONS = ['## Tiers', '## Stop rules'];

// Regions the rule file marks as not worth injecting. The marker is explicit
// and lives in the rule file itself, where the person editing it can see it —
// an earlier version keyed on heading level instead, which made "what every
// session is governed by" a silent consequence of a formatting choice.
const SKIP_OPEN = '<!-- inject:skip -->';
const SKIP_CLOSE = '<!-- /inject:skip -->';

/**
 * A fence opener, as CommonMark defines one: three or more backticks or
 * tildes. The closer has to be the same character and no shorter, which is why
 * this returns the run rather than a boolean — a three-backtick line inside a
 * four-backtick block is content, not the end of the block.
 */
function fenceRun(line) {
  const trimmed = line.trimStart();
  const char = trimmed[0];
  if (char !== '`' && char !== '~') return null;
  let length = 0;
  while (trimmed[length] === char) length += 1;
  if (length < 3) return null;
  // `bare` is what separates a closer from an opener: an opener may carry an
  // info string (```sh), a closer may not.
  return { char, length, bare: trimmed.slice(length).trim() === '' };
}

/**
 * The excerpt: the preamble, plus each kept `## ` section whole, minus any
 * explicitly skip-marked region. Fenced code is data, not structure, so a
 * heading or a marker inside a fence is left alone — both fence characters,
 * with the CommonMark closing rule (same character, at least as long, nothing
 * but whitespace after it), because a rules file quotes shell and markdown at
 * each other.
 *
 * It returns the input UNCHANGED — injecting everything — whenever the file
 * does not look the way this function expects: a kept heading missing, a skip
 * region left open, a fence left open. Partial output is the dangerous answer,
 * because a governance section can go missing with nothing to notice it; a run
 * that gets the whole file has only paid twice.
 *
 * The limits, stated so nobody relies on cover that is not here: it reads
 * headings by prefix, so `## Tiers of anything` satisfies the check; a skip
 * marker is recognised only at the start of its own line; and it does not
 * understand indented code blocks or HTML blocks.
 */
export function excerptAutonomy(markdown) {
  const lines = markdown.split('\n');
  const kept = [];
  const seen = new Set();
  let keeping = true; // the preamble, until the first `## `
  let skipping = false;
  let fence = null;

  let strayClose = false;

  for (const line of lines) {
    const run = fenceRun(line);
    if (fence) {
      // A closer is the same character, at least as long, and carries nothing
      // but whitespace after it. That last clause is not pedantry: an opener
      // MAY carry an info string, so without it a ```js line inside an open
      // ```md block reads as the end of the block, and everything past it is
      // parsed as structure again.
      if (run && run.char === fence.char && run.length >= fence.length && run.bare) fence = null;
    } else if (run) {
      fence = run;
    } else {
      const trimmed = line.trim();
      // Matched by prefix: a marker with something after it is still a marker,
      // and the whole line goes. Requiring the line to be exactly the marker
      // would let `<!-- inject:skip --> note` open nothing and then print
      // itself into the context.
      if (trimmed.startsWith(SKIP_OPEN)) {
        skipping = true;
        continue;
      }
      if (trimmed.startsWith(SKIP_CLOSE)) {
        strayClose ||= !skipping;
        skipping = false;
        continue;
      }
      if (line.startsWith('## ')) {
        const heading = KEPT_SECTIONS.find((candidate) => line.startsWith(candidate));
        // Counted only when the section actually reaches the output. Counting
        // it while skipping would let a kept section be suppressed by a skip
        // region while the completeness check below still read as satisfied.
        if (heading && !skipping) seen.add(heading);
        keeping = Boolean(heading);
      }
    }
    if (keeping && !skipping) kept.push(line);
  }

  // A fence left open, a skip region left open or closed without being opened,
  // or a kept section that never reached the output: the file is not the one
  // this function knows how to cut, so it is not cut. Rescanning to "recover"
  // would put a heading that sits inside a code block back into the structure,
  // which is the same defect wearing a fix.
  if (fence || skipping || strayClose || seen.size !== KEPT_SECTIONS.length) return markdown;
  return kept.join('\n').trim();
}

/**
 * Whether this file is being run as a script rather than imported.
 *
 * The realpath on both sides is the point: ESM resolves `import.meta.url`
 * through symlinks while `process.argv[1]` keeps the path as typed, so a
 * project under a symlinked directory — a macOS temp dir, a symlinked home, a
 * checkout behind a link — fails a naive equality check. The hook would then
 * print nothing and exit 0, which reads exactly like a healthy session.
 */
function invokedDirectly() {
  if (!process.argv[1]) return false;
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return real(fileURLToPath(import.meta.url)) === real(process.argv[1]);
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

if (invokedDirectly()) {
  process.exit(main());
}
