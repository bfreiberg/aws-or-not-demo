import { Stack, CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';

export const ORIGIN_SECRET_NAME = 'aws-or-not/origin-verify';

// Accepts a bare hostname or a URL (e.g. the app stack's GameUrl/AdminUrl outputs).
export function hostOf(value) {
  if (!value) throw new Error('endpoint domain is required');
  return value.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

const visibility = (metricName) => ({
  cloudWatchMetricsEnabled: true,
  sampledRequestsEnabled: true,
  metricName,
});

const managedRule = (name, priority, extra = {}) => ({
  name,
  priority,
  overrideAction: { none: {} },
  statement: { managedRuleGroupStatement: { vendorName: 'AWS', name, ...extra } },
  visibilityConfig: visibility(name),
});

/**
 * CloudFront + WAF in front of the two Web Function endpoints (must live in us-east-1).
 * Adds the `x-origin-verify` header the apps require on every protected request.
 */
export class EdgeStack extends Stack {
  constructor(scope, id, { domain, hostedZoneId, hostedZoneName, ...props }) {
    super(scope, id, props);
    const gameDomain = hostOf(props.gameDomain);
    const adminDomain = hostOf(props.adminDomain);

    const secret = new secretsmanager.Secret(this, 'OriginVerifySecret', {
      secretName: ORIGIN_SECRET_NAME,
      description: 'Shared header value CloudFront sends to the aws-or-not origins',
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', { hostedZoneId, zoneName: hostedZoneName });
    const certificate = new acm.Certificate(this, 'Certificate', {
      domainName: domain,
      validation: acm.CertificateValidation.fromDns(zone),
    });

    // Free flat-rate plan: max 5 rules, IP-based rate limiting only (no scope-down filters), no rule overrides.
    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      name: 'aws-or-not-edge',
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: visibility('aws-or-not-edge'),
      rules: [
        {
          name: 'RateLimitPerIp',
          priority: 0,
          action: { block: {} },
          statement: { rateBasedStatement: { limit: 500, evaluationWindowSec: 300, aggregateKeyType: 'IP' } },
          visibilityConfig: visibility('RateLimitPerIp'),
        },
        managedRule('AWSManagedRulesAmazonIpReputationList', 1),
        managedRule('AWSManagedRulesKnownBadInputsRuleSet', 2),
        managedRule('AWSManagedRulesCommonRuleSet', 3),
      ],
    });

    const customHeaders = { 'x-origin-verify': secret.secretValue.unsafeUnwrap() };
    const gameOrigin = new origins.HttpOrigin(gameDomain, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      customHeaders,
    });
    const adminOrigin = new origins.HttpOrigin(adminDomain, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      customHeaders,
    });

    // The Free flat-rate plan only allows AWS-managed cache and origin request policies, so the real
    // client IP is passed in a header set by a CloudFront Function (it overwrites any client-sent value;
    // the app trusts it only on requests that carry the origin secret).
    const viewerIp = new cloudfront.Function(this, 'ViewerIpFunction', {
      functionName: 'aws-or-not-viewer-ip',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        "function handler(event) { var request = event.request; request.headers['x-viewer-ip'] = { value: event.viewer.ip }; return request; }",
      ),
    });

    const cached = (cachePolicy) => ({
      origin: gameOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy,
      compress: true,
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'aws-or-not',
      domainNames: [domain],
      certificate,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
      enableIpv6: true,
      webAclId: webAcl.attrArn,
      defaultBehavior: {
        origin: gameOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        functionAssociations: [{ function: viewerIp, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
        compress: true,
      },
      additionalBehaviors: {
        '/og/*': cached(cloudfront.CachePolicy.CACHING_OPTIMIZED),
        '/card/*': cached(cloudfront.CachePolicy.CACHING_OPTIMIZED),
        // CachingOptimized, not UseOriginCacheControlHeaders: the latter puts Host in the cache key and so
        // forwards it, and the endpoint only answers to its own hostname (502). With the app's no-cache header
        // CloudFront keeps static files for at most the policy's 1 s minimum TTL.
        '/public/*': cached(cloudfront.CachePolicy.CACHING_OPTIMIZED),
        '/admin*': {
          origin: adminOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          compress: true,
        },
      },
    });

    const target = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution));
    new route53.ARecord(this, 'AliasA', { zone, recordName: 'aws-or-not', target });
    new route53.AaaaRecord(this, 'AliasAaaa', { zone, recordName: 'aws-or-not', target });

    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new CfnOutput(this, 'DistributionDomainName', { value: distribution.distributionDomainName });
    new CfnOutput(this, 'OriginSecretArn', { value: secret.secretArn });
  }
}
