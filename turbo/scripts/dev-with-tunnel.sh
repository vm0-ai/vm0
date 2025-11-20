#!/bin/bash
# Start Next.js dev server with Cloudflare Tunnel for local webhook testing
#
# This script enables E2B webhooks to reach localhost by:
# 1. Starting a Cloudflare Tunnel to expose localhost:3000
# 2. Extracting the public tunnel URL
# 3. Setting VM0_API_URL to the tunnel URL
# 4. Starting the Next.js dev server with the tunnel URL
#
# Related: https://github.com/vm0-ai/vm0/issues/102

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TURBO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WEB_APP_DIR="$TURBO_ROOT/apps/web"
TUNNEL_LOG="/tmp/cloudflared-dev.log"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

log_info() {
  echo -e "${GREEN}[dev:tunnel]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[dev:tunnel]${NC} $1"
}

log_error() {
  echo -e "${RED}[dev:tunnel]${NC} $1"
}

# Check if cloudflared is installed
if ! command -v cloudflared &> /dev/null; then
  log_error "cloudflared not found!"
  log_error "Please rebuild the devcontainer to install cloudflared."
  exit 1
fi

# Check if port 3000 is already in use
# Try to connect to the port - if connection succeeds, port is in use
if timeout 1 bash -c 'cat < /dev/null > /dev/tcp/127.0.0.1/3000' 2>/dev/null; then
  log_error "Port 3000 is already in use!"
  log_error "Please stop any running dev server and try again."
  log_error "You can find the process with: fuser 3000/tcp or ps aux | grep 3000"
  exit 1
fi

log_info "Starting Cloudflare Tunnel..."
log_info "This will expose localhost:3000 to the internet for webhook testing."
echo ""

# Start cloudflared tunnel in background with HTTP/2 protocol
# Note: HTTP/2 protocol is required - QUIC fails in devcontainer environment
cloudflared tunnel --url http://localhost:3000 --protocol http2 > "$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!

# Cleanup function
cleanup() {
  local exit_code=$?
  echo ""
  log_info "Shutting down..."

  # Kill cloudflared
  if [ ! -z "$TUNNEL_PID" ] && kill -0 $TUNNEL_PID 2>/dev/null; then
    log_info "Stopping Cloudflare Tunnel (PID: $TUNNEL_PID)..."
    kill $TUNNEL_PID 2>/dev/null || true
    # Wait a moment for graceful shutdown
    sleep 1
    # Force kill if still running
    kill -9 $TUNNEL_PID 2>/dev/null || true
  fi

  # Kill Next.js dev server and all its child processes
  if [ ! -z "$DEV_SERVER_PID" ] && kill -0 $DEV_SERVER_PID 2>/dev/null; then
    log_info "Stopping Next.js dev server (PID: $DEV_SERVER_PID)..."
    # Kill the pnpm process and its entire process group
    kill -- -$(ps -o pgid= $DEV_SERVER_PID | grep -o '[0-9]*') 2>/dev/null || kill $DEV_SERVER_PID 2>/dev/null || true
    # Wait a moment
    sleep 1
    # Force kill any remaining processes
    pkill -9 -P $DEV_SERVER_PID 2>/dev/null || true
    kill -9 $DEV_SERVER_PID 2>/dev/null || true
  fi

  log_info "Cleanup complete."
  exit $exit_code
}

trap cleanup EXIT INT TERM

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
log_info "✅ Tunnel URL: ${GREEN}${TUNNEL_URL}${NC}"
echo ""
log_info "Waiting for tunnel to fully establish..."
sleep 10

# Verify tunnel is actually accessible
log_info "Verifying tunnel connectivity..."
if ! curl -s --max-time 5 "${TUNNEL_URL}" > /dev/null 2>&1; then
  log_warn "Tunnel URL not immediately accessible, but this is normal."
  log_warn "It may take a few more seconds to become fully available."
fi

echo ""
log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log_info "🌐 Webhook Tunnel Active"
log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Local:   http://localhost:3000"
echo "  Tunnel:  ${GREEN}${TUNNEL_URL}${NC}"
echo ""
log_info "E2B webhooks will be sent to:"
echo "  ${YELLOW}${TUNNEL_URL}/api/webhooks/agent-events${NC}"
echo ""
log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Start Next.js dev server with VM0_API_URL set to tunnel URL
log_info "Starting Next.js dev server with tunnel URL..."
echo ""

cd "$WEB_APP_DIR"

# Start dev server in background with VM0_API_URL set (not exported)
# This way the variable is only set for the dev server process
VM0_API_URL="$TUNNEL_URL" pnpm dev > /tmp/nextjs-dev.log 2>&1 &
DEV_SERVER_PID=$!

# Wait for dev server to be ready
log_info "Waiting for Next.js to be ready..."
MAX_WAIT=120
WAITED=0
NEXTJS_READY=false

while [ $WAITED -lt $MAX_WAIT ]; do
  # Check if dev server process is still running
  if ! kill -0 $DEV_SERVER_PID 2>/dev/null; then
    log_error "Next.js dev server process died!"
    log_error "Check logs: /tmp/nextjs-dev.log"
    tail -50 /tmp/nextjs-dev.log
    exit 1
  fi

  # Check for startup errors in logs
  if grep -q "EADDRINUSE" /tmp/nextjs-dev.log 2>/dev/null; then
    log_error "Port 3000 is already in use (detected in Next.js logs)!"
    log_error "Check logs: /tmp/nextjs-dev.log"
    tail -20 /tmp/nextjs-dev.log
    exit 1
  fi

  # Check if Next.js is ready by looking for "Ready" in logs
  if grep -q "Ready in" /tmp/nextjs-dev.log 2>/dev/null; then
    # Double-check that port is actually listening
    if timeout 1 bash -c 'cat < /dev/null > /dev/tcp/127.0.0.1/3000' 2>/dev/null; then
      log_info "✅ Next.js dev server is ready!"
      NEXTJS_READY=true
      break
    fi
  fi

  sleep 2
  WAITED=$((WAITED + 2))
done

if [ "$NEXTJS_READY" = false ]; then
  log_error "Next.js dev server failed to start within ${MAX_WAIT} seconds"
  log_error "Check logs: /tmp/nextjs-dev.log"
  tail -50 /tmp/nextjs-dev.log
  exit 1
fi

echo ""
log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log_info "🚀 Development Server Ready!"
log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  VM0_API_URL is set to: ${GREEN}${TUNNEL_URL}${NC}"
echo ""
log_info "You can now test E2B webhooks locally:"
echo "  ${YELLOW}vm0 run <agent-name> \"<prompt>\"${NC}"
echo ""
log_info "Logs:"
echo "  Tunnel:  tail -f ${TUNNEL_LOG}"
echo "  Next.js: tail -f /tmp/nextjs-dev.log"
echo ""
log_info "Press Ctrl+C to stop both servers"
log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Tail Next.js logs (this keeps the script running)
tail -f /tmp/nextjs-dev.log
