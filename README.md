# AWS or Not?

A quiz: is it a real AWS service, or made up? Built as a sample for **AWS Lambda Web Functions**.
It's two plain Hono HTTP servers that listen on a port, with no handler adapters, deployed as web functions.

## Architecture

```
players ──▶ aws-or-not-game  (public)  ──┐  pages, game API, /r/:id result pages, /og/:id.png cards
                                          ├─▶ DynamoDB (single table)
admin   ──▶ aws-or-not-admin (Cognito) ──┘  dashboard, timer config, leaderboard moderation
```

- **Server-authoritative game.** The browser never sees an answer before it answers. Every answer is graded server-side, with optimistic locking on the run item.
- **Share cards** are rendered on demand with satori + resvg-wasm (pure JS/WASM, so arm64-safe) and served with `immutable` caching. Result pages carry Open Graph tags, so links unfurl on LinkedIn, X and Bluesky.
- **Two functions, two roles.** The public game role can't write config. The admin enforces Cognito auth (PKCE, TOTP MFA, `admins` group) in the app, because `IamAuth` can't serve a browser login.
- **Abuse protection:** 400 ms minimum answer time, a per-IP-hash daily leaderboard cap (salted HMAC; raw IPs are never stored), and endpoint throttling and scaling caps.


## Content

This repo ships only `content/questions.sample.json`. To build a real set:

1. Curate `content/real.json` (gitignored): real services with `tier` 1–5 and a one-line `explanation`.
2. `AWS_PROFILE=<profile> npm run generate` asks Bedrock for fakes per tier, filters near-duplicates of real names, and writes `content/questions.draft.json`.
3. Review the draft by hand, then save it as `content/questions.json` (gitignored). The build uses it automatically.

Question IDs are opaque hashes of the service name (see `content/ids.js`), so the ID never reveals whether a question is real or fake.

## Develop

```bash
make install
make dev-game        # http://localhost:3000 against DynamoDB Local (Docker or Finch)
make test            # unit + integration (DynamoDB Local) + infra
make e2e             # Playwright
```

DynamoDB Local runs via Docker or Finch (the Makefile auto-detects).

## Deploy

### First deploy

1. Create your deployment config (gitignored):

   ```bash
   cp infra/deploy-config.example.json infra/deploy-config.json
   ```

   | Key | Meaning |
   |---|---|
   | `domain` | Public hostname, e.g. `aws-or-not.example.com` |
   | `hostedZoneId`, `hostedZoneName` | The Route 53 public hosted zone the domain lives in (same account) |
   | `alertEmail` | Where budget alerts go |
   | `budgetUsd` | Monthly budget for the app's services; at 100% the kill switch throttles both endpoints to 0 |

2. Bootstrap CDK in your app region and in `us-east-1` (CloudFront certificate and WAF live there):

   ```bash
   cdk bootstrap aws://<account>/<region> aws://<account>/us-east-1 --profile <profile>
   ```

### Build and deploy

```bash
make deploy PROFILE=<profile> REGION=<region>
```

Region is pinned to `us-east-1`; override with `REGION=`:

```bash
make deploy PROFILE=<profile> REGION=us-west-2
```

This builds both ZIPs, uploads them under content-hash keys to a versioned bucket, and deploys
`AwsOrNotCode` and `AwsOrNotApp`. Then create an admin:

```bash
aws cognito-idp admin-create-user --region us-east-1 --profile <profile> \
  --user-pool-id <UserPoolId> --username you@example.com \
  --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true
aws cognito-idp admin-add-user-to-group --region us-east-1 --profile <profile> \
  --user-pool-id <UserPoolId> --username you@example.com --group-name admins
```

### Custom domain (CloudFront + WAF)

Public traffic goes through your custom domain (`domain` in `infra/deploy-config.json`): a CloudFront distribution with an
AWS WAF web ACL, both in the `AwsOrNotEdge` stack, which always lives in **us-east-1** (CloudFront
certificates and CLOUDFRONT-scoped WAF exist only there; bootstrap CDK in us-east-1 too). It owns
the ACM certificate, the Route 53 A/AAAA alias records in your hosted zone, and the Secrets Manager
secret `aws-or-not/origin-verify` that CloudFront sends as the `x-origin-verify` header.

Deploy order (`scripts/deploy.sh` does all of it):

1. `AwsOrNotApp` (eu-central-1).
2. `AwsOrNotEdge` (us-east-1), with the endpoint hostnames from the app outputs
   (`dist/app-outputs.json` `GameUrl` / `AdminUrl`):
   ```bash
   (cd infra && npx cdk deploy AwsOrNotEdge --profile <profile> --region us-east-1 \
     -c gameDomain=<game endpoint host> -c adminDomain=<admin endpoint host>)
   ```
3. `AwsOrNotGuard`.

The apps read the secret lazily by name, so there is no need to redeploy the app after the edge
stack. Outputs go to `dist/edge-outputs.json` and `dist/guard-outputs.json`.

One-time: subscribe the distribution and its web ACL to the **CloudFront flat-rate Free plan**
(not supported in CloudFormation; the console or the CLI works):

```bash
aws pricing-plan-manager create-subscription --region us-east-1 --profile <profile> \
  --plan-family CloudFront --plan-tier FREE \
  --resource-arns arn:aws:cloudfront::<account>:distribution/<DistributionId> <web ACL ARN>
```

The Free plan is strict about what the distribution may use. The stack is built to stay eligible:
AWS-managed cache and origin request policies only (the client IP reaches the app through an
`x-viewer-ip` header set by a CloudFront Function), all edge locations, and 4 WAF rules (per-IP rate
limit of 500 requests per 5 minutes, IP reputation, known bad inputs, common rule set) without
scope-down filters or rule overrides. Custom cache/origin request policies, a narrower price class,
or path-scoped WAF rules make the distribution ineligible. The web ACL must stay attached.

The raw endpoint URLs (`*.lambda-web.eu-central-1.on.aws`) now return **403** for everything except
`/api/health`, because only CloudFront adds the `x-origin-verify` header.

### Post-deploy smoke checklist

1. `curl https://<GameUrl>/api/health` — expect `{"status":"ok"}`.
2. Play one game to completion, then check the game logs (`aws logs tail /aws/lambda/web/aws-or-not-game --since 10m --region us-east-1 --profile <profile>`). If the warn `"no client ip; leaderboard cap skipped"` appears, `x-forwarded-for` is not being forwarded — investigate and adjust `clientIp()` in `shared/http.js` to use whatever header the platform provides. Note that `clientIp()` uses the rightmost comma-separated entry, assuming the platform appends it.
3. Open `/r/<resultId>` — result page renders with title and score.
5. Open `/og/<resultId>.png` — returns `content-type: image/png`.
6. Visit `<AdminUrl>` and sign in; complete TOTP enrollment on first login.
7. Confirm game logs in CloudWatch at `/aws/lambda/web/aws-or-not-game`.

## Cost guard

The `AwsOrNotGuard` stack (eu-central-1) watches monthly spend and throttles both endpoints to zero if it gets out of hand.

**What triggers the kill switch:**

| Threshold | Type | Action |
|---|---|---|
| 50% of $20 | Actual spend | Email alert |
| 80% of $20 | Actual spend | Email alert |
| 100% of $20 | Forecasted spend | Email alert |
| 100% of $20 | Actual spend | Email alert + SNS → Lambda kill switch |

The kill-switch Lambda calls `UpdateWebFunctionEndpoint` on both `aws-or-not-game/default` and `aws-or-not-admin/default`, setting `throttleConfig.rateLimit` to 0, which immediately stops traffic to both endpoints.

**Important caveats:**

- Budget data lags several hours, so the kill switch is a backstop against runaway spend, not a real-time guardrail.
- The alert email (`alertEmail` in `infra/deploy-config.json`) must be confirmed once via the AWS subscription confirmation link sent on first deploy of `AwsOrNotGuard`.

**Re-enabling after a kill-switch event:**

Once you have investigated the cause, restore traffic by setting the rate limit back to 100 on each endpoint:

```bash
aws lambda-web update-web-function-endpoint \
  --function-name aws-or-not-game \
  --endpoint-name default \
  --throttle-config rateLimit=100 \
  --region eu-central-1 --profile <profile>

aws lambda-web update-web-function-endpoint \
  --function-name aws-or-not-admin \
  --endpoint-name default \
  --throttle-config rateLimit=100 \
  --region eu-central-1 --profile <profile>
```

Alternatively, redeploying `AwsOrNotApp` restores the configured rate limit from CDK.

## Cleanup

`cdk destroy AwsOrNotApp AwsOrNotCode AwsOrNotGuard`, and `cdk destroy AwsOrNotEdge --region us-east-1 -c gameDomain=x -c adminDomain=x` (cancel the Free plan subscription first). Some things outlive the stacks and must be deleted by hand if you want them gone:

- the DynamoDB table `aws-or-not`, the Cognito user pool `aws-or-not-admins` and the code bucket `aws-or-not-code-<account>` (retained on purpose; the bucket is versioned, so delete all object versions first);
- the log groups `/aws/lambda/web/aws-or-not-game.local` and `/aws/lambda/web/aws-or-not-admin.local`, which the Web Functions platform creates outside the stack.
