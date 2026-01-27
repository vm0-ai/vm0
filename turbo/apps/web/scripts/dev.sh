#!/bin/bash
# Start Cloudflare Tunnel and then exec Next.js dev server
#
# This script enables E2B webhooks to reach localhost by:
# 1. Starting a Cloudflare Tunnel to expose localhost:3000
# 2. Extracting the public tunnel URL
# 3. Executing Next.js dev server with VM0_API_URL set to tunnel URL
#
# Related: https://github.com/vm0-ai/vm0/issues/1726

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TUNNEL_LOG="/tmp/cloudflared-dev.log"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

log_info() {
  echo -e "${GREEN}[tunnel]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[tunnel]${NC} $1"
}

log_error() {
  echo -e "${RED}[tunnel]${NC} $1"
}

# Cleanup function - only need to kill cloudflared since next dev runs via exec
cleanup() {
  if [ ! -z "$TUNNEL_PID" ] && kill -0 $TUNNEL_PID 2>/dev/null; then
    kill $TUNNEL_PID 2>/dev/null || true
    sleep 1
    kill -9 $TUNNEL_PID 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

log_info "Starting Cloudflare Tunnel..."

# Start cloudflared tunnel in background with HTTP/2 protocol
# Note: HTTP/2 protocol is required - QUIC fails in devcontainer environment
cloudflared tunnel --url http://localhost:3000 --protocol http2 > "$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!

# Wait for tunnel URL to be available
log_info "Waiting for tunnel URL (this may take 10-15 seconds)..."
MAX_ATTEMPTS=30
ATTEMPT=0
TUNNEL_URL=""

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
  # Check if cloudflared is still running
  if ! kill -0 $TUNNEL_PID 2>/dev/null; then
    log_error "Cloudflared process died unexpectedly!"
    log_error "Check logs: $TUNNEL_LOG"
    cat "$TUNNEL_LOG"
    exit 1
  fi

  # Try to extract tunnel URL
  TUNNEL_URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -n 1)

  if [ ! -z "$TUNNEL_URL" ]; then
    break
  fi

  ATTEMPT=$((ATTEMPT + 1))
  sleep 1
done

if [ -z "$TUNNEL_URL" ]; then
  log_error "Failed to get tunnel URL after ${MAX_ATTEMPTS} seconds"
  log_error "Cloudflared log:"
  cat "$TUNNEL_LOG"
  exit 1
fi

echo ""
log_info "Tunnel URL: ${GREEN}${TUNNEL_URL}${NC}"
log_info "Webhooks: ${YELLOW}${TUNNEL_URL}/api/webhooks/agent-events${NC}"
echo ""

# Change to web app directory and exec next dev with VM0_API_URL set
cd "$WEB_APP_DIR"
exec env VM0_API_URL="$TUNNEL_URL" npx next dev --turbopack --port 3000
