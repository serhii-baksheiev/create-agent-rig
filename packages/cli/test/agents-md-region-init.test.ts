import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InitError, initProject, projectNameFor } from '../src/commands/init.js';
import { agentOsUniversalDir } from '../src/templates.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';
import {
  REGION_BEGIN,
  REGION_END,
  composeRegion,
  sha256,
} from '../../../test/helpers/agents-md-region.js';

/**
 * RP-256 slice 2 — installing beside a user-owned AGENTS.md through one
 * bounded managed region (Jira RP-256 comment 20585).
 *
 * ⚠ Conflict with existing tests, surfaced rather than resolved here (see
 * `.claude/rules/workflow.md` — a test-writer never overwrites an old test):
 * `packages/cli/test/init.test.ts` currently has two tests that assert the
 * OPPOSITE of what this slice asks for —
 *   - "refuses to clobber an existing AGENTS.md, without looping into the
 *     upgrade refusal" (init.test.ts, describe "initProject — the install")
 *   - "when both CLAUDE.md and AGENTS.md already exist, blames AGENTS.md —
 *     not the coexisting CLAUDE.md" (init.test.ts, describe "initProject —
 *     CLAUDE.md coexistence (RP-256 slice 1)")
 * Both assert `initProject` THROWS `InitError` for exactly the two fixtures
 * this file's "a plain pre-existing AGENTS.md" and "both files" describe
 * blocks below expect to SUCCEED. Implementing slice 2 as designed means
 * those two old tests become obsolete and need to be rewritten or removed —
 * a decision for whoever drives Green, not made here. The `docs/decisions/
 * agents-md-canonical.md` table row "A repo that had its own AGENTS.md
 * before init → init refuses outright" names the same obsolete behaviour.
 */

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-init-agents-region-'));
});

afterEach(async () => {
  await removeFixture(repo);
});

const manifestPath = (): string => path.join(repo, '.claude', '.rig-manifest.json');

/**
 * The subset of the raw manifest JSON these tests read directly — `regions`
 * has no production type yet, so the file is read as `unknown` and narrowed
 * to this shape at each call site, rather than `any` (which `pnpm lint`
 * refuses).
 */
type RawManifestShape = {
  regions?: Record<string, string>;
  files?: Record<string, string>;
  kept?: Record<string, string>;
};

async function readRawManifest(): Promise<unknown> {
  return JSON.parse(await readFile(manifestPath(), 'utf8')) as unknown;
}

/**
 * The rendered rulebook body, computed independently of production's own
 * `substituteContent`/`initFileContents` — read straight from the shipped
 * template and substituted here with a plain `replaceAll`, the one token
 * `AGENTS.md` documents (`__PROJECT_NAME__` is the only substitution token).
 */
async function renderBody(projectName: string): Promise<string> {
  const raw = await readFile(path.join(agentOsUniversalDir(), 'AGENTS.md'), 'utf8');
  return raw.replaceAll('__PROJECT_NAME__', projectName);
}

describe('initProject — AGENTS.md coexistence (RP-256 slice 2)', () => {
  const USER_NO_TRAILING_NL = '# Host team notes\nSome existing content, no trailing newline';
  const USER_CRLF = '# Host team notes\r\nCRLF all the way through\r\n';

  it('appends the managed region after a user AGENTS.md with no trailing newline, preserving the user bytes as an exact prefix', async () => {
    await writeFile(path.join(repo, 'AGENTS.md'), USER_NO_TRAILING_NL);

    const result = await initProject(repo, {});

    const body = await renderBody(projectNameFor(repo));
    const expected = composeRegion(USER_NO_TRAILING_NL, body);
    const onDisk = await readFile(path.join(repo, 'AGENTS.md'), 'utf8');
    expect(onDisk).toBe(expected);
    expect(onDisk.slice(0, USER_NO_TRAILING_NL.length)).toBe(USER_NO_TRAILING_NL);
    expect((result as unknown as { written: string[] }).written).toContain('AGENTS.md');
  });

  it('appends the managed region after a user AGENTS.md using CRLF line endings, preserving the user bytes as an exact prefix', async () => {
    await writeFile(path.join(repo, 'AGENTS.md'), USER_CRLF);

    await initProject(repo, {});

    const body = await renderBody(projectNameFor(repo));
    const expected = composeRegion(USER_CRLF, body);
    const onDisk = await readFile(path.join(repo, 'AGENTS.md'), 'utf8');
    expect(onDisk).toBe(expected);
    expect(onDisk.slice(0, USER_CRLF.length)).toBe(USER_CRLF);
  });

  it('records manifest.regions["AGENTS.md"] as sha256 of the region body alone, and does not record AGENTS.md under files or kept', async () => {
    await writeFile(path.join(repo, 'AGENTS.md'), USER_NO_TRAILING_NL);

    await initProject(repo, {});

    const body = await renderBody(projectNameFor(repo));
    const raw = (await readRawManifest()) as RawManifestShape;
    expect(raw.regions?.['AGENTS.md']).toBe(sha256(body));
    expect(raw.files?.['AGENTS.md']).toBeUndefined();
    expect(raw.kept?.['AGENTS.md']).toBeUndefined();
  });

  // Explicit regression pin (ticket's own acceptance criterion): nothing
  // about a CLEAN repo's install may change because a DIFFERENT repo now
  // takes the region-append path — the file set and bytes stay exactly what
  // they were before this slice, and the manifest gets no `regions` key at
  // all. This may already pass today — that is expected and fine; it pins
  // the "additive, never changes the clean case" half of the design.
  it('a clean repo (no pre-existing AGENTS.md) is installed exactly as before: no markers, no manifest `regions` key', async () => {
    await initProject(repo, {});

    const onDisk = await readFile(path.join(repo, 'AGENTS.md'), 'utf8');
    expect(onDisk).not.toContain(REGION_BEGIN);
    expect(onDisk).not.toContain(REGION_END);

    const raw = (await readRawManifest()) as RawManifestShape;
    expect(raw.regions).toBeUndefined();
  });

  it('both files: a user-owned root CLAUDE.md and a user-owned AGENTS.md coexist — the nested shim installs, and AGENTS.md gets its region, neither refused', async () => {
    const userClaude = '# host rules — do not touch\n';
    await writeFile(path.join(repo, 'CLAUDE.md'), userClaude);
    await writeFile(path.join(repo, 'AGENTS.md'), USER_NO_TRAILING_NL);

    const result = await initProject(repo, {});

    expect((result as unknown as { written: string[] }).written).toContain('.claude/CLAUDE.md');
    expect((result as unknown as { written: string[] }).written).toContain('AGENTS.md');
    expect(await readFile(path.join(repo, 'CLAUDE.md'), 'utf8')).toBe(userClaude);
    const shim = await readFile(path.join(repo, '.claude', 'CLAUDE.md'), 'utf8');
    expect(shim.split(/\r?\n/, 1)[0]).toBe('@../AGENTS.md');
    const body = await renderBody(projectNameFor(repo));
    expect(await readFile(path.join(repo, 'AGENTS.md'), 'utf8')).toBe(
      composeRegion(USER_NO_TRAILING_NL, body),
    );
  });

  it('installs the workflow layer too, alongside AGENTS.md coexistence', async () => {
    await writeFile(path.join(repo, 'AGENTS.md'), USER_NO_TRAILING_NL);

    await initProject(repo, { withWorkflow: true });

    await expect(
      readFile(path.join(repo, '.agents', 'skills', 'pr-ship', 'SKILL.md')),
    ).resolves.toBeTruthy();
    const onDisk = await readFile(path.join(repo, 'AGENTS.md'), 'utf8');
    expect(onDisk.startsWith(USER_NO_TRAILING_NL)).toBe(true);
    expect(onDisk).toContain(REGION_BEGIN);
  });

  describe('the 32 KiB Codex default doc cap', () => {
    // Codex's documented default per-document cap, named by the ticket.
    const CAP_BYTES = 32768;

    it('warns when the combined AGENTS.md would exceed the cap, and still installs', async () => {
      const hugePrefix = `# host notes\n${'x'.repeat(40000)}\n`;
      await writeFile(path.join(repo, 'AGENTS.md'), hugePrefix);

      const result = await initProject(repo, {});

      const onDisk = await readFile(path.join(repo, 'AGENTS.md'), 'utf8');
      expect(Buffer.byteLength(onDisk, 'utf8')).toBeGreaterThan(CAP_BYTES);
      const warnings = (result as unknown as { warnings?: string[] }).warnings ?? [];
      expect(warnings.some((w) => /32[, ]?768|32\s*KiB/i.test(w))).toBe(true);
      // still installed — a warning is not a refusal
      expect(onDisk.startsWith(hugePrefix)).toBe(true);
    });

    it('does not warn on an ordinary install well under the cap', async () => {
      const result = await initProject(repo, {});

      const warnings = (result as unknown as { warnings?: string[] }).warnings ?? [];
      expect(warnings.some((w) => /32[, ]?768|32\s*KiB/i.test(w))).toBe(false);
    });
  });

  // The refusals that remain: foreign or malformed markers already sitting
  // in the user's AGENTS.md. Each exits non-zero, writes nothing (no
  // manifest), and — since there is no rig installed yet — never tells the
  // user to run `upgrade` (mirrors the wording rule slice 1 pinned for the
  // plain "already has an AGENTS.md" and nested-CLAUDE.md refusals).
  describe('refuses foreign or malformed markers, writing nothing', () => {
    it('a begin marker with no end marker', async () => {
      const hostile = `# mine\n${REGION_BEGIN}\nunterminated\n`;
      await writeFile(path.join(repo, 'AGENTS.md'), hostile);

      let caught: unknown;
      try {
        await initProject(repo, {});
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(InitError);
      expect((caught as Error).message).not.toMatch(/create-agent-rig upgrade/);
      expect(await readFile(path.join(repo, 'AGENTS.md'), 'utf8')).toBe(hostile);
      await expect(access(manifestPath())).rejects.toThrow();
    });

    it('an end marker with no begin marker', async () => {
      const hostile = `# mine\nstray content\n${REGION_END}\n`;
      await writeFile(path.join(repo, 'AGENTS.md'), hostile);

      let caught: unknown;
      try {
        await initProject(repo, {});
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(InitError);
      expect((caught as Error).message).not.toMatch(/create-agent-rig upgrade/);
      expect(await readFile(path.join(repo, 'AGENTS.md'), 'utf8')).toBe(hostile);
      await expect(access(manifestPath())).rejects.toThrow();
    });

    it('two begin markers', async () => {
      const hostile = `# mine\n${REGION_BEGIN}\nfirst\n${REGION_BEGIN}\nsecond\n${REGION_END}\n`;
      await writeFile(path.join(repo, 'AGENTS.md'), hostile);

      let caught: unknown;
      try {
        await initProject(repo, {});
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(InitError);
      expect((caught as Error).message).not.toMatch(/create-agent-rig upgrade/);
      expect(await readFile(path.join(repo, 'AGENTS.md'), 'utf8')).toBe(hostile);
      await expect(access(manifestPath())).rejects.toThrow();
    });
  });
});
