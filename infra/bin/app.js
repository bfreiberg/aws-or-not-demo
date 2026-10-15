import { App } from 'aws-cdk-lib';
import { CodeStack } from '../lib/code-stack.js';
import { AppStack } from '../lib/app-stack.js';
import { GuardStack } from '../lib/guard-stack.js';
import { EdgeStack } from '../lib/edge-stack.js';
import { loadDeployConfig } from '../lib/config.js';

const app = new App();
// Pinned: the caller's AWS_REGION/CDK_DEFAULT_REGION must not move the stacks.
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.DEPLOY_REGION ?? 'us-east-1' };

new CodeStack(app, 'AwsOrNotCode', { env });
// Guard, App and Edge need the deployment-specific values in infra/deploy-config.json (gitignored).
const config = loadDeployConfig();
const needConfig = (stack) => {
  if (!config) throw new Error(`${stack} needs infra/deploy-config.json. Copy infra/deploy-config.example.json and fill it in.`);
  return config;
};

if (config) new GuardStack(app, 'AwsOrNotGuard', { env, alertEmail: config.alertEmail, budgetUsd: config.budgetUsd });

const codeBucket = app.node.tryGetContext('codeBucket');
if (codeBucket) {
  new AppStack(app, 'AwsOrNotApp', {
    env,
    codeBucket,
    gameKey: app.node.getContext('gameKey'),
    adminKey: app.node.getContext('adminKey'),
    siteDomain: needConfig('AwsOrNotApp').domain,
  });
}

// CloudFront certificates and CLOUDFRONT-scoped WAF must be in us-east-1, whatever DEPLOY_REGION is.
// The endpoint hostnames come from the AwsOrNotApp outputs via -c (no cross-region references).
const gameDomain = app.node.tryGetContext('gameDomain');
const adminDomain = app.node.tryGetContext('adminDomain');
if (gameDomain && adminDomain) {
  new EdgeStack(app, 'AwsOrNotEdge', {
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
    gameDomain,
    adminDomain,
    domain: needConfig('AwsOrNotEdge').domain,
    hostedZoneId: config.hostedZoneId,
    hostedZoneName: config.hostedZoneName,
  });
}
