import { describe, it, expect } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { GuardStack } from '../lib/guard-stack.js';

const env = { account: '111111111111', region: 'eu-central-1' };
const app = new App();
const stack = new GuardStack(app, 'TestGuard', { env, alertEmail: 'alerts@example.com', budgetUsd: 20 });
const t = Template.fromStack(stack);

describe('GuardStack – budget', () => {
  it('creates a monthly COST budget of $20 USD', () => {
    t.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: {
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        BudgetLimit: { Amount: 20, Unit: 'USD' },
      },
    });
  });

  it('has a 50% ACTUAL notification with email subscriber', () => {
    const budgets = Object.values(t.findResources('AWS::Budgets::Budget'));
    const notifications = budgets[0].Properties.NotificationsWithSubscribers;
    const n50 = notifications.find(
      (n) => n.Notification.NotificationType === 'ACTUAL' && n.Notification.Threshold === 50,
    );
    expect(n50).toBeDefined();
    expect(n50.Notification.ComparisonOperator).toBe('GREATER_THAN');
    expect(n50.Subscribers.some((s) => s.SubscriptionType === 'EMAIL')).toBe(true);
  });

  it('has an 80% ACTUAL notification with email subscriber', () => {
    const budgets = Object.values(t.findResources('AWS::Budgets::Budget'));
    const notifications = budgets[0].Properties.NotificationsWithSubscribers;
    const n80 = notifications.find(
      (n) => n.Notification.NotificationType === 'ACTUAL' && n.Notification.Threshold === 80,
    );
    expect(n80).toBeDefined();
    expect(n80.Subscribers.some((s) => s.SubscriptionType === 'EMAIL')).toBe(true);
  });

  it('has a 100% FORECASTED notification with email subscriber', () => {
    const budgets = Object.values(t.findResources('AWS::Budgets::Budget'));
    const notifications = budgets[0].Properties.NotificationsWithSubscribers;
    const n100f = notifications.find(
      (n) => n.Notification.NotificationType === 'FORECASTED' && n.Notification.Threshold === 100,
    );
    expect(n100f).toBeDefined();
    expect(n100f.Subscribers.some((s) => s.SubscriptionType === 'EMAIL')).toBe(true);
  });

  it('has a 100% ACTUAL notification with both email and SNS subscribers', () => {
    const budgets = Object.values(t.findResources('AWS::Budgets::Budget'));
    const notifications = budgets[0].Properties.NotificationsWithSubscribers;
    const n100a = notifications.find(
      (n) => n.Notification.NotificationType === 'ACTUAL' && n.Notification.Threshold === 100,
    );
    expect(n100a).toBeDefined();
    expect(n100a.Subscribers.some((s) => s.SubscriptionType === 'EMAIL')).toBe(true);
    expect(n100a.Subscribers.some((s) => s.SubscriptionType === 'SNS')).toBe(true);
  });
});

describe('GuardStack – SNS topic policy', () => {
  it('allows budgets.amazonaws.com to publish with aws:SourceAccount condition', () => {
    t.hasResourceProperties('AWS::SNS::TopicPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Principal: { Service: 'budgets.amazonaws.com' },
            Action: 'sns:Publish',
            Condition: {
              StringEquals: { 'aws:SourceAccount': '111111111111' },
            },
          }),
        ]),
      },
    });
  });
});

describe('GuardStack – kill-switch IAM', () => {
  it('grants UpdateWebFunctionEndpoint and GetWebFunctionEndpoint on aws-or-not-* resources', () => {
    const policies = Object.values(t.findResources('AWS::IAM::Policy'))
      .filter((p) => {
        const roles = p.Properties?.Roles ?? [];
        return roles.some((r) => {
          const ref = r?.Ref ?? '';
          return ref.startsWith('KillSwitch') || ref.includes('KillSwitch');
        });
      });

    expect(policies.length).toBeGreaterThan(0);

    const statements = policies.flatMap((p) => p.Properties.PolicyDocument.Statement);
    const killStatement = statements.find((s) =>
      [s.Action].flat().some((a) => a === 'lambda:UpdateWebFunctionEndpoint'),
    );
    expect(killStatement).toBeDefined();

    // Resources must be scoped to aws-or-not-* only
    const resources = [killStatement.Resource].flat().map((r) => JSON.stringify(r));
    for (const r of resources) {
      expect(r).toContain('aws-or-not-');
    }
  });
});

describe('GuardStack – Lambda runtime and architecture', () => {
  it('uses Node.js 24 runtime on arm64', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
    });
  });

  it('sets a 30-second timeout', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      Timeout: 30,
    });
  });
});

describe('GuardStack budget scope', () => {
  it('counts only the app services, not the registrar, Bedrock or tax', async () => {
    const { APP_SERVICES } = await import('../lib/guard-stack.js');
    const budget = Object.values(t.findResources('AWS::Budgets::Budget'))[0].Properties.Budget;
    expect(budget.CostFilters).toEqual({ Service: APP_SERVICES });
    expect(APP_SERVICES).toContain('AWS Lambda');
    expect(APP_SERVICES).not.toContain('Amazon Registrar');
    expect(APP_SERVICES.some((s) => /bedrock|claude|tax/i.test(s))).toBe(false);
  });
});
