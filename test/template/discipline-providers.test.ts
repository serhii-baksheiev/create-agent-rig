import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * RP-316. Two external discipline providers can sit beside a Rig install:
 * Probity (`@nizos/probity`, a PreToolUse hook some projects wire in) and
 * Superpowers (`obra/superpowers`, a Claude Code plugin). Neither is
 * installed by Rig. This file pins the three claims that let them coexist
 * without Rig quietly treating either one's observation as its own verdict:
 *
 * 1. no gate/verdict file the template ships reads either provider's name —
 *    the loop stays the one authoritative scheduler regardless of what else
 *    is wired into the harness (may already hold; that is the point — this
 *    pins the boundary, it does not newly create it);
 * 2. the retired Mechanical TDD mechanism (RP-398) has not grown a second
 *    "tdd"-named file, and the two presets that need no TDD provider at all
 *    (`minimal`, `sdd`) do not list `probity` as an integration (may already
 *    hold, for the same reason);
 * 3. `docs/decisions/discipline-providers.md` exists, carries the
 *    "not synced" banner, stays out of the templates tree, and states the
 *    specific facts this coexistence rests on (does not hold yet — the
 *    record does not exist);
 * 4. `docs/compatibility.md` carries the rows this record implies about
 *    Superpowers' orchestration skills inside a Rig loop run, and about an
 *    attended session running Superpowers alongside Rig (does not hold yet
 *    — the rows do not exist).
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universalDir = path.join(repoRoot, 'templates', 'agent-os', 'universal');

// --- small helpers -----------------------------------------------------

const readRepoFile = (relPath: string): string =>
  readFileSync(path.join(repoRoot, relPath), 'utf8');

const repoPathExists = (relPath: string): boolean => existsSync(path.join(repoRoot, relPath));

/** Every file under `dir`, recursive, following no symlink. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** Paragraphs of a markdown document, split on blank lines. */
const paragraphsOf = (markdown: string): string[] =>
  markdown
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== '');

/**
 * The text of the first markdown section (any heading level) whose heading
 * line contains `keyword` (case-insensitive), up to the next heading of the
 * same level or shallower. Returns '' when no such heading exists.
 */
function sectionByHeading(markdown: string, keyword: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const headingRe = /^(#{1,6})\s+(.*)$/;
  let startLine = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = headingRe.exec(lines[i]!);
    if (m && m[2]!.toLowerCase().includes(keyword.toLowerCase())) {
      startLine = i;
      level = m[1]!.length;
      break;
    }
  }
  if (startLine === -1) return '';
  let endLine = lines.length;
  for (let i = startLine + 1; i < lines.length; i++) {
    const m = headingRe.exec(lines[i]!);
    if (m && m[1]!.length <= level) {
      endLine = i;
      break;
    }
  }
  return lines.slice(startLine, endLine).join('\n');
}

/** Every backticked span in the text. */
const backtickedSpans = (text: string): string[] =>
  [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);

/** Minimal pipe-table row parser: one row's cells, lower-cased headers. */
function tableRows(markdown: string): Array<{ line: number; cells: Record<string, string> }> {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const splitRow = (line: string): string[] =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());
  const rows: Array<{ line: number; cells: Record<string, string> }> = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i]!.startsWith('|') || !/^\|[\s:|-]+\|$/.test(lines[i + 1]!.trim())) continue;
    const headers = splitRow(lines[i]!).map((h) => h.toLowerCase());
    let j = i + 2;
    for (; j < lines.length && lines[j]!.startsWith('|'); j++) {
      const cells = splitRow(lines[j]!);
      rows.push({
        line: j + 1,
        cells: Object.fromEntries(headers.map((h, k) => [h, cells[k] ?? ''])),
      });
    }
    i = j;
  }
  return rows;
}

// --- 1. provider observations never reach the Rig verdict machinery ----

describe('provider observations never reach the Rig verdict machinery (RP-316)', () => {
  const GATE_FILE_CANDIDATES = [
    '.claude/scripts/verdict.mjs',
    '.claude/scripts/lib/verdict.mjs',
    '.claude/scripts/lib/gate-coverage.mjs',
    '.claude/scripts/revalidate.mjs',
    '.claude/scripts/queue/core.mjs',
    '.claude/scripts/decision-router.mjs',
  ];
  const GATE_FILES = GATE_FILE_CANDIDATES.filter((f) => existsSync(path.join(universalDir, f)));
  const MISSING = GATE_FILE_CANDIDATES.filter((f) => !GATE_FILES.includes(f));

  it('every candidate gate/verdict file exists in the shipped template (none dropped)', () => {
    // If this ever fails, the dropped paths are named here rather than
    // silently shrinking the it.each list below.
    expect(MISSING, `dropped (do not exist): ${MISSING.join(', ')}`).toEqual([]);
  });

  it.each(GATE_FILES)('%s names neither provider — the loop stays the one scheduler', (relFile) => {
    const content = readFileSync(path.join(universalDir, relFile), 'utf8');
    expect(content).not.toMatch(/probity/i);
    expect(content).not.toMatch(/superpowers/i);
  });
});

// --- 2. no second TDD framework -----------------------------------------

describe('no second TDD framework (RP-316)', () => {
  it('no file under .claude/scripts/ or .claude/hooks/ in the shipped template has a name matching /tdd/i', () => {
    const scanDirs = [
      path.join(universalDir, '.claude', 'scripts'),
      path.join(universalDir, '.claude', 'hooks'),
    ].filter((d) => existsSync(d));
    expect(scanDirs.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const dir of scanDirs) {
      for (const file of walk(dir)) {
        if (/tdd/i.test(path.basename(file))) {
          offenders.push(path.relative(repoRoot, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('presets "minimal" and "sdd" in templates/agent-os/profiles.json list no "probity" integration', () => {
    const profiles = JSON.parse(
      readRepoFile(path.join('templates', 'agent-os', 'profiles.json')),
    ) as {
      presets: Record<string, { integrations: string[] }>;
    };
    for (const presetName of ['minimal', 'sdd']) {
      const preset = profiles.presets[presetName];
      expect(preset, `preset "${presetName}" does not exist`).toBeDefined();
      expect(preset!.integrations).not.toContain('probity');
    }
  });
});

// --- 3. the decision record ----------------------------------------------

describe('docs/decisions/discipline-providers.md (RP-316)', () => {
  const DOC_PATH = path.join('docs', 'decisions', 'discipline-providers.md');

  it('exists and carries the "This record is not synced" banner', () => {
    expect(repoPathExists(DOC_PATH), `${DOC_PATH} does not exist yet`).toBe(true);
    const doc = readRepoFile(DOC_PATH);
    expect(doc).toContain('This record is not synced');
  });

  it('is absent from templates/agent-os/universal/docs/decisions/ — it never ships into a rig', () => {
    const synced = path.join(
      'templates',
      'agent-os',
      'universal',
      'docs',
      'decisions',
      'discipline-providers.md',
    );
    expect(repoPathExists(synced)).toBe(false);
  });

  it('states one authoritative loop/scheduler', () => {
    const doc = readRepoFile(DOC_PATH);
    expect(doc).toMatch(/\bone (loop|scheduler)\b/i);
    expect(doc).toMatch(/authoritative/i);
  });

  it("states that Probity's block is a permission decision, never a Rig verdict, in one paragraph", () => {
    const doc = readRepoFile(DOC_PATH);
    const hit = paragraphsOf(doc).some(
      (p) => p.includes('permissionDecision') && /\bnever\b/i.test(p) && /\bverdict\b/i.test(p),
    );
    expect(hit, 'no single paragraph carries permissionDecision + never + verdict').toBe(true);
  });

  it('states that no Probity evidence kind is defined, and why', () => {
    const doc = readRepoFile(DOC_PATH);
    expect(doc).toContain('--debug');
    expect(doc).toMatch(/undocumented/i);
    expect(doc).toMatch(/hook payload/i);
  });

  it('names the Superpowers orchestration skills as unsupported inside a Rig loop run, and says per-skill disabling does not exist', () => {
    const doc = readRepoFile(DOC_PATH);
    for (const skill of [
      'subagent-driven-development',
      'dispatching-parallel-agents',
      'executing-plans',
    ]) {
      expect(doc).toContain(skill);
    }
    expect(doc).toMatch(/unsupported/i);
    expect(doc).toMatch(/\brig loop run\b/i);
    expect(doc).toContain('per-skill');
  });

  it('states harness limits: names both Claude Code and Codex, and says Superpowers on Codex is unverified in the Superpowers section', () => {
    const doc = readRepoFile(DOC_PATH);
    expect(doc).toContain('Claude Code');
    expect(doc).toContain('Codex');
    const section = sectionByHeading(doc, 'superpowers');
    expect(section, 'no heading containing "superpowers" found').not.toBe('');
    expect(section).toContain('Codex');
    expect(section).toMatch(/unverified/i);
  });

  it('the TDD retrospective defers measurement to RP-320, and says RP-302 is not restored', () => {
    const doc = readRepoFile(DOC_PATH);
    expect(doc).toContain('RP-320');
    expect(doc).toMatch(/not measured|unmeasured/i);
    expect(doc).toContain('RP-302');
  });

  it('every docs/… or test/… path cited in backticks exists in the repo', () => {
    const doc = readRepoFile(DOC_PATH);
    const candidates = backtickedSpans(doc).filter(
      (span) => /^(docs|test)\//.test(span) && !span.includes('<') && !span.includes('*'),
    );
    expect(
      candidates.length,
      'no docs/… or test/… path cited at all — nothing to check',
    ).toBeGreaterThan(0);
    const dead = candidates.filter((p) => !repoPathExists(p));
    expect(dead, 'cited paths that do not exist').toEqual([]);
  });
});

// --- 4. docs/compatibility.md rows ---------------------------------------

describe('docs/compatibility.md Superpowers rows (RP-316)', () => {
  const COMPAT_PATH = path.join('docs', 'compatibility.md');

  it('keeps the existing "Superpowers in the default/product profile" row UNSUPPORTED', () => {
    const doc = readRepoFile(COMPAT_PATH);
    const row = tableRows(doc).find((r) =>
      Object.values(r.cells).some((c) => c.includes('Superpowers in the default/product profile')),
    );
    expect(row, 'the existing row no longer exists').toBeDefined();
    expect(Object.values(row!.cells)).toContain('UNSUPPORTED');
  });

  it('adds a row for Superpowers orchestration skills inside a Rig loop run: UNSUPPORTED, citing the decision record', () => {
    const doc = readRepoFile(COMPAT_PATH);
    const row = tableRows(doc).find((r) => {
      const capability = (r.cells.capability ?? '').toLowerCase();
      return (
        capability.includes('superpowers') &&
        capability.includes('orchestration') &&
        capability.includes('rig loop run')
      );
    });
    expect(row, 'no row for Superpowers orchestration skills inside a Rig loop run').toBeDefined();
    expect(Object.values(row!.cells)).toContain('UNSUPPORTED');
    const cited = Object.values(row!.cells).some((c) => c.includes('discipline-providers.md'));
    expect(cited, 'row does not cite docs/decisions/discipline-providers.md').toBe(true);
  });

  it('adds a row for Superpowers installed alongside an attended Rig session (orthogonal skills): UNVERIFIED, citing the decision record', () => {
    const doc = readRepoFile(COMPAT_PATH);
    const row = tableRows(doc).find((r) => {
      const capability = (r.cells.capability ?? '').toLowerCase();
      return (
        capability.includes('superpowers') &&
        capability.includes('attended') &&
        (capability.includes('orthogonal') || capability.includes('alongside'))
      );
    });
    expect(row, 'no row for Superpowers installed alongside an attended Rig session').toBeDefined();
    expect(Object.values(row!.cells)).toContain('UNVERIFIED');
    const cited = Object.values(row!.cells).some((c) => c.includes('discipline-providers.md'));
    expect(cited, 'row does not cite docs/decisions/discipline-providers.md').toBe(true);
  });
});
