#!/bin/bash
# Start the API dev server with a public tunnel URL for external callbacks.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
TUNNEL_URL_FILE="$REPO_ROOT/turbo/.dev-tunnel-url"
TUNNEL_SCRIPT="$REPO_ROOT/scripts/tunnel.sh"
API_PORT=3001
TUNNEL_PORT=3043
ENV_LOCAL_FILE="$API_APP_DIR/.env.local"
STRIPE_PIDFILE="/tmp/stripe-listen-api.pid"
TUNNEL_PIDFILE="/tmp/cloudflared-${TUNNEL_PORT}.pid"
LEGACY_API_TUNNEL_PIDFILE="/tmp/cloudflared-${API_PORT}.pid"

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
  if [[ "${API_KEEP_TUNNEL_ON_EXIT:-}" != "1" ]]; then
    kill_stale "$TUNNEL_PIDFILE" ""
    kill_stale "$LEGACY_API_TUNNEL_PIDFILE" ""
  fi
}
trap cleanup EXIT INT TERM

default_tunnel_hostname() {
  local service="$1"
  local email domain username machine_hostname

  email="$(git -C "$REPO_ROOT" config user.email 2>/dev/null || true)"
  domain="${email##*@}"
  if [[ "$domain" != "vm0.ai" ]]; then
    return 0
  fi

  username="${email%%@*}"
  machine_hostname="$(bash "$REPO_ROOT/scripts/cn.sh")"
  printf "tunnel-%s-%s-%s.vm7.ai\n" "$username" "$machine_hostname" "$service"
}

default_api_tunnel_hostname() {
  default_tunnel_hostname "www"
}

start_api_tunnel() {
  local tunnel_hostname tunnel_url

  if [[ ! -x "$TUNNEL_SCRIPT" ]]; then
    echo "Error: tunnel script is not executable at $TUNNEL_SCRIPT" >&2
    exit 1
  fi

  tunnel_hostname="${TUNNEL_HOSTNAME:-${API_TUNNEL_HOSTNAME:-}}"
  if [[ -z "$tunnel_hostname" ]]; then
    tunnel_hostname="$(default_api_tunnel_hostname)"
  fi

  if [[ -n "$tunnel_hostname" ]]; then
    tunnel_url="$(TUNNEL_HOSTNAME="$tunnel_hostname" "$TUNNEL_SCRIPT" "$TUNNEL_PORT")"
  else
    tunnel_url="$("$TUNNEL_SCRIPT" "$TUNNEL_PORT")"
  fi

  printf "%s\n" "$tunnel_url" > "$TUNNEL_URL_FILE"
  printf "%s\n" "$tunnel_url"
}

kill_stale "$LEGACY_API_TUNNEL_PIDFILE" ""

TUNNEL_URL="$(start_api_tunnel)"

echo "[api:dev] Tunnel URL=${TUNNEL_URL}"

start_stripe_webhook_forwarding

cd "$API_APP_DIR"
env \
  VM0_DEBUG='*' \
  FEISHU_CALLBACK_BASE_URL="$TUNNEL_URL" \
  tsx watch --env-file=.env.local src/server.ts
