#!/bin/bash
# Start the API dev server with the same public tunnel URL used by the web app.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
TUNNEL_URL_FILE="$REPO_ROOT/turbo/.dev-tunnel-url"
MAX_WAIT_SECONDS="${API_TUNNEL_URL_WAIT_SECONDS:-90}"

wait_for_tunnel_url() {
  local waited=0
  local tunnel_url

  while (( waited < MAX_WAIT_SECONDS )); do
    tunnel_url="$(cat "$TUNNEL_URL_FILE" 2>/dev/null || true)"
    if [[ "$tunnel_url" == https://* ]]; then
      printf '%s\n' "$tunnel_url"
      return 0
    fi

    sleep 1
    waited=$((waited + 1))
  done

  return 1
}

if ! TUNNEL_URL="$(wait_for_tunnel_url)"; then
  echo "Error: timed out waiting for web tunnel URL at $TUNNEL_URL_FILE" >&2
  echo "Start web dev together with api dev so the API can publish external callbacks." >&2
  exit 1
fi

echo "[api:dev] VM0_API_URL=${TUNNEL_URL}"

cd "$API_APP_DIR"
exec env VM0_API_URL="$TUNNEL_URL" VM0_DEBUG='*' tsx watch --env-file=.env.local src/server.ts
