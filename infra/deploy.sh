#!/usr/bin/env bash
# Build, push and deploy Rendezvous. Idempotent: creates the stack the first time, updates it afterwards.
#   ./infra/deploy.sh            # build + push + deploy
#   SKIP_BUILD=1 ./infra/deploy.sh   # redeploy the current image tag without rebuilding
set -euo pipefail
cd "$(dirname "$0")/.."
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
else
  TAG=${TAG:-latest}
fi

echo "== deploying stack $STACK with image $REPO:$TAG"
aws cloudformation deploy --region "$REGION" --stack-name "$STACK" \
  --template-file infra/rendezvous.yaml \
  --parameter-overrides "ImageUri=$REPO:$TAG" \
  --capabilities CAPABILITY_IAM \
  --tags Project=rendezvous \
  --no-fail-on-empty-changeset

aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query 'Stacks[0].Outputs' --output table
