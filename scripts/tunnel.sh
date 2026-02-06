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
# Port-to-service mapping: 3000=web, 3001=docs, 3002=platform, 3003=site
# Otherwise, creates an anonymous quick tunnel:
#   <random>.trycloudflare.com

set -euo pipefail

TUNNEL_BASE_DOMAIN="vm7.ai"
MAX_WAIT=30

log() { echo -e "[tunnel] $1" >&2; }

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

# --- Determine mode based on git email ---
EMAIL=$(git config user.email 2>/dev/null || true)
DOMAIN="${EMAIL##*@}"

if [[ "$DOMAIN" == "vm0.ai" ]]; then
  MODE="named"
  USERNAME="${EMAIL%%@*}"
  MACHINE_HOSTNAME=$(hostname)

  # Map well-known ports to service names
  case "$PORT" in
    3000) SERVICE="www" ;;
    3001) SERVICE="docs" ;;
    3002) SERVICE="platform" ;;
    3003) SERVICE="site" ;;
    *)    SERVICE="$PORT" ;;
  esac

  FQDN="tunnel-${USERNAME}-${MACHINE_HOSTNAME}-${SERVICE}.${TUNNEL_BASE_DOMAIN}"
  TUNNEL_NAME="tunnel-${USERNAME}-${MACHINE_HOSTNAME}-${SERVICE}"
  TUNNEL_URL="https://${FQDN}"
else
  MODE="anonymous"
fi

# --- Named tunnel setup ---
if [[ "$MODE" == "named" ]]; then
  log "Named tunnel: ${FQDN} -> localhost:${PORT}"

  # Ensure authenticated
  if [[ ! -f "$HOME/.cloudflared/cert.pem" ]]; then
    log "Not authenticated. Running cloudflared tunnel login..."
    cloudflared tunnel login >&2
  fi

  # Reuse existing tunnel or create a new one
  TUNNEL_ID=$(cloudflared tunnel list --name "$TUNNEL_NAME" 2>/dev/null | { grep "$TUNNEL_NAME" || true; } | awk '{print $1}')
  if [[ -n "$TUNNEL_ID" && -f "$HOME/.cloudflared/${TUNNEL_ID}.json" ]]; then
    log "Reusing existing tunnel: ${TUNNEL_NAME}"
  else
    # Credentials missing — clean up and recreate
    if [[ -n "$TUNNEL_ID" ]]; then
      cloudflared tunnel cleanup "$TUNNEL_NAME" >/dev/null 2>&1 || true
      cloudflared tunnel delete "$TUNNEL_NAME" >/dev/null 2>&1 || true
    fi
    log "Creating tunnel: ${TUNNEL_NAME}"
    cloudflared tunnel create "$TUNNEL_NAME" >&2
    TUNNEL_ID=$(cloudflared tunnel list --name "$TUNNEL_NAME" 2>/dev/null | { grep "$TUNNEL_NAME" || true; } | awk '{print $1}')
  fi
  if [[ -z "$TUNNEL_ID" ]]; then
    log "Error: failed to get tunnel ID"
    exit 1
  fi

  CREDENTIALS_FILE="$HOME/.cloudflared/${TUNNEL_ID}.json"

  # Write config
  CONFIG_FILE="$HOME/.cloudflared/config-${TUNNEL_NAME}.yml"
  cat > "$CONFIG_FILE" <<EOF
tunnel: ${TUNNEL_ID}
credentials-file: ${CREDENTIALS_FILE}

ingress:
  - hostname: ${FQDN}
    service: http://localhost:${PORT}
  - service: http_status:404
EOF

  # Create DNS route
  cloudflared tunnel route dns --overwrite-dns "$TUNNEL_NAME" "$FQDN" >/dev/null 2>&1 || true

  # Start tunnel in background
  # QUIC fails in devcontainer environment, must use HTTP/2
  cloudflared tunnel --config "$CONFIG_FILE" --protocol http2 run "$TUNNEL_NAME" > "$TUNNEL_LOG" 2>&1 &

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
