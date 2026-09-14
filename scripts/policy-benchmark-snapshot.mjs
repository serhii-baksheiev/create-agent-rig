import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from './policy-benchmark-runtime.mjs';

export const benchmarkGit = async (root, env, args, input = '') => {
  const result = await runProcess(
    'git',
    ['-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false', ...args],
    { cwd: root, env, input, maxBytes: 32 * 1024 * 1024 },
  );
  if (result.code !== 0 || result.timedOut)
    throw new Error(`benchmark Git failed: ${result.stderr.toString('utf8')}`);
  return result.stdout;
};

export const materializeSnapshot = async ({ root, head, destination, env }) => {
  if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(head))
    throw new Error('snapshot requires a full Git object ID');
  const listing = await benchmarkGit(root, env, [
    'ls-tree',
    '-r',
    '-z',
    '-l',
    '--full-tree',
    head,
    '--',
    'templates/agent-os/universal/.claude',
    'templates/agent-os/universal/.codex',
    '.claude',
    '.codex',
    'contracts/session-messaging/v1',
  ]);
  const entries = listing
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d{6}) (\w+) ([a-f0-9]+) +([\d-]+)\t(.+)$/.exec(line);
      if (!match) throw new Error('invalid Git tree entry');
      return {
        mode: match[1],
        type: match[2],
        oid: match[3],
        size: Number(match[4]),
        name: match[5],
      };
    });
  const prefix = entries.some((entry) => entry.name.startsWith('templates/agent-os/universal/'))
    ? 'templates/agent-os/universal/'
    : '';
  const selected = entries.filter(
    ({ name }) =>
      name.startsWith('contracts/session-messaging/v1/') ||
      ['.claude/hooks/', '.claude/scripts/', '.claude/settings.json', '.codex/hooks.json'].some(
        (surface) =>
          surface.endsWith('/') ? name.startsWith(prefix + surface) : name === prefix + surface,
      ),
  );
  if (
    selected.length > 4096 ||
    selected.reduce((size, entry) => size + entry.size, 0) > 24 * 1024 * 1024
  )
    throw new Error('snapshot size limit exceeded');
  for (const entry of selected) {
    if (entry.mode === '120000') throw new Error('measured Git symlink is not permitted');
    if (!['100644', '100755'].includes(entry.mode) || entry.type !== 'blob')
      throw new Error('snapshot requires regular Git blobs');
    if (
      entry.name.includes('\\') ||
      entry.name.includes(':') ||
      entry.name.includes('\ufffd') ||
      entry.name.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw new Error('unsafe snapshot path');
  }
  const bytes = selected.length
    ? await benchmarkGit(
        root,
        env,
        ['cat-file', '--batch'],
        selected.map((entry) => entry.oid).join('\n') + '\n',
      )
    : Buffer.alloc(0);
  let offset = 0;
  for (const entry of selected) {
    const newline = bytes.indexOf(10, offset);
    const header = bytes.subarray(offset, newline).toString('ascii');
    if (newline < offset || header !== `${entry.oid} blob ${entry.size}`)
      throw new Error('invalid Git blob framing');
    offset = newline + 1;
    const content = bytes.subarray(offset, offset + entry.size);
    if (content.length !== entry.size || bytes[offset + entry.size] !== 10)
      throw new Error('truncated Git blob');
    const target = path.resolve(destination, entry.name);
    const relative = path.relative(path.resolve(destination), target);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('snapshot path escapes destination');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, { flag: 'wx', mode: entry.mode === '100755' ? 0o755 : 0o644 });
    offset += entry.size + 1;
  }
  if (offset !== bytes.length) throw new Error('unexpected Git batch trailing output');
  return {
    root: path.resolve(destination),
    surfaceRoot: path.join(destination, prefix),
    contractRoot: path.join(destination, 'contracts/session-messaging/v1'),
  };
};
