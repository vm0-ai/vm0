#!/bin/bash
# Start Cloudflare Tunnel and then exec Next.js dev server
#
# This script enables E2B webhooks to reach localhost by:
# 1. Starting a Cloudflare Tunnel via scripts/tunnel.sh
# 2. Executing Next.js dev server with VM0_API_URL set to tunnel URL
#
# Related: https://github.com/vm0-ai/vm0/issues/1726

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
PORT=3000

# Cleanup cloudflared on exit
cleanup() {
  TUNNEL_PID=$(cat "/tmp/cloudflared-${PORT}.pid" 2>/dev/null || true)
  if [[ -n "$TUNNEL_PID" ]] && kill -0 "$TUNNEL_PID" 2>/dev/null; then
    kill "$TUNNEL_PID" 2>/dev/null || true
    sleep 1
    kill -9 "$TUNNEL_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# Start tunnel and capture URL
TUNNEL_URL=$("$REPO_ROOT/scripts/tunnel.sh" "$PORT")

echo ""
echo -e "\033[0;32m[tunnel]\033[0m Tunnel URL: ${TUNNEL_URL}"
echo -e "\033[0;32m[tunnel]\033[0m Webhooks: \033[1;33m${TUNNEL_URL}/api/webhooks/agent-events\033[0m"
echo ""

# Update SLACK_REDIRECT_BASE_URL in .env.local
ENV_LOCAL_FILE="$WEB_APP_DIR/.env.local"
if [ -f "$ENV_LOCAL_FILE" ]; then
  if grep -q "^SLACK_REDIRECT_BASE_URL=" "$ENV_LOCAL_FILE"; then
    sed -i "s|^SLACK_REDIRECT_BASE_URL=.*|SLACK_REDIRECT_BASE_URL=${TUNNEL_URL}|" "$ENV_LOCAL_FILE"
  else
    echo "SLACK_REDIRECT_BASE_URL=${TUNNEL_URL}" >> "$ENV_LOCAL_FILE"
  fi
fi

# Start Next.js dev server
cd "$WEB_APP_DIR"
exec env VM0_API_URL="$TUNNEL_URL" npx next dev --turbopack --port "$PORT"
