import { CfnResource, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as logs from 'aws-cdk-lib/aws-logs';

// No L2 construct exists for Lambda Web Functions; this wraps the three CloudFormation resources.
// The endpoint API only accepts these throttle values.
export const ALLOWED_RATE_LIMITS = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000];

export class WebFunction extends Construct {
  constructor(scope, id, { functionName, bucket, key, role, environment, timeoutSeconds = 30, maxEnvironments, rateLimit }) {
    super(scope, id);
    // The endpoint API rejects fewer than 2 environments.
    if (!Number.isInteger(maxEnvironments) || maxEnvironments < 2) {
      throw new Error(`maxEnvironments ${maxEnvironments} must be an integer >= 2`);
    }
    if (!ALLOWED_RATE_LIMITS.includes(rateLimit)) {
      throw new Error(`rateLimit ${rateLimit} is not one of ${ALLOWED_RATE_LIMITS.join(', ')}`);
    }

    const logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: `/aws/lambda/web/${functionName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      // Deleted with the stack, so a rolled-back or destroyed stack can be redeployed without a name clash.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const fn = new CfnResource(this, 'Function', {
      type: 'AWS::Lambda::WebFunction',
      properties: { FunctionName: functionName },
    });
    fn.node.addDependency(logGroup);

    // Immutable: a new Key (content hash) replaces the revision and shifts the endpoint to it.
    const revision = new CfnResource(this, 'Revision', {
      type: 'AWS::Lambda::WebFunctionRevision',
      properties: {
        FunctionName: functionName, // bare name, never the ARN
        BuildConfig: {
          CodeConfig: { S3Object: { Bucket: bucket, Key: key } },
          RuntimeConfig: { Runtime: 'nodejs24.x' },
        },
        ServiceConfig: {
          ExecutionRoleArn: role.roleArn,
          TimeoutSeconds: timeoutSeconds,
          EnvironmentVariables: { NODE_ENV: 'production', ...environment },
          TelemetryConfig: { LoggingConfig: { LogGroup: logGroup.logGroupName, ApplicationLogLevel: 'INFO', SystemLogLevel: 'WARN' } },
        },
      },
    });
    revision.addDependency(fn);
    // The app calls AWS at init, so the role's inline policies must exist before the revision starts.
    revision.node.addDependency(role);

    const endpoint = new CfnResource(this, 'Endpoint', {
      type: 'AWS::Lambda::WebFunctionEndpoint',
      properties: {
        FunctionName: functionName,
        EndpointName: 'default',
        EndpointType: 'HomeRegion',
        AuthType: 'ApplicationManaged',
        RevisionWeights: [{ RevisionId: revision.getAtt('RevisionId'), Weight: 100 }],
        ScalingConfig: { MaxEnvironments: maxEnvironments },
        ThrottleConfig: { RateLimit: rateLimit },
      },
    });
    endpoint.addDependency(revision);

    this.domainName = endpoint.getAtt('DomainName').toString();
  }
}
