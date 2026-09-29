#!/usr/bin/env node
// Bounded continuation notes for an unfinished workflow-level stop.
//
// A second controller — another machine, another session, days later — has to
// be able to resume or revalidate a claimed item from durable, SHARED evidence
// alone: a tracker note, the PR, the branch, the claim. It cannot see this
// session's own run journal or Memory. This file is the one place that
// composes that note and, with `--post`, publishes it — and it does so on
// exactly FOUR workflow-level stops, never on an ordinary Claude Stop, a
// subagent stop, or a review round:
//
//   escalation   — `.claude/rules/autonomy.md` ("Escalation format")
//   blocker      — an owner/external blocker the run cannot resolve itself
//   pause        — an intentional pause or handoff
//   terminated   — the session ends while a claimed item remains unfinished
//
//   node .claude/scripts/continuation.mjs --ticket <id> --stop <kind>
//        [--pr <n>] [--diagnosis <text>] [--remaining <text>] [--post]
//
// The note is always printed to stdout. `--post` is the only thing that
// touches the network — without it, nothing here ever resolves or calls a
// queue adapter at all, so a caller that never passes it gets a purely local,
// read-only preview.
//
// RP-290: when `RIG_RUN_DIR`'s journal carries a `check-result` event
// (`check-run.mjs`) whose LATEST record for a check name is a failure, the
// note gains one more line per such name — `failed-check: <name> exit
// <code>; tests: <id1>, <id2>…` — so a fresh reader has the failing test
// identity without the original process output. See
// `test/template/continuation.test.ts` (absent in a generated rig) ›
// "adds a failed-check line built from the latest failing check-result
// record, with a repo-relative test identity intact". A later pass for the
// same name drops its line — › "uses the LATEST check-result record for a
// check name — a later pass drops the earlier failure line". No
// `check-result` events at all leaves the note byte-identical to before
// RP-290 — › "does not add a failed-check line when the run directory
// carries no check-result events at all — unchanged from before RP-290". A
// `spawn-error` record (the command never started) is never treated as a
// test failure — › "adds NO failed-check line for a spawn-error record —
// RP-290 review round 1: a command that never started is not a test
// failure".
//
// It NEVER records: a transcript, a prompt, source code, or a credential.
// EVERY string field this composes — `ticket`, `branch`, `pr`, `headSha`,
// `gateRounds`, the verdict's gate names, blocker rule names and verdict
// words, `diagnosis`, `remaining` — goes through the same steps, in this
// order, before anything is printed or posted:
//
//   - the RAW value (up to `RAW_FIELD_CAP + 128` = 2128 characters — wider
//     than the cap below, on purpose: see the straddle case a few lines down)
//     is scanned for a credential shape by `findSecretValues`
//     (`lib/secrets.mjs`, imported and reused verbatim, never a second copy of
//     the vocabulary — `invariants.md`: "one mechanism, one implementation").
//     Anything found withholds the WHOLE FIELD — `[redacted]` — and nothing
//     below runs. Never a partial redaction: a per-pattern `replace()` that
//     substitutes only the matched span is exactly the leak two round-3
//     reviewers found (a PEM key's BEGIN header replaced while its base64
//     body posted in full; a native-regex "resume past the WHOLE rejected
//     match" that skipped a keyword-bearing value entirely) — see "Limits"
//     below for both;
//   - the raw value is cut to 2000 characters (`RAW_FIELD_CAP`), with an
//     explicit `[truncated]` marker rather than a silent cut — BEFORE the
//     passes below ever see it, so none of them is ever handed more than
//     2000 characters of untrusted input, however large the field the caller
//     actually supplied;
//   - every line terminator this runtime can produce — `\r\n`, `\r`, `\n`,
//     U+2028 (LINE SEPARATOR), U+2029 (PARAGRAPH SEPARATOR), U+0085 (NEL) —
//     is collapsed to `⏎`, so a forged `…head: …` line inside free text
//     cannot be read as a second field by a reader who only greps for
//     `^head: `, INCLUDING a reader whose regex uses JavaScript's `m` flag,
//     which treats U+2028/U+2029 as line terminators the same way `\n` is;
//   - an absolute-path SHAPE (see "Limits" below) becomes `[path]`, over five
//     structured patterns every field goes through; `diagnosis` and
//     `remaining` additionally go through one more, COARSER pass afterward,
//     because those two are free text a person typed under pressure, not a
//     value this module or its caller constructed.
//
// `diagnosis` and `remaining` additionally each get their own 500-character
// cap after all of the above (the same explicit `[truncated]` marker, never a
// silent cut); no other field is capped a second time on its own — the whole
// note's 2000-character cap (below) is the backstop for a field (`branch`,
// for instance) whose 2000-character raw cap alone can still leave the note
// over budget once every field is joined into one string — see
// `test/template/continuation.test.ts` (absent in a generated rig) ›
// "caps diagnosis and remaining at 500 characters, with an explicit
// [truncated] marker" and › "caps the whole note, even when no single field
// is over its own cap".
//
// Evidence is gathered from what is already durable in this checkout, never
// invented or asked of the session's own memory:
//
//   - branch and head SHA — `git rev-parse` through the shared sanitised
//     environment (`git-env.mjs`), so a checkout under a git hook is not
//     misread (see that module's own header for the incident this guards);
//   - gate rounds already spent on THIS branch, in THIS checkout's own
//     counter file (`queue/gate-rounds.mjs`, the same counter `pr-ship`
//     writes) — reported as `unknown`, never `0`, when the counter carries no
//     entry for the branch, because the counter can never observe a genuine,
//     journalled zero (every entry it holds is a positive integer);
//   - the latest REVIEW ROUND — `readRunEvidence(runDir)`, which reads
//     `RIG_RUN_DIR`'s run journal (`run-journal.mjs`) ONLY when that variable
//     is declared: the last `reviewer-fan-out` decision this run recorded,
//     and the latest verdict journalled under each reviewer name IT
//     launched, after it. Once that round has produced at least one decision
//     of its own, a launched reviewer that never journalled a verdict is
//     still reported, as `{ gate, verdict: null, blockers: [] }` —
//     `renderVerdict` prints that entry as `<gate> no-verdict` — so a second
//     reader cannot mistake "launched and never answered" for "never
//     launched at all". A round with NO decisions of its own yet (the
//     fan-out is still the newest thing in the journal) reports
//     `reviewers: []`, the same as no fan-out at all, rather than seeding a
//     roster nothing has happened against — see
//     `test/template/continuation.test.ts` (absent in a generated rig) ›
//     "reports a launched reviewer that never journalled a verdict, instead
//     of silently omitting it" and › "does not report a verdict from an
//     older round once a newer fan-out has run". An undeclared, missing, or
//     unusable run directory, or one that never recorded a fan-out, reports
//     `{ headSha: null, reviewers: [] }` — silently, like every other
//     optional trace in this rig, never a throw. `verdict.headSha` — the
//     head this round's fan-out ran against — goes through the exact same
//     field pipeline as every other value above BEFORE `shortShaOf` ever
//     slices it to 7 characters, so an embedded line terminator inside it
//     cannot forge a second `head: ` line either — see › "collapses an
//     embedded newline in verdict.headSha before slicing it, so it cannot
//     forge a second head: line — code-reviewer r3 B2".
//
// `--post` resolves the configured queue adapter exactly the way
// `queue/index.mjs` and `preflight.mjs` already do (`loadConfig` +
// `resolveAdapter`) and calls its `comment()`. An adapter that cannot post —
// `plan-md` has no comment thread at all — is a refusal, not a silent no-op:
// the note is still printed, and the process exits non-zero naming why.
//
// `--ticket` is validated against a tracker-key or bare-number shape
// (`/^[A-Z][A-Z0-9_]+-\d+$|^\d+$/`) before anything else runs — including
// before `--post` resolves an adapter at all. This value is later
// interpolated into an adapter call (`comment({ id: ticket }, …)`); refusing
// an unrecognised shape early is cheaper than trusting whatever a caller, or
// a scripted retry, supplies.
//
// --- Limits -----------------------------------------------------------
//
// - Credential redaction is WHOLE-FIELD, checked first, on the raw value —
//   see the top of this header. `findSecretValues` inherits `lib/secrets.mjs`'s
//   own stated limits (a text scan, not an entropy analyser; an all-letters
//   secret is invisible to its `assigned-secret` arm; a shape that vocabulary
//   does not name — a connection-string password
//   (`postgres://user:hunter2@host/db`), for one — is not redacted here
//   either; it would need a pattern added to `lib/secrets.mjs` itself, not a
//   second copy here) rather than restating them. Two round-3 findings are
//   why this is whole-field rather than per-pattern now:
//     - a PEM/OpenSSH private-key block: the old per-pattern `redactSecrets`
//       replaced only the matched `-----BEGIN … PRIVATE KEY-----` header,
//       leaving the base64 body — the actual key material — to be printed in
//       full alongside it;
//     - a value sitting behind a REJECTED keyword match on the same line: a
//       native `String.replace` with a global pattern resumes scanning after
//       the WHOLE rejected match, so a keyword landing inside an all-letters
//       value that is itself rejected (`AtlassianApiToken`, which ends in the
//       credential word `Token`) consumed the real assignment that followed
//       it on the same walk. `findSecretValues`'s own walk does not have this
//       defect — it resumes one character past the start of a rejected match,
//       not past its end — which is the whole reason to call it directly
//       rather than re-implement the walk here.
//   See `test/template/continuation.test.ts` (absent in a generated rig) ›
//   "redacts a PEM private key block as a whole field, never leaking the key
//   body — security-scanner r3 BLOCKER 1" and › "redacts the whole field when
//   a real credential value sits behind a rejected all-letters keyword match
//   — security-scanner r3 BLOCKER 2".
// - The redaction SCAN WINDOW (`RAW_FIELD_CAP + 128` = 2128 characters) is
//   deliberately wider than `RAW_FIELD_CAP` (2000, the cut every OTHER pass
//   below is bounded by): a credential can straddle the 2000-character cut,
//   and the old cut-then-redact order left only the token's first few
//   characters inside the field `redactSecrets` ever saw — too short to
//   match. Scanning the wider, still-bounded window before any cut runs
//   closes that gap. See › "does not leave a GitHub token prefix behind when
//   the token straddles the raw field cap — security-scanner r3 advisory 1".
//   A credential starting past character 2128 of the raw field is not found
//   by this scan — but `capRawField` below cuts the field to 2000 characters
//   before printing regardless, so such a credential never reaches the note
//   either way; see › "never lets a secret buried past the first few
//   thousand characters of an oversized field reach the note".
// - Every field is then cut to 2000 raw characters (`RAW_FIELD_CAP`) before
//   any scrub pass runs — this is what makes every pass below provably
//   bounded on its own: none of them is ever handed more than 2000
//   characters, whatever the field's real length, and the redaction scan
//   above is bounded independently (2128 characters, delegated to
//   `lib/secrets.mjs`'s own documented bound — capped input, no nested
//   quantifier, a judged-value walk capped at 32 candidates per line).
// - The path scrub recognises an absolute path by SHAPE, not by a fixed
//   prefix list, over FIVE patterns every field goes through, tried in this
//   order, each one replacing its match with `[path]` before the next
//   pattern runs:
//     - a `file:` URI (`file:///…`, one or more slashes) — the shape a Node
//       ESM stack frame carries, POSIX or Windows-drive form alike —
//       consumed to the next hard delimiter or the end of the field;
//     - a `\\host\share\…` UNC path (any host, `\\wsl$\…` and
//       `\\wsl.localhost\…` included, and now `\\host/share/…` — either
//       slash direction after the host, so a mixed-slash UNC path scrubs
//       too, not only the pure-backslash form), consumed to the next hard
//       delimiter or the end of the field, together with one immediately
//       preceding `label:` token when the text reads `label: \\host\share\…`
//       — otherwise a line that names the host twice (once as a plain word,
//       once inside the path) leaves the first copy behind. That label token
//       is bounded explicitly — `[^\s:]{1,64}:[ \t]{1,8}`, at most
//       64 + 1 (the literal colon) + 8 = 73 characters tried per starting
//       position — so a long colon-less run cannot turn this optional group
//       into a re-scan of the rest of the field;
//     - a drive-letter path (`C:\…` or `C:/…`), consumed to the next hard
//       delimiter or the end of the field — so an embedded space
//       (`C:\Users\Some Name\…`) stays part of the match, and a drive letter
//       is only recognised when it is not itself preceded by a letter or
//       digit (so the `s:` inside `https://…` is never mistaken for one, and
//       a digit-prefixed run like `9C:\Users\alice` is left to the coarser
//       free-text pass below rather than this pattern — see the
//       "9C:\Users\alice" case a few lines down). This pattern runs FIRST,
//       inside `scrubPaths`, ahead of the coarse free-text pass below — which
//       is why that coarse pass carries no drive-letter trigger of its own:
//       any drive-letter-shaped span this pattern's own condition already
//       recognises is gone (replaced with `[path]`) before the coarse pass
//       ever sees the field, so a second, token-level drive-letter check
//       there could never fire and would be dead code;
//     - a forward-slash UNC path (`//host/…`, no backslash at all — the
//       shape a quoted or URL-typed string forces, and now also `//host\…` —
//       either slash direction after the host), consumed to the next hard
//       delimiter or the end of the field, and only when it is not itself
//       preceded by `:` or a word character — which is what keeps
//       `https://host/a/b`'s own `://` intact;
//     - a slash-rooted POSIX path of two or more segments, consumed (from the
//       second segment on) to the next hard delimiter or the end of the
//       field, and only when it is not itself preceded by a word character or
//       another `/` — a colon IS allowed immediately before it, so
//       `label:/home/x` scrubs — which is what keeps a URL
//       (`https://example.invalid/a/b`) intact: `/a/b` is preceded by a word
//       character, and `//host` cannot itself start a match because its
//       first `/` has nothing but a second `/` after it, never the
//       non-slash character the pattern requires.
//   A "hard delimiter" is one of `"`, `'`, `` ` ``, `|`, `<`, `>`, or `⏎` (the
//   marker the line-terminator collapse above already produced by the time
//   this runs, since that pass always runs first). Consuming through
//   everything else — INCLUDING whitespace — is deliberate: a real path may
//   legitimately contain a space, and leaving trailing prose unscrubbed cost
//   this module two rounds of leaks; over-scrubbing a little trailing text is
//   the safe direction, never the other one.
// - A tilde-prefixed path (`~/…`, `~alice/…`, a bare `~\…`) is NOT one of the
//   five structured patterns above — no test in this suite needs a structured
//   field (`branch`, `ticket`, a gate name) to scrub one, and the coarser rule
//   below already covers it for `diagnosis`/`remaining`, which is the only
//   place a person types a home-directory path by hand.
// - `diagnosis` and `remaining` go through ONE MORE pass after the five
//   structured patterns above: any WHITESPACE-DELIMITED token whose SHAPE
//   looks like a path — not merely one that contains a `/` anywhere, which
//   is what RP-297 round 1 fixed — starts a scrubbed span. The FINAL
//   trigger set, after rounds 2, 3, and the post-cap fix (see the block
//   comments above `TILDE_BOUNDARY` and `HOME_ROOT_SEGMENT` for the exact
//   regexes and what each round changed and why): a token triggers this
//   pass when it starts with `/` or `\`; or contains a `\` anywhere; or
//   carries a `~` after its own start or any non-word character
//   (`TILDE_BOUNDARY`); or contains a `..` path segment (`hasDotDotSegment`);
//   or carries a non-`http(s)` URI scheme (`file://`, `smb://`,
//   `vscode-remote://`, …) after its own start or any non-alphanumeric
//   character (`hasNonHttpSchemeUri`/`SCHEME_URI_AT_BOUNDARY`); or carries
//   an environment-variable-style reference (`$HOME`, `%USERPROFILE%`) after
//   its own start or any non-word character, ALSO carrying a path separator
//   somewhere in the token (`ENV_VAR_BOUNDARY`); or names a known home
//   root — `Users`, `home`, `wsl.localhost`, `wsl$`, case-insensitive — after
//   its own start or any character that is NEITHER a word character NOR a
//   path separator, immediately followed by a path separator
//   (`HOME_ROOT_SEGMENT`). There is no longer a whole-token exclusion for a
//   token that itself starts with `http://`/`https://` — round 3 deleted it
//   (see the block comment above `isFreeTextPathToken`) because it hid a
//   SECOND, non-http(s) shape later in the same token; only
//   `hasNonHttpSchemeUri` excludes http(s) specifically, by scheme name,
//   wherever it appears.
//   The span begins at the token's own first character (so a leading hard
//   delimiter — an opening `"`, for instance — stays outside it, because the
//   text is first split on hard delimiters and each delimiter-free segment
//   is scrubbed on its own) and runs to the next hard delimiter or the end
//   of the field — the same "consume through whitespace" rule the five
//   structured patterns already use, and for the same reason: this is the
//   coarse, safe-direction backstop for every shape the five named patterns
//   do not recognise. It is coarser on purpose: it does not distinguish a
//   relative path from an absolute one, it can swallow trailing prose the
//   five structured patterns would have left alone (a plain word after a
//   scrubbed tilde path, for instance), and a token that legitimately mixes
//   an env-var sigil with an unrelated number (`$5/month`) is scrubbed too —
//   over-scrubbing diagnosis/remaining text is the accepted trade for never
//   under-scrubbing it. UP TO the shapes the triggers above actually
//   recognise, though: an UNROOTED token with none of them — no leading
//   separator, no backslash, no `~`/scheme/env-var/home-root boundary, no
//   `..` segment — survives verbatim, same as an N/N fraction (`3/3`), a
//   repo-relative test identity (`packages/cli/test/x.test.ts:367`, NOT
//   `Users/alice/x` or `--dir=Users/alice/proj`, both of which
//   `HOME_ROOT_SEGMENT` catches), a git ref (`HEAD~2`, `origin/feature-x~1`
//   — a tilde after a WORD character is not a boundary), an SSH git remote
//   (`git@github.com:org/repo` — no `://`, so no scheme trigger), an
//   ordinary identifier that merely contains the trigger characters
//   (`foo~bar`, `myhome/x`), a repo-relative path with a home-root NAME as
//   an inner segment (`src/users/list.ts`, `lib/home/x.ts`,
//   `a/b/home/c` — the `/` immediately before the root name is excluded
//   from `HOME_ROOT_SEGMENT`'s boundary), or a name that merely STARTS WITH
//   a root name with no separator directly after it (`usersvc/x.ts`,
//   `homepage/a.md`, `src/Users.ts`); see `test/template/continuation.test.ts`
//   (absent in a generated rig), `describe('RP-297 — free-text path token
//   trigger is shape-based, not any forward slash')`, every nested
//   `describe` by name.
//
//   Known, accepted gaps in this coarse pass — each one is a character
//   class drawn deliberately narrow to avoid over-redacting an ordinary
//   identifier, and each one is a text-scan trade the module header's top
//   already states in general (a real path may be typed in a shape this
//   pass does not special-case): a trigger's own boundary character is
//   itself a WORD character (`1smb://…` — a digit precedes the scheme, so
//   `SCHEME_URI_AT_BOUNDARY`'s alphanumeric exclusion does not treat it as
//   a boundary; `_~alice` — `_` is a word character under `\w`, so
//   `TILDE_BOUNDARY` does not fire; `1Users/` — a leading digit is a word
//   character, so `HOME_ROOT_SEGMENT` does not fire); a home-root NAME
//   sitting deeper than the segment immediately after a non-separator
//   boundary, reached only through other separators (`mnt/c/Users/alice` —
//   the `/` before `Users` is excluded from `HOME_ROOT_SEGMENT`'s boundary
//   the same way `src/users/list.ts`'s is, deliberately, per the paragraph
//   above); and a home-root segment inside a token that STARTS WITH
//   `http://`/`https://` (`http://host/Users/alice` — `HOME_ROOT_SEGMENT`'s
//   own boundary still excludes the `/` immediately before `Users`, exactly
//   as it would in a plain POSIX path). None of these are asserted against
//   in the test suite; they are named here, not tested, because closing them
//   would require widening a boundary class past "characters that cannot
//   themselves be part of an ordinary identifier or path segment" — the
//   line every trigger in this file currently holds.
//   It runs ONLY on these two fields,
//   never on a structured one, because a structured field's caller
//   constructs the value rather than typing it under pressure. Bounded, not
//   linear: the field is split once on hard delimiters (a native
//   `String.split`), and each segment is walked token by token by a
//   two-group match (`\s*` then `\S+`); a run of trailing whitespace makes
//   that match retry from every position in it, so the worst case is
//   quadratic in the segment's length — which RAW_FIELD_CAP has already cut
//   to 2000 characters before this pass runs. See
//   `test/template/continuation.test.ts` (absent in a generated rig), the
//   `describe('RP-224 round 4 — …')` block, for every shape above by name
//   next to the assertion that proves it — including › "scrubs a mixed-slash
//   UNC path in diagnosis (backslash host, forward-slash tail) while leaving
//   adjacent URLs intact — code-reviewer r3 B1", › "scrubs a drive-less
//   rooted Windows path in diagnosis (\Users\alice\x — advisory A3)", ›
//   "scrubs a tilde-prefixed path that names a user directly, not only ~/
//   (~alice/x — advisory A3)", › "scrubs a tilde-prefixed path using a
//   backslash separator (~\x — advisory A3)", › "scrubs an smb:// path,
//   which is not an http(s) URL (advisory A3)", › "scrubs a vscode-remote://
//   URI, which is not an http(s) URL (advisory A3)", › "scrubs a
//   tilde-prefixed path with an embedded space, consuming both words of a
//   two-word name (advisory A2: neither First nor Last survives)", ›
//   "scrubs a drive-letter path in diagnosis even when a digit sits directly
//   before the drive letter (9C:\Users\alice — advisory A3)", and — for the
//   structured mixed-slash UNC extension — › "scrubs a mixed-slash UNC path
//   in the branch field (forward-slash host, backslash tail) — code-reviewer
//   r3 B1".
//   A RELATIVE path in a STRUCTURED field (`src/file.ts`, `../sibling/x.ts`),
//   a single-segment absolute POSIX path in a structured field (`/etc`
//   alone, with nothing after it), and any shape none of the above names
//   pass through a structured field unscrubbed; see `test/template/
//   continuation.test.ts` (absent in a generated rig), the
//   `describe('path scrubbing by SHAPE, not a fixed prefix list')` block, for
//   the structured-field cases by name next to the assertion that proves
//   them — including › "leaves a URL with a port number untouched, so
//   localhost:3000 is never mistaken for a drive letter", › "scrubs a Node
//   ESM stack-frame file:// URI (POSIX form)", › "scrubs a Node ESM
//   stack-frame file:// URI (Windows drive-letter form)", › "scrubs a
//   forward-slash UNC path (//wsl.localhost/...), not only the backslash
//   form", › "scrubs a forward-slash UNC path to a generic server share", ›
//   "scrubs a POSIX path that sits directly after a colon with no separating
//   space", › "does not leave the tail of a space-containing POSIX path
//   behind after the scrubbed prefix", and › "does not leave the tail of a
//   space-containing UNC path behind after the scrubbed prefix".
// - None of the five structured patterns nests one unbounded quantifier
//   inside another, so none of them can backtrack catastrophically on
//   adversarial input, and the 2000-character raw cap above means none of
//   them is ever asked to try — see `test/template/continuation.test.ts`
//   (absent in a generated rig) › "completes well under a generous bound on a
//   220,000-character field, the shape that once risked catastrophic
//   backtracking" and › "never lets a secret buried past the first few
//   thousand characters of an oversized field reach the note".
// - `readRunEvidence` reads only the latest REVIEW ROUND — every reviewer
//   verdict journalled after the LAST `reviewer-fan-out` decision, and only
//   for the reviewer names that fan-out actually launched. An
//   `item-selection` or `review-routing:*` record, and any verdict from a
//   round before the latest fan-out, are never reported. See "Evidence is
//   gathered…" above for the seeded-`no-verdict` behaviour and its one
//   exception.
// - Gate rounds are read for the branch `git` reports right now; a detached
//   checkout (`HEAD` literal) is refused by `gate-rounds.mjs`'s own
//   `requireBranch`, which this module reports as an unknown count rather
//   than a crash.
//
// See `test/template/continuation.test.ts` (absent in a generated rig) for
// every case above, by name, next to the assertion that proves it.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withoutGitLocation } from './git-env.mjs';
import { readRun } from './run-journal.mjs';
import { findSecretValues } from './lib/secrets.mjs';

/** The only four workflow-level stops this note exists for. */
export const STOP_KINDS = Object.freeze(['escalation', 'blocker', 'pause', 'terminated']);

/** A tracker key (`RP-224`) or a bare issue number (`224`) — nothing else. */
const TICKET_SHAPE = /^[A-Z][A-Z0-9_]+-\d+$|^\d+$/;

const PATH_MARKER = '[path]';
const REDACTED_MARKER = '[redacted]';
const NEWLINE_MARKER = '⏎';
const FIELD_CAP = 500;
const FIELD_TRUNCATION_MARKER = '[truncated]';
const NOTE_CAP = 2000;
const NOTE_TRUNCATION_SUFFIX = '\n[truncated]';
// Every string field is cut to this many raw characters BEFORE
// collapseNewlines/scrubPaths ever see it (`composeTextField`/
// `composeFreeTextField` below) — the same marker as the 500-character
// diagnosis/remaining cap, because both do the same thing: mark the cut,
// never drop it silently.
const RAW_FIELD_CAP = 2000;
// The whole-field credential scan reads this many raw characters — wider
// than RAW_FIELD_CAP, so a credential straddling the 2000-character cut is
// still seen whole. See the module header's "Limits" section.
const SECRET_SCAN_WINDOW = RAW_FIELD_CAP + 128;

const FAN_OUT_GATE = 'reviewer-fan-out';

// Five SHAPE-based path patterns, applied in this order, to EVERY field (see
// the module header's "Limits" section for what each one recognises and
// where it stops). Every pattern below is a single bounded forward scan of
// the field it is given: one fixed character class repeated once
// (`[^delimiters]*` or `[^\s]+`), never a quantifier nested inside another.
// The one exception — UNC_PATH's optional `label:` prefix — is bounded
// explicitly instead (`{1,64}` and `{1,8}`), so it can try and fail at most
// 73 characters per starting position rather than re-scanning an unbounded
// run looking for a colon that never comes. Combined with the RAW_FIELD_CAP
// cut above, no pattern here is ever asked to scan more than 2000
// characters, and none of them is quadratic even without that cap.
//
// A "hard delimiter" — `"`, `'`, `` ` ``, `|`, `<`, `>`, `⏎` — is what ends a
// match mid-field; everything else, including a literal space, is consumed
// as part of the path. `⏎` is safe to use as a delimiter because the
// line-terminator collapse always runs before these patterns (see
// `composeTextField`/`composeFreeTextField` below), so an actual line
// terminator can never reach them as `\n`/`\u2028`/etc.

// `file:` URI — a Node ESM stack-frame shape (`file:///home/x`,
// `file:///C:/Users/x`), not preceded by a word character (so a word ending
// in "…file:" is not mistaken for the scheme).
const FILE_URI = /(?<!\w)file:\/+[^"'`|<>⏎]*/g;
// `\\host\share\…` or `\\host/share/…` (either slash after the host), with
// the bounded optional `label:` prefix described above, to the next hard
// delimiter or the end of the field.
const UNC_PATH = /(?:[^\s:]{1,64}:[ \t]{1,8})?\\\\[^\s\\/]+[\\/][^"'`|<>⏎]*/g;
// A drive letter not itself preceded by a letter/digit (so `http`**s**`:` is
// never read as one), to the next hard delimiter or the end of the field.
const DRIVE_PATH = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^"'`|<>⏎]*/g;
// `//host/…` or `//host\…` (either slash after the host) with no leading
// backslash at all, not itself preceded by `:` or a word character (so
// `https://host/…` is left alone), to the next hard delimiter or the end of
// the field.
const FORWARD_SLASH_UNC = /(?<![:\w])\/\/[^\s/\\]+[\\/][^"'`|<>⏎]*/g;
// A slash-rooted POSIX path of >= 2 segments, not preceded by a word
// character or another `/` (colon IS allowed, so `label:/home/x` scrubs);
// consumed, from the second segment on, to the next hard delimiter or the
// end of the field.
const POSIX_PATH = /(?<![\w/])\/[^\s"'`|<>⏎/]+\/[^"'`|<>⏎]*/g;

const scrubPaths = (text) =>
  text
    .replace(FILE_URI, PATH_MARKER)
    .replace(UNC_PATH, PATH_MARKER)
    .replace(DRIVE_PATH, PATH_MARKER)
    .replace(FORWARD_SLASH_UNC, PATH_MARKER)
    .replace(POSIX_PATH, PATH_MARKER);

// Splits free text on the hard delimiters, keeping the delimiters as their
// own array entries so `scrubFreeText` can leave a leading quote (or other
// delimiter) outside the span it scrubs.
const HARD_DELIMITER_SPLIT = /(["'`|<>⏎])/g;

// RP-297 round 2 — security-scanner HOLD on PR #351 (head e50df6e): every
// shape trigger below used to be anchored to the TOKEN'S OWN START
// (`^`/`startsWith`), so leading punctuation a person types under
// pressure — a paren, a bracket, a `--flag=`, a `label:` — sat in front of
// the shape and defeated the check entirely. Every trigger that isn't
// already a whole-token membership test (`includes('\\')`,
// `hasDotDotSegment`) is now a BOUNDARY match instead: it fires at the
// token's own start, or immediately after a single character that
// disqualifies from being part of the shape itself — see each constant
// below for exactly which characters disqualify for THAT trigger (they
// differ: `TILDE_BOUNDARY` and `ENV_VAR_BOUNDARY` disqualify only a word
// character; `SCHEME_URI_AT_BOUNDARY` disqualifies only a letter or digit;
// `HOME_ROOT_SEGMENT` disqualifies a word character OR a path separator —
// see its own comment below for why the separator exclusion is there) —
// since round 3 tightened three of them further, and the post-cap fix below
// brought the fourth (`HOME_ROOT_SEGMENT`) in line with the same family.
//
// RP-297 round 3 — code-reviewer and security-scanner both HOLD on the
// round-2 fix (review at 14bc59d): three of round 2's own boundary
// definitions were themselves too narrow, and one whole-token
// short-circuit hid a second, later shape in the same token —
// `test/template/continuation.test.ts` (absent in a generated rig),
// `describe('RP-297 round 3 — …')`, by name below each fix:
//
//   - `TILDE_BOUNDARY` excluded `.` and `-` from counting as a boundary
//     (to let a version-ish run like `v1.2-3` continue through unbroken),
//     which also meant `-~alice/x` and `.~alice/x` read as ONE identifier
//     and the tilde shape never fired — › "RP-297 round 3 — a tilde after
//     `.` or `-` must still be redacted, not treated as one unbroken
//     identifier". A tilde after a WORD character must still survive
//     (`HEAD~2`, `foo~bar`) — › "leaves a git detached-HEAD-relative ref
//     untouched" and › "leaves an ordinary identifier containing a tilde
//     untouched (foo~bar)" — so the fix drops only the `.`/`-` exclusions,
//     not the word-character one.
//   - `SCHEME_URI_AT_BOUNDARY` excluded `-`, `.`, and `+` from counting as a
//     boundary too (so `vscode-remote://` isn't misread as two schemes),
//     which also meant a LEADING `-`/`./`+` before the scheme name hid the
//     whole scheme — › "RP-297 round 3 — a scheme URI after `-`, `.`, or
//     `+` must still be redacted". Replaced with a lookbehind that excludes
//     only an alphanumeric predecessor, so `vscode-remote://` still matches
//     as ONE scheme (the greedy capture consumes the internal `-` before
//     the boundary check ever runs again) while `-smb://…`/`.smb://…`/
//     `+smb://…` now match too.
//   - `isFreeTextPathToken`'s own top line, `if (HTTP_URL_PREFIX.test(token))
//     return false`, was a WHOLE-TOKEN short-circuit: a token that STARTS
//     WITH http(s) returned `false` immediately, before any other trigger
//     ever ran — so a SECOND, non-http(s) shape later in the same token
//     (`https://ok/,smb://alice-pc/share`, `https://x/(~alice/y)`,
//     `HTTP://x/~alice`) was never seen — › "RP-297 round 3 — a later
//     non-http(s) scheme or tilde inside a token that STARTS with
//     http(s):// must still be redacted". Deleted outright rather than
//     narrowed: nothing else needs it — `hasNonHttpSchemeUri` already
//     excludes an http(s) scheme match SPECIFICALLY (by name, not by
//     token position), and no other trigger reacts to the substring
//     `http`/`https` at all — so a bare, wrapped http(s) URL with no OTHER
//     shape in the token still survives on its own: ›
//     "leaves a parenthesised http:// URL untouched
//     ((http://example.invalid/a))".
//
// RP-297 post-cap fix — both round-3 reviewers held on the round-3
// `HOME_ROOT_SEGMENT` fix itself (`/(?:^[^\w/\\]*)(users|home|…)[\\/]/i`):
// it anchored the whole match to the token's absolute start, tolerating only
// a RUN of non-word, non-separator punctuation before the root name — so the
// moment a WORD character sat in front of the root (a flag name, a label, a
// drive letter, a lone variable name: `--dir=Users/alice/proj`,
// `path:home/alice/x`, `C:Users/alice`), the anchor could never reach the
// root at all, the same class of leak the round 2/round 3 tilde and scheme
// fixes each closed in turn — `test/template/continuation.test.ts` (absent
// in a generated rig), `describe('RP-297 round 4 — a word-bearing prefix
// before the home root must not defeat the (now start-anchored) home-root
// check')`. The fix drops the anchor for a true single-character BOUNDARY
// match, the same family every other trigger above already uses — see
// `HOME_ROOT_SEGMENT`'s own comment below for why it still excludes a
// preceding path separator specifically (the property round 3 needed and
// this fix must not lose).

// A `~`-prefixed path, at the token's own start or after any character
// that is not a word character — round 3 dropped the `.`/`-` exclusions
// round 2 had (see the block comment above).
const TILDE_BOUNDARY = /(?:^|[^\w])~/;

// A non-http(s) URI scheme (`file://`, `smb://`, `vscode-remote://`, …), at
// the token's own start or after any character that is not itself
// alphanumeric — round 3 replaced round 2's wider exclusion set (which also
// excluded `-`/`.`/`+`, so those couldn't PRECEDE a new scheme either) with
// a lookbehind that excludes only a letter or digit, so the scheme name's
// OWN internal `-`/`.`/`+` (`vscode-remote`) still reads as one scheme —
// the greedy capture below consumes it before the lookbehind is ever
// re-checked at a later position — while a `-`/`.`/`+` immediately BEFORE
// the scheme name no longer hides it. Every match in the token is walked
// (not just tested), so an `http`/`https` scheme found at one match does
// not hide a DIFFERENT, non-http(s) scheme found at another — this is what
// lets a token that itself starts with `https://` still be redacted for a
// LATER, non-http(s) scheme in the same token (see the round 3 block
// comment above `isFreeTextPathToken` no longer short-circuits on one).
const SCHEME_URI_AT_BOUNDARY = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9+.-]*):\/\//g;
const HTTP_SCHEME_NAME = /^https?$/i;

/**
 * Does `token` carry a non-http(s) URI scheme at a boundary anywhere in it?
 * One forward `exec` walk over the token — bounded, since every field this
 * runs on is already cut to `RAW_FIELD_CAP` before this pass ever sees it.
 */
const hasNonHttpSchemeUri = (token) => {
  SCHEME_URI_AT_BOUNDARY.lastIndex = 0;
  let match;
  while ((match = SCHEME_URI_AT_BOUNDARY.exec(token)) !== null) {
    if (!HTTP_SCHEME_NAME.test(match[1])) return true;
  }
  return false;
};

// `$HOME/x`, `%USERPROFILE%\x` — an environment-variable-style path
// reference, at the token's own start or after any non-word character, and
// ONLY when the token ALSO carries a path separator somewhere — so a bare
// `$5` or `%done%` is not mistaken for one. This pass does not distinguish
// a price from a path, though: a token that legitimately mixes the two,
// like `$5/month`, IS scrubbed — over-scrubbing diagnosis/remaining text is
// the accepted trade this whole coarse pass makes (see the module header's
// "Limits" section), not a claim that a `$`-prefixed number is safe.
const ENV_VAR_BOUNDARY = /(?:^|[^\w])[$%]/;

// A known home root — `Users`, `home`, `wsl.localhost`, or `wsl$`
// (case-insensitive) — at the token's own start or after any character that
// is neither a word character NOR a path separator (`/`/`\`), immediately
// followed by a path separator: the same roots an absolute
// Windows/POSIX/WSL path would have used had the caller typed the leading
// separator, so `Users/alice/proj`, `(Users/alice/x)`, and
// `--dir=Users/alice/proj` are all treated the same as `/Users/alice/proj`
// would have been.
//
// This is the same BOUNDARY-match shape every other trigger in this file
// uses (see the block comment above `TILDE_BOUNDARY`) — post-cap fix: round
// 3's version anchored the match to the token's own absolute start instead
// (only a punctuation-only RUN could precede the root), which is what
// missed a word-bearing prefix like `--dir=`/`path:`/`C:` (see the block
// comment above this one). The one way this boundary is NARROWER than
// `TILDE_BOUNDARY`/`ENV_VAR_BOUNDARY` on purpose: a path separator
// immediately before the root name does NOT count as a boundary here, only
// a non-word, non-separator character does (or the token's own start) — so
// an INNER segment that merely names a home root, like `users` in
// `src/users/list.ts` or `home` in `a/b/home/c`, still survives: ›
// "leaves a repo-relative path with \"users\" as an INNER segment
// untouched (src/users/list.ts)" and › "leaves a home root buried past the
// first two segments untouched (a/b/home/c)". The trailing `[\\/]`
// requirement (the root name must be followed immediately by a separator,
// not just any character) is what keeps a directory or file name that
// merely STARTS WITH a root name from matching at all — `usersvc/x.ts` and
// `homepage/a.md` have no separator directly after `users`/`home`, so
// neither the boundary nor a later retry ever completes a match: ›
// "leaves a directory that merely STARTS WITH \"users\" untouched, not a
// whole segment (usersvc/x.ts)" and › "leaves a directory that merely
// STARTS WITH \"home\" untouched, not a whole segment (homepage/a.md)".
const HOME_ROOT_SEGMENT = /(?:^|[^\w/\\])(users|home|wsl\.localhost|wsl\$)[\\/]/i;

/** Does this token contain a literal `..` path segment (split on `/` and `\`)? */
const hasDotDotSegment = (token) => token.split(/[\\/]/).includes('..');

/**
 * Does this whitespace-delimited token start a coarse free-text path span?
 *
 * RP-297 round 1: this used to trigger on ANY token merely CONTAINING a
 * `/`, which misread an N/N fraction (`3/3`) and a repo-relative evidence
 * identity (`packages/cli/test/x.test.ts:367`) as a path — and the scrub
 * then consumes everything from that token's own start to the end of the
 * segment, so the trailing text (a test id, a line number) was lost too.
 * RP-297 rounds 2, 3 and the post-cap fix replaced it with the SHAPE-based
 * triggers below — see the block comments above `TILDE_BOUNDARY` and
 * `HOME_ROOT_SEGMENT` for what each one catches, exactly which characters
 * count as a boundary for it, and which test pins it. A token starts a path
 * span when: it starts with `/` or `\`; or it contains a `\` anywhere; or
 * it carries a `~` at a boundary (`TILDE_BOUNDARY`); or it contains a `..`
 * path segment (`hasDotDotSegment`, which can climb out of the repo
 * regardless of which separator it uses); or it carries a non-http(s) URI
 * scheme at a boundary (`hasNonHttpSchemeUri`); or it carries an
 * environment-variable-style reference at a boundary that ALSO carries a
 * path separator somewhere in the token (`ENV_VAR_BOUNDARY`); or it names a
 * known home root at a boundary that is NOT itself a path separator,
 * immediately followed by one (`HOME_ROOT_SEGMENT`). A token with none of
 * these shapes — no leading separator, no backslash, no `..` segment, no
 * recognised scheme, no home-root boundary — survives verbatim, the same as
 * a repo-relative test identity: `test/template/continuation.test.ts`
 * (absent in a generated rig) › "leaves a repo-relative test identity in
 * diagnosis untouched, with the trailing text intact"
 * (`packages/cli/test/x.test.ts:367` — NOT `Users/alice/x` or
 * `--dir=Users/alice/proj`, both of which `HOME_ROOT_SEGMENT` catches, and
 * NOT `src/users/list.ts`, which it deliberately does not, since the `/`
 * immediately before `users` there is excluded from counting as a
 * boundary — › "leaves a repo-relative path with \"users\" as an INNER
 * segment untouched").
 */
const isFreeTextPathToken = (token) => {
  if (token.startsWith('/') || token.startsWith('\\')) return true;
  if (token.includes('\\')) return true;
  if (TILDE_BOUNDARY.test(token)) return true;
  if (hasDotDotSegment(token)) return true;
  if (hasNonHttpSchemeUri(token)) return true;
  if (ENV_VAR_BOUNDARY.test(token) && (token.includes('/') || token.includes('\\'))) return true;
  if (HOME_ROOT_SEGMENT.test(token)) return true;
  return false;
};

/**
 * One hard-delimiter-free segment of a free-text field: find the FIRST
 * whitespace-delimited token that triggers `isFreeTextPathToken`, and if one
 * exists, replace everything from that token's own start to the end of the
 * segment with `[path]`. One forward token scan (`\s*` then `\S+`); trailing
 * whitespace makes it quadratic in the segment's length, which the raw field
 * cap bounds (see the module header).
 */
const scrubFreeTextSegment = (segment) => {
  const tokenPattern = /(\s*)(\S+)/g;
  let match;
  while ((match = tokenPattern.exec(segment)) !== null) {
    if (isFreeTextPathToken(match[2])) {
      const start = match.index + match[1].length;
      return `${segment.slice(0, start)}${PATH_MARKER}`;
    }
  }
  return segment;
};

/**
 * The coarse free-text path scrub — `diagnosis`/`remaining` only, applied
 * AFTER `scrubPaths` above. See the module header's "Limits" section for the
 * rule in full.
 */
const scrubFreeText = (text) => {
  const parts = text.split(HARD_DELIMITER_SPLIT);
  for (let index = 0; index < parts.length; index += 2) {
    parts[index] = scrubFreeTextSegment(parts[index]);
  }
  return parts.join('');
};

/** Collapse every line terminator this runtime can produce, so free text cannot forge a second `key: value` line. */
const collapseNewlines = (text) => text.replace(/\r\n|\r|\n|\u2028|\u2029|\u0085/g, NEWLINE_MARKER);

/**
 * Cut a field to `RAW_FIELD_CAP` characters BEFORE `collapseNewlines` /
 * `scrubPaths` / `scrubFreeText` ever see it. This is what keeps every regex
 * pass above provably bounded regardless of how large the caller's own field
 * is — see the module header's "Limits" section.
 */
const capRawField = (value) => {
  if (value.length <= RAW_FIELD_CAP) return value;
  const keep = RAW_FIELD_CAP - FIELD_TRUNCATION_MARKER.length;
  return `${value.slice(0, keep)}${FIELD_TRUNCATION_MARKER}`;
};

/**
 * Whether the RAW value (up to `SECRET_SCAN_WINDOW` characters) carries any
 * credential shape `lib/secrets.mjs` names — reusing `findSecretValues`
 * verbatim rather than a second copy of the vocabulary (`invariants.md`:
 * "one mechanism, one implementation"). A hit means the WHOLE field is
 * withheld; see the module header's "Limits" section for why whole-field,
 * never partial.
 */
const hasSecret = (raw) => findSecretValues(raw.slice(0, SECRET_SCAN_WINDOW)).length > 0;

/** Cap one free-text field, with an explicit marker rather than a silent cut. */
const truncateField = (value) => {
  if (value.length <= FIELD_CAP) return value;
  const keep = FIELD_CAP - FIELD_TRUNCATION_MARKER.length;
  return `${value.slice(0, keep)}${FIELD_TRUNCATION_MARKER}`;
};

/**
 * A STRUCTURED field: `ticket`, `branch`, `pr`, `headSha`, `gateRounds`, a
 * gate name, a blocker rule name, a verdict word. Whole-field secret check on
 * the raw value, then cap, collapse line terminators, and scrub the five
 * structured path shapes — never the coarser free-text pass below, which is
 * for typed prose, not a value this module or its caller constructs.
 * `undefined`/`null` render `unknown` rather than being guessed or omitted.
 */
const composeTextField = (value) => {
  if (value === undefined || value === null) return 'unknown';
  const raw = String(value);
  if (hasSecret(raw)) return REDACTED_MARKER;
  return scrubPaths(collapseNewlines(capRawField(raw)));
};

/**
 * A FREE-TEXT field: `diagnosis` or `remaining`. Same whole-field secret
 * check and the same structured scrub as `composeTextField`, plus the
 * coarser free-text path scrub afterward (see the module header's "Limits"
 * section). `undefined`/`null` render `unknown`.
 */
const composeFreeTextField = (value) => {
  if (value === undefined || value === null) return 'unknown';
  const raw = String(value);
  if (hasSecret(raw)) return REDACTED_MARKER;
  return scrubFreeText(scrubPaths(collapseNewlines(capRawField(raw))));
};

/** `composeFreeTextField`, plus the per-field 500-character cap `diagnosis`/`remaining` carry. */
const composeCappedTextField = (value) => truncateField(composeFreeTextField(value));

/**
 * Cap the WHOLE note — a backstop for a field this module does not cap on
 * its own. RP-295 (RP-290 review follow-up, item C.1) — `prefixText` (the ten
 * fixed `ticket`/`stop`/.../`remaining` lines) and `failedCheckText` (zero or
 * more `failed-check:` lines) are capped SEPARATELY here: the old version cut
 * one joined string from the front, so a note over `NOTE_CAP` lost whatever
 * sat at the very END — the failed-check block, appended last, ahead of
 * everything else that is only ever `unknown` or capped free text
 * (`diagnosis`/`remaining`, `FIELD_CAP` each). The failed-check block is the
 * highest-value content this note carries, so it is now the one thing that
 * survives intact: `prefixText` is truncated to whatever budget remains
 * after reserving room for the full `failedCheckText` and the truncation
 * suffix. See `continuation.test.ts` (absent in a generated rig) › "keeps a
 * failed-check line intact, ahead of the whole-note cap, even when
 * diagnosis/remaining filler alone nearly fills the note".
 */
const capNote = (prefixText, failedCheckText) => {
  const full = failedCheckText ? `${prefixText}\n${failedCheckText}` : prefixText;
  if (full.length <= NOTE_CAP) return full;

  const reserved = failedCheckText ? failedCheckText.length + 1 : 0;
  const budget = NOTE_CAP - NOTE_TRUNCATION_SUFFIX.length - reserved;
  if (budget < 0) {
    // The failed-check block alone, plus the suffix, is already over
    // NOTE_CAP — bounded the same way any other over-cap case here is: fall
    // back to truncating the WHOLE joined note from the front, never an
    // unbounded write.
    return `${full.slice(0, NOTE_CAP - NOTE_TRUNCATION_SUFFIX.length)}${NOTE_TRUNCATION_SUFFIX}`;
  }
  const truncatedPrefix = `${prefixText.slice(0, budget)}${NOTE_TRUNCATION_SUFFIX}`;
  return failedCheckText ? `${truncatedPrefix}\n${failedCheckText}` : truncatedPrefix;
};

/**
 * The short (7-character) form of a head SHA, for the `latest-verdict` line.
 * The value goes through `composeTextField` FIRST — the same whole-field
 * secret check, cap, line-terminator collapse and path scrub every other
 * field gets — before it is ever sliced, so an embedded line terminator (or
 * a credential, however unlikely in a SHA) cannot survive into the sliced
 * result. A falsy `headSha` (absent, `null`, `''`) renders `unknown` without
 * running the pipeline at all — there is nothing to compose.
 */
const shortShaOf = (headSha) => {
  if (!headSha) return 'unknown';
  const composed = composeTextField(headSha);
  return composed === 'unknown' ? 'unknown' : composed.slice(0, 7);
};

/** Blocker rule names, scrubbed/redacted like every other string field, blanks dropped. */
const renderBlockerRules = (blockers) =>
  Array.isArray(blockers)
    ? blockers.filter((rule) => typeof rule === 'string' && rule.trim() !== '').map(composeTextField)
    : [];

/** A reviewer's verdict word: `no-verdict` for null/undefined (launched, never answered), composed like every other field otherwise. */
const renderVerdictWord = (word) =>
  word === null || word === undefined ? 'no-verdict' : composeTextField(word);

/**
 * Renders either verdict shape `composeNote` accepts:
 *
 *   - a single verdict: `{ gate, verdict, headSha, blockers }`
 *   - a review round: `{ headSha, reviewers: [{ gate, verdict, blockers }, …] }`
 *     — the shape `readRunEvidence` returns. A reviewer entry whose
 *     `verdict` is `null` (launched, never journalled one) renders as
 *     `<gate> no-verdict`.
 *
 * `unknown` when there is nothing to report: no verdict at all, a single
 * verdict missing its `gate`/`verdict`, or a review round with no reviewers.
 */
const renderVerdict = (verdict) => {
  if (!verdict) return 'unknown';

  if (Array.isArray(verdict.reviewers)) {
    if (verdict.reviewers.length === 0) return 'unknown';
    const shortSha = shortShaOf(verdict.headSha);
    const parts = verdict.reviewers.map((reviewer) => {
      const gate = composeTextField(reviewer?.gate);
      const answer = renderVerdictWord(reviewer?.verdict);
      const blockers = renderBlockerRules(reviewer?.blockers);
      const suffix = blockers.length > 0 ? ` (${blockers.join(', ')})` : '';
      return `${gate} ${answer}${suffix}`;
    });
    return `${parts.join(', ')} @ ${shortSha}`;
  }

  if (!verdict.gate || !verdict.verdict) return 'unknown';
  const shortSha = shortShaOf(verdict.headSha);
  const gate = composeTextField(verdict.gate);
  const answer = composeTextField(verdict.verdict);
  const blockers = renderBlockerRules(verdict.blockers);
  const suffix = blockers.length > 0 ? ` — blockers: ${blockers.join(', ')}` : '';
  return `${gate} ${answer} @ ${shortSha}${suffix}`;
};

// RP-295 (RP-290 review follow-up, item C.2) — a signal name is rendered
// verbatim into the note, so it goes through the same allowlist shape every
// other structured value in this module is held to rather than being passed
// through unchecked: exactly `SIG` followed by 1-12 uppercase letters/digits
// (`SIGTERM`, `SIGKILL`, `SIGRT35`, …). Anything else — `check-run.mjs`
// itself only ever sets `signal` from Node's own `child.on('close', (code,
// sig) => …)`, but this module never trusts an upstream shape it does not
// control — is omitted rather than rendered, falling back to the bare exit
// code below.
const SIGNAL_NAME_PATTERN = /^SIG[A-Z0-9]{1,12}$/;

/**
 * The outcome portion of a `failed-check:` line — RP-295 (RP-290 review
 * follow-up, item C.2). `composeFailedCheckLine` used to read only
 * `exitCode`, never `signal`/`timedOut`, even though `check-run.mjs` records
 * both: a timed-out or signal-killed check reports `exitCode: null` (Node's
 * own `child.on('close', (code, sig) => …)` shape once a process is killed),
 * which rendered as the bare, uninformative "exit unknown" — nothing told a
 * fresh reader the check never got the chance to fail on its own. `timedOut`
 * takes priority over `signal` (a timeout kill sets both, and "timed out" is
 * the more specific fact — it explains WHY the process was signalled).
 */
const describeCheckOutcome = (check) => {
  if (check?.timedOut === true) return 'timed out';
  if (typeof check?.signal === 'string' && SIGNAL_NAME_PATTERN.test(check.signal)) {
    return `killed by ${check.signal}`;
  }
  return `exit ${composeTextField(check?.exitCode)}`;
};

/**
 * One `failed-check: <name> exit <code>; tests: <id1>, <id2>…` line — RP-290,
 * from a `check-run.mjs` `check-result` record whose latest outcome for that
 * name is `fail`. Every value goes through `composeTextField`, the same
 * structured pipeline every other field in this note gets, so an embedded
 * credential or line terminator inside a test id is redacted/collapsed the
 * same way — and a REPO-RELATIVE test id (no leading `/`) is not itself a
 * shape any of the five structured path patterns matches, so it survives
 * intact rather than becoming `[path]`. `tests:` reads `unknown` when the
 * record named no failing test id at all, never an empty string. The outcome
 * portion renders "timed out" or "killed by <SIGNAL>" instead of a bare
 * "exit unknown" where `check-run.mjs` recorded one — see
 * `describeCheckOutcome` above.
 */
const composeFailedCheckLine = (check) => {
  const name = composeTextField(check?.name);
  const outcome = describeCheckOutcome(check);
  const ids = Array.isArray(check?.failedTests)
    ? check.failedTests
        .filter((id) => typeof id === 'string' && id.trim() !== '')
        .map((id) => composeTextField(id))
    : [];
  const testsField = ids.length > 0 ? ids.join(', ') : 'unknown';
  return `failed-check: ${name} ${outcome}; tests: ${testsField}`;
};

/** `failedChecks` renders as zero or more `failed-check:` lines, never guessed when absent. */
const renderFailedCheckLines = (failedChecks) =>
  Array.isArray(failedChecks) ? failedChecks.map(composeFailedCheckLine) : [];

/**
 * The shared note shape, in a fixed key order — see the module header for
 * what it never carries. Throws only on an unknown/absent `stop`: every
 * other field is optional and renders `unknown` rather than being guessed or
 * omitted, so a reader always sees the same ten lines, plus one
 * `failed-check:` line (RP-290) per failing check `readFailedChecks` found —
 * none when `failedChecks` is absent or empty, which keeps every caller and
 * every existing test that never passes it byte-identical to before RP-290.
 */
export const composeNote = ({
  ticket,
  stop,
  branch,
  pr,
  headSha,
  gateRounds,
  verdict,
  diagnosis,
  remaining,
  failedChecks,
} = {}) => {
  if (!STOP_KINDS.includes(stop)) {
    throw new Error(
      `continuation note needs --stop to be one of ${STOP_KINDS.join(', ')}; got ${JSON.stringify(stop)}.`,
    );
  }

  const prefixLines = [
    'rig-continuation v1',
    `ticket: ${composeTextField(ticket)}`,
    `stop: ${stop}`,
    `branch: ${composeTextField(branch)}`,
    `pr: ${composeTextField(pr)}`,
    `head: ${composeTextField(headSha)}`,
    `gate-rounds-this-checkout: ${composeTextField(gateRounds)}`,
    `latest-verdict: ${renderVerdict(verdict)}`,
    `diagnosis: ${composeCappedTextField(diagnosis)}`,
    `remaining: ${composeCappedTextField(remaining)}`,
  ];
  const failedCheckText = renderFailedCheckLines(failedChecks).join('\n');

  return capNote(prefixLines.join('\n'), failedCheckText);
};

/**
 * The latest REVIEW ROUND this run's journal carries: the last
 * `reviewer-fan-out` decision, and the latest verdict journalled under each
 * reviewer name IT launched, after it — never `item-selection`,
 * `review-routing:*`, or a verdict from a round before the latest fan-out.
 *
 * Once the round has produced at least one decision of its own, every
 * launched reviewer name is reported even when it never journalled a
 * verdict — `{ gate, verdict: null, blockers: [] }` — so a silent non-answer
 * is not indistinguishable from a reviewer that was never launched at all. A
 * round with NO decisions yet (the fan-out is still the newest entry in the
 * journal) reports `reviewers: []` instead, the same as no fan-out at all —
 * that case has produced no evidence to seed a roster against, exactly like
 * an undeclared run.
 *
 * `runDir` absent, non-existent, unreadable, or carrying no fan-out at all
 * are all read the same way: there is no evidence, not an error.
 */
export const readRunEvidence = (runDir) => {
  try {
    const { decisions } = readRun({ runDir });

    let fanOut = null;
    let fanOutIndex = -1;
    decisions.forEach((decision, index) => {
      if (decision.gate === FAN_OUT_GATE) {
        fanOut = decision;
        fanOutIndex = index;
      }
    });
    if (!fanOut) return { headSha: null, reviewers: [] };

    const launched = Array.isArray(fanOut.reviewers)
      ? fanOut.reviewers.filter((name) => typeof name === 'string')
      : [];
    const launchedSet = new Set(launched);
    const afterFanOut = decisions.slice(fanOutIndex + 1);

    const latestByReviewer = new Map();
    // Seed every launched reviewer as "not yet answered" only once the round
    // has produced at least one decision of its own (see the doc comment
    // above) — insertion order below is launched order, and a real verdict
    // later in the loop overwrites the seeded entry in place rather than
    // moving it.
    if (afterFanOut.length > 0) {
      for (const name of launched) {
        latestByReviewer.set(name, { gate: name, verdict: null, blockers: [] });
      }
    }
    for (const decision of afterFanOut) {
      if (!launchedSet.has(decision.gate)) continue;
      latestByReviewer.set(decision.gate, {
        gate: decision.gate,
        verdict: decision.verdict ?? null,
        blockers: Array.isArray(decision.blockers)
          ? decision.blockers.map((blocker) => blocker.rule)
          : [],
      });
    }

    return {
      headSha: fanOut.headSha ?? null,
      reviewers: Array.from(latestByReviewer.values()),
    };
  } catch {
    return { headSha: null, reviewers: [] };
  }
};

const CHECK_RESULT_KIND = 'check-result';

/**
 * RP-290 — the LATEST `check-result` event per check NAME (`check-run.mjs`),
 * filtered to the ones whose latest outcome is `fail`. A later PASS for the
 * same name drops its earlier failure; a later FAIL for a name that once
 * passed replaces it. `runDir` absent, non-existent, or unreadable reports
 * none — the same silent-optional-trace shape every other reader in this
 * module uses.
 */
export const readFailedChecks = (runDir) => {
  try {
    const { events } = readRun({ runDir });
    const latestByName = new Map();
    for (const event of events) {
      if (event.kind !== CHECK_RESULT_KIND) continue;
      const data = event.data;
      if (!data || typeof data.name !== 'string') continue;
      // RP-295 (RP-290 review follow-up, item C.3) — a `spawn-error` record
      // never overwrites a PRIOR record for the same name: `spawn-error` is
      // filtered out below regardless (a command that never started is not
      // a test failure), so letting it become "latest" for a name that had
      // already failed would lose that failure's own identity with nothing
      // more informative to replace it. Only another `fail` or a `pass`
      // record may replace an existing entry — a `spawn-error` is recorded
      // only when it is the FIRST thing seen for that name.
      if (data.outcome === 'spawn-error' && latestByName.has(data.name)) continue;
      latestByName.set(data.name, data);
    }
    return Array.from(latestByName.values()).filter((data) => data.outcome === 'fail');
  } catch {
    return [];
  }
};

// --- CLI ---------------------------------------------------------------

const gitValue = (args, cwd) => {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: withoutGitLocation(),
    }).trim();
  } catch {
    return null;
  }
};

const parseArgs = (argv) => {
  const args = { ticket: null, stop: null, pr: null, diagnosis: null, remaining: null, post: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--ticket') args.ticket = argv[(i += 1)] ?? null;
    else if (flag === '--stop') args.stop = argv[(i += 1)] ?? null;
    else if (flag === '--pr') args.pr = argv[(i += 1)] ?? null;
    else if (flag === '--diagnosis') args.diagnosis = argv[(i += 1)] ?? null;
    else if (flag === '--remaining') args.remaining = argv[(i += 1)] ?? null;
    else if (flag === '--post') args.post = true;
    else return { error: `unknown flag ${flag}` };
  }
  if (!args.ticket) {
    return {
      error:
        'usage: node continuation.mjs --ticket <id> --stop escalation|blocker|pause|terminated ' +
        '[--pr <n>] [--diagnosis <text>] [--remaining <text>] [--post]\n--ticket is required.',
    };
  }
  // Validated FIRST, before the --stop check below and before any adapter is
  // ever resolved: this value is later interpolated into an adapter call.
  if (!TICKET_SHAPE.test(args.ticket)) {
    return {
      error:
        `--ticket must look like a tracker key (e.g. RP-224) or a bare issue number; ` +
        `got ${JSON.stringify(args.ticket)}.`,
    };
  }
  if (!STOP_KINDS.includes(args.stop)) {
    return {
      error: `--stop must be one of ${STOP_KINDS.join(', ')}; got ${JSON.stringify(args.stop)}.`,
    };
  }
  return { ok: true, ...args };
};

/**
 * Was this file invoked directly? Compared by REALPATH on both sides, the
 * same shape every CLI sibling in this directory uses (see
 * `duplicate-work.mjs`'s own copy for the symlinked-checkout case it guards).
 */
const invokedDirectly = () => {
  if (!process.argv[1]) return false;
  const real = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return real(fileURLToPath(import.meta.url)) === real(process.argv[1]);
};

if (invokedDirectly()) {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    process.exit(1);
  }

  const cwd = process.cwd();
  const branch = gitValue(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const headSha = gitValue(['rev-parse', 'HEAD'], cwd);

  const gateRounds = await (async () => {
    if (!branch) return null;
    try {
      const { gateRoundsFor } = await import('./queue/gate-rounds.mjs');
      const rounds = gateRoundsFor({ branch, projectRoot: cwd });
      // `gateRoundsFor` answers 0 for "no entry at all" — the counter can
      // never hold a genuine journalled zero, so a bare 0 here would always
      // be the absent-entry case wearing the wrong word. Report `unknown`.
      return rounds > 0 ? rounds : null;
    } catch {
      return null;
    }
  })();

  // `readRunEvidence`/`readFailedChecks` already report nulls/none for an
  // undeclared/unreadable run — passing `undefined` when RIG_RUN_DIR is unset
  // takes that same path.
  const verdict = readRunEvidence(process.env.RIG_RUN_DIR);
  const failedChecks = readFailedChecks(process.env.RIG_RUN_DIR);

  const note = composeNote({
    ticket: parsed.ticket,
    stop: parsed.stop,
    branch,
    pr: parsed.pr,
    headSha,
    gateRounds,
    verdict,
    diagnosis: parsed.diagnosis,
    remaining: parsed.remaining,
    failedChecks,
  });

  process.stdout.write(`${note}\n`);

  // `--post` is the ONLY branch that resolves a queue adapter or touches the
  // network — every other path above is local evidence gathering.
  if (parsed.post) {
    try {
      const { loadConfig, resolveAdapter } = await import('./queue/index.mjs');
      const configPath = join(cwd, '.claude', 'queue.json');
      const config = loadConfig(configPath);
      const adapter = await resolveAdapter(config.adapter ?? 'plan-md');
      const result = await adapter.comment({ id: parsed.ticket }, note, { env: process.env });
      if (!result?.ok) {
        process.stderr.write(
          `continuation: the note above was NOT posted — ${result?.why ?? 'the adapter refused'}\n`,
        );
        process.exit(1);
      }
    } catch (error) {
      process.stderr.write(`continuation: the note above was NOT posted — ${error.message}\n`);
      process.exit(1);
    }
  }

  process.exit(0);
}
