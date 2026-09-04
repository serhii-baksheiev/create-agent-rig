/**
 * The capability probe (RP-36): given a declaration, a harness adapter and
 * that surface's hook-wiring snapshot, what can this surface actually enforce?
 *
 * ONE active read of a snapshot the caller supplies. This module cannot fetch
 * one, which bounds what IT does — it does not, on its own, stop a caller
 * looping it, and the header of an earlier draft claimed otherwise. What
 * records the occasion of a probe is `./coverage.ts`, whose `coverageFromProbe`
 * requires a `ProbeTrigger` and refuses a word outside that vocabulary:
 * `policy-coverage.test.ts` › "refuses the trigger %j, because a probe is
 * occasioned by a change to the surface and by nothing else".
 *
 * The four answers, each pinned in `packages/cli/test/policy-coverage.test.ts`:
 *
 * | input | answer | pinned by |
 * | --- | --- | --- |
 * | a group naming exactly the declared tools and RUNNING the hook | `SUPPORTED` | › "reads %s as running the hook, because it is what the rig really ships" |
 * | the hook run under that event, but by no group naming exactly those tools | `DEGRADED` | › "reads a wiring that drops a declared tool as DEGRADED, naming the tool that is missing" |
 * | a readable snapshot that runs the hook nowhere under that event | `UNSUPPORTED` | › "reads a hook wired nowhere under the policy event as UNSUPPORTED, naming the hook path" |
 * | a snapshot, or any level of wiring under it, in a shape this module cannot read | `INTEGRATION-FAILED` | › "reports INTEGRATION-FAILED when %s, naming the event it could not read" |
 *
 * 🔴 The last two rows are a distinction, not a duplicate, and collapsing them
 * costs something in each direction. `rules/invariants.md` states the rule
 * under "Refusing to inspect is a third outcome": a field that is simply
 * ABSENT leaves nothing to judge, while a field PRESENT in an unreadable shape
 * is exactly the case worth reporting. Read as one, either an honest absence
 * becomes a false alarm or an unreadable surface becomes a quiet, uncounted
 * zero — the second being the shape a past guard here actually shipped. The
 * costly case is an unreadable element BESIDE a valid group, held by ›
 * "does not report SUPPORTED when an unreadable element sits beside a valid
 * group, because that is a partial read".
 *
 * Neither weak answer can pass silently: `./coverage.ts` › `qualifierFor` maps
 * both to `UNVERIFIABLE`, and `./decision-record.ts` refuses a record carrying
 * either state with an unqualified verdict — › "refuses the silent pass an
 * unwired surface would otherwise produce, and accepts it once qualifierFor
 * speaks".
 *
 * The rationale, including what this deliberately does not do, is
 * `docs/decisions/capability-coverage.md`.
 */

import type { HarnessAdapter, NativeHookSurface } from './adapter.js';
import type { PolicyDeclaration } from './declaration.js';
import type { CapabilityState } from './vocabulary.js';
import { isRecord, quote } from './validation.js';

/** One hook the surface runs; the command is the harness's own spelling. */
export interface HookEntry {
  command: string;
}

/** One matcher and the hooks the surface runs for it. */
export interface HookGroup {
  matcher?: string;
  hooks: readonly HookEntry[];
}

/** A surface's hook wiring, as the harness itself records it: event → groups. */
export interface HookSnapshot {
  hooks: Record<string, readonly HookGroup[] | undefined>;
}

export interface ProbeResult {
  state: CapabilityState;
  /**
   * Why the state is not `SUPPORTED`. Absent exactly when it is — ›
   * "reports no reason when the policy is supported, because there is nothing
   * to explain" — because an empty reason beside a weak state is how a
   * downgrade stops being evidence.
   */
  reason?: string;
}

/**
 * The longest hook command this module will parse.
 *
 * A command comes off a file on disk, and every line of work done on untrusted
 * input in a module whose callers fail open is a line that can be made
 * expensive (`rules/invariants.md`, "A guard that fails open must do provably
 * bounded work"). Past the cap the command is refused rather than parsed, and
 * a refusal reads `UNSUPPORTED` — the safe direction.
 *
 * The margin, measured rather than asserted over every wiring snapshot this
 * rig ships: the longest command in any of them is 131 bytes, so 4096 is ~31x
 * the longest. An earlier draft of
 * this comment claimed "two orders of magnitude", which was wrong by 3x and
 * which nothing checked — the cited test pins that the cap ADMITS the shipped
 * commands, not any ratio: › "states its command-length cap as a whole number,
 * and one that admits the commands the rig ships".
 */
export const MAX_HOOK_COMMAND_LENGTH = 4096;

/**
 * How many tool names a reason may list before it says "and N more".
 *
 * The names come out of the snapshot's own matcher, so an unbounded join is
 * both unbounded work and an unbounded string in an operator's terminal: ›
 * "keeps the reason short when a thousand tools are added, and says how many it
 * did not name".
 */
export const MAX_NAMED_TOOLS_IN_REASON = 5;

/** Shell punctuation that makes execution conditional, piped or commented out. */
const NOT_UNCONDITIONAL = /(\|\||;|#|\|(?!\|))/;

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

const unquote = (token: string): string => token.replace(/^["']|["']$/g, '');

/**
 * Split a segment into words the way a shell would for this purpose: on
 * whitespace, except inside quotes or a `$( )` substitution.
 *
 * A plain `split(/\s+/)` cannot read a command this rig actually ships. An
 * assignment whose value is a command substitution is ONE word whose value
 * happens to contain spaces, and splitting it into three makes the segment
 * look like an assignment followed by a command — which is exactly what the
 * rule below refuses. Pinned by the keep-green control ›
 * "still reads %s as running the hook, so the segment rule refuses nothing the
 * rig ships".
 *
 * One forward pass, one character at a time, with a depth counter that cannot
 * exceed the input length: the work is linear and the module's callers fail
 * open, so it may not be otherwise (`rules/invariants.md`, "A guard that fails
 * open must do provably bounded work").
 */
const wordsOf = (segment: string): string[] => {
  const words: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let depth = 0;
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index] ?? '';
    if (quote !== null) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === '$' && segment[index + 1] === '(') depth += 1;
    else if (character === ')' && depth > 0) depth -= 1;
    if (/\s/.test(character) && depth === 0) {
      if (current !== '') words.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (current !== '') words.push(current);
  return words;
};

/**
 * A word that backgrounds the command, so nothing waits for its exit code.
 *
 * A backgrounded hook returns to the harness immediately, so a
 * fail-closed guard never blocks the operation it was wired to judge — the
 * mechanism is neutered while the wiring still names it. Matching a trailing
 * `&` rather than any `&` is what keeps `2>&1` readable: › "still reads a
 * redirected hook that is not backgrounded as running the hook".
 */
const BACKGROUNDS = /&$/;

/**
 * The repo-relative path a token denotes, or `null` when it is rooted
 * somewhere this harness never roots its own hooks.
 *
 * `roots` comes from the adapter (`NativeHookSurface.hookRootVariables`).
 * Stripping ANY `$VAR/` collapsed every tree onto the same string, so a hook
 * rooted at an unrelated variable was indistinguishable from the repository's
 * own file and read SUPPORTED. Returning `null` for a root the harness does
 * not name is what makes that a refusal rather than a false pass.
 */
const asRepoRelative = (token: string, roots: readonly string[]): string | null => {
  const bare = unquote(token);
  const rooted = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?\/(.*)$/.exec(bare);
  if (rooted !== null) {
    const [, variable = '', rest = ''] = rooted;
    return roots.includes(variable) ? rest : null;
  }
  return bare.replace(/^\.\//, '');
};

/**
 * Does this command RUN the hook, rather than merely mention it?
 *
 * The distinction is the whole point. A substring read reports a `.bak` file,
 * an `echo`, a commented-out line, a path handed to a different program and a
 * vendored copy under another tree as enforcement — the direction that hands
 * back a false `SUPPORTED`, which is the one answer a capability contract must
 * never give on evidence it does not have. Every one of those is a case in ›
 * "reads %s as UNSUPPORTED, naming the hook path it looked for".
 *
 * The accepted shape is deliberately narrow, and every clause of it was paid
 * for by a measured false `SUPPORTED`:
 *
 * - no `||`, `;`, single `|` or `#` anywhere — execution must be unconditional;
 * - `&&`-joined segments, and every segment BEFORE the one that runs the hook
 *   must consist only of `NAME=value` assignments. Without that clause
 *   `false && node <hook>` and `[ -f /tmp/enable ] && node <hook>` read as
 *   enforcement, and so did a mention inside a quoted string: ›
 *   "reads %s before the hook as UNSUPPORTED, because that segment decides
 *   whether the hook runs at all";
 * - no word backgrounds the command;
 * - `node` is the executable word, flags are skipped, and the first remaining
 *   word EQUALS the hook path once quotes, a root this harness names, and a
 *   leading `./` are stripped.
 *
 * Anything else is refused rather than guessed at, and a refusal reads
 * `UNSUPPORTED` — the safe direction, because it understates what the surface
 * enforces. What it understates is written down: `/usr/bin/node <hook>` and
 * `pnpm node <hook>` are refused for naming an executable other than `node`,
 * and `cd "$D" && node <hook>` for a leading segment that is not an
 * assignment — › "reads a directory change before the hook as UNSUPPORTED,
 * understating a wiring that may well be real".
 */
const runs = (command: string, surface: NativeHookSurface): boolean => {
  if (command.length > MAX_HOOK_COMMAND_LENGTH) return false;
  if (NOT_UNCONDITIONAL.test(command)) return false;
  const segments = command.split('&&');
  for (let index = 0; index < segments.length; index += 1) {
    const words = wordsOf(segments[index] ?? '');
    if (words.some((word) => BACKGROUNDS.test(word))) return false;
    let cursor = 0;
    while (cursor < words.length && ASSIGNMENT.test(words[cursor] ?? '')) cursor += 1;
    if (unquote(words[cursor] ?? '') !== 'node') continue;
    // Everything ahead of the segment that runs the hook has to be an
    // assignment too: a segment that can fail is a segment that decides
    // whether the hook runs at all.
    const precededOnlyByAssignments = segments.slice(0, index).every((earlier) => {
      const earlierWords = wordsOf(earlier);
      return earlierWords.length > 0 && earlierWords.every((word) => ASSIGNMENT.test(word));
    });
    if (!precededOnlyByAssignments) return false;
    cursor += 1;
    while (cursor < words.length && (words[cursor] ?? '').startsWith('-')) cursor += 1;
    if (asRepoRelative(words[cursor] ?? '', surface.hookRootVariables) === surface.hookPath) {
      return true;
    }
  }
  return false;
};

const toolsOf = (matcher: string): string[] => matcher.split('|').filter((tool) => tool !== '');

const sameTools = (declared: readonly string[], wired: readonly string[]): boolean =>
  declared.length === wired.length && declared.every((tool) => wired.includes(tool));

/** What the declaration names and the wiring does not, and the reverse. */
const differenceOf = (declared: readonly string[], wired: readonly string[]) => ({
  missing: declared.filter((tool) => !wired.includes(tool)),
  extra: wired.filter((tool) => !declared.includes(tool)),
});

/**
 * Name a bounded number of tools, each escaped.
 *
 * Both properties are required of a string assembled from a matcher that came
 * off disk: bounded, or one probe produces a megabyte of diagnostic; escaped,
 * or a segment carrying a newline and an ANSI sequence forges a line of the
 * report it appears in. Held by › "escapes a tool name carrying a newline and
 * an ANSI sequence, so a matcher cannot forge a line of the report".
 */
const names = (tools: readonly string[]): string => {
  const shown = tools.slice(0, MAX_NAMED_TOOLS_IN_REASON).map(quote).join(', ');
  const unnamed = tools.length - MAX_NAMED_TOOLS_IN_REASON;
  return unnamed > 0 ? `${shown}, and ${String(unnamed)} more` : shown;
};

const describeDifference = (missing: readonly string[], extra: readonly string[]): string => {
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`does not cover ${names(missing)}`);
  if (extra.length > 0) parts.push(`also covers ${names(extra)}, which the policy does not`);
  return parts.join('; ');
};

const unreadable = (what: string): ProbeResult => ({
  state: 'INTEGRATION-FAILED',
  reason: `the surface snapshot could not be read: ${what}`,
});

/**
 * Probe one policy against one surface's snapshot. Pure: the snapshot is the
 * caller's to obtain, and `snapshot` is `unknown` on purpose — the shape is
 * checked at every level rather than trusted, because a surface file is
 * outside data and a level silently skipped is a partial read reported as a
 * whole one.
 */
export function probePolicy(
  policy: PolicyDeclaration,
  adapter: HarnessAdapter,
  snapshot: unknown,
): ProbeResult {
  if (!isRecord(snapshot)) {
    return unreadable('it is not an object carrying a hooks field');
  }
  if ('hooks' in snapshot && !isRecord(snapshot.hooks)) {
    return unreadable('its hooks field is not an object of event names');
  }

  const surface = adapter.nativeSurfaceOf(policy);
  const wiring = isRecord(snapshot.hooks) ? snapshot.hooks : {};

  // An event that is ABSENT contributes no groups and is not a finding; an
  // event PRESENT in a shape this cannot read is the finding.
  const groups: HookGroup[] = [];
  if (surface.event in wiring) {
    const under = wiring[surface.event];
    if (!Array.isArray(under)) {
      return unreadable(`the value under ${surface.event} is not a list of groups`);
    }
    for (const group of under) {
      if (!isRecord(group)) {
        return unreadable(`a group under ${surface.event} is not an object`);
      }
      if (!Array.isArray(group.hooks)) {
        return unreadable(`the hooks of a group under ${surface.event} are not a list`);
      }
      const hooks: HookEntry[] = [];
      for (const hook of group.hooks) {
        if (!isRecord(hook) || typeof hook.command !== 'string') {
          return unreadable(`a hook under ${surface.event} has no readable command`);
        }
        hooks.push({ command: hook.command });
      }
      // The matcher is a level like any other, and it is the level the
      // SUPPORTED/DEGRADED decision is read from. Coercing a present-but-
      // unreadable one to `undefined` made it the EMPTY matcher, so an
      // unreadable group answered DEGRADED — a level skipped, reported as a
      // whole read. Absent stays absent; present-and-unreadable is a finding.
      if ('matcher' in group && typeof group.matcher !== 'string') {
        return unreadable(`the matcher of a group under ${surface.event} is not a string`);
      }
      groups.push({
        matcher: typeof group.matcher === 'string' ? group.matcher : undefined,
        hooks,
      });
    }
  }

  const declared = toolsOf(surface.matcher);
  const running = groups.filter((group) => group.hooks.some((hook) => runs(hook.command, surface)));

  if (running.length === 0) {
    return {
      state: 'UNSUPPORTED',
      reason: `no group under ${surface.event} runs ${surface.hookPath}, so the mechanism is absent on this surface`,
    };
  }
  if (running.some((group) => sameTools(declared, toolsOf(group.matcher ?? '')))) {
    return { state: 'SUPPORTED' };
  }

  // Every group running the hook differs from the declaration; report the
  // closest one, so the reason names a real discrepancy rather than a union of
  // several. "Closest" is the fewest tools out of place.
  const differences = running.map((group) => differenceOf(declared, toolsOf(group.matcher ?? '')));
  const sizeOf = (d: { missing: string[]; extra: string[] }): number =>
    d.missing.length + d.extra.length;
  const closest = differences.reduce((best, d) => (sizeOf(d) < sizeOf(best) ? d : best));
  return {
    state: 'DEGRADED',
    reason: `${surface.hookPath} runs under ${surface.event}, but the matcher ${describeDifference(closest.missing, closest.extra)}`,
  };
}
