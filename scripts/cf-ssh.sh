#!/bin/bash
# SSH to metal machines via Cloudflare Tunnel.
#
# For dev-* hosts: reads CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET
# from scripts/.env.local (same pattern as other project scripts).
#
# For prod-* hosts: uses CF_ACCESS_CLIENT_ID_PROD and CF_ACCESS_CLIENT_SECRET_PROD
# from environment variables.
#
# Hostname conversion must match parse_host() in scripts/cloudflared-ssh.sh:
#   dev-1.aws.vm3.ai -> dev-1-aws-ssh.vm3.ai
#
# Usage:
#   scripts/cf-ssh.sh <host> [ssh-args...]
#
# Examples:
#   scripts/cf-ssh.sh dev-1.aws.vm3.ai
#   scripts/cf-ssh.sh dev-1.aws.vm3.ai -L 8080:localhost:8080
#   scripts/cf-ssh.sh dev-1.aws.vm3.ai -- ls -la
#   scripts/cf-ssh.sh prod-1.aws.vm3.ai -- uptime

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DOMAIN="vm3.ai"

# --- Load .env.local ---
ENV_FILE="$SCRIPT_DIR/.env.local"
if [[ -f "$ENV_FILE" ]]; then
  while IFS='=' read -r key value; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    value="${value%\"}"
    value="${value#\"}"
    case "$key" in
      CF_ACCESS_CLIENT_ID) export CF_ACCESS_CLIENT_ID="$value" ;;
      CF_ACCESS_CLIENT_SECRET) export CF_ACCESS_CLIENT_SECRET="$value" ;;
    esac
  done < "$ENV_FILE"
fi

# --- Args ---
if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <host> [ssh-args...]" >&2
  echo "Example: $0 dev-1.aws.vm3.ai" >&2
  exit 1
fi

HOST="$1"
shift

# --- Select credentials based on host prefix ---
if [[ "$HOST" == prod-* ]]; then
  CF_ID="${CF_ACCESS_CLIENT_ID_PROD:-}"
  CF_SECRET="${CF_ACCESS_CLIENT_SECRET_PROD:-}"
  if [[ -z "$CF_ID" || -z "$CF_SECRET" ]]; then
    echo "Error: CF_ACCESS_CLIENT_ID_PROD and CF_ACCESS_CLIENT_SECRET_PROD must be set for prod hosts" >&2
    exit 1
  fi
else
  CF_ID="${CF_ACCESS_CLIENT_ID:-}"
  CF_SECRET="${CF_ACCESS_CLIENT_SECRET:-}"
  if [[ -z "$CF_ID" || -z "$CF_SECRET" ]]; then
    echo "Error: CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must be set" >&2
    echo "Add them to $ENV_FILE or export as environment variables" >&2
    exit 1
  fi
fi

# --- Convert hostname to tunnel hostname ---
# Must match parse_host() in scripts/cloudflared-ssh.sh
SUB="${HOST%.${DOMAIN}}"
TUNNEL_HOST="${SUB//./-}-ssh.${DOMAIN}"

exec ssh \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  -o ProxyCommand="cloudflared access ssh --hostname $TUNNEL_HOST --id $CF_ID --secret $CF_SECRET" \
  "$HOST" "$@"
