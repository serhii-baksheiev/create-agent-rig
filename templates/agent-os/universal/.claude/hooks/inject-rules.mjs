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
// Which part is load-bearing is not this hook's judgment to make: the rule
// file marks what it does not need injected, and everything else goes. That
// division of labour is the whole design, and it was arrived at the expensive
// way. An earlier version of this file selected `## ` sections from a kept
// list — and four review rounds each found a different way for that selection
// to return a silently truncated excerpt: a heading inside a code fence, a
// heading inside a skipped region, a section whose heading and body fell on
// opposite sides of a marker, a heading inside an HTML block. Each fix closed
// one spelling and the next round found another, because a parser that infers
// structure has no bottom. This one does not parse structure at all.
//
// ⚠ The saving rests on an assumption this repository cannot enforce: that the
// tool already loads `.claude/rules/*.md` as project instructions, so injecting
// the whole file pays for it twice. That is harness behaviour, observable but
// not pinned here. Where it does not hold, this is a plain subtraction — which
// is why every ambiguity resolves toward injecting more.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
 * The whole file, minus every region the file itself marks with
 * `<!-- inject:skip -->` … `<!-- /inject:skip -->`. That is the entire
 * operation: nothing here reads a heading, so no arrangement of headings —
 * indented, inside an HTML block, split across a marker — can change what
 * survives. What is omitted is a decision made in the rule file, by whoever
 * writes the rule, and visible on the line above it.
 *
 * Fenced code is data, not structure, so a marker inside a fence is content.
 * Both fence characters, with the CommonMark closing rule (same character, at
 * least as long, nothing but whitespace after it) — a rules file quotes shell
 * and markdown at each other, and an opener may carry an info string where a
 * closer may not.
 *
 * It returns the input UNCHANGED whenever the markup is malformed: a skip
 * region left open, one closed without being opened, one nested inside
 * another, or a fence left open. Partial output is the dangerous answer,
 * because a governance section can go missing with nothing to notice it; a run
 * that gets the whole file has only paid twice.
 *
 * The limits, so nobody relies on cover that is not here. A marker is
 * recognised only as the first non-whitespace text on its own line — so one
 * inside a blockquote is not a marker, and its text reaches the context. And
 * fence-awareness is the only structure it knows: a BALANCED marker pair
 * written inside an indented code block or an HTML comment is obeyed, so a
 * document that demonstrates the markers loses the lines between them. Show
 * them inside a fence.
 */
export function excerptAutonomy(markdown) {
  const lines = markdown.split('\n');
  const kept = [];
  let skipping = false;
  let fence = null;
  let malformed = false;

  for (const line of lines) {
    const run = fenceRun(line);
    if (fence) {
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
        // A second open inside a region is as much a mistake as a stray close,
        // and the two are the same signal: the markers do not pair up.
        malformed ||= skipping;
        skipping = true;
        continue;
      }
      if (trimmed.startsWith(SKIP_CLOSE)) {
        malformed ||= !skipping;
        skipping = false;
        continue;
      }
    }
    if (!skipping) kept.push(line);
  }

  if (fence || skipping || malformed) return markdown;
  const excerpt = kept.join('\n').trim();
  // Nothing left is the largest possible version of "partial output", and the
  // marker pairing cannot see it: a balanced pair around the whole file is
  // well-formed. A zero, not a threshold — this is deliberately not the byte
  // ratio an earlier round used and deleted.
  return excerpt === '' ? markdown : excerpt;
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

  let rules;
  try {
    rules = readFileSync(new URL('../rules/autonomy.md', import.meta.url), 'utf8');
  } catch {
    // no rules file — nothing to inject, never an error
    return 0;
  }

  // The cut is the only thing allowed to fail here, and its failure resolves
  // the way every other ambiguity in this file does: inject more. Leaving it
  // inside the read's catch meant a throw in the excerpter printed NOTHING and
  // exited 0 — the rules gone, and the session looking healthy.
  let body;
  try {
    body = excerptAutonomy(rules);
  } catch {
    body = rules;
  }

  // The banner reports what happened, so it cannot be written once and assumed:
  // on the fallback path nothing was removed, and telling a session to go read
  // four sections it is already holding is the same kind of false report the
  // cut itself is built to avoid.
  const notice =
    body === rules
      ? 'This is `.claude/rules/autonomy.md` in full.\n\n'
      : 'This is `.claude/rules/autonomy.md` with the sections it marks as ' +
        'reference removed — read the file itself for those: how the Tier-2 ' +
        'gate is swept from outside, how external work is reconciled, ' +
        'post-deploy verification, and the escalation format.\n\n';

  process.stdout.write(
    `[agent-os] Autonomy rules refresh — in force regardless of compaction.\n${notice}${body}\n`,
  );
  return 0;
}

if (invokedDirectly()) {
  process.exit(main());
}
