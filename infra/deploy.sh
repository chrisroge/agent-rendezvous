#!/usr/bin/env bash
# Build, push and deploy Rendezvous. Idempotent: creates the stack the first time, updates it afterwards.
#   ./infra/deploy.sh                 # build + push + deploy
#   SKIP_BUILD=1 TAG=v0.1.6 ./infra/deploy.sh   # redeploy an existing image tag
# Account-specific values come from infra/params.env (see infra/params.example.env).
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -f infra/params.env ]] || { echo "infra/params.env missing — copy infra/params.example.env and fill it in" >&2; exit 1; }
set -a; source infra/params.env; set +a
REGION=${AWS_REGION:-us-east-2}
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REPO="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/rendezvous"
TAG=${TAG:-$(date -u +%Y%m%d%H%M%S)}
STACK=${STACK:-rendezvous}
BUILDER=${BUILDER:-podman}

if [[ -z "${SKIP_BUILD:-}" ]]; then
  echo "== building $REPO:$TAG"
  $BUILDER build --platform linux/amd64 -t "$REPO:$TAG" -t "$REPO:latest" .
  aws ecr get-login-password --region "$REGION" | $BUILDER login --username AWS --password-stdin "$REPO"
  $BUILDER push "$REPO:$TAG"
  $BUILDER push "$REPO:latest"
fi

echo "== deploying stack $STACK with image $REPO:$TAG"
aws cloudformation deploy --region "$REGION" --stack-name "$STACK" \
  --template-file infra/rendezvous.yaml \
  --parameter-overrides "ImageUri=$REPO:$TAG" "DomainName=$DOMAIN" "HostedZoneId=$HOSTED_ZONE_ID" "VpcId=$VPC_ID" "SubnetIds=$SUBNET_IDS" "StripePortalConfigId=${STRIPE_PORTAL_CONFIG_ID:-}" "FounderPaymentLinkUrl=${FOUNDER_PAYMENT_LINK_URL:-}" \
  --capabilities CAPABILITY_IAM \
  --tags Project=rendezvous \
  --no-fail-on-empty-changeset

aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query 'Stacks[0].Outputs' --output table
