#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CreateError, createProject } from './commands/create.js';
import { InitError, initFileContents, initProject, planInit } from './commands/init.js';
import { INTEGRATIONS_VERBS, runIntegrationsCommand } from './commands/integrations.js';
import { execFileRunner, setupSubsystems } from './commands/setup.js';
import { UpgradeError, applyUpgrade, planUpgrade } from './commands/upgrade.js';
import type { UpgradePlan, UpgradeVerdict } from './commands/upgrade.js';
import {
  CHANGED_SINCE_PLANNING_REASON,
  UninstallError,
  applyUninstall,
  isUnverifiedReason,
  planUninstall,
  protectedFileReason,
} from './commands/uninstall.js';
import type {
  ApplyUninstallResult,
  UninstallAction,
  UninstallOutcome,
  UninstallPlan,
  UninstallVerdict,
  WiringPreservedKind,
} from './commands/uninstall.js';
import { makePalette } from './lib/colors.js';
import { readManifest, sha256 } from './lib/manifest.js';
import { SubsystemsError, refreshSubsystems, subsystemsManifestPath } from './lib/subsystems.js';
import { promptConfirm } from './lib/prompts.js';
import { collectGovernance, renderSummary } from './lib/summary.js';
import { packageVersion, rigHandshake } from './lib/version.js';
import { runMemory } from './commands/memory.js';

const USAGE = `Usage: create-agent-rig <dir> [options]

Scaffolds a new directory into <dir>: \`mkdir\` + \`git init\` + the same install
\`init\` runs into an existing repo — a Claude Code + Codex agent operating
system, no application scaffolding. Refuses to write into a non-empty
directory.

Options
  --no-git          skip git init + the pristine-template baseline commit
  --layer workflow  also install the experimental, opt-in workflow layer (the
                    queue adapter, the loop and pr-ship skills, run-state,
                    journal, revalidation, claim-records, and the PR-lifecycle
                    helpers) — see init below; default is the core layer only.
                    "workflow" is the only accepted name — process/Core
                    installs unconditionally and is never named. Repeatable;
                    repeating the same name is harmless.
  --no-color        plain output (NO_COLOR is respected too)
  --version         print the version (--version --json: the contract handshake,
                    one JSON object with the name, version and contract version)
  -h, --help        this text

Also: create-agent-rig init [--dry-run] [--layer workflow]
  Install the process layer (rules, gates, stop rules — no architecture
  assumptions) into the CURRENT existing repo. Refuses to clobber CLAUDE.md
  or AGENTS.md.
  --layer workflow also installs the experimental workflow layer: an
  autonomous, cooperative multi-session queue/loop/PR-lifecycle mechanism,
  never required by Lean Core. Without it, only the core layer is installed.
  A rig that already has the workflow layer keeps it on a plain re-run with
  no flag — the flag only ever adds the layer, never drops one a previous
  run already recorded.
  --force is deprecated: it refuses and points at upgrade, which refreshes a
  rig file by file. It is removed in 0.6.

Also: create-agent-rig upgrade [--dry-run] [--yes]
  Bring the rig in the CURRENT repo up to this version. Replaces the files it
  installed and you did not touch; everything else is reported, never merged.
  Re-runs the subsystem manifest derivation when one exists (see setup).

Also: create-agent-rig setup --memory-root <checkout> [--memory-ref <sha>] [--dry-run]
  Record the Memory executable in this machine's subsystem manifest
  (~/.config/create-agent-rig/subsystems.json; %APPDATA% on Windows) from the
  one declared root. Performs the --version --json handshake first and refuses
  a foreign contract major with exit 4 before writing anything.

Also: create-agent-rig setup list [--json]
  Print the release-owned integrations registry (RP-22): id, capability,
  mode, licence or terms, source, per-harness route and automation, and
  stability. Read-only.

Also: create-agent-rig setup add <id> [--required] [--version <pin>] [--dry-run] [--json]
  Validate <id> against that same registry, then create or update its entry
  in the committed declaration (.rig/integrations.json), through
  resolveWritableInside with sorted, stable bytes. Installs nothing. A flag
  left off an existing entry keeps its previously recorded value rather than
  dropping it.

Also: create-agent-rig setup verify [--only <id>] [--json]
  Read-only: classify every declared integration against what can currently
  be observed. No route adapter exists yet at this release, so every harness
  reads "unverified" (no-sanctioned-probe) until a later release wires one up.
  Exits 1 when any required integration is not installed on every harness it
  applies to, or when the declaration itself does not parse; 0 otherwise,
  including when there is no declaration at all.

Also: create-agent-rig uninstall [dir] [--dry-run] [--yes] [--detach] [--json]
  Remove what a rig installed from [dir] (default: the current directory) —
  only files whose bytes on disk still match what the manifest recorded, are
  still one of the exact paths this release installs, and still match right
  up to the moment each one is removed; anything under .git is refused
  outright, whatever hash a manifest pairs it with. Everything else (edited,
  foreign, deleted already, kept by init, changed since the plan was shown, or
  not a path this release owns) is left in place and reported. The manifest
  is removed last, and only once every removal succeeded AND nothing was
  preserved — a preserved path means the rig still owns bytes it did not
  remove, so the evidence naming them stays; a failed run also keeps it, so a
  re-run picks up where it stopped. --detach removes the manifest anyway,
  after the same safe cleanup, leaving every preserved path for you and
  printing the full handover list — it never forces away a conflicting or
  modified file. --json's payload names which of three outcomes a run
  reached: "uninstalled" (clean), "partial" (something kept, manifest stays),
  "detached" (--detach: manifest gone, a handover list left behind). Prints
  the plan, then asks before removing anything: --yes answers up front
  (required off a terminal, and always required with --json, which never
  prompts) — the same consent rule applies to --detach. --json prints one
  JSON object and nothing else on stdout (see docs/command-contract.md);
  without it, uninstall reports in prose like init and upgrade. Idempotent: a
  repeat run finds no manifest and does nothing, exit 0.

Also: create-agent-rig memory <doctor|load> [args…]
  Run a Memory verb through the registered executable: the --version --json
  handshake first (a foreign contract major exits 4 and the verb never runs),
  then the verb and its arguments, Memory's answer passed through unchanged.
  Your arguments go to Memory as written; a load that names no --timeout-ms
  gets --timeout-ms 45000 appended (Memory's own deadline, kept under the rig's
  60 s bound). No manifest answers unsupported/absent (exit 0); an invalid
  invocation exits 2.`;

async function runSetup(rawArgs: string[]): Promise<number> {
  // RP-22 S4: dispatch to the new read-only verbs (plus the declaration
  // write) only when the FIRST argument is one of them. Any other first
  // argument — including none at all — falls through to the legacy
  // `--memory-root` path unchanged, so `setup --memory-root …` and a bare
  // `setup` keep answering exactly as they did before this slice.
  const verb = rawArgs[0];
  if ((INTEGRATIONS_VERBS as readonly string[]).includes(verb ?? '')) {
    const result = await runIntegrationsCommand({
      verb: verb!,
      args: rawArgs.slice(1),
      cwd: process.cwd(),
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    return result.exitCode;
  }

  let values: {
    'memory-root'?: string;
    'memory-ref'?: string;
    'dry-run'?: boolean;
    'no-color'?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: rawArgs,
      options: {
        'memory-root': { type: 'string' },
        'memory-ref': { type: 'string' },
        'dry-run': { type: 'boolean' },
        'no-color': { type: 'boolean' },
      },
      allowPositionals: false,
    }));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}\n`);
    return 1;
  }
  const memoryRoot = values['memory-root'];
  if (memoryRoot === undefined) {
    process.stderr.write(`setup needs --memory-root <checkout>\n\n${USAGE}\n`);
    return 1;
  }
  try {
    const result = await setupSubsystems({
      memoryRoot,
      memoryRef: values['memory-ref'] ?? null,
      dryRun: values['dry-run'] === true,
    });
    if (result.outcome === 'refused') {
      process.stderr.write(`Memory handshake: ${JSON.stringify(result.handshake)}\n`);
      return result.exitCode;
    }
    process.stdout.write(
      `Memory handshake: ${JSON.stringify(result.handshake)}\n` +
        (result.outcome === 'dry-run'
          ? `Dry run — nothing written (would write ${result.file}).\n`
          : `Wrote ${result.file}\n`),
    );
    return 0;
  } catch (error) {
    if (error instanceof SubsystemsError) {
      process.stderr.write(`setup: ${error.message} (${error.code})\n`);
      return 1;
    }
    throw error;
  }
}

/**
 * `--layer <name>`, repeatable (RP-180 round 2: the owner's spelling is
 * `--layer workflow`, never `--with-workflow`). `workflow` is the only name a
 * user may opt into today — `process`/Core installs unconditionally and is
 * never something a user names. Repeating the same name is harmless; naming
 * anything else is a usage error the caller reports the same way it reports
 * any other bad flag (message to stderr + USAGE, exit 1) — neither `init` nor
 * the top-level `create` accepts `--json` today, so there is no JSON error
 * shape to match here; this follows the one shape those two commands already
 * use.
 */
function resolveLayerFlag(
  layer: string[] | undefined,
): { withWorkflow: boolean } | { error: string } {
  const names = layer ?? [];
  const unknown = names.find((name) => name !== 'workflow');
  if (unknown !== undefined) {
    return {
      error: `Unknown --layer "${unknown}" — the only accepted layer name is "workflow" (process/Core installs unconditionally and is never named).`,
    };
  }
  return { withWorkflow: names.length > 0 };
}

async function runInit(rawArgs: string[]): Promise<number> {
  let values: {
    'dry-run'?: boolean;
    force?: boolean;
    'no-color'?: boolean;
    layer?: string[];
  };
  try {
    ({ values } = parseArgs({
      args: rawArgs,
      // `--no-color` for the same reason it is accepted on `upgrade`: USAGE
      // offers it without scoping it to one command.
      options: {
        'dry-run': { type: 'boolean' },
        force: { type: 'boolean' },
        'no-color': { type: 'boolean' },
        layer: { type: 'string', multiple: true },
      },
      allowPositionals: false,
    }));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}\n`);
    return 1;
  }
  const layerResult = resolveLayerFlag(values.layer);
  if ('error' in layerResult) {
    process.stderr.write(`${layerResult.error}\n\n${USAGE}\n`);
    return 1;
  }
  const cwd = process.cwd();
  const dryRun = values['dry-run'] === true;
  const { withWorkflow } = layerResult;

  // `init` adopts a repo the rig knows nothing about. Run inside a rig `create`
  // generated — reachable when its CLAUDE.md was deleted — it is the wrong
  // command: it installs the process layer alone and never refreshes the stack
  // overlays. Say so before anything is written, so it is visible on --dry-run
  // too.
  //
  // It is a manifest read, so any rig without a READABLE manifest gets no
  // advisory even when it came from `create` — one never written, one deleted,
  // and one present but voided by `parseManifest` all reach here alike. The
  // same limit `recordInstall` carries, stated in both places because either
  // one alone reads as wider.
  const existing = await readManifest(cwd);

  const plan = await planInit(cwd, { withWorkflow });
  process.stdout.write(
    `agent-rig init — process layer${withWorkflow ? ' + the opt-in workflow layer' : ''} into ${cwd}\n\n` +
      plan.files.map((f) => `  + ${f.path}`).join('\n') +
      '\n',
  );
  if (existing?.kind === 'create') {
    process.stdout.write(
      `\n!  This rig was created by create-agent-rig — \`init\` only fills gaps here; use \`upgrade\` to refresh.\n`,
    );
  }
  if (plan.conflicts.length > 0) {
    process.stdout.write(
      `\nAlready present (kept, not overwritten):\n` +
        plan.conflicts.map((c) => `  · ${c}`).join('\n') +
        '\n',
    );
  }

  const result = await initProject(cwd, { dryRun, force: values.force === true, withWorkflow });
  if (dryRun) {
    process.stdout.write(`\nDry run — nothing written (${result.plannedCount} files planned).\n`);
    return 0;
  }
  process.stdout.write(
    `\nInstalled ${result.written.length} files` +
      (result.skipped.length ? `, kept ${result.skipped.length} existing` : '') +
      '.\n',
  );

  // A kept harness config silently disables that harness's enforcement: the
  // hooks sit on disk and are never called, while the rules claim they are.
  // Say so loudly, and hand over the exact entries for each affected harness.
  const generated = await initFileContents(cwd);
  for (const wiringPath of ['.claude/settings.json', '.codex/hooks.json']) {
    if (!result.skipped.includes(wiringPath)) continue;
    const installedHash = existing?.files[wiringPath];
    if (installedHash !== undefined) {
      try {
        if (sha256(await readFile(path.join(cwd, wiringPath))) === installedHash) continue;
      } catch {
        // The write preflight already classified this path. If it changes
        // before reporting, fall through to the conservative warning.
      }
    }
    const wiring = generated.get(wiringPath) ?? '';
    process.stdout.write(
      `\n!  ${wiringPath} already exists — it was kept, so the rig's hooks are NOT wired there.\n` +
        `   Until you merge these entries into it, nothing enforces the rules:\n\n` +
        wiring.replace(/^/gm, '   ') +
        '\n',
    );
  }
  return 0;
}

const MARK: Record<UpgradeVerdict, string> = {
  update: '~',
  new: '+',
  conflict: '!',
  deleted: '-',
  wiring: '!',
  unchanged: '·',
  retired: 'x',
};

function renderUpgradePlan(repoDir: string, plan: UpgradePlan): string {
  const of = (verdict: UpgradeVerdict) => plan.actions.filter((a) => a.verdict === verdict);
  const lines: string[] = [
    `agent-rig upgrade — ${plan.kind} rig in ${repoDir}`,
    plan.bootstrapped
      ? `  no readable manifest here (deleted, never written, or unparseable) — matching files against released versions`
      : `  installed by ${plan.fromVersion}`,
    `  upgrading to ${plan.toVersion}`,
  ];

  // RP-180 round 4, blocker A(4): when a layer's membership was inferred
  // from disk rather than read from a manifest, say so — and how much
  // evidence it rested on — instead of silently deciding.
  for (const note of plan.layerInference ?? []) {
    lines.push(
      note.adopted
        ? `  ${note.layer} layer inferred from ${note.present} of ${note.total} files on disk`
        : `  ${note.present} of ${note.total} ${note.layer}-layer files found on disk — below quorum, left as your own (not adopted)`,
    );
  }

  lines.push('');

  for (const verdict of ['update', 'new', 'deleted', 'retired', 'conflict', 'wiring'] as const) {
    for (const action of of(verdict)) {
      lines.push(
        `  ${MARK[verdict]} ${action.rel}` + (action.reason ? `  — ${action.reason}` : ''),
      );
      // A conflict is only useful if the new version can be diffed by hand.
      if (verdict === 'conflict' && action.templatePath) {
        lines.push(`      new version: ${action.templatePath}`);
      }
    }
  }

  // Every one of `UpgradeVerdict`'s seven members is accounted for here.
  // `wiring`, `deleted` and `retired` each print their own line and were in
  // none of the buckets, so a reader counted lines and was told a smaller
  // number. (`unchanged` is counted and prints nothing — the sum is over
  // actions, not over printed lines.) The three appear only when they
  // occurred, so a plan without them renders exactly as it always has. Pinned
  // by, in cli-report.test.ts, "renders a plan with no wiring action exactly
  // as it does today".
  // `deleted` before `wiring`, the relative order the plan prints them in.
  // ⚠ Only their order relative to EACH OTHER matches: the plan prints
  // `deleted` before `conflict` and the summary prints it after, so this is not
  // a plan-ordered line. Pinned by, in cli-report.test.ts,
  // "lists the two occasional buckets in the order the plan prints them".
  const occasional = [
    ['deleted', (n: number) => `${n} you removed (left removed)`],
    ['retired', (n: number) => `${n} no longer shipped (now yours)`],
    ['wiring', (n: number) => `${n} wiring handed over`],
  ] as const;
  const extra = occasional
    .map(([verdict, phrase]) => [of(verdict).length, phrase] as const)
    .filter(([count]) => count > 0)
    .map(([count, phrase]) => phrase(count));
  lines.push(
    '',
    `  ${of('update').length} to replace, ${of('new').length} new, ` +
      `${of('conflict').length} yours (kept), ` +
      [...extra, `${of('unchanged').length} already current`].join(', '),
  );
  return `${lines.join('\n')}\n`;
}

async function runUpgrade(rawArgs: string[]): Promise<number> {
  let values: { 'dry-run'?: boolean; yes?: boolean; 'no-color'?: boolean };
  try {
    ({ values } = parseArgs({
      args: rawArgs,
      // `--no-color` is advertised in USAGE without scoping it to one command, so
      // every command accepts it. Refusing a flag the help offers costs the
      // reader more than honouring it costs us — and honouring it is only a
      // parse here, because the sole palette lives on the `create` path below.
      // Pinned by, in cli-report.test.ts,
      // "upgrade accepts --no-color and prints plain output".
      options: {
        'dry-run': { type: 'boolean' },
        yes: { type: 'boolean' },
        'no-color': { type: 'boolean' },
      },
      allowPositionals: false,
    }));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}\n`);
    return 1;
  }

  const cwd = process.cwd();
  const plan = await planUpgrade(cwd);
  process.stdout.write(renderUpgradePlan(cwd, plan));

  // The one thing this command will not do for you — printed with the plan,
  // because the dry run is where a reader decides whether there is work here,
  // and a report that mentions entries it never shows is not a plan.
  if (plan.wiringByPath.size > 0) {
    for (const [wiringPath, wiring] of plan.wiringByPath) {
      process.stdout.write(
        `\n!  ${wiringPath} was handed over rather than replaced — the reason is\n` +
          `   on its line above. It is hook wiring, so it is never overwritten\n` +
          `   without proof the rig wrote those exact bytes.\n` +
          `   This version wires it like this; merge in what is missing:\n\n` +
          wiring.replace(/^/gm, '   ') +
          '\n',
      );
    }
  }

  if (values['dry-run'] === true) {
    process.stdout.write('\nDry run — nothing written.\n');
    return 0;
  }

  // The plan above is the review step, so it has to be answered before
  // anything is written. On a terminal that is a question; off one it is a
  // refusal — never guess for a run that cannot be asked, least of all when
  // the answer rewrites its repository.
  const isInteractive = Boolean(process.stdin.isTTY && process.stderr.isTTY);
  if (values.yes !== true) {
    if (!isInteractive) {
      process.stderr.write(
        'Refusing to rewrite files in a non-interactive run. ' +
          'Re-run with --yes once the plan above is what you want (or --dry-run to keep looking).\n',
      );
      return 1;
    }
    const confirmed = await promptConfirm('\nApply this plan?', {
      input: process.stdin,
      output: process.stderr,
      isInteractive,
    });
    if (!confirmed) {
      process.stdout.write('Nothing written.\n');
      return 0;
    }
  }

  const result = await applyUpgrade(cwd, plan);
  process.stdout.write(`\nWrote ${result.written.length} files.\n`);

  // The subsystem manifest is machine-scoped and written by `setup`; an
  // upgrade re-runs the same derivation so `installedVersion` follows the
  // executable the root now holds. It is never part of the rig manifest or of
  // `result.written` — that file list is the repository's, this one is the
  // user's. Absent stays absent: creating it is `setup`'s act.
  try {
    const refreshed = await refreshSubsystems({
      file: subsystemsManifestPath(process.env, process.platform),
      run: execFileRunner,
      nodeExecutable: process.execPath,
      platform: process.platform,
    });
    if (refreshed !== 'absent')
      process.stdout.write(
        `Subsystem manifest: ${typeof refreshed === 'string' ? refreshed : JSON.stringify(refreshed)}\n`,
      );
  } catch (error) {
    if (!(error instanceof SubsystemsError)) throw error;
    process.stdout.write(`Subsystem manifest: not refreshed — ${error.message} (${error.code})\n`);
  }
  return 0;
}

const UNINSTALL_MARK: Record<UninstallVerdict, string> = {
  remove: '-',
  absent: '·',
  preserved: '!',
};

interface UninstallPayload {
  schemaVersion: 1;
  command: 'uninstall';
  dryRun: boolean;
  /** What the plan would remove — every `remove`-verdict path, whether or not this run actually removed it. */
  planned: string[];
  /** What was actually deleted from disk. Always `[]` on a dry run, a refusal, or when planning itself failed. */
  removed: string[];
  absent: string[];
  preserved: Array<{ path: string; reason: string }>;
  manifestRemoved: boolean;
  completed?: string[];
  remaining?: string[];
  error?: string;
  /** Which of `uninstalled` / `partial` / `detached` this run reached — absent exactly when `error` is present. See `docs/command-contract.md`, "## uninstall (RP-181)". */
  outcome?: UninstallOutcome;
}

/**
 * `removed` is always what actually happened — `applyUninstall`'s own result
 * — never a re-derivation of the plan: empty on a dry run, a consent refusal,
 * or a plan that itself failed, and on a partial failure the SUBSET that
 * finished, not every `remove`-verdict path the plan named. `planned` is the
 * plan's own answer regardless of outcome, so a caller can tell "what would
 * this have done" from "what did it do" even when they differ.
 *
 * `changedSincePlanning` and `protectedHooksAtApply` paths are both folded
 * into `preserved` — the first with reason
 * {@link CHANGED_SINCE_PLANNING_REASON}, the second worded by
 * {@link protectedFileReason} — the SAME function `planUninstall` itself
 * calls to word a hook it protects at PLAN time, so a reader cannot tell
 * which pass discovered the protection from the wording alone, and picking
 * the right one of the four underlying strings never happens twice: a
 * directly-named hook's wording depends on `entry.wiringKind` (a `kept`
 * wiring file's hook was never "preserved as edited", and reusing that
 * wording told two contradictory stories about the same file), a
 * transitively-imported one on `entry.importedBy`, and one protected only by
 * the conservative superset sweep — never traced at all — on
 * `entry.unverifiedBecause`, which names the file whose own unreadability
 * triggered the sweep rather than claiming a connection this command never
 * confirmed. Neither `changedSincePlanning` nor
 * `protectedHooksAtApply` is in `plan.actions` (both were `remove` at plan
 * time and only discovered otherwise at apply time), but both are exactly as
 * un-removed as any other preserved path, and a caller reading `preserved`
 * for "what did this run leave behind" must see them there too, not in a
 * third and fourth, easy-to-miss list.
 *
 * `outcome` is passed straight through from `applyUninstall`'s own result:
 * present on every completed, non-dry-run call, absent on `--dry-run` and on
 * a hard failure alike — this function never invents or infers it.
 */
function uninstallPayload(
  dryRun: boolean,
  actions: readonly UninstallAction[],
  removed: readonly string[],
  applied?: {
    manifestRemoved: boolean;
    completed?: string[];
    remaining?: string[];
    error?: string;
    changedSincePlanning?: string[];
    protectedHooksAtApply?: Array<{
      rel: string;
      wiringRel: string;
      wiringKind: WiringPreservedKind;
      importedBy?: string;
      unverifiedBecause?: string;
    }>;
    outcome?: UninstallOutcome;
  },
): UninstallPayload {
  const of = (verdict: UninstallVerdict) =>
    actions.filter((a) => a.verdict === verdict).map((a) => a.rel);
  const payload: UninstallPayload = {
    schemaVersion: 1,
    command: 'uninstall',
    dryRun,
    planned: of('remove'),
    removed: [...removed],
    absent: of('absent'),
    preserved: [
      ...actions
        .filter((a) => a.verdict === 'preserved')
        .map((a) => ({ path: a.rel, reason: a.reason ?? '' })),
      ...(applied?.changedSincePlanning ?? []).map((path) => ({
        path,
        reason: CHANGED_SINCE_PLANNING_REASON,
      })),
      ...(applied?.protectedHooksAtApply ?? []).map(
        ({ rel, wiringRel, wiringKind, importedBy, unverifiedBecause }) => ({
          path: rel,
          reason: protectedFileReason(wiringRel, wiringKind, importedBy, unverifiedBecause),
        }),
      ),
    ],
    manifestRemoved: applied?.manifestRemoved ?? false,
  };
  if (applied?.completed !== undefined) payload.completed = applied.completed;
  if (applied?.remaining !== undefined) payload.remaining = applied.remaining;
  if (applied?.error !== undefined) payload.error = applied.error;
  if (applied?.outcome !== undefined) payload.outcome = applied.outcome;
  return payload;
}

function renderUninstallPlan(repoDir: string, plan: UninstallPlan): string {
  const of = (verdict: UninstallVerdict) => plan.actions.filter((a) => a.verdict === verdict);
  const lines: string[] = [`agent-rig uninstall — ${repoDir}`, ''];
  for (const verdict of ['remove', 'preserved', 'absent'] as const) {
    for (const action of of(verdict)) {
      lines.push(
        `  ${UNINSTALL_MARK[verdict]} ${action.rel}` +
          (action.reason ? `  — ${action.reason}` : ''),
      );
    }
  }
  lines.push(
    '',
    `  ${of('remove').length} to remove, ${of('preserved').length} preserved, ` +
      `${of('absent').length} already gone`,
  );
  return `${lines.join('\n')}\n`;
}

async function runUninstall(rawArgs: string[]): Promise<number> {
  let positionals: string[];
  let values: {
    'dry-run'?: boolean;
    json?: boolean;
    yes?: boolean;
    detach?: boolean;
    'no-color'?: boolean;
  };
  try {
    ({ positionals, values } = parseArgs({
      args: rawArgs,
      options: {
        'dry-run': { type: 'boolean' },
        json: { type: 'boolean' },
        yes: { type: 'boolean' },
        detach: { type: 'boolean' },
        // `--no-color` for the same reason it is accepted on `init` and
        // `upgrade`: USAGE offers it without scoping it to one command. It
        // has no observable effect here specifically — uninstall's report
        // never uses the colour palette in the first place — accepted only
        // so the flag never produces an "unknown option" error a reader of
        // USAGE would not expect.
        'no-color': { type: 'boolean' },
      },
      allowPositionals: true,
    }));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}\n`);
    return 1;
  }
  if (positionals.length > 1) {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }
  const repoDir = path.resolve(process.cwd(), positionals[0] ?? '.');
  const dryRun = values['dry-run'] === true;
  const json = values.json === true;
  const yes = values.yes === true;
  const detach = values.detach === true;

  let plan: UninstallPlan;
  try {
    plan = await planUninstall(repoDir);
  } catch (error) {
    // `UninstallError` is a message this command composed on purpose — the
    // usual case. Anything else (EACCES, ENOTDIR, a permission the caller did
    // not expect) is unplanned, but `--json` promises one JSON object and
    // nothing else on stdout regardless of which kind it is: a stack trace on
    // stderr with no payload at all breaks that promise for a caller who only
    // ever reads stdout. Off `--json`, the trace is still the right
    // diagnostic, so it is rethrown to `main()`'s own handler unchanged.
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      process.stdout.write(
        `${JSON.stringify(uninstallPayload(dryRun, [], [], { manifestRemoved: false, error: message }))}\n`,
      );
      return 1;
    }
    if (error instanceof UninstallError) {
      process.stderr.write(`${message}\n`);
      return 1;
    }
    throw error;
  }

  if (plan.noManifest) {
    if (json) {
      // `outcome` names an END STATE a real run reached; `--dry-run` never
      // reaches one, even here — "nothing installed" is an end state only
      // once a real (non-dry) run has acted, or declined to act, on it.
      process.stdout.write(
        `${JSON.stringify(
          uninstallPayload(
            dryRun,
            [],
            [],
            dryRun
              ? { manifestRemoved: false }
              : { manifestRemoved: false, outcome: 'uninstalled' },
          ),
        )}\n`,
      );
    } else {
      process.stdout.write(`No rig manifest found in ${repoDir} — nothing to uninstall.\n`);
    }
    return 0;
  }

  // The plan is the review step, so it is shown before anything is decided —
  // in both output modes, and before the consent question below, not after.
  if (!json) process.stdout.write(renderUninstallPlan(repoDir, plan));

  if (dryRun) {
    if (json) {
      process.stdout.write(`${JSON.stringify(uninstallPayload(true, plan.actions, []))}\n`);
    } else {
      process.stdout.write('\nDry run — nothing removed.\n');
    }
    return 0;
  }

  // Consent, never guessed, least of all when the answer deletes files — the
  // same shape `upgrade` asks before it writes: `--yes` up front, a prompt on
  // a terminal, and an outright refusal off one. `--json` stays
  // non-interactive on principle, the same reason `--version --json` and
  // every other JSON payload here never prompts: it is read by a script, and
  // a script blocking on a TTY question is a hang, not a safeguard. So
  // without `--yes` it gets the same refusal a non-interactive run gets,
  // reported in its own shape instead of a stderr sentence.
  const isInteractive = Boolean(process.stdin.isTTY && process.stderr.isTTY);
  if (!yes) {
    if (json || !isInteractive) {
      const message = 'Refusing to remove files without --yes in a non-interactive run.';
      if (json) {
        process.stdout.write(
          `${JSON.stringify(
            uninstallPayload(false, plan.actions, [], { manifestRemoved: false, error: message }),
          )}\n`,
        );
      } else {
        process.stderr.write(
          `${message} Re-run with --yes once the plan above is what you want ` +
            '(or --dry-run to keep looking).\n',
        );
      }
      return 1;
    }
    const confirmed = await promptConfirm('\nRemove these files?', {
      input: process.stdin,
      output: process.stderr,
      isInteractive,
    });
    if (!confirmed) {
      process.stdout.write('Nothing removed.\n');
      return 0;
    }
  }

  let result: ApplyUninstallResult;
  try {
    result = await applyUninstall(repoDir, plan, { detach });
  } catch (error) {
    // Mirrors the `planUninstall` try/catch above, for the same reason: the
    // apply-time hook-protection re-check added in the same change as this
    // comment reads the filesystem again (`regularFileStatus`, `readFile`)
    // OUTSIDE of `applyUninstall`'s own per-file try/catch, so an EACCES or
    // ENOTDIR surfacing from THAT read must not escape as a bare stack trace
    // with no JSON on stdout — `--json` promises exactly one object there
    // regardless of which kind of failure this is.
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      // `removed: []` here is not a guess: EVERY call inside `applyUninstall`
      // that can throw uncaught (`rigOwnedPaths`, the apply-time
      // `protectedHooksFor` pass) runs strictly before its own removal loop
      // starts — that loop wraps every per-file removal in its OWN
      // try/catch and always RETURNS a result (with the real `removed` so
      // far) rather than throwing. So an exception reaching this `catch` can
      // only mean nothing was removed yet. This is a structural property of
      // `applyUninstall`'s own control flow (see the comment immediately
      // above its removal loop), not backed by a test of the hypothetical
      // case, which does not exist today — if a future edit adds a
      // throwing call INSIDE or AFTER that loop, this array would start
      // lying, silently, exactly here.
      process.stdout.write(
        `${JSON.stringify(
          uninstallPayload(false, plan.actions, [], { manifestRemoved: false, error: message }),
        )}\n`,
      );
      return 1;
    }
    if (error instanceof UninstallError) {
      process.stderr.write(`${message}\n`);
      return 1;
    }
    throw error;
  }

  if (result.error !== undefined) {
    if (json) {
      process.stdout.write(
        `${JSON.stringify(
          uninstallPayload(false, plan.actions, result.removed, {
            manifestRemoved: false,
            completed: result.completed,
            remaining: result.remaining,
            error: result.error,
            changedSincePlanning: result.changedSincePlanning,
            protectedHooksAtApply: result.protectedHooksAtApply,
          }),
        )}\n`,
      );
    } else {
      process.stderr.write(
        `\nStopped after a failure: ${result.error}\n` +
          `  completed: ${(result.completed ?? []).join(', ') || '(none)'}\n` +
          `  remaining: ${(result.remaining ?? []).join(', ') || '(none)'}\n` +
          `The manifest was kept — re-run to continue.\n`,
      );
    }
    return 1;
  }

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        uninstallPayload(false, plan.actions, result.removed, {
          manifestRemoved: result.manifestRemoved,
          changedSincePlanning: result.changedSincePlanning,
          protectedHooksAtApply: result.protectedHooksAtApply,
          outcome: result.outcome,
        }),
      )}\n`,
    );
    return 0;
  }

  // The three outcomes `--json` names structurally are said in prose here
  // too, not only encoded in a field: `preserved` below is the IDENTICAL
  // list `uninstallPayload` already built for `--json` above (not a second,
  // separately-maintained computation of the same thing) — the plan's own
  // `preserved` verdicts, any path caught changed only at apply time, and
  // any hook a wiring file's OWN apply-time edit or symlink just protected,
  // each with the reason that pass recorded. All three are equally "left
  // behind", and a report naming only one kind — or naming a count instead
  // of the paths themselves — would read as if the others never happened, or
  // leave an operator with nothing to grep for once the count passes a
  // handful.
  const { preserved } = uninstallPayload(false, plan.actions, result.removed, {
    manifestRemoved: result.manifestRemoved,
    changedSincePlanning: result.changedSincePlanning,
    protectedHooksAtApply: result.protectedHooksAtApply,
    outcome: result.outcome,
  });
  const preservedList = (): string =>
    preserved.map(({ path, reason }) => `  ! ${path}${reason ? ` — ${reason}` : ''}`).join('\n');
  // A roll-up, on top of the per-line reasons, distinguishing what the
  // command actually traced from what it kept only as a precaution — at
  // the scale a symlinked, single-seeded hook dependency can now produce
  // (dozens of paths swept in by caution alone), one line naming the split
  // does more for an operator than reading every reason individually
  // (UX-lens review, RP-181, carried since cycle 5 as the roll-up advisory).
  const unverifiedCount = preserved.filter((p) => isUnverifiedReason(p.reason)).length;
  const rollup =
    unverifiedCount > 0
      ? `  (${preserved.length - unverifiedCount} genuinely referenced or imported; ` +
        `${unverifiedCount} kept only as a precaution — something needed to verify them ` +
        `could not be read)\n`
      : '';
  if (result.outcome === 'detached') {
    process.stdout.write(
      `\nDetached: removed ${result.removed.length} files and the manifest.\n` +
        (preserved.length > 0
          ? `${preserved.length} file(s) left behind — they are yours now, uninstall no longer owns them:\n` +
            rollup +
            `${preservedList()}\n`
          : ''),
    );
  } else if (result.manifestRemoved) {
    process.stdout.write(`\nRemoved ${result.removed.length} files and the manifest.\n`);
  } else {
    // Every removal that was planned succeeded, but something else was
    // preserved (in the plan, or discovered changed at apply time) — the rig
    // still owns bytes it did not remove, so the manifest naming them was
    // kept on purpose, not left behind by a failure. Named, not only
    // counted: a run with the now-larger preserved count a transitive-import
    // walk can produce still needs to be actionable from this one line of
    // output, without re-running `--json` just to learn what survived.
    process.stdout.write(
      `\nRemoved ${result.removed.length} files. ${preserved.length} preserved — the manifest ` +
        `was kept: the rig is still installed.\n${rollup}${preservedList()}\n`,
    );
  }
  // A removal is a working-tree change, not a commit — uninstall never
  // touches git history itself (docs/command-contract.md, "## uninstall
  // (RP-181)"), so nothing here is recorded until a run stages and commits
  // it. Said only when something was actually deleted; a preserved-only or
  // no-op run leaves nothing to stage.
  if (result.removed.length > 0) {
    process.stdout.write('Run `git add -A` and commit to record the removal.\n');
  }
  return 0;
}

async function main(): Promise<number> {
  if (process.argv[2] === 'init') {
    return runInit(process.argv.slice(3));
  }
  if (process.argv[2] === 'setup') {
    return runSetup(process.argv.slice(3));
  }
  if (process.argv[2] === 'upgrade') {
    return runUpgrade(process.argv.slice(3));
  }
  if (process.argv[2] === 'uninstall') {
    return runUninstall(process.argv.slice(3));
  }
  if (process.argv[2] === 'memory') {
    // The consumer path of the RP-19 handshake: manifest → `--version --json`
    // → exit 4 on a foreign major → doctor/load passed through (`load` gains a
    // default `--timeout-ms` when the caller names none — commands/memory.ts).
    const [verb = '', ...args] = process.argv.slice(3);
    const result = await runMemory({ verb, args });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    return result.exitCode;
  }

  let positionals: string[];
  let values: {
    help?: boolean;
    version?: boolean;
    json?: boolean;
    'no-git'?: boolean;
    'no-color'?: boolean;
    layer?: string[];
  };
  try {
    ({ positionals, values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean' },
        // `--json` is read on `--version` alone: the handshake object of
        // docs/command-contract.md, one JSON line and nothing else on stdout.
        json: { type: 'boolean' },
        'no-git': { type: 'boolean' },
        'no-color': { type: 'boolean' },
        layer: { type: 'string', multiple: true },
      },
      allowPositionals: true,
    }));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}\n`);
    return 1;
  }

  if (values.version) {
    if (values.json) {
      process.stdout.write(`${JSON.stringify(await rigHandshake())}\n`);
      return 0;
    }
    process.stdout.write(`${await packageVersion()}\n`);
    return 0;
  }
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const dirArg = positionals[0];
  if (!dirArg || positionals.length > 1) {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }

  const layerResult = resolveLayerFlag(values.layer);
  if ('error' in layerResult) {
    process.stderr.write(`${layerResult.error}\n\n${USAGE}\n`);
    return 1;
  }

  const { projectDir, projectName } = await createProject(dirArg, {
    cwd: process.cwd(),
    git: values['no-git'] !== true,
    withWorkflow: layerResult.withWorkflow,
  });

  const palette = makePalette(
    Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && values['no-color'] !== true,
  );
  const summary = await collectGovernance(projectDir);
  process.stdout.write('\n' + renderSummary(projectName, dirArg, summary, palette));
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (
      error instanceof CreateError ||
      error instanceof InitError ||
      error instanceof UpgradeError ||
      error instanceof UninstallError
    ) {
      process.stderr.write(`${error.message}\n`);
    } else {
      console.error(error); // unexpected: the trace is the diagnostic
    }
    process.exitCode = 1;
  });
