import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, it } from 'vitest';
import { WebStack } from '../lib/web-stack.js';

// The web stack is stateless serving only: a private bucket behind CloudFront.
// The bundle itself is synced by the deploy step (see README) — synth stays
// independent of `next build`.
//
// Synthesised lazily rather than in a `beforeAll`, like its neighbours in this
// directory: `vitest.config.ts` raises `testTimeout` and leaves `hookTimeout`
// at 10 s, so a hook is the one place in the suite running on a short fuse.
// This stack bundles no Lambda and takes ~370 ms — the reason to do it anyway
// is that the next person copies whatever shape is here.
let cached: Template | undefined;
const template = () => (cached ??= Template.fromStack(new WebStack(new App(), 'TestWebStack')));

describe('web serving stack', () => {
  it('keeps the bucket fully private', () => {
    template().hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: Match.objectLike({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      }),
    });
  });

  it('serves through CloudFront with origin access control', () => {
    template().resourceCountIs('AWS::CloudFront::Distribution', 1);
    template().resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    template().hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: 'index.html',
      }),
    });
  });

  it('exports the distribution domain and bucket name for the deploy step', () => {
    template().hasOutput('WebBucketName', {});
    template().hasOutput('WebUrl', {});
  });
});
