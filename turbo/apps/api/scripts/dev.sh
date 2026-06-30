#!/bin/bash
# Start the API dev server with the same public tunnel URL used by the web app.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
TUNNEL_URL_FILE="$REPO_ROOT/turbo/.dev-tunnel-url"
MAX_WAIT_SECONDS="${API_TUNNEL_URL_WAIT_SECONDS:-90}"
API_PORT=3001
ENV_LOCAL_FILE="$API_APP_DIR/.env.local"
STRIPE_PIDFILE="/tmp/stripe-listen-api.pid"

kill_stale() {
  local pidfile="$1" pattern="$2"
  local pid

  pid="$(cat "$pidfile" 2>/dev/null || true)"
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

update_env_value() {
  local key="$1" value="$2"

  if grep -q "^${key}=" "$ENV_LOCAL_FILE"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_LOCAL_FILE"
  else
    printf "%s=%s\n" "$key" "$value" >> "$ENV_LOCAL_FILE"
  fi
}

start_stripe_webhook_forwarding() {
  local stripe_key stripe_webhook_secret

  if ! command -v stripe >/dev/null 2>&1; then
    echo "[stripe] Stripe CLI not found; skipping local webhook forwarding."
    return 0
  fi

  stripe_key="$(grep "^STRIPE_SECRET_KEY=" "$ENV_LOCAL_FILE" 2>/dev/null | cut -d= -f2-)"
  if [[ -z "$stripe_key" ]]; then
    echo "Error: STRIPE_SECRET_KEY not found in apps/api/.env.local. Run scripts/sync-env.sh first." >&2
    exit 1
  fi

  kill_stale "$STRIPE_PIDFILE" "stripe listen .*--forward-to localhost:${API_PORT}/api/webhooks/stripe"
  kill_stale "/tmp/stripe-listen.pid" "stripe listen .*--forward-to localhost:3000/api/webhooks/stripe"

  stripe_webhook_secret="$(stripe listen --api-key "$stripe_key" --print-secret 2>/dev/null)"
  update_env_value "STRIPE_WEBHOOK_SECRET" "$stripe_webhook_secret"

  stripe listen \
    --api-key "$stripe_key" \
    --forward-to "localhost:${API_PORT}/api/webhooks/stripe" \
    > /tmp/stripe-listen-api.log 2>&1 &
  echo "$!" > "$STRIPE_PIDFILE"

  echo "[stripe] Webhook forwarding -> localhost:${API_PORT}/api/webhooks/stripe"
}

cleanup() {
  kill_stale "$STRIPE_PIDFILE" ""
}
trap cleanup EXIT INT TERM

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

start_stripe_webhook_forwarding

cd "$API_APP_DIR"
env VM0_API_URL="$TUNNEL_URL" VM0_DEBUG='*' tsx watch --env-file=.env.local src/server.ts
