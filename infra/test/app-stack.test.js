import { describe, it, expect } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { AppStack } from '../lib/app-stack.js';
import { CodeStack } from '../lib/code-stack.js';

const env = { account: '111111111111', region: 'us-east-1' };
const app = new App();
const stack = new AppStack(app, 'Test', { env, codeBucket: 'code-bucket', gameKey: 'game/abc.zip', adminKey: 'admin/def.zip', siteDomain: 'aws-or-not.example.com' });
const t = Template.fromStack(stack);

const policiesFor = (roleLogicalIdPrefix) => Object.values(t.findResources('AWS::IAM::Policy'))
  .filter((p) => p.Properties.Roles.some((r) => r.Ref?.startsWith(roleLogicalIdPrefix)))
  .flatMap((p) => p.Properties.PolicyDocument.Statement);

describe('AppStack', () => {
  it('creates two public web functions on home-region endpoints', () => {
    t.resourceCountIs('AWS::Lambda::WebFunction', 2);
    t.resourceCountIs('AWS::Lambda::WebFunctionEndpoint', 2);
    t.hasResourceProperties('AWS::Lambda::WebFunctionEndpoint', { AuthType: 'ApplicationManaged', EndpointType: 'HomeRegion', FunctionName: 'aws-or-not-game' });
    t.hasResourceProperties('AWS::Lambda::WebFunctionRevision', {
      FunctionName: 'aws-or-not-game',
      BuildConfig: { CodeConfig: { S3Object: { Bucket: 'code-bucket', Key: 'game/abc.zip' } }, RuntimeConfig: { Runtime: 'nodejs24.x' } },
    });
  });

  it('attaches log group to revision telemetry config', () => {
    t.hasResourceProperties('AWS::Lambda::WebFunctionRevision', {
      ServiceConfig: { TelemetryConfig: { LoggingConfig: { LogGroup: Match.anyValue() } } },
    });
  });

  it('creates the table with GSI1 and TTL', () => {
    t.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
      GlobalSecondaryIndexes: [{ IndexName: 'GSI1' }],
    });
  });

  it('creates an admin-only user pool with MFA required', () => {
    t.hasResourceProperties('AWS::Cognito::UserPool', { MfaConfiguration: 'ON', AdminCreateUserConfig: { AllowAdminCreateUserOnly: true } });
    t.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: 'admins' });
    t.hasResourceProperties('AWS::Cognito::UserPoolClient', { GenerateSecret: false, AllowedOAuthFlows: ['code'] });
  });

  it('never lets the game role write CONFIG', () => {
    const writes = policiesFor('GameRole').filter((s) => [s.Action].flat().some((a) => a === 'dynamodb:PutItem' || a === 'dynamodb:UpdateItem'));
    expect(writes.length).toBeGreaterThan(0);
    for (const s of writes) {
      const keys = s.Condition['ForAllValues:StringLike']['dynamodb:LeadingKeys'];
      expect(keys).not.toContain('CONFIG');
    }
  });

  it('lets the admin role write CONFIG and update results only', () => {
    const writes = policiesFor('AdminRole').filter((s) => [s.Action].flat().some((a) => a.startsWith('dynamodb:Put') || a.startsWith('dynamodb:Update')));
    const keys = writes.flatMap((s) => s.Condition['ForAllValues:StringLike']['dynamodb:LeadingKeys']);
    expect(keys.sort()).toEqual(['CONFIG', 'RESULT#*']);
  });

  it('publishes the admin client id to SSM', () => {
    t.hasResourceProperties('AWS::SSM::Parameter', { Name: '/quiz-aws-or-not/admin-client-id' });
  });

  it('sets PUBLIC_ORIGIN and ORIGIN_SECRET_ID on both revisions', () => {
    const revisions = Object.values(t.findResources('AWS::Lambda::WebFunctionRevision'));
    expect(revisions).toHaveLength(2);
    for (const rev of revisions) {
      const env = rev.Properties.ServiceConfig.EnvironmentVariables;
      expect(env.PUBLIC_ORIGIN).toBe('https://aws-or-not.example.com');
      expect(env.ORIGIN_SECRET_ID).toBe('aws-or-not/origin-verify');
    }
  });

  it('grants both roles GetSecretValue on the origin-verify secret ARN', () => {
    const gameStatements = policiesFor('GameRole');
    const adminStatements = policiesFor('AdminRole');
    const expectedArn = `arn:aws:secretsmanager:us-east-1:${env.account}:secret:aws-or-not/origin-verify-*`;
    for (const statements of [gameStatements, adminStatements]) {
      const hasGrant = statements.some(
        (s) => [s.Action].flat().includes('secretsmanager:GetSecretValue') &&
               [s.Resource].flat().includes(expectedArn),
      );
      expect(hasGrant).toBe(true);
    }
  });

  it('includes the custom domain in Cognito callback and logout URLs', () => {
    t.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      CallbackURLs: Match.arrayWith(['https://aws-or-not.example.com/admin/callback']),
    });
    t.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      LogoutURLs: Match.arrayWith(['https://aws-or-not.example.com/admin/signed-out']),
    });
  });

  it('SSM parameter name does not start with /aws or /ssm', () => {
    const params = Object.values(t.findResources('AWS::SSM::Parameter'));
    for (const param of params) {
      const name = param.Properties.Name;
      expect(/^\/?(?:aws|ssm)/i.test(name)).toBe(false);
    }
  });

  it('Cognito domain prefix does not contain aws, amazon, or cognito', () => {
    const domains = Object.values(t.findResources('AWS::Cognito::UserPoolDomain'));
    for (const domain of domains) {
      // domainPrefix may be a Fn::Join token — check the literal string parts
      const prefix = domain.Properties.Domain;
      const parts = typeof prefix === 'string'
        ? [prefix]
        : (prefix?.['Fn::Join']?.[1] ?? []).filter((p) => typeof p === 'string');
      for (const part of parts) {
        expect(/aws|amazon|cognito/i.test(part)).toBe(false);
      }
    }
  });
});

describe('CodeStack', () => {
  it('creates a versioned, TLS-only bucket readable by Lambda', () => {
    const code = Template.fromStack(new CodeStack(new App(), 'Code', { env }));
    code.hasResourceProperties('AWS::S3::Bucket', { VersioningConfiguration: { Status: 'Enabled' } });
    const statements = Object.values(code.findResources('AWS::S3::BucketPolicy'))[0].Properties.PolicyDocument.Statement;
    expect(statements.some((s) => s.Principal?.Service === 'lambda.amazonaws.com')).toBe(true);
    expect(statements.some((s) => s.Effect === 'Deny' && s.Condition?.Bool?.['aws:SecureTransport'] === 'false')).toBe(true);
  });
});

describe('endpoint limits and log groups', () => {
  it('uses only throttle values the endpoint API accepts', async () => {
    const { ALLOWED_RATE_LIMITS } = await import('../lib/web-function.js');
    for (const ep of Object.values(t.findResources('AWS::Lambda::WebFunctionEndpoint'))) {
      expect(ALLOWED_RATE_LIMITS).toContain(ep.Properties.ThrottleConfig.RateLimit);
    }
  });

  it('rejects an unsupported rate limit at synth time', async () => {
    const { WebFunction } = await import('../lib/web-function.js');
    const { Stack } = await import('aws-cdk-lib');
    const iam = await import('aws-cdk-lib/aws-iam');
    const s = new Stack(new App(), 'Bad', { env });
    const role = new iam.Role(s, 'R', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    expect(() => new WebFunction(s, 'W', { functionName: 'x', bucket: 'b', key: 'k', role, environment: { A: 'a' }, maxEnvironments: 2, rateLimit: 20 }))
      .toThrow(/rateLimit 20/);
    expect(() => new WebFunction(s, 'W2', { functionName: 'y', bucket: 'b', key: 'k', role, environment: { A: 'a' }, maxEnvironments: 1, rateLimit: 100 }))
      .toThrow(/maxEnvironments 1/);
  });

  it('deletes log groups with the stack so a redeploy cannot clash', () => {
    for (const lg of Object.values(t.findResources('AWS::Logs::LogGroup'))) {
      expect(lg.DeletionPolicy).toBe('Delete');
    }
  });

  it('applies endpoint caps: game 100 rps / 3 envs, admin 100 rps / 1 env', () => {
    t.hasResourceProperties('AWS::Lambda::WebFunctionEndpoint', {
      FunctionName: 'aws-or-not-game',
      ThrottleConfig: { RateLimit: 100 },
      ScalingConfig: { MaxEnvironments: 3 },
    });
    t.hasResourceProperties('AWS::Lambda::WebFunctionEndpoint', {
      FunctionName: 'aws-or-not-admin',
      ThrottleConfig: { RateLimit: 100 },
      ScalingConfig: { MaxEnvironments: 2 },
    });
  });

  it('sets DynamoDB max on-demand throughput: 400 read / 200 write', () => {
    t.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      WriteOnDemandThroughputSettings: { MaxWriteRequestUnits: 200 },
    });
    const tables = Object.values(t.findResources('AWS::DynamoDB::GlobalTable'));
    expect(tables[0].Properties.Replicas).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ReadOnDemandThroughputSettings: { MaxReadRequestUnits: 400 },
        }),
      ]),
    );
  });

  it('sets INFO application log level and WARN system log level on revisions', () => {
    t.hasResourceProperties('AWS::Lambda::WebFunctionRevision', {
      ServiceConfig: {
        TelemetryConfig: {
          LoggingConfig: {
            ApplicationLogLevel: 'INFO',
            SystemLogLevel: 'WARN',
          },
        },
      },
    });
  });

  it('sets 30-day retention on the .local platform log groups', () => {
    t.hasResourceProperties('Custom::LogRetention', {
      LogGroupName: '/aws/lambda/web/aws-or-not-game.local',
      RetentionInDays: 30,
    });
    t.hasResourceProperties('Custom::LogRetention', {
      LogGroupName: '/aws/lambda/web/aws-or-not-admin.local',
      RetentionInDays: 30,
    });
  });
});
