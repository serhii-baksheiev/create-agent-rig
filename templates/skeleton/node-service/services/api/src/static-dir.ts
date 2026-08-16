// Where the built web bundle lives, resolved relative to the composition root.
// A pure function rather than an inline expression in main.ts: main.ts is wiring
// that tests never import, and this resolution has a bug worth pinning —
// `new URL(url).pathname` leaves percent-escapes in place (a checkout under
// "/Users/a b/" resolves to "/Users/a%20b/") and prefixes a slash on Windows.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** `apps/web/out`, three levels up from a module in `services/api/src`. */
export function defaultStaticDirFor(moduleUrl: string): string {
  return path.resolve(
    path.dirname(fileURLToPath(moduleUrl)),
    '..',
    '..',
    '..',
    'apps',
    'web',
    'out',
  );
}
