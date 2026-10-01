import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, lstatSync, openSync, readFileSync, readlinkSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { withoutGitLocation } from '../git-env.mjs';

const safeGitPath = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 512 &&
  !isAbsolute(value) &&
  !value.split(/[\\/]/).some((part) => part === '' || part === '.' || part === '..');

const decodeGitPathList = (bytes, label) => {
  if (bytes.length > 0 && bytes.at(-1) !== 0) throw new Error(`${label} is not NUL terminated`);
  const paths = [];
  for (const encoded of bytes.toString('binary').split('\0').slice(0, -1)) {
    let file;
    try {
      file = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(encoded, 'binary'));
    } catch {
      throw new Error(`${label} contains an undecodable Git path`);
    }
    if (!safeGitPath(file)) throw new Error(`${label} contains an unsafe or over-bound Git path`);
    paths.push(file);
  }
  return paths;
};

const gitBytes = ({ projectRoot, args, label, maxBytes }) => {
  try {
    return execFileSync('git', ['-C', projectRoot, ...args], {
      encoding: 'buffer',
      env: withoutGitLocation(),
      maxBuffer: maxBytes,
    });
  } catch {
    throw new Error(`${label} could not be read`);
  }
};

const untrackedBytes = ({ projectRoot, file, remainingBytes }) => {
  let current = projectRoot;
  for (const part of file.split('/').slice(0, -1)) {
    current = join(current, part);
    const directory = lstatSync(current);
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new Error('untracked Git path has a symlink or non-directory ancestor');
    }
  }
  const fullPath = join(projectRoot, file);
  const stat = lstatSync(fullPath);
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(fullPath, { encoding: 'buffer' });
    if (target.length > remainingBytes) throw new Error('working-tree state exceeds its byte bound');
    return { kind: 'symlink', bytes: target };
  }
  if (!stat.isFile()) throw new Error('untracked Git path is not a regular file');
  if (stat.size > remainingBytes) throw new Error('working-tree state exceeds its byte bound');
  const fd = openSync(fullPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const bytes = readFileSync(fd);
    const finished = lstatSync(fullPath);
    if (!finished.isFile() || finished.isSymbolicLink() || finished.dev !== stat.dev || finished.ino !== stat.ino) {
      throw new Error('untracked Git path changed during validation');
    }
    if (bytes.length > remainingBytes) throw new Error('working-tree state exceeds its byte bound');
    return { kind: 'file', bytes };
  } finally {
    closeSync(fd);
  }
};

// A check boundary covers the index and untracked files as well as Git's
// ordinary worktree diff. It writes only a bounded digest to the run journal.
export const workingTreeStateFingerprint = ({ projectRoot, gitHead, maxBytes }) => {
  if (!/^[a-f0-9]{40}$/.test(gitHead ?? '')) throw new Error('working-tree state has no valid Git HEAD');
  const digest = createHash('sha256');
  let consumed = 0;
  const include = (label, bytes) => {
    consumed += bytes.length;
    if (consumed > maxBytes) throw new Error('working-tree state exceeds its byte bound');
    digest.update(`${label}\0${bytes.length}\0`);
    digest.update(bytes);
  };
  include(
    'worktree-diff',
    gitBytes({
      projectRoot,
      args: ['diff', '--binary', '--no-ext-diff', '--no-textconv', gitHead, '--'],
      label: 'working-tree Git diff',
      maxBytes,
    }),
  );
  include(
    'index-diff',
    gitBytes({
      projectRoot,
      args: ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', gitHead, '--'],
      label: 'index Git diff',
      maxBytes,
    }),
  );
  const untracked = decodeGitPathList(
    gitBytes({
      projectRoot,
      args: ['ls-files', '--others', '--exclude-standard', '-z'],
      label: 'untracked Git paths',
      maxBytes,
    }),
    'untracked Git paths',
  )
    .filter((file) => !file.startsWith('node_modules/'))
    .sort();
  if (untracked.length > 256) throw new Error('working-tree state exceeds 256 untracked paths');
  include('untracked-count', Buffer.from(String(untracked.length)));
  for (const file of untracked) {
    include('untracked-path', Buffer.from(file));
    const state = untrackedBytes({ projectRoot, file, remainingBytes: maxBytes - consumed });
    include('untracked-kind', Buffer.from(state.kind));
    include('untracked-content', state.bytes);
  }
  return { algorithm: 'sha256', value: digest.digest('hex') };
};
