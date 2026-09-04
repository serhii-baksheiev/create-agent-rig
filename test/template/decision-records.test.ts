import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universalDir = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const decisionsDir = path.join(universalDir, 'docs', 'decisions');

const rel = (p: string) => path.relative(repoRoot, p);

/**
 * AR-63 (second half, as re-scoped by the owner): the defect history and the
 * long rationale leave `.claude/skills/loop/SKILL.md` and `.claude/rules/*.md`
 * for `docs/decisions/<topic>.md`, and what stays behind is **the rule plus a
 * citation**.
 *
 * The records live under `templates/agent-os/universal/` — not in this repo's
 * root `docs/` — because `scripts/sync-agent-os.mjs` copies the universal layer
 * into both this repo and every generated project. A rule that cites
 * `docs/decisions/x.md` from a layer that does not ship the record is a dead
 * reference in every rig that installs it.
 *
 * What this file checks is the SHAPE of that arrangement, never its sentences:
 * which topics get a record, and how the split falls, is the implementer's
 * call. Deliberately absent, because the owner ruled them out of scope: any
 * token, byte or word budget for the files the rationale was cut out of.
 */

/** Every file under a directory, recursively, as absolute paths. */
async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const p = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(p) : Promise.resolve([p]);
    }),
  );
  return files.flat();
}

type Record_ = { name: string; file: string; content: string };

/**
 * The records themselves.
 *
 * Throws — rather than returning `[]` — when the directory is absent, so that
 * every check below is red while the records have no home. A citation check
 * that passes vacuously is the exact failure this file exists to prevent.
 */
async function decisionRecords(): Promise<Record_[]> {
  let names: string[];
  try {
    names = (await readdir(decisionsDir)).filter((n) => n.endsWith('.md'));
  } catch {
    throw new Error(
      `${rel(decisionsDir)}/ does not exist — the extracted rationale has nowhere to live`,
    );
  }
  return Promise.all(
    names.sort().map(async (name) => ({
      name,
      file: path.join(decisionsDir, name),
      content: await readFile(path.join(decisionsDir, name), 'utf8'),
    })),
  );
}

type Citation = { from: string; target: string };

/** Every `docs/decisions/<name>.md` reference in the universal layer. */
async function citations(): Promise<Citation[]> {
  const found: Citation[] = [];
  for (const file of await walk(universalDir)) {
    const content = await readFile(file, 'utf8');
    for (const m of content.matchAll(/docs\/decisions\/([A-Za-z0-9._-]+\.md)/g)) {
      found.push({ from: rel(file), target: m[1]! });
    }
  }
  return found;
}

describe('decision records travel with the layer that cites them', () => {
  it('ships at least one record under the universal layer', async () => {
    const records = await decisionRecords();
    expect(records.map((r) => r.name)).not.toEqual([]);
  });

  // A citation is the whole point of the extraction: the rule stays, the
  // reasoning moves, and the reader follows a pointer. A pointer to a file the
  // generated project never received is worse than the paragraph it replaced.
  it('cites no record that does not exist', async () => {
    const records = await decisionRecords();
    const present = new Set(records.map((r) => r.name));
    const dead = (await citations())
      .filter((c) => !present.has(c.target))
      .map((c) => `${c.from} cites docs/decisions/${c.target}, which does not exist`);
    expect(dead).toEqual([]);
  });

  // The other direction: rationale nobody points at is a dump, not extraction.
  // Only the rulebook counts as a citer — a record cross-referencing another
  // record keeps a detached pair alive without anything reaching either.
  it('keeps no record that the rulebook never points at', async () => {
    const records = await decisionRecords();
    const fromRulebook = (await citations()).filter((c) => {
      const claude = `${path.join('templates', 'agent-os', 'universal', '.claude')}${path.sep}`;
      const rootDoc = path.join('templates', 'agent-os', 'universal', 'CLAUDE.md');
      return c.from.startsWith(claude) || c.from === rootDoc;
    });
    const cited = new Set(fromRulebook.map((c) => c.target));
    const orphans = records
      .filter((r) => !cited.has(r.name))
      .map((r) => `docs/decisions/${r.name} is cited by no rule, skill or CLAUDE.md`);
    expect(orphans).toEqual([]);
  });

  it('opens every record with a level-1 heading that names it', async () => {
    const records = await decisionRecords();
    const unnamed = records
      .filter((r) => {
        const first = r.content.split('\n').find((line) => line.trim() !== '') ?? '';
        return !/^#\s+\S/.test(first);
      })
      .map((r) => `docs/decisions/${r.name} does not open with a "# ..." heading`);
    expect(unnamed).toEqual([]);
  });

  // The same domain that must not travel in a skill must not travel in the
  // rationale extracted out of one: these files ship to other people's machines.
  it('carries no absolute host or personal path in a record', async () => {
    const records = await decisionRecords();
    const forbidden: Array<[string, RegExp]> = [
      ['a Windows drive path', /[A-Z]:\//],
      ['a macOS home path', /\/Users\/[a-z]/i],
      ['a Linux home path', /\/home\/[a-z]/i],
    ];
    const leaks: string[] = [];
    for (const record of records) {
      for (const [what, re] of forbidden) {
        if (re.test(record.content)) leaks.push(`docs/decisions/${record.name}: ${what}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it('does not ship generator-only RP tracker keys or CLI paths in the capability-coverage record', async () => {
    const leaks: string[] = [];
    const record = (await decisionRecords()).find(
      (entry) => entry.name === 'capability-coverage.md',
    );
    if (record !== undefined) {
      const trackerKeys = [...record.content.matchAll(/\bRP-\d+\b/g)].map((match) => match[0]);
      for (const trackerKey of new Set(trackerKeys)) {
        leaks.push(`docs/decisions/${record.name}: generator tracker key ${trackerKey}`);
      }
      if (record.content.includes('packages/cli/')) {
        leaks.push(`docs/decisions/${record.name}: generator CLI implementation path`);
      }
    }

    expect(leaks).toEqual([]);
  });
});
