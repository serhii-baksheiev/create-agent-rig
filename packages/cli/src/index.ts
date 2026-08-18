#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { CreateError, createProject } from './commands/create.js';
import { InitError, initFileContents, initProject, planInit } from './commands/init.js';
import { UpgradeError, applyUpgrade, planUpgrade } from './commands/upgrade.js';
import type { UpgradePlan, UpgradeVerdict } from './commands/upgrade.js';
import { makePalette } from './lib/colors.js';
import { readManifest } from './lib/manifest.js';
import { promptConfirm, promptTarget } from './lib/prompts.js';
import { collectGovernance, renderSummary } from './lib/summary.js';
import { DEFAULT_TARGET, TARGET_NAMES } from './lib/targets.js';
import { packageVersion } from './lib/version.js';

const USAGE = `Usage: create-agent-rig <dir> [options]

Scaffolds a new project into <dir>: a Claude Code + Codex agent operating system
plus a runnable code skeleton. Refuses to write into a non-empty directory.

Options
  --target <name>   ${TARGET_NAMES.join(' | ')}
                    (interactive selection when omitted on a terminal;
                    required when not a terminal — default: ${DEFAULT_TARGET})
  --no-git          skip git init + the pristine-template baseline commit
  --no-color        plain output (NO_COLOR is respected too)
  --version         print the version
  -h, --help        this text

Also: create-agent-rig init [--dry-run]
  Install the process layer (rules, gates, stop rules — no architecture
  assumptions) into the CURRENT existing repo. Refuses to clobber CLAUDE.md
  or AGENTS.md.
  --force is deprecated: it refuses and points at upgrade, which refreshes a
  rig file by file. It is removed in 0.6.

Also: create-agent-rig upgrade [--dry-run] [--yes]
  Bring the rig in the CURRENT repo up to this version. Replaces the files it
  installed and you did not touch; everything else is reported, never merged.`;

async function runInit(rawArgs: string[]): Promise<number> {
  let values: { 'dry-run'?: boolean; force?: boolean };
  try {
    ({ values } = parseArgs({
      args: rawArgs,
      options: { 'dry-run': { type: 'boolean' }, force: { type: 'boolean' } },
      allowPositionals: false,
    }));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}\n`);
    return 1;
  }
  const cwd = process.cwd();
  const dryRun = values['dry-run'] === true;

  // `init` adopts a repo the rig knows nothing about. Run inside a rig `create`
  // generated — reachable when its CLAUDE.md was deleted — it is the wrong
  // command: it installs the process layer alone and never refreshes the stack
  // overlays. Say so before anything is written, so it is visible on --dry-run
  // too.
  //
  // It is a manifest read, so a pre-0.4.0 rig with no manifest gets no advisory
  // even when it came from `create` — the same limit `recordInstall` carries,
  // and stated in both places because either one alone reads as wider.
  const existing = await readManifest(cwd);

  const plan = await planInit(cwd);
  process.stdout.write(
    `agent-rig init — process layer into ${cwd}\n\n` +
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

  const result = await initProject(cwd, { dryRun, force: values.force === true });
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
};

function renderUpgradePlan(repoDir: string, plan: UpgradePlan): string {
  const of = (verdict: UpgradeVerdict) => plan.actions.filter((a) => a.verdict === verdict);
  const lines: string[] = [
    `agent-rig upgrade — ${plan.kind} rig in ${repoDir}`,
    plan.bootstrapped
      ? `  no manifest here (a pre-0.4.0 rig) — matching files against released versions`
      : `  installed by ${plan.fromVersion}`,
    `  upgrading to ${plan.toVersion}`,
    '',
  ];

  for (const verdict of ['update', 'new', 'deleted', 'conflict', 'wiring'] as const) {
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

  const unchanged = of('unchanged').length;
  lines.push(
    '',
    `  ${of('update').length} to replace, ${of('new').length} new, ` +
      `${of('conflict').length} yours (kept), ${unchanged} already current`,
  );
  return `${lines.join('\n')}\n`;
}

async function runUpgrade(rawArgs: string[]): Promise<number> {
  let values: { 'dry-run'?: boolean; yes?: boolean };
  try {
    ({ values } = parseArgs({
      args: rawArgs,
      options: { 'dry-run': { type: 'boolean' }, yes: { type: 'boolean' } },
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
  if (plan.wiring !== null) {
    process.stdout.write(
      `\n!  .claude/settings.json was handed over rather than replaced — the reason is\n` +
        `   on its line above. It is where your own hooks live, so it is never\n` +
        `   overwritten on anything but proof the rig wrote those exact bytes.\n` +
        `   This version wires them like this; merge in what is missing:\n\n` +
        plan.wiring.replace(/^/gm, '   ') +
        '\n',
    );
  }

  if (values['dry-run'] === true) {
    process.stdout.write('\nDry run — nothing written.\n');
    return 0;
  }

  // The plan above is the review step, so it has to be answered before
  // anything is written. On a terminal that is a question; off one it is the
  // same refusal `create` makes without --target — never guess for a run that
  // cannot be asked, least of all when the answer rewrites its repository.
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
  return 0;
}

async function main(): Promise<number> {
  if (process.argv[2] === 'init') {
    return runInit(process.argv.slice(3));
  }
  if (process.argv[2] === 'upgrade') {
    return runUpgrade(process.argv.slice(3));
  }

  let positionals: string[];
  let values: {
    help?: boolean;
    target?: string;
    version?: boolean;
    'no-git'?: boolean;
    'no-color'?: boolean;
  };
  try {
    ({ positionals, values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        help: { type: 'boolean', short: 'h' },
        target: { type: 'string' },
        version: { type: 'boolean' },
        'no-git': { type: 'boolean' },
        'no-color': { type: 'boolean' },
      },
      allowPositionals: true,
    }));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}\n`);
    return 1;
  }

  if (values.version) {
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

  // Non-TTY correctness (polish brief §5): never prompt into a pipe — a
  // prompt would hang CI. Non-interactive runs must state the target.
  const isInteractive = Boolean(process.stdin.isTTY && process.stderr.isTTY);
  let target = values.target;
  if (!target) {
    if (!isInteractive) {
      process.stderr.write(
        `Missing --target in a non-interactive run. ` +
          `Pass --target <${TARGET_NAMES.join('|')}>.\n`,
      );
      return 1;
    }
    target = await promptTarget(TARGET_NAMES, DEFAULT_TARGET, {
      input: process.stdin,
      output: process.stderr,
      isInteractive,
    });
  }

  const { projectDir, projectName } = await createProject(dirArg, {
    cwd: process.cwd(),
    target,
    git: values['no-git'] !== true,
  });

  const palette = makePalette(
    Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && values['no-color'] !== true,
  );
  const summary = await collectGovernance(projectDir);
  process.stdout.write('\n' + renderSummary(projectName, target, dirArg, summary, palette));
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
      error instanceof UpgradeError
    ) {
      process.stderr.write(`${error.message}\n`);
    } else {
      console.error(error); // unexpected: the trace is the diagnostic
    }
    process.exitCode = 1;
  });
