import type { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

// `bin/app.ts` is what every `cdk deploy` and every CI run actually builds, so
// the CORS allow-list has to be correct THERE — a stack that can be handed the
// right origin, by an entrypoint that hands it none, ships an app whose own
// browser calls are blocked. The README's `curl` health check sends no `Origin`
// header, so nothing downstream notices.
//
// The composition is exercised through the entrypoint rather than rebuilt here:
// a test that re-wires the stacks itself passes just as happily while
// `bin/app.ts` stays broken.

const originsOfComposedApp = async (): Promise<unknown[]> => {
  const { createApp } = (await import('../bin/app.js')) as { createApp: () => App };
  const app = createApp();
  const template = Template.fromStack(app.node.findChild('AppStack') as Stack);
  const apis = template.findResources('AWS::ApiGatewayV2::Api');
  return Object.values(apis).flatMap(
    (api) =>
      (api.Properties as { CorsConfiguration?: { AllowOrigins?: unknown[] } }).CorsConfiguration
        ?.AllowOrigins ?? [],
  );
};

/**
 * `createApp()` builds its own `App`, so `new App({ context })` is not a seam
 * here. CDK's own is: the CLI passes `-c key=value` to a synth through
 * `CDK_CONTEXT_JSON`, which the `App` constructor reads — so setting it around
 * one `createApp()` call reproduces `cdk deploy -c allowedOrigins=…` exactly,
 * without the test knowing anything about how the stacks are wired.
 *
 * `process.env` is process-global, so this seam is not concurrency-safe: an
 * `it.concurrent` in this file would have one case's context leak into
 * another's synth. Keep these cases sequential.
 */
const withCdkContext = async <T>(context: Record<string, unknown>, run: () => Promise<T>) => {
  const previous = process.env.CDK_CONTEXT_JSON;
  process.env.CDK_CONTEXT_JSON = JSON.stringify(context);
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.CDK_CONTEXT_JSON;
    else process.env.CDK_CONTEXT_JSON = previous;
  }
};

/**
 * The default composition is synthesised once and shared — but deliberately
 * NOT from `beforeAll`. This project's `vitest.config.ts` raises `testTimeout`
 * for exactly this cost and leaves `hookTimeout` at vitest's 10s default, so
 * work put in a hook runs on a fuse a quarter the length of the one the config
 * meant to give it. Synthesising here bundles three Lambdas with esbuild while
 * sibling workers do the same; that contention is what made this suite fail
 * intermittently with `Hook timed out in 10000ms`.
 */
let defaultComposition: Promise<unknown[]> | undefined;
const defaultComposedOrigins = (): Promise<unknown[]> =>
  (defaultComposition ??= originsOfComposedApp());

/** What CDK emits for a cross-stack reference: a Join around an ImportValue. */
const referencesTheWebDistribution = (origin: unknown): boolean => {
  if (typeof origin === 'string') return false; // a hard-coded origin, whatever it says
  const rendered = JSON.stringify(origin);
  return /Fn::ImportValue/.test(rendered) && /WebStack/.test(rendered);
};

describe('the deployed app allows the origin it is actually served from', () => {
  it('takes its allowed origin from the web distribution, not from a localhost no deploy uses', async () => {
    // `distributionDomainName` is a synth-time token; CDK resolves it across
    // stacks as an `Fn::ImportValue`, and `AllowOrigins` accepts it. So the
    // entrypoint has no excuse to leave the two stacks unwired.
    const appStackOrigins = await defaultComposedOrigins();
    expect(appStackOrigins.length).toBeGreaterThan(0);
    expect(appStackOrigins.some(referencesTheWebDistribution)).toBe(true);
  });

  it('still names who may call it: no wildcard reaches the composed app', async () => {
    const appStackOrigins = await defaultComposedOrigins();
    expect(appStackOrigins).not.toContain('*');
    expect(JSON.stringify(appStackOrigins)).not.toContain('"*"');
  });

  it('carries the https scheme, without which no browser Origin header can match', async () => {
    const appStackOrigins = await defaultComposedOrigins();
    const distributionOrigin = appStackOrigins.find(referencesTheWebDistribution);
    expect(JSON.stringify(distributionOrigin)).toContain('https://');
  });
});

// The README and `AppStackProps.allowedOrigins` both advertise
// `-c allowedOrigins=https://…` as the way to point the API at a custom domain.
// It once did not work: the entrypoint passed `allowedOrigins` unconditionally
// and props win, so the flag was discarded on synth with no error and no
// warning — a green deploy, a CORS-blocked browser, and `allowOrigins: ['*']`
// as the obvious repair for a hurried reader. That is the regression the rest
// of this file exists to prevent, arriving through a different door, which is
// why the door is pinned here.
describe('the documented -c escape hatch reaches the composed app', () => {
  it('serves the origin the flag names instead of discarding it for the CloudFront import', async () => {
    const origins = await withCdkContext({ allowedOrigins: 'https://custom.example.com' }, () =>
      originsOfComposedApp(),
    );

    expect(origins).toContain('https://custom.example.com');
    expect(
      origins.some(referencesTheWebDistribution),
      'a custom domain that still allows only the CloudFront import is a blocked browser',
    ).toBe(false);
  });
});

// Two files read the same context key, and they once disagreed by one value:
// the entrypoint asked `override === undefined` while `resolveAllowedOrigins`
// treated `undefined` OR `null` as "nothing given". A `null` — writable in
// `cdk.json`, `cdk.context.json` or `CDK_CONTEXT_JSON`, though never producible
// by the `-c` flag — landed in the gap, and the entrypoint dropped the wired
// origin as if an override existed while the stack fell back to a localhost no
// deploy is served from. Green synth, blocked browser: this branch's whole
// failure class. One predicate now, imported; this pins that it stays one.
describe('a context that names no origin is not an override', () => {
  it('keeps the wired CloudFront origin when allowedOrigins is present but null', async () => {
    const origins = await withCdkContext({ allowedOrigins: null }, () => originsOfComposedApp());

    expect(
      origins.some(referencesTheWebDistribution),
      'a null context must compose exactly like no context at all',
    ).toBe(true);
    expect(origins).not.toContain('http://localhost:3000');
  });
});
