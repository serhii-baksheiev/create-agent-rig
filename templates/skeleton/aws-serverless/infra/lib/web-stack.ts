// Stateless serving for the static web export: a private S3 bucket behind
// CloudFront. Deliberately no BucketDeployment construct — synth must never
// depend on `next build` having run. The bundle ships via `aws s3 sync`
// (see README), keeping the stack small and the dependency one-way.
import { CfnOutput, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { Distribution, ViewerProtocolPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { BlockPublicAccess, Bucket } from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

export class WebStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const bucket = new Bucket(this, 'WebBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      // Skeleton default: destroyable. Flip to RETAIN before real traffic.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const distribution = new Distribution(this, 'WebDistribution', {
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      defaultRootObject: 'index.html',
    });

    new CfnOutput(this, 'WebBucketName', { value: bucket.bucketName });
    new CfnOutput(this, 'WebUrl', { value: `https://${distribution.domainName}` });
    // The upload step needs this to invalidate the edge cache: a synced bucket
    // whose distribution still serves the old objects has not deployed.
    new CfnOutput(this, 'WebDistributionId', { value: distribution.distributionId });
  }
}
