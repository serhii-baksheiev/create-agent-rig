// Builds the deployable artifact: a bundled server plus the web public dir,
// into dist/. It produces a real, runnable thing — it does not ship it
// anywhere. Run it: STATIC_DIR=dist/public node dist/server.mjs
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  entryPoints: [path.join(root, 'services', 'api', 'src', 'main.ts')],
  outfile: path.join(dist, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // ESM-on-node output may reference require() from a dependency — shim it.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});

// The built web bundle, if present (pnpm build:web). Served via STATIC_DIR.
await cp(path.join(root, 'apps', 'web', 'out'), path.join(dist, 'public'), {
  recursive: true,
}).catch(() => {});

console.log('artifact built: dist/server.mjs (+ dist/public if the web was built).');
console.log('run it: STATIC_DIR=dist/public node dist/server.mjs');
