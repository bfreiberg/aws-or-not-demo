#!/usr/bin/env bash
# Builds, uploads both ZIPs under content-hash keys, then deploys the app stack, the edge stack
# (CloudFront + WAF, always us-east-1) and the cost guard.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${AWS_PROFILE:?set AWS_PROFILE}"
# Pinned: an AWS_REGION from the caller's shell must not move the deploy.
export AWS_REGION="${DEPLOY_REGION:-us-east-1}"
export DEPLOY_REGION="$AWS_REGION"

aws sts get-caller-identity --query Arn --output text --region "$AWS_REGION"
node scripts/build.js

(cd infra && npx cdk deploy AwsOrNotCode --profile "$AWS_PROFILE" --region "$AWS_REGION" --outputs-file ../dist/code-outputs.json)
BUCKET=$(node -p "require('./dist/code-outputs.json').AwsOrNotCode.BucketName")

for fn in game admin; do
  FILE=$(node -p "require('./dist/manifest.json').$fn.file")
  KEY=$(node -p "require('./dist/manifest.json').$fn.key")
  if aws s3api head-object --bucket "$BUCKET" --key "$KEY" --region "$AWS_REGION" >/dev/null 2>&1; then
    echo "s3://$BUCKET/$KEY already uploaded"
  else
    aws s3 cp "$FILE" "s3://$BUCKET/$KEY" --region "$AWS_REGION"
  fi
done

(cd infra && npx cdk deploy AwsOrNotApp --profile "$AWS_PROFILE" --region "$AWS_REGION" \
  -c codeBucket="$BUCKET" \
  -c gameKey="$(node -p "require('../dist/manifest.json').game.key")" \
  -c adminKey="$(node -p "require('../dist/manifest.json').admin.key")" \
  --outputs-file ../dist/app-outputs.json)

# Endpoint hostnames for the CloudFront origins (GameUrl is https://<host>, AdminUrl is https://<host>/admin).
GAME_DOMAIN=$(node -p "new URL(require('./dist/app-outputs.json').AwsOrNotApp.GameUrl).host")
ADMIN_DOMAIN=$(node -p "new URL(require('./dist/app-outputs.json').AwsOrNotApp.AdminUrl).host")

# CloudFront certificates and CLOUDFRONT-scoped WAF only exist in us-east-1, regardless of DEPLOY_REGION.
(cd infra && npx cdk deploy AwsOrNotEdge --profile "$AWS_PROFILE" --region us-east-1 \
  -c gameDomain="$GAME_DOMAIN" -c adminDomain="$ADMIN_DOMAIN" \
  --outputs-file ../dist/edge-outputs.json)

(cd infra && npx cdk deploy AwsOrNotGuard --profile "$AWS_PROFILE" --region "$AWS_REGION" \
  --outputs-file ../dist/guard-outputs.json)

node -e "const o=require('./dist/app-outputs.json').AwsOrNotApp, e=require('./dist/edge-outputs.json').AwsOrNotEdge; console.log('Site:  https://'+require('./infra/deploy-config.json').domain+' ('+e.DistributionDomainName+')\nGame endpoint:  '+o.GameUrl+'\nAdmin endpoint: '+o.AdminUrl)"
