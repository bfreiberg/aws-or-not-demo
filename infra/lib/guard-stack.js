import * as path from 'node:path';
import * as url from 'node:url';
import { Stack, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

// Cost Explorer SERVICE dimension values (aws ce get-dimension-values --dimension SERVICE).
export const APP_SERVICES = [
  'AWS Lambda', 'Amazon DynamoDB', 'Amazon CloudFront', 'CloudFront Flat-Rate Plans', 'AWS WAF',
  'AmazonCloudWatch', 'AWS Secrets Manager', 'Amazon Cognito', 'Amazon Simple Storage Service',
  'Amazon Simple Notification Service', 'AWS Key Management Service', 'AWS Systems Manager',
  'AWS Data Transfer', 'Amazon Route 53',
];

export class GuardStack extends Stack {
  constructor(scope, id, { alertEmail, budgetUsd, ...props }) {
    super(scope, id, props);

    // ── SNS topic for 100% ACTUAL alert ──────────────────────────────────────
    const alertTopic = new sns.Topic(this, 'BudgetAlertTopic', {
      topicName: 'aws-or-not-budget-alert',
    });

    // Allow budgets.amazonaws.com to publish, scoped to this account.
    const budgetPublishPermission = alertTopic.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowBudgetsPublish',
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('budgets.amazonaws.com')],
      actions: ['sns:Publish'],
      resources: [alertTopic.topicArn],
      conditions: {
        StringEquals: { 'aws:SourceAccount': this.account },
      },
    }));

    // Email subscription for the 100% ACTUAL SNS notification.
    alertTopic.addSubscription(new snsSubscriptions.EmailSubscription(alertEmail));

    // ── Kill-switch Lambda ────────────────────────────────────────────────────
    const killSwitchLogGroup = new logs.LogGroup(this, 'KillSwitchLogs', {
      logGroupName: '/aws/lambda/aws-or-not-kill-switch',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const killSwitch = new NodejsFunction(this, 'KillSwitch', {
      functionName: 'aws-or-not-kill-switch',
      entry: path.join(__dirname, '../functions/kill-switch/index.mjs'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.seconds(30),
      logGroup: killSwitchLogGroup,
      bundling: {
        // Bundle the @aws-sdk/client-lambda-web dependency (not in Lambda runtime).
        externalModules: [],
        nodeModules: ['@aws-sdk/client-lambda-web'],
      },
    });

    // IAM: allow get + update on aws-or-not-* web functions in this account/region.
    const webFunctionArnPrefix = `arn:aws:lambda:${this.region}:${this.account}:web-function/aws-or-not-*`;
    const webFunctionArnWildcard = `arn:aws:lambda:${this.region}:${this.account}:web-function/aws-or-not-*/*`;
    killSwitch.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'lambda:UpdateWebFunctionEndpoint',
        'lambda:GetWebFunctionEndpoint',
      ],
      resources: [webFunctionArnPrefix, webFunctionArnWildcard],
    }));

    // Subscribe the kill-switch to the SNS topic.
    const killSwitchSubscription = alertTopic.addSubscription(new snsSubscriptions.LambdaSubscription(killSwitch));

    // ── Budget ────────────────────────────────────────────────────────────────
    const monthlyBudget = new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: 'aws-or-not-monthly',
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: {
          amount: budgetUsd,
          unit: 'USD',
        },
        // Only the services the app runs on, so account-wide charges (domain registration under
        // "Amazon Registrar", Bedrock content generation, tax) never trip the kill switch.
        costFilters: { Service: APP_SERVICES },
      },
      notificationsWithSubscribers: [
        // 50% ACTUAL – email only
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 50,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [
            { subscriptionType: 'EMAIL', address: alertEmail },
          ],
        },
        // 80% ACTUAL – email only
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 80,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [
            { subscriptionType: 'EMAIL', address: alertEmail },
          ],
        },
        // 100% FORECASTED – email only
        {
          notification: {
            notificationType: 'FORECASTED',
            comparisonOperator: 'GREATER_THAN',
            threshold: 100,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [
            { subscriptionType: 'EMAIL', address: alertEmail },
          ],
        },
        // 100% ACTUAL – email + SNS (triggers kill switch)
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 100,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [
            { subscriptionType: 'EMAIL', address: alertEmail },
            { subscriptionType: 'SNS', address: alertTopic.topicArn },
          ],
        },
      ],
    });
    // Budget creation validates SNS access and can immediately send its first alert.
    // The function dependency includes its SNS invoke permission and execution policies.
    monthlyBudget.node.addDependency(budgetPublishPermission.policyDependable, killSwitch, killSwitchSubscription);
  }
}
