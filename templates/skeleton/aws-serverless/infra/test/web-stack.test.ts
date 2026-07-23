import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, it } from 'vitest';
import { WebStack } from '../lib/web-stack.js';

// The web stack is stateless serving only: a private bucket behind CloudFront.
// The bundle itself is synced by the deploy step (see README) — synth stays
// independent of `next build`.
let template: Template;

beforeAll(() => {
  template = Template.fromStack(new WebStack(new App(), 'TestWebStack'));
});

describe('web serving stack', () => {
  it('keeps the bucket fully private', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: Match.objectLike({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      }),
    });
  });

  it('serves through CloudFront with origin access control', () => {
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: 'index.html',
      }),
    });
  });

  it('exports the distribution domain and bucket name for the deploy step', () => {
    template.hasOutput('WebBucketName', {});
    template.hasOutput('WebUrl', {});
  });
});
