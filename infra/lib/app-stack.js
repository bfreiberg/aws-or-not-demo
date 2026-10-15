import { Stack, RemovalPolicy, CfnOutput, Duration } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { WebFunction } from './web-function.js';

const CLIENT_ID_PARAM = '/quiz-aws-or-not/admin-client-id';

const leadingKeys = (keys) => ({ 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': keys } });

function webRole(scope, id, roleName) {
  return new iam.Role(scope, id, {
    roleName,
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
  });
}

export class AppStack extends Stack {
  constructor(scope, id, { codeBucket, gameKey, adminKey, siteDomain, ...props }) {
    super(scope, id, props);

    const table = new dynamodb.TableV2(this, 'Table', {
      tableName: 'aws-or-not',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand({ maxReadRequestUnits: 400, maxWriteRequestUnits: 200 }),
      timeToLiveAttribute: 'expiresAt',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
      globalSecondaryIndexes: [{
        indexName: 'GSI1',
        partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
        maxReadRequestUnits: 400,
        maxWriteRequestUnits: 200,
      }],
    });
    const indexArn = `${table.tableArn}/index/GSI1`;

    const ipSalt = new secretsmanager.Secret(this, 'IpSalt', {
      description: 'Salt for hashing client IPs (aws-or-not leaderboard cap)',
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });

    // Game: read everything it needs, write only its own key prefixes, never CONFIG.
    const gameRole = webRole(this, 'GameRole', 'aws-or-not-game-web-role');
    gameRole.addToPolicy(new iam.PolicyStatement({ actions: ['dynamodb:GetItem', 'dynamodb:BatchGetItem'], resources: [table.tableArn] }));
    gameRole.addToPolicy(new iam.PolicyStatement({ actions: ['dynamodb:Query'], resources: [indexArn] }));
    gameRole.addToPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:PutItem'], resources: [table.tableArn], conditions: leadingKeys(['RUN#*', 'RESULT#*']),
    }));
    gameRole.addToPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:UpdateItem'], resources: [table.tableArn], conditions: leadingKeys(['QSTAT#*', 'DAY#*', 'RATE#*']),
    }));
    ipSalt.grantRead(gameRole);
    // Constructed ARN so both roles can read the CloudFront origin-verify secret from us-east-1.
    // Using a literal us-east-1 region because the secret always lives there (CloudFront is global).
    const originVerifyArn = `arn:aws:secretsmanager:us-east-1:${this.account}:secret:aws-or-not/origin-verify-*`;
    gameRole.addToPolicy(new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: [originVerifyArn] }));

    // Admin: read stats and leaderboards, write CONFIG, update RESULT# (leaderboard removal).
    const adminRole = webRole(this, 'AdminRole', 'aws-or-not-admin-web-role');
    adminRole.addToPolicy(new iam.PolicyStatement({ actions: ['dynamodb:GetItem', 'dynamodb:BatchGetItem'], resources: [table.tableArn] }));
    adminRole.addToPolicy(new iam.PolicyStatement({ actions: ['dynamodb:Query'], resources: [indexArn] }));
    adminRole.addToPolicy(new iam.PolicyStatement({ actions: ['dynamodb:PutItem'], resources: [table.tableArn], conditions: leadingKeys(['CONFIG']) }));
    adminRole.addToPolicy(new iam.PolicyStatement({ actions: ['dynamodb:UpdateItem'], resources: [table.tableArn], conditions: leadingKeys(['RESULT#*']) }));
    // Constructed ARN (not param.parameterArn) to avoid a dependency cycle through the admin revision.
    adminRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${CLIENT_ID_PARAM}`],
    }));
    adminRole.addToPolicy(new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: [originVerifyArn] }));

    const pool = new cognito.UserPool(this, 'AdminPool', {
      userPoolName: 'aws-or-not-admins',
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: { otp: true, sms: false },
      passwordPolicy: { minLength: 14 },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    new cognito.CfnUserPoolGroup(this, 'AdminsGroup', { userPoolId: pool.userPoolId, groupName: 'admins' });
    const domain = pool.addDomain('Domain', { cognitoDomain: { domainPrefix: `or-not-quiz-${this.account}` } });

    const PUBLIC_ORIGIN = `https://${siteDomain}`;
    const ORIGIN_SECRET_ID = 'aws-or-not/origin-verify';

    const game = new WebFunction(this, 'Game', {
      functionName: 'aws-or-not-game',
      bucket: codeBucket,
      key: gameKey,
      role: gameRole,
      environment: {
        TABLE_NAME: table.tableName,
        IP_SALT_SECRET_ARN: ipSalt.secretArn,
        PUBLIC_ORIGIN,
        ORIGIN_SECRET_ID,
      },
      maxEnvironments: 3,
      rateLimit: 100,
    });

    const admin = new WebFunction(this, 'Admin', {
      functionName: 'aws-or-not-admin',
      bucket: codeBucket,
      key: adminKey,
      role: adminRole,
      environment: {
        TABLE_NAME: table.tableName,
        USER_POOL_ID: pool.userPoolId,
        COGNITO_DOMAIN: domain.baseUrl(),
        CLIENT_ID_PARAM,
        PUBLIC_ORIGIN,
        ORIGIN_SECRET_ID,
      },
      maxEnvironments: 2,
      rateLimit: 100,
    });

    // Set retention on the platform-created .local log groups (pre-exist in live accounts).
    new logs.LogRetention(this, 'GameLocalLogRetention', {
      logGroupName: '/aws/lambda/web/aws-or-not-game.local',
      retention: logs.RetentionDays.ONE_MONTH,
    });
    new logs.LogRetention(this, 'AdminLocalLogRetention', {
      logGroupName: '/aws/lambda/web/aws-or-not-admin.local',
      retention: logs.RetentionDays.ONE_MONTH,
    });

    const client = pool.addClient('AdminClient', {
      generateSecret: false,
      authFlows: {},
      preventUserExistenceErrors: true,
      idTokenValidity: Duration.hours(1),
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: [`https://${admin.domainName}/admin/callback`, `${PUBLIC_ORIGIN}/admin/callback`, 'http://localhost:3001/admin/callback'],
        logoutUrls: [`https://${admin.domainName}/admin/signed-out`, `${PUBLIC_ORIGIN}/admin/signed-out`, 'http://localhost:3001/admin/signed-out'],
      },
    });
    new ssm.StringParameter(this, 'AdminClientId', { parameterName: CLIENT_ID_PARAM, stringValue: client.userPoolClientId });

    new CfnOutput(this, 'GameUrl', { value: `https://${game.domainName}` });
    new CfnOutput(this, 'AdminUrl', { value: `https://${admin.domainName}/admin` });
    new CfnOutput(this, 'UserPoolId', { value: pool.userPoolId });
    new CfnOutput(this, 'CognitoDomain', { value: domain.baseUrl() });
    new CfnOutput(this, 'TableName', { value: table.tableName });
  }
}
