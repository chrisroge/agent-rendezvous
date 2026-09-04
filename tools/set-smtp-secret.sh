#!/usr/bin/env bash
# Store SMTP relay credentials in AWS Secrets Manager without the token appearing in shell history,
# a transcript, or the process list. Prompts silently, writes the secret, then rolls the ECS service.
#
#   ./tools/set-smtp-secret.sh                      # Postmark defaults (token is used as BOTH user and pass)
#   HOST=smtp.example.com PORT=587 ./tools/set-smtp-secret.sh
set -euo pipefail
REGION=${REGION:-us-east-2}
HOST=${HOST:-smtp.postmarkapp.com}
PORT=${PORT:-587}

read -rsp "SMTP token/password (input hidden): " TOKEN; echo
[[ -n "$TOKEN" ]] || { echo "nothing entered; aborted" >&2; exit 1; }
read -rp "SMTP username [same as token]: " USERNAME; USERNAME=${USERNAME:-$TOKEN}

# Build the JSON with a here-doc via stdin so the value never lands in argv.
PAYLOAD=$(TOKEN="$TOKEN" USERNAME="$USERNAME" HOST="$HOST" PORT="$PORT" python3 -c '
import json, os
print(json.dumps({"host": os.environ["HOST"], "port": os.environ["PORT"], "user": os.environ["USERNAME"], "pass": os.environ["TOKEN"]}))')

VERSION=$(printf '%s' "$PAYLOAD" | aws secretsmanager put-secret-value --region "$REGION" \
  --secret-id rendezvous/smtp --secret-string file:///dev/stdin --query VersionId --output text)
unset TOKEN PAYLOAD
echo "stored in rendezvous/smtp (version $VERSION), host=$HOST port=$PORT"

echo "forcing a new deployment so the task picks it up…"
aws ecs update-service --region "$REGION" --cluster rendezvous --service rendezvous --force-new-deployment --query 'service.deployments[0].status' --output text
echo "done. Set MAIL_TRANSPORT=smtp in infra/params.env and redeploy the stack if it is still 'ses'."
