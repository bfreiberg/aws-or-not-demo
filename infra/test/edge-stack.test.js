import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { describe, it, expect } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { EdgeStack, hostOf } from '../lib/edge-stack.js';

const env = { account: '111111111111', region: 'us-east-1' };
const app = new App();
const stack = new EdgeStack(app, 'TestEdge', {
  env,
  domain: 'aws-or-not.example.com',
  hostedZoneId: 'Z0123456789EXAMPLE',
  hostedZoneName: 'example.com',
  gameDomain: 'game.q2l.lambda-web.eu-central-1.on.aws',
  adminDomain: 'https://admin.q2l.lambda-web.eu-central-1.on.aws/admin',
});
const t = Template.fromStack(stack);
const json = t.toJSON();
const dist = Object.values(t.findResources('AWS::CloudFront::Distribution'))[0].Properties.DistributionConfig;
const rules = Object.values(t.findResources('AWS::WAFv2::WebACL'))[0].Properties.Rules;
const rule = (name) => rules.find((r) => r.Name === name);
const behavior = (path) => dist.CacheBehaviors.find((b) => b.PathPattern === path);
const logicalId = (type, pred = () => true) =>
  Object.entries(t.findResources(type)).find(([, r]) => pred(r.Properties))[0];

describe('hostOf', () => {
  it('strips scheme and path', () => {
    expect(hostOf('https://a.example/admin')).toBe('a.example');
    expect(hostOf('a.example')).toBe('a.example');
  });
});

describe('EdgeStack – secret and certificate', () => {
  it('generates the origin-verify secret by name, 48 chars, no punctuation', () => {
    t.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'aws-or-not/origin-verify',
      GenerateSecretString: { PasswordLength: 48, ExcludePunctuation: true },
    });
  });

  it('requests a DNS-validated certificate for the custom domain', () => {
    t.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'aws-or-not.example.com',
      ValidationMethod: 'DNS',
      DomainValidationOptions: [{ DomainName: 'aws-or-not.example.com', HostedZoneId: 'Z0123456789EXAMPLE' }],
    });
  });
});

describe('EdgeStack – WAF', () => {
  it('is CLOUDFRONT scoped, default allow, 4 rules (within the Free plan limit of 5)', () => {
    t.hasResourceProperties('AWS::WAFv2::WebACL', { Scope: 'CLOUDFRONT', DefaultAction: { Allow: {} } });
    expect(rules).toHaveLength(4);
    for (const r of rules) {
      expect(r.VisibilityConfig).toMatchObject({ CloudWatchMetricsEnabled: true, SampledRequestsEnabled: true });
    }
    expect(new Set(rules.map((r) => r.Priority)).size).toBe(4);
  });

  it('blocks more than 500 requests / 5 min per IP', () => {
    const r = rule('RateLimitPerIp');
    expect(r.Action).toEqual({ Block: {} });
    expect(r.Statement.RateBasedStatement).toEqual({ Limit: 500, EvaluationWindowSec: 300, AggregateKeyType: 'IP' });
  });

  it('has no scope-down filters or rule overrides (not eligible on the Free plan)', () => {
    for (const r of rules) {
      expect(JSON.stringify(r)).not.toContain('ScopeDownStatement');
      expect(JSON.stringify(r)).not.toContain('RuleActionOverrides');
    }
  });

  it('uses the three AWS managed rule groups', () => {
    for (const name of ['AWSManagedRulesAmazonIpReputationList', 'AWSManagedRulesKnownBadInputsRuleSet', 'AWSManagedRulesCommonRuleSet']) {
      const r = rule(name);
      expect(r.OverrideAction).toEqual({ None: {} });
      expect(r.Statement.ManagedRuleGroupStatement).toMatchObject({ VendorName: 'AWS', Name: name });
    }
  });
});

describe('EdgeStack – distribution', () => {
  it('serves the alias over HTTP/2+3, all edge locations, IPv6, with the WAF and certificate', () => {
    expect(dist).toMatchObject({
      Aliases: ['aws-or-not.example.com'],
      HttpVersion: 'http2and3',
      PriceClass: 'PriceClass_All',
      IPV6Enabled: true,
      WebACLId: { 'Fn::GetAtt': [logicalId('AWS::WAFv2::WebACL'), 'Arn'] },
    });
    expect(dist.ViewerCertificate.AcmCertificateArn).toEqual({ Ref: logicalId('AWS::CertificateManager::Certificate') });
  });

  it('has HTTPS-only origins for both endpoints carrying x-origin-verify as a dynamic reference', () => {
    expect(dist.Origins.map((o) => o.DomainName).sort()).toEqual([
      'admin.q2l.lambda-web.eu-central-1.on.aws',
      'game.q2l.lambda-web.eu-central-1.on.aws',
    ]);
    const secretId = logicalId('AWS::SecretsManager::Secret');
    for (const o of dist.Origins) {
      expect(o.CustomOriginConfig.OriginProtocolPolicy).toBe('https-only');
      const [h] = o.OriginCustomHeaders;
      expect(h.HeaderName).toBe('x-origin-verify');
      expect(h.HeaderValue).toEqual({ 'Fn::Join': ['', ['{{resolve:secretsmanager:', { Ref: secretId }, ':SecretString:::}}']] });
    }
  });

  it('never contains a plaintext secret value', () => {
    // The only place a generated value could appear is the header; it must be a resolve reference.
    const headers = JSON.stringify(dist.Origins.map((o) => o.OriginCustomHeaders));
    expect(headers).toContain('{{resolve:secretsmanager:');
    expect(JSON.stringify(json)).not.toMatch(/SecretString"\s*:\s*"/);
  });

  it('default behavior: game origin, all methods, no caching, managed AllViewerExceptHostHeader, viewer-IP function', () => {
    const d = dist.DefaultCacheBehavior;
    expect(d.AllowedMethods).toEqual(['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE']);
    expect(d.CachePolicyId).toBe(cloudfront.CachePolicy.CACHING_DISABLED.cachePolicyId);
    expect(d.OriginRequestPolicyId).toBe(cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER.originRequestPolicyId);
    const gameOriginId = dist.Origins.find((o) => o.DomainName.startsWith('game.')).Id;
    expect(d.TargetOriginId).toBe(gameOriginId);
    expect(d.FunctionAssociations).toEqual([{ EventType: 'viewer-request', FunctionARN: { 'Fn::GetAtt': [logicalId('AWS::CloudFront::Function'), 'FunctionARN'] } }]);
    const fn = Object.values(t.findResources('AWS::CloudFront::Function'))[0];
    expect(fn.Properties.FunctionCode).toContain("request.headers['x-viewer-ip'] = { value: event.viewer.ip }");
  });

  it('never uses a managed cache policy that forwards Host (the endpoint routes on its own hostname)', () => {
    const forwardsHost = [cloudfront.CachePolicy.USE_ORIGIN_CACHE_CONTROL_HEADERS.cachePolicyId, cloudfront.CachePolicy.USE_ORIGIN_CACHE_CONTROL_HEADERS_QUERY_STRINGS.cachePolicyId];
    for (const b of [dist.DefaultCacheBehavior, ...dist.CacheBehaviors]) expect(forwardsHost).not.toContain(b.CachePolicyId);
  });

  it('uses only AWS-managed cache and origin request policies (Free flat-rate plan requirement)', () => {
    t.resourceCountIs('AWS::CloudFront::CachePolicy', 0);
    t.resourceCountIs('AWS::CloudFront::OriginRequestPolicy', 0);
  });

  it('/admin*: admin origin, all methods, no caching, AllViewerExceptHostHeader', () => {
    const b = behavior('/admin*');
    expect(b.TargetOriginId).toBe(dist.Origins.find((o) => o.DomainName.startsWith('admin.')).Id);
    expect(b.AllowedMethods).toEqual(['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE']);
    expect(b.CachePolicyId).toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
    expect(b.OriginRequestPolicyId).toBe('b689b0a8-53d0-40ab-baf2-68738e2966ac'); // AllViewerExceptHostHeader
  });

  it('/og/* and /card/* use CachingOptimized with compression', () => {
    for (const p of ['/og/*', '/card/*']) {
      expect(behavior(p)).toMatchObject({ CachePolicyId: '658327ea-f89d-4fab-a63d-7e88639e58f6', Compress: true });
    }
  });

  it('/public/* uses CachingOptimized (no Host in the cache key) with compression', () => {
    expect(behavior('/public/*')).toMatchObject({
      CachePolicyId: cloudfront.CachePolicy.CACHING_OPTIMIZED.cachePolicyId,
      Compress: true,
    });
  });
});

describe('EdgeStack – DNS and outputs', () => {
  it('creates A and AAAA alias records to the distribution', () => {
    for (const Type of ['A', 'AAAA']) {
      t.hasResourceProperties('AWS::Route53::RecordSet', {
        Type,
        Name: 'aws-or-not.example.com.',
        HostedZoneId: 'Z0123456789EXAMPLE',
        AliasTarget: {
          DNSName: { 'Fn::GetAtt': [logicalId('AWS::CloudFront::Distribution'), 'DomainName'] },
          HostedZoneId: Match.anyValue(),
        },
      });
    }
  });

  it.each(['quiz.example.com', 'quiz.games.example.com'])('uses the configured hostname %s for both DNS records', (domain) => {
    const custom = Template.fromStack(new EdgeStack(new App(), 'CustomDomain', {
      env,
      domain,
      hostedZoneId: 'Z0123456789EXAMPLE',
      hostedZoneName: 'example.com',
      gameDomain: 'game.example.net',
      adminDomain: 'admin.example.net',
    }));
    const [distributionId] = Object.keys(custom.findResources('AWS::CloudFront::Distribution'));
    custom.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: { Aliases: [domain] },
    });
    for (const Type of ['A', 'AAAA']) {
      custom.hasResourceProperties('AWS::Route53::RecordSet', {
        Type,
        Name: `${domain}.`,
        AliasTarget: {
          DNSName: { 'Fn::GetAtt': [distributionId, 'DomainName'] },
          HostedZoneId: Match.anyValue(),
        },
      });
    }
  });

  it('outputs distribution ID, domain name and secret ARN', () => {
    for (const k of ['DistributionId', 'DistributionDomainName', 'OriginSecretArn']) t.hasOutput(k, {});
  });
});
