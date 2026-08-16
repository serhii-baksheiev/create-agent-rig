import type { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';

// `bin/app.ts` is what every `cdk deploy` and every CI run actually builds, so
// the CORS allow-list has to be correct THERE — a stack that can be handed the
// right origin, by an entrypoint that hands it none, ships an app whose own
// browser calls are blocked. The README's `curl` health check sends no `Origin`
// header, so nothing downstream notices.
//
// The composition is exercised through the entrypoint rather than rebuilt here:
// a test that re-wires the stacks itself passes just as happily while
// `bin/app.ts` stays broken.
let appStackOrigins: unknown[];

beforeAll(async () => {
  const { createApp } = (await import('../bin/app.js')) as { createApp: () => App };
  const app = createApp();
  const template = Template.fromStack(app.node.findChild('AppStack') as Stack);
  const apis = template.findResources('AWS::ApiGatewayV2::Api');
  appStackOrigins = Object.values(apis).flatMap(
    (api) =>
      (api.Properties as { CorsConfiguration?: { AllowOrigins?: unknown[] } }).CorsConfiguration
        ?.AllowOrigins ?? [],
  );
});

/** What CDK emits for a cross-stack reference: a Join around an ImportValue. */
const referencesTheWebDistribution = (origin: unknown): boolean => {
  if (typeof origin === 'string') return false; // a hard-coded origin, whatever it says
  const rendered = JSON.stringify(origin);
  return /Fn::ImportValue/.test(rendered) && /WebStack/.test(rendered);
};

describe('the deployed app allows the origin it is actually served from', () => {
  it('takes its allowed origin from the web distribution, not from a localhost no deploy uses', () => {
    // `distributionDomainName` is a synth-time token; CDK resolves it across
    // stacks as an `Fn::ImportValue`, and `AllowOrigins` accepts it. So the
    // entrypoint has no excuse to leave the two stacks unwired.
    expect(appStackOrigins.length).toBeGreaterThan(0);
    expect(appStackOrigins.some(referencesTheWebDistribution)).toBe(true);
  });

  it('still names who may call it: no wildcard reaches the composed app', () => {
    expect(appStackOrigins).not.toContain('*');
    expect(JSON.stringify(appStackOrigins)).not.toContain('"*"');
  });

  it('carries the https scheme, without which no browser Origin header can match', () => {
    const distributionOrigin = appStackOrigins.find(referencesTheWebDistribution);
    expect(JSON.stringify(distributionOrigin)).toContain('https://');
  });
});
