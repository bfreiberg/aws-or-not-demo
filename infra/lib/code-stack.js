import { Stack, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';

export class CodeStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    const bucket = new s3.Bucket(this, 'CodeBucket', {
      bucketName: `aws-or-not-code-${this.account}`,
      versioned: true,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    bucket.addToResourcePolicy(new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal('lambda.amazonaws.com')],
      actions: ['s3:GetObject', 's3:GetObjectVersion'],
      resources: [bucket.arnForObjects('*')],
      conditions: {
        StringEquals: { 'aws:SourceAccount': this.account },
        ArnLike: { 'aws:SourceArn': `arn:aws:lambda:${this.region}:${this.account}:web-function/*` },
      },
    }));
    new CfnOutput(this, 'BucketName', { value: bucket.bucketName });
  }
}
