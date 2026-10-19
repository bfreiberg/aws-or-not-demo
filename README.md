# AWS or Not?

A quiz in which players decide whether a name is a real AWS service or a made-up one. The project is a
sample for **AWS Lambda Web Functions**: two Hono HTTP servers that listen on a port, deployed as web
functions without handler adapters.

**Play:** https://aws-or-not.freiberg.cloud

![A quiz run: questions, a promotion, and the result card](docs/demo.gif)

## How it works

- Runs are endless. Questions get harder over six tiers (4, 5, 6, 7 and 8 questions, then the last tier
  without end), and three wrong answers end the run. Hard mode adds a per-question timer.
- The server grades every answer. The browser never receives the answer before submitting; run state is
  updated with optimistic locking.
- Question statistics update in the background, and the answer percentage loads separately. These
  analytics are approximate: failed, saturated, or interrupted updates can be lost without affecting gameplay.
- Each result has a page (`/r/:id`) with Open Graph tags and a share card rendered on demand
  (`/og/:id.png`, satori + resvg-wasm).
- An admin app (Cognito, PKCE, TOTP MFA, `admins` group) shows usage statistics, sets the Hard-mode
  timer and removes leaderboard entries.

## Architecture

```
browser ──▶ CloudFront + WAF ──┬──▶ aws-or-not-game   (Web Function) ──┐
            (us-east-1)        └──▶ aws-or-not-admin  (Web Function) ──┴──▶ DynamoDB (single table)
                                           │
                                           └── Cognito user pool (admin sign-in)
```

| Stack | Region | Contents |
|---|---|---|
| `AwsOrNotCode` | app region | Versioned S3 bucket for the function ZIPs |
| `AwsOrNotApp` | app region | Both web functions, IAM roles, DynamoDB table, Cognito, secrets |
| `AwsOrNotEdge` | us-east-1 | CloudFront distribution, WAF web ACL, ACM certificate, Route 53 records, origin secret |
| `AwsOrNotGuard` | app region | Monthly budget and the endpoint kill switch |

## Repository layout

| Path | Contents |
|---|---|
| `game/` | Public app: pages, game API, result pages, share cards |
| `admin/` | Admin app: sign-in, dashboard, configuration |
| `shared/` | Game engine, DynamoDB store, card renderer, HTTP helpers |
| `content/` | Question validation, ID derivation, fake-name generator |
| `infra/` | CDK app (JavaScript) |
| `scripts/` | Asset copy, build, local runners, deploy |
| `test/` | Unit, integration and Playwright tests |

## Content

The repository contains only `content/questions.sample.json`. To build a full question set:

1. Write `content/real.json` (gitignored) with real services, each with a `tier` from 1 to 6 and an
   `explanation`.
2. Run `AWS_PROFILE=<profile> npm run generate`. It requests fake names per tier from Amazon Bedrock,
   drops names close to a real one, and writes `content/questions.draft.json`.
3. Review the draft and save it as `content/questions.json` (gitignored). The build uses it when present.

Question IDs are derived from the service name (`content/ids.js`), so an ID does not indicate whether a
question is real or fake.

## Local development

Requires Node.js 24 and Docker or Finch for DynamoDB Local.

```bash
make install
make dev-game   # http://localhost:3000
make test       # unit, integration and infra tests
make e2e        # Playwright
```

## Deployment

1. Create the deployment config (gitignored):

   ```bash
   cp infra/deploy-config.example.json infra/deploy-config.json
   ```

   | Key | Meaning |
   |---|---|
   | `domain` | Public hostname, for example `aws-or-not.example.com` |
   | `hostedZoneId`, `hostedZoneName` | Route 53 public hosted zone of the domain, in the same account |
   | `alertEmail` | Recipient of budget alerts |
   | `budgetUsd` | Monthly budget for the app's services |

2. Bootstrap CDK in the app region and in `us-east-1`:

   ```bash
   cdk bootstrap aws://<account>/<region> aws://<account>/us-east-1 --profile <profile>
   ```

3. Deploy:

   ```bash
   make deploy PROFILE=<profile> REGION=<region>
   ```

   `REGION` defaults to `us-east-1` and is not taken from `AWS_REGION`. `make deploy` runs the tests,
   then `scripts/deploy.sh` builds both ZIPs, uploads them under content-hash keys, and deploys
   `AwsOrNotCode`, `AwsOrNotApp`, `AwsOrNotEdge` and `AwsOrNotGuard`.

   The deployment script keeps the edge stack in `us-east-1` regardless of `REGION`.

4. Create an admin user:

   ```bash
   aws cognito-idp admin-create-user --region <region> --profile <profile> \
     --user-pool-id <UserPoolId> --username you@example.com \
     --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true
   aws cognito-idp admin-add-user-to-group --region <region> --profile <profile> \
     --user-pool-id <UserPoolId> --username you@example.com --group-name admins
   ```

5. Confirm the SNS subscription email sent to `alertEmail`.

### Custom domain

Web Function endpoints have no custom-domain option, so `AwsOrNotEdge` places CloudFront in front of
both functions. The game is served at `/`, the admin app at `/admin`.

- CloudFront adds an `x-origin-verify` header from a Secrets Manager secret. Both apps reject requests
  without it (`403`), so the generated endpoint URLs answer only `/api/health`.
- A CloudFront Function passes the client IP in `x-viewer-ip`.
- Share cards and static files are cached at the edge.

The configuration is eligible for the **CloudFront flat-rate Free plan**: AWS-managed cache and origin
request policies only, all edge locations, and four WAF rules (500 requests per 5 minutes per IP, IP
reputation, known bad inputs, common rule set) without scope-down statements or rule overrides.
Subscribe once after the first deploy:

```bash
aws pricing-plan-manager create-subscription --region us-east-1 --profile <profile> \
  --plan-family CloudFront --plan-tier FREE \
  --resource-arns arn:aws:cloudfront::<account>:distribution/<DistributionId> <WebAclArn>
```

### Verification

1. `https://<domain>/api/health` returns `{"status":"ok"}`.
2. A complete run ends on `/r/<id>`, and `/og/<id>.png` returns `image/png`.
3. The generated endpoint URLs return `403` for `/`.
4. `https://<domain>/admin` redirects to the Cognito sign-in page.
5. Game logs appear in `/aws/lambda/web/aws-or-not-game` without the warning
   `no client ip; leaderboard cap skipped`.

## Cost controls

| Control | Setting |
|---|---|
| Endpoint throttle | 100 requests/s per endpoint |
| Environments | Game: at most 3; admin: 2 |
| DynamoDB | On-demand; base table and leaderboard index each capped at 400 read and 200 write units |
| WAF | 500 requests per 5 minutes per IP |
| Logs | Platform logs at `WARN`, 30-day retention |
| Budget | `budgetUsd` per month, limited to the services the app uses |

The budget emails `alertEmail` at 50% and 80% of actual spend and at 100% of forecasted spend. At 100% of
actual spend, a Lambda function sets the throttle of both endpoints to 0. Budget data is updated a few
times a day, so the kill switch limits sustained overspend rather than short spikes. To restore traffic:

```bash
for fn in aws-or-not-game aws-or-not-admin; do
  aws lambda-web update-web-function-endpoint --function-name $fn --endpoint-name default \
    --throttle-config rateLimit=100 --region <region> --profile <profile>
done
```

## Cleanup

```bash
cd infra
npx cdk destroy AwsOrNotGuard AwsOrNotApp AwsOrNotCode --profile <profile>
npx cdk destroy AwsOrNotEdge --region us-east-1 -c gameDomain=x -c adminDomain=x --profile <profile>
```

Cancel the flat-rate plan subscription before destroying `AwsOrNotEdge`. The following resources are
retained and must be deleted manually:

- DynamoDB table `aws-or-not`, Cognito user pool `aws-or-not-admins`, and the bucket
  `aws-or-not-code-<account>` (versioned; delete all object versions first).
- Log groups `/aws/lambda/web/aws-or-not-game.local` and `/aws/lambda/web/aws-or-not-admin.local`, which
  the platform creates outside the stack.

## License

Apache License 2.0. See [LICENSE](LICENSE).

## Disclaimer

AWS or Not? is an independent project. It is not affiliated with, endorsed by or sponsored by Amazon Web
Services. AWS and the names of AWS services are trademarks of Amazon.com, Inc. or its affiliates.
