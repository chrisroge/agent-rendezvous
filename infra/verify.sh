#!/usr/bin/env bash
# Post-deploy verification: DNS, TLS, health, MCP handshake, and the full e2e suite against production.
set -uo pipefail
cd "$(dirname "$0")/.."
[[ -f infra/params.env ]] && { set -a; source infra/params.env; set +a; }
DOMAIN=${DOMAIN:-agentrendezvous.app}
REGION=${AWS_REGION:-us-east-2}
echo "== DNS";   dig +short "$DOMAIN" A | head -3
echo "== TLS";   echo | openssl s_client -servername "$DOMAIN" -connect "$DOMAIN:443" 2>/dev/null | openssl x509 -noout -subject -issuer -dates
echo "== HTTP→HTTPS"; curl -sI "http://$DOMAIN/" | head -1
echo "== healthz"; curl -sS "https://$DOMAIN/healthz"; echo
echo "== MCP initialize"
curl -sS -X POST "https://$DOMAIN/mcp" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"verify","version":"0"}}}' | head -c 300; echo
echo "== tools/list"
curl -sS -X POST "https://$DOMAIN/mcp" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | python3 -c 'import sys,json; print([t["name"] for t in json.load(sys.stdin)["result"]["tools"]])'
echo "== e2e suite against production"
OPERATOR_TOKEN=$(aws secretsmanager get-secret-value --region "$REGION" --secret-id rendezvous/operator-token --query SecretString --output text 2>/dev/null || true)
PURGE_AFTER=1 BASE_URL="https://$DOMAIN" OPERATOR_TOKEN="$OPERATOR_TOKEN" npx tsx --test tests/rendezvous.test.ts 2>&1 | grep -E "^ℹ (tests|pass|fail)|✖|✔"
