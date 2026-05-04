#!/bin/bash
# Start Cloudflare Tunnel and Expo Metro dev server for mobile development.
#
# Usage: scripts/dev.sh
# Outputs a tunnel URL that can be entered into Expo Go on a physical device.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
PORT=8081

kill_stale() {
  local pidfile="$1" pattern="$2"
  local pid
  pid=$(cat "$pidfile" 2>/dev/null || true)
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    sleep 1
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$pidfile"
  if [[ -n "$pattern" ]]; then
    pkill -f "$pattern" 2>/dev/null || true
  fi
}

kill_stale "/tmp/cloudflared-${PORT}.pid" "cloudflared tunnel .*localhost:${PORT}"

cleanup() {
  kill_stale "/tmp/cloudflared-${PORT}.pid" ""
}
trap cleanup EXIT INT TERM

TUNNEL_URL=$("$REPO_ROOT/scripts/tunnel.sh" "$PORT")

echo ""
echo -e "\033[0;32m[tunnel]\033[0m Tunnel URL: ${TUNNEL_URL}"
echo ""
echo -e "\033[0;36m[expo]\033[0m Open Expo Go on your phone and enter:"
echo -e "\033[1;33m  ${TUNNEL_URL}\033[0m"
echo ""

cd "$MOBILE_DIR"
exec npx expo start --port "$PORT"
