import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { AppStack } from '../lib/app-stack.js';

// `Template.fromStack` bundles the Lambda entries with esbuild — slow-ish, so
// it runs once and is shared. Deliberately not in `beforeAll`: this project's
// `vitest.config.ts` raises `testTimeout` for exactly this cost and leaves
// `hookTimeout` at vitest's 10s default, so the same work in a hook runs on a
// much shorter fuse — and it is contended, because sibling workers are
// bundling too.
let synthesised: Template | undefined;
const template = (): Template =>
  (synthesised ??= Template.fromStack(new AppStack(new App(), 'TestStack')));

describe('storage', () => {
  it('creates the single table with pk/sk and on-demand billing', () => {
    template().hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    });
    template().resourceCountIs('AWS::DynamoDB::Table', 1);
  });
});

describe('queue discipline', () => {
  it('wires the DLQ with maxReceiveCount 3', () => {
    template().hasResourceProperties('AWS::SQS::Queue', {
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
    });
  });

  it('alarms as soon as one message reaches the DLQ', () => {
    template().hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'ApproximateNumberOfMessagesVisible',
      Threshold: 1,
      EvaluationPeriods: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
    });
  });

  it('feeds the worker one message at a time', () => {
    template().hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 1,
    });
  });
});

describe('functions and routes', () => {
  it('deploys exactly the create, list and worker functions — one purpose each', () => {
    template().resourceCountIs('AWS::Lambda::Function', 3);
  });

  it('passes table and queue to the api via environment', () => {
    template().hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          TABLE_NAME: Match.anyValue(),
          QUEUE_URL: Match.anyValue(),
        }),
      },
    });
  });

  it('exposes exactly two routes: POST /notes and GET /notes', () => {
    template().hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /notes',
    });
    template().hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'GET /notes',
    });
    template().resourceCountIs('AWS::ApiGatewayV2::Route', 2);
  });

  it('allows the browser origin in: CORS is configured', () => {
    template().hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: Match.objectLike({
        AllowMethods: Match.arrayWith(['GET', 'POST']),
      }),
    });
  });

  it('never allows every origin: the api names who may call it', () => {
    const apis = template().findResources('AWS::ApiGatewayV2::Api');
    const origins = Object.values(apis).flatMap(
      (api) =>
        (api.Properties as { CorsConfiguration?: { AllowOrigins?: unknown[] } }).CorsConfiguration
          ?.AllowOrigins ?? [],
    );

    // A starter multiplies whatever it ships: `*` here becomes the default of
    // every project generated from it. The web bundle has a known origin.
    expect(origins.length).toBeGreaterThan(0);
    expect(origins).not.toContain('*');
  });
});

describe('least-privilege IAM', () => {
  it('grants writes to the creator, reads to the lister, queue send — nothing broad', () => {
    const policies = template().findResources('AWS::IAM::Policy');
    const statements = Object.values(policies).flatMap(
      (policy) =>
        (policy.Properties as { PolicyDocument: { Statement: Array<Record<string, unknown>> } })
          .PolicyDocument.Statement,
    );
    const actions = statements.flatMap((s) =>
      Array.isArray(s.Action) ? (s.Action as string[]) : [s.Action as string],
    );

    expect(actions).toContain('dynamodb:PutItem');
    expect(actions).toContain('dynamodb:Scan'); // the list function reads
    expect(actions).toContain('sqs:SendMessage');
    // Least privilege: nothing broad.
    expect(actions).not.toContain('dynamodb:*');
    expect(actions.some((a) => a === '*')).toBe(false);
  });
});
