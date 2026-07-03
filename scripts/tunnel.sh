#!/bin/bash
# Start a Cloudflare Tunnel to expose a local service.
# Outputs the tunnel URL to stdout. All other messages go to stderr.
# Writes the cloudflared PID to /tmp/cloudflared-<port>.pid for cleanup.
#
# Usage: scripts/tunnel.sh <port>
# Example: TUNNEL_URL=$(scripts/tunnel.sh 3000)
#
# If git email is @vm0.ai, creates a named tunnel with fixed domain:
#   tunnel-<username>-<hostname>-<service>.vm7.ai
# Port-to-service mapping: 3000=web, 3001=docs, 3002=app
# Otherwise, creates an anonymous quick tunnel:
#   <random>.trycloudflare.com
#
# Named tunnels use the Cloudflare API (CF_DNS_AND_TUNNEL_API_TOKEN + CF_ACCOUNT_ID)
# to manage tunnels without requiring interactive `cloudflared tunnel login`.

set -euo pipefail

TUNNEL_BASE_DOMAIN="vm7.ai"
MAX_WAIT=30
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { echo -e "[tunnel] $1" >&2; }

# --- Load env from scripts/.env.local if not already set ---
load_env() {
  local var="$1"
  if [[ -z "${!var:-}" ]]; then
    local env_file="$SCRIPT_DIR/.env.local"
    if [[ -f "$env_file" ]]; then
      local val
      val=$(grep "^${var}=" "$env_file" 2>/dev/null | head -1 | cut -d= -f2-)
      if [[ -n "$val" ]]; then
        export "$var=$val"
      fi
    fi
  fi
}

# --- Args ---
if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <port>" >&2
  exit 1
fi

PORT="$1"
if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
  echo "Error: port must be a number, got '$PORT'" >&2
  exit 1
fi

TUNNEL_LOG="/tmp/cloudflared-${PORT}.log"
TUNNEL_PIDFILE="/tmp/cloudflared-${PORT}.pid"

# --- Determine mode based on git email or TUNNEL_HOSTNAME override ---
if [[ -n "${TUNNEL_HOSTNAME:-}" ]]; then
  MODE="named"
  FQDN="$TUNNEL_HOSTNAME"
  TUNNEL_NAME="${FQDN%%.*}"
  TUNNEL_URL="https://${FQDN}"
  log "Using TUNNEL_HOSTNAME override: ${FQDN}"
else
  EMAIL=$(git config user.email 2>/dev/null || true)
  DOMAIN="${EMAIL##*@}"

  if [[ "$DOMAIN" == "vm0.ai" ]]; then
    MODE="named"
    USERNAME="${EMAIL%%@*}"
    MACHINE_HOSTNAME=$(bash "$(dirname "$0")/cn.sh")

    # Map well-known ports to service names
    case "$PORT" in
      3000) SERVICE="www" ;;
      3001) SERVICE="docs" ;;
      3002) SERVICE="app" ;;
      *)    SERVICE="$PORT" ;;
    esac

    FQDN="tunnel-${USERNAME}-${MACHINE_HOSTNAME}-${SERVICE}.${TUNNEL_BASE_DOMAIN}"
    TUNNEL_NAME="tunnel-${USERNAME}-${MACHINE_HOSTNAME}-${SERVICE}"
    TUNNEL_URL="https://${FQDN}"
  else
    MODE="anonymous"
  fi
fi

# --- Named tunnel setup via Cloudflare API ---
if [[ "$MODE" == "named" ]]; then
  log "Named tunnel: ${FQDN} -> localhost:${PORT}"

  load_env CF_DNS_AND_TUNNEL_API_TOKEN
  load_env CF_ACCOUNT_ID

  if [[ -z "${CF_DNS_AND_TUNNEL_API_TOKEN:-}" || -z "${CF_ACCOUNT_ID:-}" ]]; then
    log "Error: CF_DNS_AND_TUNNEL_API_TOKEN and CF_ACCOUNT_ID are required for named tunnels."
    log "Run 'scripts/sync-env.sh' to sync them from 1Password."
    exit 1
  fi

  CF_API="https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/cfd_tunnel"
  AUTH_HEADER="Authorization: Bearer ${CF_DNS_AND_TUNNEL_API_TOKEN}"

  # Find existing tunnel by name
  TUNNEL_RESPONSE=$(curl -sf "${CF_API}?name=${TUNNEL_NAME}&is_deleted=false" -H "$AUTH_HEADER")
  TUNNEL_ID=$(echo "$TUNNEL_RESPONSE" | python3 -c "import sys,json; r=json.load(sys.stdin)['result']; print(r[0]['id'] if r else '')" 2>/dev/null || true)

  if [[ -n "$TUNNEL_ID" ]]; then
    log "Reusing existing tunnel: ${TUNNEL_NAME} (${TUNNEL_ID})"
  else
    # Create new tunnel
    log "Creating tunnel: ${TUNNEL_NAME}"
    CREATE_RESPONSE=$(curl -sf -X POST "$CF_API" \
      -H "$AUTH_HEADER" \
      -H "Content-Type: application/json" \
      -d "{\"name\":\"${TUNNEL_NAME}\",\"tunnel_secret\":\"$(openssl rand -base64 32)\"}")
    TUNNEL_ID=$(echo "$CREATE_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['id'])" 2>/dev/null || true)
    if [[ -z "$TUNNEL_ID" ]]; then
      log "Error: failed to create tunnel"
      echo "$CREATE_RESPONSE" >&2
      exit 1
    fi
    log "Created tunnel: ${TUNNEL_NAME} (${TUNNEL_ID})"
  fi

  # Get tunnel token
  TUNNEL_TOKEN=$(curl -sf "${CF_API}/${TUNNEL_ID}/token" -H "$AUTH_HEADER" | python3 -c "import sys,json; print(json.load(sys.stdin)['result'])" 2>/dev/null || true)
  if [[ -z "$TUNNEL_TOKEN" ]]; then
    log "Error: failed to get tunnel token"
    exit 1
  fi

  # Create DNS CNAME route via API
  ZONE_RESPONSE=$(curl -sf "https://api.cloudflare.com/client/v4/zones?name=${TUNNEL_BASE_DOMAIN}" -H "$AUTH_HEADER")
  ZONE_ID=$(echo "$ZONE_RESPONSE" | python3 -c "import sys,json; r=json.load(sys.stdin)['result']; print(r[0]['id'] if r else '')" 2>/dev/null || true)
  if [[ -n "$ZONE_ID" ]]; then
    CNAME_TARGET="${TUNNEL_ID}.cfargotunnel.com"
    # Check if DNS record exists
    EXISTING_RECORD=$(curl -sf "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records?name=${FQDN}&type=CNAME" -H "$AUTH_HEADER")
    RECORD_ID=$(echo "$EXISTING_RECORD" | python3 -c "import sys,json; r=json.load(sys.stdin)['result']; print(r[0]['id'] if r else '')" 2>/dev/null || true)
    if [[ -n "$RECORD_ID" ]]; then
      # Update existing record
      curl -sf -X PUT "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records/${RECORD_ID}" \
        -H "$AUTH_HEADER" -H "Content-Type: application/json" \
        -d "{\"type\":\"CNAME\",\"name\":\"${FQDN}\",\"content\":\"${CNAME_TARGET}\",\"proxied\":true}" >/dev/null 2>&1
    else
      # Create new record
      curl -sf -X POST "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records" \
        -H "$AUTH_HEADER" -H "Content-Type: application/json" \
        -d "{\"type\":\"CNAME\",\"name\":\"${FQDN}\",\"content\":\"${CNAME_TARGET}\",\"proxied\":true}" >/dev/null 2>&1
    fi
    log "DNS route: ${FQDN} -> ${CNAME_TARGET}"
  fi

  # Write ingress config
  CONFIG_FILE="/tmp/cloudflared-config-${TUNNEL_NAME}.yml"
  cat > "$CONFIG_FILE" <<EOF
ingress:
  - hostname: ${FQDN}
    service: http://localhost:${PORT}
  - service: http_status:404
EOF

  # Start tunnel with token (no cert.pem needed)
  # QUIC fails in devcontainer environment, must use HTTP/2
  cloudflared tunnel --config "$CONFIG_FILE" --protocol http2 run --token "$TUNNEL_TOKEN" > "$TUNNEL_LOG" 2>&1 &

else
  log "Anonymous tunnel: localhost:${PORT}"

  # Start quick tunnel in background
  # QUIC fails in devcontainer environment, must use HTTP/2
  cloudflared tunnel --url "http://localhost:${PORT}" --protocol http2 > "$TUNNEL_LOG" 2>&1 &
fi

TUNNEL_PID=$!
echo "$TUNNEL_PID" > "$TUNNEL_PIDFILE"

# --- Wait for tunnel to be ready ---
log "Waiting for tunnel connection..."
ATTEMPT=0

while [[ $ATTEMPT -lt $MAX_WAIT ]]; do
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    log "Error: cloudflared process died unexpectedly"
    cat "$TUNNEL_LOG" >&2
    exit 1
  fi

  if [[ "$MODE" == "named" ]]; then
    # Named tunnel: wait for "Registered tunnel connection"
    if grep -q "Registered tunnel connection" "$TUNNEL_LOG" 2>/dev/null; then
      break
    fi
  else
    # Anonymous tunnel: wait for trycloudflare.com URL
    TUNNEL_URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -n 1)
    if [[ -n "$TUNNEL_URL" ]]; then
      break
    fi
  fi

  ATTEMPT=$((ATTEMPT + 1))
  sleep 1
done

if [[ "$MODE" == "anonymous" && -z "${TUNNEL_URL:-}" ]]; then
  log "Error: failed to get tunnel URL after ${MAX_WAIT}s"
  cat "$TUNNEL_LOG" >&2
  exit 1
fi

if [[ "$MODE" == "named" ]] && ! grep -q "Registered tunnel connection" "$TUNNEL_LOG" 2>/dev/null; then
  log "Error: tunnel failed to connect after ${MAX_WAIT}s"
  cat "$TUNNEL_LOG" >&2
  exit 1
fi

log "Tunnel ready: ${TUNNEL_URL} -> localhost:${PORT} (pid: ${TUNNEL_PID})"

# Output URL to stdout
echo "$TUNNEL_URL"
