import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { AppStack } from '../lib/app-stack.js';

// Template.fromStack bundles the Lambda entries with esbuild — slow-ish, run once.
let template: Template;

beforeAll(() => {
  const app = new App();
  template = Template.fromStack(new AppStack(app, 'TestStack'));
});

describe('storage', () => {
  it('creates the single table with pk/sk and on-demand billing', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    });
    template.resourceCountIs('AWS::DynamoDB::Table', 1);
  });
});

describe('queue discipline', () => {
  it('wires the DLQ with maxReceiveCount 3', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
    });
  });

  it('alarms as soon as one message reaches the DLQ', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'ApproximateNumberOfMessagesVisible',
      Threshold: 1,
      EvaluationPeriods: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
    });
  });

  it('feeds the worker one message at a time', () => {
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 1,
    });
  });
});

describe('functions and route', () => {
  it('deploys exactly the api and worker functions', () => {
    template.resourceCountIs('AWS::Lambda::Function', 2);
  });

  it('passes table and queue to the api via environment', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          TABLE_NAME: Match.anyValue(),
          QUEUE_URL: Match.anyValue(),
        }),
      },
    });
  });

  it('exposes exactly one route: POST /notes', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /notes',
    });
    template.resourceCountIs('AWS::ApiGatewayV2::Route', 1);
  });
});

describe('least-privilege IAM', () => {
  it('grants the api writes (no reads, no deletes beyond the write set) and queue send', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const statements = Object.values(policies).flatMap(
      (policy) =>
        (policy.Properties as { PolicyDocument: { Statement: Array<Record<string, unknown>> } })
          .PolicyDocument.Statement,
    );
    const actions = statements.flatMap((s) =>
      Array.isArray(s.Action) ? (s.Action as string[]) : [s.Action as string],
    );

    expect(actions).toContain('dynamodb:PutItem');
    expect(actions).toContain('sqs:SendMessage');
    // Least privilege: nothing broad, nothing destructive.
    expect(actions).not.toContain('dynamodb:*');
    expect(actions).not.toContain('dynamodb:Scan');
    expect(actions).not.toContain('dynamodb:GetItem');
    expect(actions.some((a) => a === '*')).toBe(false);
  });
});
