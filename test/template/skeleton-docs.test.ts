import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// A skeleton teaches by example, so an unstated failure mode is copied forward
// as if it were a design. These pin the tradeoffs the templates ship WITH —
// the claim has to survive an edit, or it quietly disappears.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (target: string, ...parts: string[]) =>
  readFile(path.join(repoRoot, 'templates', 'skeleton', target, ...parts), 'utf8');

describe('aws-serverless is honest about the dual write in create-note', () => {
  it('the README names the failure mode: a failed publish leaves a note with no event', async () => {
    const readme = await read('aws-serverless', 'README.md');
    expect(readme, 'the two writes are named as such').toMatch(
      /dual[- ]write|not atomic|two writes/i,
    );
    expect(
      readme,
      'and what it costs: the put succeeded, the publish did not, nothing compensates',
    ).toMatch(/(publish|event)[^.]{0,200}(fail|error)|(fail|error)[^.]{0,200}(publish|event)/i);
    expect(readme, 'and the way out, so the reader is not left with a shrug').toMatch(
      /outbox|compensat|retry/i,
    );
  });

  it('the usecase carries the warning where the two writes actually happen', async () => {
    // A reader who never opens the README still edits this file.
    const usecase = await read('aws-serverless', 'services/api/src/usecases/create-note.ts');
    expect(usecase).toMatch(/dual[- ]write|not atomic|two writes/i);
    expect(usecase).toMatch(/outbox|compensat/i);
  });
});

// The deploy workflow now ships the bundle itself. A README written before that
// step existed describes a deploy that no longer happens, and — worse — sets up
// a role that cannot perform the one that does.
describe('aws-serverless deploy docs match the deploy that actually runs', () => {
  const readme = () => read('aws-serverless', 'README.md');

  it('names the extra IAM permissions the upload step needs beyond a CDK deploy role', async () => {
    // A correctly-minimal OIDC role for `cdk deploy` has none of these, so the
    // first real deploy fails at the upload — after both stacks are already up.
    const content = await readme();
    for (const permission of [
      's3:PutObject',
      's3:DeleteObject',
      's3:ListBucket',
      'cloudfront:CreateInvalidation',
    ]) {
      expect(content, `the README never mentions ${permission}`).toContain(permission);
    }
  });

  it('invalidates the edge cache on the manual path too', async () => {
    // `web-stack.ts` states it outright: "a synced bucket whose distribution
    // still serves the old objects has not deployed". A manual path that stops
    // at `aws s3 sync` contradicts the stack it deploys.
    const content = await readme();
    const manual = content.slice(content.indexOf('### Local / manual'));
    expect(manual, 'the manual section is where the hand-run commands live').toMatch(/aws s3 sync/);
    expect(manual).toMatch(/create-invalidation/);
    // and against the same distribution the stack outputs, not a pasted id
    expect(manual).toMatch(/WebDistributionId/);
  });

  it('builds the bundle in the manual path, since --delete makes a stale one destructive', async () => {
    // The workflow builds two steps before its sync and so cannot be stale; a
    // hand-run is exactly where a month-old `out/` sits, and `--delete` then
    // removes every newer object from the live bucket. Checking for the bundle
    // is not enough — the check passes on the stale one.
    const content = await readme();
    const manual = content.slice(content.indexOf('### Local / manual'));
    expect(manual, 'the manual path never builds what it is about to sync').toMatch(/build:web/);
    expect(manual.indexOf('build:web'), 'it builds before it syncs').toBeLessThan(
      manual.indexOf('aws s3 sync'),
    );
  });

  it('names the build-time API URL the bundle needs, on both the CI and the hand path', async () => {
    // `apps/web/src/lib/api.ts` reads `process.env.NEXT_PUBLIC_API_URL ?? ''`,
    // inlined at build time, and `web-stack.ts` gives the distribution exactly
    // one behaviour — the S3 origin. So an unset variable ships a bundle that
    // POSTs `/notes` at its own CDN and never reaches API Gateway. The README's
    // health check curls the API directly, so it reports healthy over a dead
    // site: this is the failure mode a doc has to name, because nothing else does.
    const content = await readme();
    expect(
      content,
      'the variable the bundle is compiled against is never named, so "nothing to configure" is unverifiable',
    ).toContain('NEXT_PUBLIC_API_URL');

    const automated = content.slice(
      content.indexOf('### Dev — automated'),
      content.indexOf('### Local / manual'),
    );
    expect(automated, 'the CI path feeds it from the API_URL repo variable').toContain('API_URL');

    // The hand path builds with `pnpm build:web` and then `--delete`-syncs the
    // result over what was live, so a bare build is not a missing convenience:
    // it replaces a working site with one whose API base is the empty string.
    const manual = content.slice(content.indexOf('### Local / manual'));
    expect(manual, 'the manual build runs bare, with no API base to compile in').toContain(
      'NEXT_PUBLIC_API_URL',
    );
    expect(
      manual.indexOf('NEXT_PUBLIC_API_URL'),
      'it has to be set no later than the build that inlines it',
    ).toBeLessThan(manual.indexOf('build:web'));
  });

  it('tells the reader whether CI ships the bundle or they must sync it by hand', async () => {
    const content = await readme();
    const automated = content.slice(
      content.indexOf('### Dev — automated'),
      content.indexOf('### Local / manual'),
    );
    expect(automated.length, 'the automated-deploy section must exist to be read').toBeGreaterThan(
      0,
    );
    expect(automated, 'the upload of the built bundle is unnamed').toMatch(
      /uploads?|syncs?|s3 sync/i,
    );
    expect(automated, 'the cache invalidation is unnamed').toMatch(/invalidat/i);
  });
});
