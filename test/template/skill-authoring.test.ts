// RP-195 slice 4: structural checks over every shipped skill, derived from
// what is on disk — never a hand-written list of skill names, so adding or
// renaming a skill cannot silently fall outside what this file checks.
//
// The mirror between the Claude skill tree (`.claude/skills/`) and the Codex
// repository-skill tree (`.agents/skills/`) — same directory set, byte-equal
// SKILL.md per skill — is already pinned in test/template/codex.test.ts ›
// "publishes every shared skill through the Codex repository skill location".
// That test is not duplicated here.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const agentOs = path.join(repoRoot, 'templates', 'agent-os');
const universal = path.join(agentOs, 'universal');
const claudeSkillsDir = path.join(universal, '.claude', 'skills');
const layersPath = path.join(universal, 'layers.json');
const routingPolicyPath = path.join(agentOs, 'subagent-routing.json');

function frontmatterOf(content: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  expect(match, 'a SKILL.md must start with YAML frontmatter').toBeTruthy();
  const fields: Record<string, string> = {};
  for (const line of match![1]!.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator > 0) {
      fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
  }
  return fields;
}

async function shippedSkillNames(): Promise<string[]> {
  return readdir(claudeSkillsDir);
}

async function skillContent(name: string): Promise<string> {
  return readFile(path.join(claudeSkillsDir, name, 'SKILL.md'), 'utf8');
}

describe('every shipped skill (universal) — checks derived from disk, not a hand-written list', () => {
  it('has a frontmatter `name` equal to its directory name, for every skill on disk', async () => {
    const skills = await shippedSkillNames();
    expect(skills.length).toBeGreaterThan(0);
    for (const skill of skills) {
      const fm = frontmatterOf(await skillContent(skill));
      expect(fm['name'], `${skill}/SKILL.md frontmatter name`).toBe(skill);
    }
  });

  it('has a non-empty `description`, for every skill on disk', async () => {
    const skills = await shippedSkillNames();
    for (const skill of skills) {
      const fm = frontmatterOf(await skillContent(skill));
      expect(fm['description'], `${skill}/SKILL.md description`).toBeTruthy();
      expect(
        fm['description']!.trim().length,
        `${skill}/SKILL.md description is blank`,
      ).toBeGreaterThan(0);
    }
  });

  // Check 3 — "every skill directory exists in both trees" — is the exact
  // assertion test/template/codex.test.ts › "publishes every shared skill
  // through the Codex repository skill location" already makes (directory-set
  // equality plus byte-for-byte SKILL.md equality). RP-177 retired the
  // per-stack overlays, so `universal` is sync's only layer and there is no
  // second layer left for this file to check. Not duplicated here.

  it('resolves every "the `<name>` skill" cross-reference to a shipped skill directory', async () => {
    const skills = new Set(await shippedSkillNames());
    const referenced = new Set<string>();
    for (const skill of skills) {
      const content = await skillContent(skill);
      for (const match of content.matchAll(/the `([a-zA-Z0-9_-]+)` skill/g)) {
        referenced.add(match[1]!);
      }
    }
    // this only pins something once at least one skill names another this way
    expect(referenced.size).toBeGreaterThan(0);
    for (const name of referenced) {
      expect(
        skills,
        `"the \`${name}\` skill" is referenced but no skill directory named "${name}" is shipped`,
      ).toContain(name);
    }
  });

  it('names only a routing role when it dispatches an agent by backticked *-reviewer/-writer/-agent/-scanner/-diagnostician name', async () => {
    const policy = JSON.parse(await readFile(routingPolicyPath, 'utf8')) as {
      roles?: Record<string, unknown>;
    };
    const roles = new Set(Object.keys(policy.roles ?? {}));
    expect(roles.size).toBeGreaterThan(0);

    const skills = await shippedSkillNames();
    const named = new Set<string>();
    const rolePattern = /`([a-zA-Z0-9]+-(?:reviewer|writer|agent|scanner|diagnostician))`/g;
    for (const skill of skills) {
      const content = await skillContent(skill);
      for (const match of content.matchAll(rolePattern)) named.add(match[1]!);
    }
    expect(named.size).toBeGreaterThan(0);
    for (const name of named) {
      expect(
        roles,
        `\`${name}\` is dispatched by a skill but has no role in templates/agent-os/subagent-routing.json`,
      ).toContain(name);
    }
  });
});

// RP-195 slice 4's own deliverable: the skill-authoring skill. It does not
// exist yet — every assertion in this block is expected to fail until the
// Green step adds it.
describe('skill-authoring skill (universal, Core) — RP-195 slice 4', () => {
  const skillRel = path.join('.claude', 'skills', 'skill-authoring', 'SKILL.md');
  const mirrorRel = path.join('.agents', 'skills', 'skill-authoring', 'SKILL.md');
  const readSkill = () => readFile(path.join(universal, skillRel), 'utf8');

  it('exists in the Claude skill tree', async () => {
    await expect(readSkill()).resolves.toBeTruthy();
  });

  it('is declared in the process layer of layers.json, both the .claude and .agents copies', async () => {
    const layers = JSON.parse(await readFile(layersPath, 'utf8')) as {
      process?: string[];
    };
    const process_ = layers.process ?? [];
    expect(process_, skillRel).toContain(slashed(skillRel));
    expect(process_, mirrorRel).toContain(slashed(mirrorRel));
  });

  // Being named in the reader-facing skill map of AGENTS.md is already
  // required, generically, by test/template/init-layer.test.ts › "names every
  // skill it installs in the map it hands the reader" once this skill ships
  // in the process layer — not duplicated here.

  it('names this test file as where its structural checks live', async () => {
    const content = await readSkill();
    expect(content).toContain('test/template/skill-authoring.test.ts');
  });
});

function slashed(rel: string): string {
  return rel.split(path.sep).join('/');
}
