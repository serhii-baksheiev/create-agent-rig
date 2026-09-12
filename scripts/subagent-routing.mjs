// The one subagent routing policy for both harnesses: which model and effort
// every named role runs on, and what an unnamed subagent defaults to.
//
// It is declared once, in `templates/agent-os/subagent-routing.json`. The Codex
// projection is DERIVED from it (`codexProfilesOf`, consumed by
// `sync-codex-adapter.mjs`), and the Claude surfaces — agent frontmatter and
// the shipped settings — are CHECKED against it, because those files are the
// authoring surface a generated project receives and edits.
//
// Every validator reports all of its problems in one Error, so a policy edit is
// fixed in one pass rather than one refusal at a time. Pinned in
// test/template/subagent-routing.test.ts › "reports every routing-policy
// problem in one error rather than stopping at the first".
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const ROUTING_POLICY_PATH = path.join(
  repoRoot,
  'templates',
  'agent-os',
  'subagent-routing.json',
);

/** The effort levels a Claude Code agent definition may carry. */
export const CLAUDE_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * Environment variables that void the pins when set: the first ignores every
 * agent definition's `model:`, the second takes precedence over effort settings.
 * Shipped settings must never set them.
 */
export const FORBIDDEN_CLAUDE_ENV = Object.freeze([
  'CLAUDE_CODE_SUBAGENT_MODEL_FORCE',
  'CLAUDE_CODE_EFFORT_LEVEL',
]);

const HARNESSES = ['claude', 'codex'];
const POLICY_KEYS = ['claudeModels', 'unnamed', 'roles'];
const CLAUDE_ROUTE_KEYS = ['model', 'effort'];

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const throwIfAny = (problems) => {
  if (problems.length > 0) throw new Error(problems.join('\n'));
};

/** The closed shape of the policy file; returns the policy when it is valid. */
export function validateRoutingPolicy(policy) {
  if (!isRecord(policy)) throw new Error('routing policy is not an object');
  const problems = [];

  for (const key of Object.keys(policy)) {
    if (!POLICY_KEYS.includes(key)) problems.push(`routing policy has an unknown key: ${key}`);
  }

  const models = isRecord(policy.claudeModels) ? policy.claudeModels : {};
  if (Object.keys(models).length === 0) problems.push('routing policy declares no Claude models');
  for (const [model, efforts] of Object.entries(models)) {
    if (
      !Array.isArray(efforts) ||
      efforts.length === 0 ||
      efforts.some((effort) => !CLAUDE_EFFORTS.includes(effort))
    ) {
      problems.push(
        `routing policy gives Claude model ${model} efforts outside ${CLAUDE_EFFORTS.join(', ')}`,
      );
    }
  }
  const supports = (model, effort) =>
    Object.hasOwn(models, model) && Array.isArray(models[model]) && models[model].includes(effort);

  const unnamed = policy.unnamed;
  if (!isRecord(unnamed)) {
    problems.push('routing policy is missing its unnamed mapping');
  } else {
    for (const key of Object.keys(unnamed)) {
      if (!HARNESSES.includes(key))
        problems.push(`unnamed subagents name an unknown harness: ${key}`);
    }
    for (const harness of HARNESSES) {
      if (!isRecord(unnamed[harness])) {
        problems.push(`unnamed subagents are missing their ${harness} mapping`);
      }
    }
    const claude = unnamed.claude;
    if (isRecord(claude)) {
      // Claude Code has no setting that pins the effort of a subagent without a
      // definition: it runs at the session's effort. A value here would be a
      // policy claim nothing enforces.
      if (Object.hasOwn(claude, 'effort')) {
        problems.push('unnamed Claude subagents cannot pin an effort');
      }
      for (const key of Object.keys(claude)) {
        if (!CLAUDE_ROUTE_KEYS.includes(key)) {
          problems.push(`unnamed Claude subagents carry an unknown field: ${key}`);
        }
      }
      if (typeof claude.model !== 'string' || !Object.hasOwn(models, claude.model)) {
        problems.push(`unnamed Claude subagents name an unknown Claude model: ${claude.model}`);
      }
    }
  }

  const roles = policy.roles;
  if (!isRecord(roles) || Object.keys(roles).length === 0) {
    problems.push('routing policy declares no roles');
  } else {
    for (const [role, entry] of Object.entries(roles)) {
      if (!isRecord(entry)) {
        problems.push(`routing role ${role} is not an object`);
        continue;
      }
      for (const harness of HARNESSES) {
        if (!isRecord(entry[harness])) {
          problems.push(`routing role ${role} is missing its ${harness} mapping`);
        }
      }
      for (const key of Object.keys(entry)) {
        if (!HARNESSES.includes(key)) {
          problems.push(`routing role ${role} names an unknown harness: ${key}`);
        }
      }
      const claude = entry.claude;
      if (!isRecord(claude)) continue;
      for (const key of Object.keys(claude)) {
        if (!CLAUDE_ROUTE_KEYS.includes(key)) {
          problems.push(`routing role ${role} carries an unknown Claude field: ${key}`);
        }
      }
      if (typeof claude.model !== 'string' || !Object.hasOwn(models, claude.model)) {
        problems.push(`routing role ${role} pins an unknown Claude model: ${claude.model}`);
      } else if (!supports(claude.model, claude.effort)) {
        problems.push(
          `routing role ${role} pins effort ${claude.effort}, which ${claude.model} does not support`,
        );
      }
    }
  }

  throwIfAny(problems);
  return policy;
}

/** The Codex view of the policy, in the shape `validateAgentProfiles` reads. */
export function codexProfilesOf(policy) {
  return {
    default: policy.unnamed.codex,
    agents: Object.fromEntries(
      Object.entries(policy.roles).map(([role, entry]) => [role, entry.codex]),
    ),
  };
}

/**
 * Claude agent definitions, one per role, each pinning exactly the role's model
 * and effort. `agents` is `[{ name, source, model?, effort? }]` from frontmatter.
 */
export function validateClaudeAgents(policy, agents) {
  const problems = [];
  const seen = new Set();
  for (const agent of agents) {
    const { name, source } = agent;
    if (seen.has(name)) problems.push(`Claude agent ${name} is defined more than once: ${source}`);
    seen.add(name);
    const route = Object.hasOwn(policy.roles, name) ? policy.roles[name].claude : null;
    if (route === null) {
      problems.push(`Claude agent ${name} has no routing role: ${source}`);
      continue;
    }
    if (!agent.model) problems.push(`Claude agent ${name} is missing model: ${source}`);
    else if (agent.model !== route.model) {
      problems.push(
        `Claude agent ${name} pins model ${agent.model}, the routing policy says ${route.model}: ${source}`,
      );
    }
    if (!agent.effort) problems.push(`Claude agent ${name} is missing effort: ${source}`);
    else if (agent.effort !== route.effort) {
      problems.push(
        `Claude agent ${name} pins effort ${agent.effort}, the routing policy says ${route.effort}: ${source}`,
      );
    }
  }
  for (const role of Object.keys(policy.roles)) {
    if (!seen.has(role)) problems.push(`routing role ${role} has no Claude agent`);
  }
  throwIfAny(problems);
}

/** The shipped Claude settings: the unnamed default set, and nothing that voids the pins. */
export function validateClaudeSettings(policy, settings) {
  const problems = [];
  const env = isRecord(settings) && isRecord(settings.env) ? settings.env : {};
  const expected = policy.unnamed.claude.model;
  if (env.CLAUDE_CODE_SUBAGENT_MODEL !== expected) {
    problems.push(`Claude settings must set env.CLAUDE_CODE_SUBAGENT_MODEL to ${expected}`);
  }
  for (const variable of FORBIDDEN_CLAUDE_ENV) {
    if (Object.hasOwn(env, variable)) {
      problems.push(`Claude settings must not set env.${variable}: it voids the pinned routing`);
    }
  }
  throwIfAny(problems);
}
