// CD brief §2: node-service's deployable artifact must actually build and run.
// This bundles the server, boots the bundle over a real socket, and closes the
// path — proving the artifact is genuine, not a stub.
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const dist = path.join(projectRoot, 'dist');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

describe('deployable artifact (dist/)', () => {
  let child: ReturnType<typeof spawn> | undefined;
  let work: string;

  beforeAll(async () => {
    work = await mkdtemp(path.join(tmpdir(), 'artifact-'));
    // `pnpm check` builds the artifact before tests; build it here only if a
    // bare `pnpm test` run left no dist to boot.
    const built = await stat(path.join(dist, 'server.mjs')).then(
      () => true,
      () => false,
    );
    if (!built) await exec('pnpm', ['build:artifact'], { cwd: projectRoot });
  }, 180_000);

  afterAll(async () => {
    child?.kill();
    await rm(work, { recursive: true, force: true });
  });

  it('produces a bundled server and the web public dir', async () => {
    expect((await stat(path.join(dist, 'server.mjs'))).size).toBeGreaterThan(1000);
    await expect(readFile(path.join(dist, 'public', 'index.html'), 'utf8')).resolves.toContain(
      '<',
    );
  });

  it('the bundle boots and serves the full request path', async () => {
    const port = await freePort();
    child = spawn(process.execPath, [path.join(dist, 'server.mjs')], {
      env: {
        ...process.env,
        PORT: String(port),
        DATA_DIR: path.join(work, 'data'),
        QUEUE_DIR: path.join(work, 'queue'),
        STATIC_DIR: path.join(dist, 'public'),
      },
      stdio: 'ignore',
    });

    const base = `http://127.0.0.1:${port}`;
    // wait for readiness
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(base + '/notes');
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    const created = await fetch(base + '/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'artifact proof' }),
    });
    expect(created.status).toBe(201);
    const listed = (await (await fetch(base + '/notes')).json()) as { notes: unknown[] };
    expect(listed.notes).toHaveLength(1);
    // the bundle also serves the web shell
    const root = await fetch(base + '/');
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toContain('text/html');
  }, 30_000);
});
