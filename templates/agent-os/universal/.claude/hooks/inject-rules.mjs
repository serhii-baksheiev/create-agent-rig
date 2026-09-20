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
//
// The output on stdout is a single JSON object —
// `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":…}}`
// — not the plain text an earlier version of this hook wrote directly. Both
// Claude Code and Codex document that shape as valid SessionStart output
// (Claude Code: code.claude.com/docs/en/hooks; Codex:
// learn.chatgpt.com/docs/hooks), and Codex additionally documents plain text
// as accepted for `session_start` — this hook always emits the JSON form
// anyway, so one code path satisfies both without guessing which harness is
// asking. The change exists because Codex 0.154.0 on Windows was measured
// reporting this hook's OLD plain-text banner as invalid SessionStart JSON,
// so the rules refresh never reached the session; Claude Code was unaffected.
// The mechanism Codex used to reach that verdict is not published — a leading
// `[` is a plausible trigger, not a confirmed one. See
// `docs/decisions/session-start-wire-format.md` for what was measured and
// what each harness's own documentation says.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readHookInput } from './lib/hook-input.mjs';

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
  const input = readHookInput();
  if (input === null) return 0;
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
  // Compared trimmed, because the two paths differ by a trailing newline that
  // is not a removal: the excerpt is trimmed and the fallback is not. A rules
  // file that marks nothing would otherwise be announced as an excerpt — which
  // is the case a project re-scoping its own rulebook lands in, every session.
  const notice =
    body.trim() === rules.trim()
      ? 'This is `.claude/rules/autonomy.md` in full.\n\n'
      : 'This is `.claude/rules/autonomy.md` with the sections it marks as ' +
        'reference removed — read the file itself for those: how the Tier-2 ' +
        'gate is swept from outside, how external work is reconciled, ' +
        'post-deploy verification, and the escalation format.\n\n';

  const additionalContext =
    `[agent-os] Autonomy rules refresh — in force regardless of compaction.\n${notice}${body}\n`;

  // `hookSpecificOutput.additionalContext` is the JSON shape both harnesses'
  // hooks documentation gives an example of for SessionStart output — see the
  // file header and `docs/decisions/session-start-wire-format.md`. No leading
  // or trailing byte outside the object, and no trailing newline: Claude Code's
  // OWN documented detection reads "starts with `{` ends with `}`", literally
  // (code.claude.com/docs/en/hooks) — Codex's JSON-vs-plain-text detection is
  // not published, so this satisfies the one contract that IS written down
  // rather than guessing at the one that is not.
  // A reader that vanishes mid-write — a closed pipe, a harness that tears
  // this process down before reading — turns the queued write into an EPIPE.
  // That specific error is silenced: it means the reader is gone and there is
  // nothing left to report to, so failing loudly would turn an absent reader
  // into a noisy non-zero SessionStart exit for no one to read. Anything ELSE
  // stdout can fail with (ENOSPC, EIO, a redirect to a full or broken device)
  // is a real write failure with an actual reader still attached, and this
  // file does not get to treat that as a healthy session: it is reported on
  // stderr and the exit is marked non-zero, the same "say what happened"
  // stance the excerpt path takes by injecting MORE rather than dropping
  // content quietly. Measured (security review, RP-185 gate): a blanket
  // handler here made a genuine stdout write failure (stdout redirected to
  // /dev/full) exit 0 with nothing delivered and no diagnostic — exactly the
  // silent-loss shape this whole file exists to avoid, just moved one write
  // call over. Pinned in hooks.test.ts (absent in a generated rig).
  process.stdout.on('error', (err) => {
    if (err && err.code === 'EPIPE') return;
    process.stderr.write(`inject-rules: stdout write failed: ${err}\n`);
    process.exitCode = 1;
  });
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext },
    }),
  );
  return 0;
}

if (invokedDirectly()) {
  // NOT process.exit(main()): exit() tears the process down without waiting
  // for a queued stdout write to drain, and this hook's payload (the whole
  // rules excerpt, wrapped in one JSON object) can be large enough to miss a
  // pipe's buffer in one write. A write that process.exit() cuts off mid-object
  // is not a short excerpt, the way the old plain-text form degraded — it is
  // invalid JSON, which is exactly the failure this hook exists to avoid.
  // Every path through main() returns 0, so setting exitCode changes nothing
  // about the exit STATUS. What it does change is whether the process
  // terminates AT ALL before the write finishes: exitCode lets the event
  // loop drain naturally, and a reader that never drains at all no longer
  // gets a fast, wrong exit 0 — it gets a hook that stays alive, waiting on
  // the write, for as long as the harness lets it. A probe that refuses to
  // read until the child would already have exited measurably DEADLOCKS this
  // version where process.exit() would have terminated (truncated). Nothing
  // in this file bounds that wait; the calling harness's own hook timeout
  // does. Pinned in hooks.test.ts (absent in a generated rig) ›
  // "delivers the whole envelope even when the reader does not drain until
  // process.exit(main()) would already have torn the process down".
  //
  // That is the trade made on purpose — a loud hang, bounded by the
  // harness's timeout, over a silent truncated "success" — and it is worth
  // stating plainly rather than leaving to be discovered: not reachable at
  // the size this hook ships today (a few KB, done in well under a second),
  // but a real behaviour change on a project whose autonomy.md grows large
  // enough, or whose harness stops reading a hook's stdout at all. See
  // `docs/decisions/session-start-wire-format.md` for the fuller record.
  process.exitCode = main();
}
