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
 * | a group naming exactly the declared tools and RUNNING the hook | `SUPPORTED` | › "reads the real %s command as running the hook, because it is what the rig really ships" |
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
 * costly case is an element BESIDE a valid group whose STRUCTURE cannot be
 * read, held by › "does not report SUPPORTED when an unreadable element sits
 * beside a valid group, because that is a partial read". ⚠ That is the
 * structural level only. A readable command that merely names the hook in an
 * unverified spelling does NOT outrank a group carrying the generated command:
 * a hook list is conjunctive, so an entry the probe could not verify cannot
 * un-run one it did verify, and the surface reads `SUPPORTED`.
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

/**
 * One hook entry as the surface records it.
 *
 * The fields are kept as read, because a harness may run MORE THAN ONE command
 * per hook — a different spelling per platform — and which fields those are is
 * the adapter's to say (`NativeHookSurface.commands`). Reading one and ignoring
 * the rest is a false `SUPPORTED`.
 */
export type HookEntry = Readonly<Record<string, string>>;

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
 * bounded work"). Past the cap the command is not read at all, and the refusal
 * reads `INTEGRATION-FAILED` — not `UNSUPPORTED`, because a command nobody
 * looked at is not evidence that the mechanism is absent. An earlier version of
 * this sentence said the opposite of the code, which is the sentence a
 * maintainer would read before "simplifying" the branch back into the silent
 * absence this design removed: › "refuses a command one byte over the cap
 * rather than reading it, even though it names no hook".
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

/** One horizontal tab, named so no source line carries an invisible one. */
const TAB = String.fromCharCode(9);

/**
 * The command as a shell would word it, for comparison only.
 *
 * Runs of spaces and tabs collapse to one space, and a single leading or
 * trailing space is then dropped. Those two are the whole tolerance — stated
 * together because an omitted one is as misleading as an invented one, and the
 * trim was missing from the first version of this paragraph. Space and tab are
 * the only default IFS
 * characters that separate WORDS without separating COMMANDS. A newline does
 * separate commands — `node` on one line and the hook path on the next is two
 * commands, the second executing the hook file directly — so collapsing it
 * would manufacture a match against the generated string and hand back the one
 * answer this module must never give without evidence. The same holds for
 * carriage return, vertical tab, form feed and a non-breaking space, none of
 * which a shell splits words on at all.
 *
 * Pinned in `packages/cli/test/policy-coverage.test.ts` (absent in a generated
 * rig) › "still reads a %s wiring with %s as SUPPORTED, because a shell
 * separates words on both" and, in the other direction, › "refuses a %s wiring
 * whose spaces became %s, because a shell does not separate words on it".
 */
const normalise = (command: string): string =>
  // The tab is split out rather than matched: a literal tab inside a character
  // class is a control character to a regular expression, which `no-control-regex`
  // refuses - and rightly, because it is invisible to a reader.
  command.split(TAB).join(' ').replace(/ +/g, ' ').replace(/^ | $/g, '');

/**
 * What one hook entry is, with respect to the policy being probed — and, when
 * it cannot be read, WHY.
 *
 * The cause travels with the answer rather than being re-derived from a
 * boolean later. It was re-derived once, and the over-cap branch then reported
 * that something had named the hook path when nothing had: a refusal that
 * states a cause which did not occur is worse than a bare one, because an
 * operator goes looking for a mention that is not in the file.
 */
type CommandKind =
  { kind: 'runs' } | { kind: 'unrelated' } | { kind: 'unreadable'; cause: 'oversize' | 'spelling' };

/**
 * Classify one hook entry by comparing every command the harness generates for
 * this hook against the field it belongs to — never by parsing any of them.
 *
 * 🔴 This replaced a partial shell parser, and the reason is worth keeping
 * because it was expensive to learn. Three gate rounds tried to decide "does
 * this command execute the hook?" by reading shell syntax. Each round closed a
 * class of false `SUPPORTED` and opened a new one: a `.bak` neighbour, then a
 * conditional `&&` segment, then a quoted mention the splitter cut through,
 * then an unterminated quote, a mismatched brace, a backgrounding `&` on a
 * later segment, and finally an assignment whose command substitution can fail
 * — which cannot be refused, because it is the shape this rig's own derived
 * command uses. The input surface was the whole shell grammar and the error
 * was asymmetric, so a partial parser could not win.
 *
 * The rig GENERATES its own wiring, so the probe compares against what it
 * would generate. There is no grammar left to lose to.
 *
 * EVERY declared field must match, because a surface can run a different
 * spelling per platform: reading only the first left a guard that had been
 * replaced on one platform reading as enforced on all of them.
 *
 * The substring test survives, and its FAILURE DIRECTION is what makes that
 * safe: it now only chooses between `INTEGRATION-FAILED` and `UNSUPPORTED` —
 * two non-passing answers — so a false positive can no longer reach
 * `SUPPORTED`. That inversion is the design: › "never reaches SUPPORTED from a
 * mere mention of the hook path, whichever spelling the mention takes".
 *
 * ⚠ What it costs, stated because it is a real loss: a hand-written wiring
 * that genuinely runs the hook — a bare `node <hookPath>`, a flag before the
 * path, a different spelling of the same variable — is `INTEGRATION-FAILED`
 * rather than `SUPPORTED`. That is "I cannot verify this" in place of a
 * confident answer, which is the direction this contract is required to err
 * in, but a rig wiring its hooks by hand will read as unverifiable.
 *
 * Over the length cap a command is not read at all: refusing to inspect is a
 * third outcome, and a guard that did not look may not report that it found
 * nothing (`rules/invariants.md`, "Refusing to inspect is a third outcome, not
 * a match and not an error").
 */
const classify = (entry: HookEntry, surface: NativeHookSurface): CommandKind => {
  const fields = Object.keys(surface.commands);
  let matched = true;
  let mentions = false;
  for (const field of fields) {
    const wired = entry[field] ?? '';
    if (wired.length > MAX_HOOK_COMMAND_LENGTH) return { kind: 'unreadable', cause: 'oversize' };
    const generated = surface.commands[field] ?? [];
    if (!generated.some((spelling) => normalise(spelling) === normalise(wired))) matched = false;
    if (wired.includes(surface.hookPath)) mentions = true;
  }
  if (matched) return { kind: 'runs' };
  return mentions ? { kind: 'unreadable', cause: 'spelling' } : { kind: 'unrelated' };
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
        if (!isRecord(hook)) {
          return unreadable(`a hook under ${surface.event} is not an object`);
        }
        // Every field this harness generates a command for has to be there and
        // be a string. An absent one is not an honest absence: the harness
        // writes them all, so a hook missing one is a wiring this module
        // cannot vouch for on the platform that field serves.
        const entry: Record<string, string> = {};
        for (const field of Object.keys(surface.commands)) {
          const wired = hook[field];
          if (typeof wired !== 'string') {
            return unreadable(`a hook under ${surface.event} has no readable ${field}`);
          }
          entry[field] = wired;
        }
        hooks.push(entry);
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

  // One pass, three kinds. Whether anything merely NAMED the hook is carried
  // across groups, because that is what separates "nothing here wires this"
  // from "something here names it and I cannot verify that it runs" — the
  // ABSENT/UNREADABLE pair this module keeps at every other level.
  const running: HookGroup[] = [];
  const refusals = new Set<'oversize' | 'spelling'>();
  for (const group of groups) {
    let runsHere = false;
    for (const hook of group.hooks) {
      const kind = classify(hook, surface);
      if (kind.kind === 'runs') runsHere = true;
      else if (kind.kind === 'unreadable') refusals.add(kind.cause);
    }
    if (runsHere) running.push(group);
  }

  if (running.length === 0) {
    // A cause that really happened, chosen from what was observed. The
    // spelling case is the more informative of the two, so it wins when both
    // occurred; the over-cap case must never borrow its sentence, because
    // nothing named anything in a command that was not read.
    if (refusals.has('spelling')) {
      return {
        state: 'INTEGRATION-FAILED',
        reason: `something under ${surface.event} names ${surface.hookPath}, but in no command this harness generates, so whether the hook runs cannot be verified from this surface`,
      };
    }
    if (refusals.has('oversize')) {
      return {
        state: 'INTEGRATION-FAILED',
        reason: `a command under ${surface.event} is longer than ${String(MAX_HOOK_COMMAND_LENGTH)} characters and was not read, so whether ${surface.hookPath} runs cannot be verified from this surface`,
      };
    }
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
