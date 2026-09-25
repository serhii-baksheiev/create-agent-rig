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

// RP-256 slice 2, round 2 — code-reviewer B2: re-running `init` on a rig
// that already region-tracks AGENTS.md must behave like re-running it on any
// other rig-owned or kept path, never as a fresh foreign-marker refusal.
describe('initProject — re-running init on an already region-tracked AGENTS.md (round 2, B2)', () => {
  const USER_PREFIX = '# Host team notes\nkeep me\n';

  it('is idempotent when the region is unedited: exit 0, AGENTS.md bytes unchanged, and the regions hash unchanged', async () => {
    await writeFile(path.join(repo, 'AGENTS.md'), USER_PREFIX);
    await initProject(repo, {});
    const before = await readFile(path.join(repo, 'AGENTS.md'), 'utf8');
    const rawBefore = (await readRawManifest()) as RawManifestShape;

    // Must not throw — a second, unedited run is a no-op, exactly like a
    // second run over any other unchanged rig-owned or kept path.
    const result = await initProject(repo, {});

    const after = await readFile(path.join(repo, 'AGENTS.md'), 'utf8');
    expect(after).toBe(before);
    const rawAfter = (await readRawManifest()) as RawManifestShape;
    expect(rawAfter.regions?.['AGENTS.md']).toBe(rawBefore.regions?.['AGENTS.md']);
    expect((result as unknown as { written: string[] }).written).not.toContain('AGENTS.md');
  });

  // Round 3 advisory A1 (code-reviewer): the idempotence test above checks
  // `regions` and `written`, but not `kept` — the mutation removing
  // `previous.regions` from `regionTrackedPaths` (`init.ts:818`) stays
  // green without this, because a reverted re-run records `kept['AGENTS.md']`
  // ALONGSIDE `regions['AGENTS.md']`, and nothing was asserting `kept` is
  // absent. A region-tracked AGENTS.md has exactly one bucket: `regions`.
  it('does not add AGENTS.md to `kept` on re-init — the manifest has exactly one bucket for it: `regions`', async () => {
    await writeFile(path.join(repo, 'AGENTS.md'), USER_PREFIX);
    await initProject(repo, {});

    await initProject(repo, {});

    const raw = (await readRawManifest()) as RawManifestShape;
    expect(raw.regions?.['AGENTS.md']).toBeDefined();
    expect(raw.kept?.['AGENTS.md']).toBeUndefined();
    expect(raw.files?.['AGENTS.md']).toBeUndefined();
  });

  it('does not refuse, and does not duplicate the region, when the user edited it themselves — left alone, byte-identical, like any other kept file', async () => {
    await writeFile(path.join(repo, 'AGENTS.md'), USER_PREFIX);
    await initProject(repo, {});
    const original = await readFile(path.join(repo, 'AGENTS.md'), 'utf8');
    // The user edits INSIDE the region, right before the end marker.
    const edited = original.replace(REGION_END, `EDITED BY THE USER\n${REGION_END}`);
    await writeFile(path.join(repo, 'AGENTS.md'), edited);

    // Must not throw "markers init cannot safely merge with".
    await initProject(repo, {});

    const after = await readFile(path.join(repo, 'AGENTS.md'), 'utf8');
    expect(after).toBe(edited);
    expect(after.split(REGION_BEGIN).length - 1).toBe(1); // never duplicated
    expect(after.split(REGION_END).length - 1).toBe(1);
  });

  // Still refused: this is the ordinary first-install refusal (already
  // pinned above, in "refuses foreign or malformed markers, writing
  // nothing") — restated here, explicitly framed as "the manifest records no
  // region at all", so it reads next to the two cases above that must NOT
  // refuse the same way.
  it('still refuses foreign markers when the manifest records no region at all', async () => {
    const hostile = `# mine\n${REGION_BEGIN}\nunterminated\n`;
    await writeFile(path.join(repo, 'AGENTS.md'), hostile);

    let caught: unknown;
    try {
      await initProject(repo, {});
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InitError);
    expect(await readFile(path.join(repo, 'AGENTS.md'), 'utf8')).toBe(hostile);
    await expect(access(manifestPath())).rejects.toThrow();
  });
});

// RP-256 slice 2, round 2 — code-reviewer B3: this is master's own behaviour
// (before this PR), pinned as a regression guard. A clean-repo install
// records AGENTS.md under `files` (a whole-file rig-owned path, not a
// region) — editing it and re-running init must still refuse, exactly as it
// always has; it must never fall into the region-append path meant for a
// FOREIGN pre-existing file, and AGENTS.md must never end up recorded under
// both `files` and `regions` at once.
describe('initProject — re-running init after the user edits a rig-owned WHOLE-FILE AGENTS.md (round 2, B3)', () => {
  it('is still refused, as before this PR — no region is appended, and AGENTS.md is never recorded in both files and regions', async () => {
    await initProject(repo, {}); // clean repo: AGENTS.md is rig-owned, under `files`
    const original = await readFile(path.join(repo, 'AGENTS.md'), 'utf8');
    const edited = `${original}\nEDITED BY THE USER\n`;
    await writeFile(path.join(repo, 'AGENTS.md'), edited);

    let caught: unknown;
    try {
      await initProject(repo, {});
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InitError);
    const onDisk = await readFile(path.join(repo, 'AGENTS.md'), 'utf8');
    expect(onDisk).toBe(edited); // unchanged — no second rulebook appended
    expect(onDisk).not.toContain(REGION_BEGIN);

    const raw = (await readRawManifest()) as RawManifestShape;
    const inFiles = raw.files?.['AGENTS.md'] !== undefined;
    const inRegions = raw.regions?.['AGENTS.md'] !== undefined;
    expect(inFiles && inRegions).toBe(false);
  });
});

// RP-256 slice 2, round 2 — code-reviewer B4 / security-scanner B2: a user
// AGENTS.md that is not valid UTF-8 must not be silently corrupted by a
// lossy `Buffer#toString('utf8')` round trip while init reports success.
// Pinned choice (the coordinator decided this one, not left open): REFUSE.
describe('initProject — a user AGENTS.md that is not valid UTF-8 (round 2, B4/security B2)', () => {
  it('refuses a Latin-1 byte (0xe9) in the prefix — non-zero, nothing written, the message names AGENTS.md and says it is not UTF-8', async () => {
    const bytes = Buffer.concat([
      Buffer.from('# caf', 'utf8'),
      Buffer.from([0xe9]),
      Buffer.from('\n'),
    ]);
    await writeFile(path.join(repo, 'AGENTS.md'), bytes);

    let caught: unknown;
    try {
      await initProject(repo, {});
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InitError);
    const message = (caught as Error).message;
    expect(message).toMatch(/AGENTS\.md/);
    expect(message).toMatch(/utf-?8/i);
    expect(await readFile(path.join(repo, 'AGENTS.md'))).toEqual(bytes);
    await expect(access(manifestPath())).rejects.toThrow();
  });

  it('refuses a UTF-16LE file with a BOM (ff fe) — non-zero, nothing written, the message names AGENTS.md and says it is not UTF-8', async () => {
    // "hi" encoded UTF-16LE with its BOM — exactly what PowerShell 5.1's
    // `echo … > AGENTS.md` writes on Windows (security-scanner B2's own
    // example of why this is not an exotic case).
    const bytes = Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]);
    await writeFile(path.join(repo, 'AGENTS.md'), bytes);

    let caught: unknown;
    try {
      await initProject(repo, {});
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InitError);
    const message = (caught as Error).message;
    expect(message).toMatch(/AGENTS\.md/);
    expect(message).toMatch(/utf-?8/i);
    expect(await readFile(path.join(repo, 'AGENTS.md'))).toEqual(bytes);
    await expect(access(manifestPath())).rejects.toThrow();
  });
});
