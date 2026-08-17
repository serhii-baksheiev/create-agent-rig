/**
 * The verdict schema — one shape every gate in this rulebook answers in.
 *
 * Before this module, a gate's verdict was a sentence the calling session
 * pattern-matched by eye: `VERDICT: HOLD`, `PREMISE FALSE`, "not
 * security-relevant". A reviewer that rambled a paragraph and never wrote the
 * line was read as whatever the caller expected.
 *
 * Two of the properties the rulebook states are decided here: a blocker names
 * what it violates, and a verdict that stops the change lists at least one. The
 * third — one verdict per report — is asked for by each gate's spec and is not
 * decided here: this reads the LAST block and ignores every earlier one
 * (limit 3), which is what lets a reviewer quote the shape and then answer.
 *
 * So a gate now ends its report with exactly one fenced ```json block, and
 * `parseVerdict` is the single place that decides whether such a block says
 * anything. `verdict.mjs` (the CLI beside this file) is how `pr-ship` calls it;
 * `run-journal.mjs` records the parsed value rather than the prose.
 *
 * 🔴 **Both directions of "the blocker list disagrees with the word" are
 * refused, and the second is the dangerous one.** A `HOLD` naming no blocker
 * gives the author nothing to act on, so the guess is usually "nothing". A
 * `SHIP` that carries blockers reads as a pass while listing the reasons it
 * should not have been one — same defect, wearing the answer everyone wanted.
 *
 * ⚠ **What this module is not.** It decides whether a verdict is WELL-FORMED,
 * never whether it is right: a reviewer that saw nothing and answers `SHIP`
 * passes here exactly like one that read the whole diff. It also does not run,
 * launch or count gates — `pr-ship` runs the fan-out, `queue/index.mjs
 * gate-round` counts the rounds.
 *
 * ⚠ **The limits, stated rather than implied.**
 *
 * 1. **An unknown gate name is accepted, with any word from `VERDICT_WORDS`.**
 *    A project adds reviewers of its own, and a schema that refused every name
 *    it had not been told about would be deleted by the first project that
 *    extended it. Such a gate is checked against the shared list and not against
 *    a per-gate one; a gate name with a typo in it is not caught either, and
 *    that is the price of the limit.
 *
 *    **One shipped gate is in that position on purpose**, and it is a reviewer
 *    a stack layer adds. This file travels to every target, and the shared layer
 *    may not print a provider's name anywhere — so a gate whose own name carries
 *    one cannot be listed here, whatever else is true of it, and reaches the
 *    schema as an unknown gate. `GATE_VOCABULARY` therefore names the gates
 *    whose NAMES this layer may carry, which is not the same set as the gates a
 *    given target runs: a stack gate whose name is neutral is listed.
 * 2. **A blocker may name no file.** A failing required check and a
 *    Definition-of-Done line have no `file:line`, and demanding one would make
 *    every run invent a location to satisfy the schema — worse than the prose
 *    this replaces. What every blocker does name is the `rule` it violates.
 * 3. **It reads the LAST block in the report.** A spec shows the shape it wants
 *    and the reviewer then answers, so the first block in a report is usually
 *    the example — somebody else's gate, and usually the opposite word.
 * 4. **Nothing launches it.** Like every gate in this layer it holds because a
 *    skill says to call it, not because a hook fires it.
 * 5. **A ``` sequence inside the block ends the block.** Markdown has no
 *    escape for it, so a reviewer quoting a fenced snippet in a `note` writes a
 *    block whose end is ambiguous — and reading it to the first closing fence
 *    would silently keep the front half, which on a measured case was a `SHIP`
 *    standing in front of the `HOLD` that followed it. Such a report is
 *    **refused**, naming the backticks as the cause: the reviewer moves the
 *    quote out of the block (an `evidence` line, or the prose above it) and
 *    answers again. There is no reading of it this module could trust.
 */

/** Every word any gate in this rulebook may return. */
export const VERDICT_WORDS = Object.freeze([
  'SHIP',
  'HOLD',
  'HEALTHY',
  'REGRESSION',
  'PREMISES_HOLD',
  'PREMISE_FALSE',
  'UNVERIFIABLE',
  'UNMEASURED',
  'NOT_APPLICABLE',
]);

/**
 * The part of that vocabulary each gate can actually mean.
 *
 * A shared list alone would let `code-reviewer` answer `HEALTHY` and
 * `post-deploy-verify` answer `SHIP` — words whose meaning belongs to another
 * gate, and which a caller reading only the word would act on.
 *
 * 🔴 `check-premises` writes its verdicts with spaces in prose (`PREMISES
 * HOLD`) and as one token inside the block. Both forms are the contract; this
 * is the machine one.
 */
export const GATE_VOCABULARY = Object.freeze({
  'pr-ship': Object.freeze(['SHIP', 'HOLD']),
  'code-reviewer': Object.freeze(['SHIP', 'HOLD', 'NOT_APPLICABLE']),
  'prose-reviewer': Object.freeze(['SHIP', 'HOLD', 'NOT_APPLICABLE']),
  'security-scanner': Object.freeze(['SHIP', 'HOLD', 'NOT_APPLICABLE']),
  'check-premises': Object.freeze([
    'PREMISES_HOLD',
    'PREMISE_FALSE',
    'UNVERIFIABLE',
    'UNMEASURED',
  ]),
  'post-deploy-verify': Object.freeze(['HEALTHY', 'REGRESSION']),
});

/**
 * The words that mean stop — each one has to name what stopped it.
 *
 * `UNVERIFIABLE` and `UNMEASURED` are here for the same reason `HOLD` is: each
 * is about a specific claim or sentence, and a verdict that will not say which
 * one leaves the caller exactly where the free prose did.
 */
export const BLOCKING_VERDICTS = Object.freeze([
  'HOLD',
  'REGRESSION',
  'PREMISE_FALSE',
  'UNVERIFIABLE',
  'UNMEASURED',
]);

/** The five keys a parsed verdict has, and the only five a block may carry. */
const SHAPE_KEYS = Object.freeze(['gate', 'verdict', 'blockers', 'advisories', 'evidence']);

const FENCE = '```json';

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isText = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * The last fenced ```json block, as one of three answers: `{ raw }` for a block
 * whose extent is unambiguous, `{ ambiguous: true }` for one carrying a fence of
 * its own (limit 5), and `null` when the report has no such block at all.
 *
 * One backward scan for the opening fence and one forward pass counting the
 * closing ones — no regular expression over model-written text, which is
 * unbounded and arrives from a subagent.
 */
const lastJsonBlock = (text) => {
  const opening = text.lastIndexOf(FENCE);
  if (opening === -1) return null;

  let start = opening + FENCE.length;
  while (start < text.length && (text[start] === ' ' || text[start] === '\t')) start += 1;
  if (text[start] === '\r') start += 1;
  if (text[start] === '\n') start += 1;

  const closing = text.indexOf('```', start);
  // No closing fence at all: the rest of the report is the body, and JSON tells
  // the reader what is wrong with it. One closing fence is the ordinary block.
  if (closing === -1) return { raw: text.slice(start) };
  if (text.indexOf('```', closing + 3) === -1) return { raw: text.slice(start, closing) };

  // 🔴 More than one: the block's end is a guess, and the two guesses disagree
  // about the verdict rather than about whitespace. Refuse instead.
  return { ambiguous: true };
};

const checkBlocker = (blocker, index, problems) => {
  const where = `blocker #${index + 1}`;
  if (!isPlainObject(blocker)) {
    problems.push(`${where} is not an object — a blocker names a rule and a note.`);
    return;
  }

  if (!isText(blocker.rule)) {
    problems.push(
      `${where} names no \`rule\`: every blocker says what it violates — a checklist ` +
        'item, a required check by name, or the Definition-of-Done line that does not hold.',
    );
  }
  if (!isText(blocker.note)) {
    problems.push(`${where} names no \`note\`: what is wrong, in the author's terms.`);
  }

  const hasFile = blocker.file !== undefined && blocker.file !== null;
  const hasLine = blocker.line !== undefined && blocker.line !== null;

  if (hasFile && !isText(blocker.file)) {
    problems.push(`${where} has a \`file\` that is not a path.`);
  } else if (hasFile && !(Number.isInteger(blocker.line) && blocker.line >= 1)) {
    problems.push(
      `${where} names a \`file\` but no usable \`line\`: a location is a file AND the ` +
        'line inside it, so a reader lands where the finding is.',
    );
  } else if (hasLine && !hasFile) {
    problems.push(`${where} names a \`line\` but no \`file\`, so the line points nowhere.`);
  }
};

/**
 * Read a gate's report and decide whether it ended in a verdict.
 *
 * Returns `{ ok: true, verdict }` or `{ ok: false, problems }` — never both, and
 * never a throw: the input is a subagent's report, so malformed IS the expected
 * case and it has to arrive as an answer rather than as a crash.
 *
 * Every problem in the block is reported together. One per round would cost the
 * gate a round per problem, and `pr-ship` has a counted, finite number of them.
 */
export function parseVerdict(text) {
  const problems = [];
  if (typeof text !== 'string') {
    return { ok: false, problems: ['no report was supplied to read a verdict from.'] };
  }

  const block = lastJsonBlock(text);
  if (block === null) {
    return {
      ok: false,
      problems: [
        'the report carries no fenced ```json block, so it states no verdict this gate ' +
          'can act on. Every gate ends with exactly one.',
      ],
    };
  }
  if (block.ambiguous) {
    return {
      ok: false,
      problems: [
        'the final ```json block carries a ``` of its own, so where it ends is a guess — ' +
          'and the guesses disagree about the verdict, not about whitespace. Move the ' +
          'backticks out of the block (quote the snippet in the prose above it, or name ' +
          'it in `evidence`) and answer again.',
      ],
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(block.raw);
  } catch (error) {
    return {
      ok: false,
      problems: [`the final fenced json block is not JSON (${error?.message ?? 'parse failed'}).`],
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      problems: ['the final fenced json block is not an object naming a gate and a verdict.'],
    };
  }

  for (const key of Object.keys(parsed)) {
    if (!SHAPE_KEYS.includes(key)) {
      problems.push(
        `the block carries \`${key}\`, which this shape does not define. Refused rather ` +
          'than dropped: a silently ignored field is one the reviewer believes it reported.',
      );
    }
  }

  const gate = parsed.gate;
  if (!isText(gate)) {
    problems.push('the block names no `gate`, so nothing says which gate this verdict is from.');
  }

  const verdict = parsed.verdict;
  const known = typeof verdict === 'string' && VERDICT_WORDS.includes(verdict);
  if (!known) {
    problems.push(
      `\`${String(verdict)}\` is not a verdict any gate in this rulebook returns ` +
        `(${VERDICT_WORDS.join(', ')}).`,
    );
  } else if (isText(gate) && Object.hasOwn(GATE_VOCABULARY, gate)) {
    const allowed = GATE_VOCABULARY[gate];
    if (!allowed.includes(verdict)) {
      problems.push(
        `${gate} cannot return ${verdict} — that word belongs to another gate. It returns ` +
          `one of: ${allowed.join(', ')}.`,
      );
    }
  }

  const blockers = parsed.blockers;
  if (!Array.isArray(blockers)) {
    problems.push(
      'the block names no `blockers` list. It is required and may be empty; absent, a ' +
        'reader cannot tell "this gate found nothing" from "this gate did not say".',
    );
  } else {
    blockers.forEach((blocker, index) => checkBlocker(blocker, index, problems));

    if (known && BLOCKING_VERDICTS.includes(verdict) && blockers.length === 0) {
      problems.push(
        `${verdict} is a verdict that stops the change, and this one names no blocker. A ` +
          'stop nobody can act on is worse than no stop: the author has to guess what to ' +
          'fix, and the guess is usually "nothing".',
      );
    }
    if (known && !BLOCKING_VERDICTS.includes(verdict) && blockers.length > 0) {
      problems.push(
        `${verdict} means proceed, and this one lists ${blockers.length} blocker(s). Either ` +
          'the word or the list is wrong, and a pass carrying the reasons it should not ' +
          'have been one is the more expensive of the two to discover later.',
      );
    }
  }

  const advisories = parsed.advisories;
  if (advisories !== undefined && !Array.isArray(advisories)) {
    problems.push('`advisories` is not a list — it is optional, and a list when present.');
  }

  const evidence = parsed.evidence;
  if (evidence !== undefined) {
    if (!Array.isArray(evidence)) {
      problems.push('`evidence` is not a list of lines — it is optional, and a list when present.');
    } else if (!evidence.every((line) => typeof line === 'string')) {
      problems.push('`evidence` carries an entry that is not a line of text.');
    }
  }

  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    verdict: {
      gate,
      verdict,
      blockers,
      advisories: advisories ?? [],
      evidence: evidence ?? [],
    },
  };
}
