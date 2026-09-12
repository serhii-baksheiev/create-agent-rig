// SessionStart hook (Claude Code): says out loud when this session's
// environment voids the pinned subagent routing.
//
// The pins live in each agent definition (`model:`, `effort:`) and in the
// shipped settings (`env.CLAUDE_CODE_SUBAGENT_MODEL`). Three conditions make them
// not apply, and none of them is visible from inside the rulebook:
// - CLAUDE_CODE_SUBAGENT_MODEL_FORCE is set: Claude Code applies one model to
//   every subagent and ignores each definition's `model:` (its 2.1.257 changelog);
// - CLAUDE_CODE_EFFORT_LEVEL is set: it takes precedence over the effort
//   settings, so a definition's `effort:` is not the effort the gate runs at;
// - Claude Code is older than MINIMUM_CLAUDE_CODE_VERSION: until 2.1.251,
//   CLAUDE_CODE_SUBAGENT_MODEL overrode an agent definition's `model:` (its
//   2.1.251 changelog), so the shipped unnamed default replaced every pin.
//
// The version is read from AI_AGENT, which Claude Code sets for its subprocesses
// (its 2.1.120 changelog). The value's shape,
// `claude-code_<major>-<minor>-<patch>_<role>`, is observed on 2.1.269 and not
// documented — so a value this hook cannot parse is reported as an unknown
// version, never taken for a supported one.
//
// It warns and never blocks: exit 0 always, the warning on stdout, which Claude
// Code adds to the session's context at SessionStart. An empty variable counts
// as unset. The rationale is docs/decisions/subagent-routing.md.
//
// Pinned in the generator's test/template/subagent-routing-hooks.test.ts
// (absent in a generated rig) › "warns when %s is set, and never blocks the
// session", › "warns on a Claude Code older than 2.1.251 and names the minimum"
// and › "warns that it could not determine the version when %s".
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readHookInput } from './lib/hook-input.mjs';

/** The first Claude Code release in which an agent definition's `model:` outranks the env default. */
export const MINIMUM_CLAUDE_CODE_VERSION = '2.1.251';

const VOIDING_VARIABLES = [
  [
    'CLAUDE_CODE_SUBAGENT_MODEL_FORCE',
    "puts every subagent on one model and ignores each agent definition's `model:`",
  ],
  [
    'CLAUDE_CODE_EFFORT_LEVEL',
    "takes precedence over the effort settings, so an agent definition's `effort:` is not the effort a gate runs at",
  ],
];

const VERSION = /^claude-code_(\d{1,6})-(\d{1,6})-(\d{1,6})(?:_|$)/;

const numbers = (version) => version.split('.').map(Number);

const olderThan = (found, minimum) => {
  for (let index = 0; index < minimum.length; index += 1) {
    if (found[index] !== minimum[index]) return found[index] < minimum[index];
  }
  return false;
};

/** Every routing problem this environment has, as sentences; empty when there is none. */
export function routingProblems(env) {
  const problems = [];
  for (const [variable, effect] of VOIDING_VARIABLES) {
    const value = env[variable];
    if (typeof value === 'string' && value !== '') {
      problems.push(`${variable} is set: it ${effect}. Unset it for the pins to apply.`);
    }
  }
  const agent = typeof env.AI_AGENT === 'string' ? VERSION.exec(env.AI_AGENT) : null;
  if (agent === null) {
    problems.push(
      `could not determine the Claude Code version from AI_AGENT, so the pins cannot be ` +
        `confirmed to apply: they need Claude Code ${MINIMUM_CLAUDE_CODE_VERSION} or later.`,
    );
  } else {
    const found = [Number(agent[1]), Number(agent[2]), Number(agent[3])];
    if (olderThan(found, numbers(MINIMUM_CLAUDE_CODE_VERSION))) {
      problems.push(
        `Claude Code ${found.join('.')} is older than ${MINIMUM_CLAUDE_CODE_VERSION}: before it, ` +
          "CLAUDE_CODE_SUBAGENT_MODEL overrides every agent definition's `model:`. Upgrade Claude Code.",
      );
    }
  }
  return problems;
}

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
  try {
    const input = readHookInput();
    if (input === null || input.hook_event_name !== 'SessionStart') return 0;
    const problems = routingProblems(process.env);
    if (problems.length === 0) return 0;
    process.stdout.write(
      '[agent-os] WARNING — the pinned subagent routing is not in force in this session:\n' +
        problems.map((problem) => `- ${problem}`).join('\n') +
        '\nGates may run on a model or effort the routing policy did not choose ' +
        '(docs/decisions/subagent-routing.md).\n',
    );
  } catch {
    // a broken warning must never make the session unusable
  }
  return 0;
}

if (invokedDirectly()) {
  process.exit(main());
}
