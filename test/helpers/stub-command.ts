/**
 * A command stub on PATH that works on every platform the suite runs on.
 *
 * The code under test spawns `gh` (and friends) with `execFileSync(name, …)`
 * — no shell. On POSIX a `#!/bin/sh` script named `gh` on PATH answers that.
 * On Windows it does not: CreateProcess resolves a bare name to `gh.exe`
 * only, a `.cmd` shim is not executed without a shell, and a shell script is
 * never executed at all (AR-138, AR-140 — why six test files' gh/git stubs
 * kept them on the windows-unit exclusion list; AR-93).
 *
 * So on win32 the stub IS a real executable: a copy of the running node
 * binary named `<name>.exe`, plus `NODE_OPTIONS=--require <preload>` — the
 * preload runs before node resolves its main script, sees that it is running
 * as `<name>`, answers from the handler, and exits. Any other node child
 * under the same NODE_OPTIONS sees a basename that is not `<name>` and
 * returns at once. Measured in `test/template/stub-command.test.ts`.
 *
 * Limit: node reads the stub's first argument before the preload runs, so an
 * invocation whose first word is a node flag (`--version`, `-c`) is answered
 * by node, not the handler. No caller here starts with one.
 *
 * The handler is JavaScript source (a function body receiving `args`, the
 * argv after the command name, and returning `{ stdout?, exitCode? }` or
 * writing to stdout itself), so one description serves both platforms.
 */
import { chmod, copyFile, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export type StubHandle = {
  /** The directory to prepend to PATH. */
  bin: string;
  /** The environment additions the stub needs (PATH prefix, NODE_OPTIONS on win32). */
  env: Record<string, string>;
  /** Restore process.env to what it was. */
  restore: () => void;
};

const preloadSource = (name: string, handlerBody: string): string => `'use strict';
const path = require('node:path');
// win32: the binary itself is named after the command; POSIX: the shell
// wrapper marks the exec with an environment variable. Either way an
// ordinary node child under the same NODE_OPTIONS matches neither.
const isStub =
  path.basename(process.execPath).replace(/\\.exe$/i, '') === ${JSON.stringify(name)} ||
  process.env.__STUB_COMMAND === ${JSON.stringify(name)};
if (!isStub) {
  // not the stub
} else {
  // node has already turned argv[1] into an absolute path; the command's own
  // first word is its basename
  const raw = process.argv.slice(1);
  const args = raw.length ? [path.basename(raw[0]), ...raw.slice(1)] : [];
  const handler = (args) => { ${handlerBody}
  };
  const out = handler(args) || {};
  if (out.stdout) process.stdout.write(out.stdout);
  process.exit(out.exitCode ?? 0);
}
`;

/**
 * Install a stub for `name` on PATH for the rest of the test, with a handler
 * written as a JS function body over `args`. Returns the handle; call
 * `restore()` in `finally`.
 */
export const stubCommand = async (name: string, handlerBody: string): Promise<StubHandle> => {
  // The name reaches a shell line and NODE_OPTIONS unquoted; a word is all a
  // command name needs to be.
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(`stubCommand: a command name is a word, got ${JSON.stringify(name)}`);
  }
  const bin = await realpath(await mkdtemp(path.join(tmpdir(), `stub-${name}-`)));
  const preload = path.join(bin, `${name}.preload.cjs`);
  await writeFile(preload, preloadSource(name, handlerBody));
  const savedPath = process.env['PATH'];
  const savedNodeOptions = process.env['NODE_OPTIONS'];
  const env: Record<string, string> = {};
  if (process.platform === 'win32') {
    await copyFile(process.execPath, path.join(bin, `${name}.exe`));
    // Forward slashes: NODE_OPTIONS strips a backslash inside its quotes —
    // measured on windows-latest at 9c0eb9c, where the preload path arrived as
    // `C:UsersrunneradminAppData...` (AR-93) — and node accepts a forward-slash
    // path there.
    const preloadForOptions = preload.replace(/\\/g, '/');
    env['NODE_OPTIONS'] = [savedNodeOptions, `--require "${preloadForOptions}"`]
      .filter(Boolean)
      .join(' ');
  } else {
    // exec, not `node`: the handler runs in the same binary the test runs in
    await writeFile(
      path.join(bin, name),
      `#!/bin/sh\n__STUB_COMMAND=${name} NODE_OPTIONS="${[savedNodeOptions, `--require \\"${preload}\\"`].filter(Boolean).join(' ')}" exec "${process.execPath}" "$@"\n`,
    );
    await chmod(path.join(bin, name), 0o755);
  }
  env['PATH'] = `${bin}${path.delimiter}${savedPath ?? ''}`;
  Object.assign(process.env, env);
  return {
    bin,
    env,
    restore: () => {
      process.env['PATH'] = savedPath;
      if (savedNodeOptions === undefined) delete process.env['NODE_OPTIONS'];
      else process.env['NODE_OPTIONS'] = savedNodeOptions;
    },
  };
};
