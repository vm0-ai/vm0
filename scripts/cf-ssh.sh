#!/bin/bash
# SSH to metal machines via Cloudflare Tunnel.
#
# Compatible with standard ssh argument format, so it can be used as a
# drop-in replacement (e.g., ansible_ssh_executable).
#
# For dev-* / local-* hosts: reads CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET
# from scripts/.env.local (same pattern as other project scripts).
#
# For prod-* hosts: uses CF_ACCESS_CLIENT_ID_PROD and CF_ACCESS_CLIENT_SECRET_PROD
# from environment variables.
#
# Hostname conversion must match parse_host() in scripts/cloudflared-ssh.sh:
#   dev-1.aws.vm3.ai -> dev-1-aws-ssh.vm3.ai
#
# Usage (direct):
#   scripts/cf-ssh.sh <host> [ssh-args...]
#   scripts/cf-ssh.sh dev-1.aws.vm3.ai -- ls -la
#
# Usage (as ssh replacement):
#   scripts/cf-ssh.sh -o Option=Value dev-1.aws.vm3.ai command
#   ansible-playbook -i "host," playbook.yml -e "ansible_ssh_executable=scripts/cf-ssh.sh"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
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

# --- Parse ssh-style arguments to extract hostname ---
# SSH options that consume the next argument as a value.
# e.g., -o Key=Value, -i /path/to/key, -l user
OPTS_WITH_VALUE="bcDEeFIiJLlmOopQRSWw"

HOST=""
args=()
skip_next=false

for arg in "$@"; do
  if $skip_next; then
    args+=("$arg")
    skip_next=false
    continue
  fi

  case "$arg" in
    # Long-form: -oKey=Value, -luser, -p22 (option letter + value joined)
    -[$OPTS_WITH_VALUE]?*)
      args+=("$arg")
      ;;
    # Short-form: -o Key=Value (next arg is the value)
    -[$OPTS_WITH_VALUE])
      args+=("$arg")
      skip_next=true
      ;;
    # Flags without values: -v, -A, -N, -tt, -46, etc.
    -*)
      args+=("$arg")
      ;;
    # First non-option argument is the hostname
    *)
      if [[ -z "$HOST" ]]; then
        HOST="$arg"
      fi
      args+=("$arg")
      ;;
  esac
done

if [[ -z "$HOST" ]]; then
  echo "Usage: $0 [ssh-options...] <host> [command...]" >&2
  echo "Example: $0 dev-1.aws.vm3.ai" >&2
  exit 1
fi

# Strip user@ prefix if present (user@host)
BARE_HOST="${HOST#*@}"

# --- Select credentials based on host prefix ---
if [[ "$BARE_HOST" == prod-* ]]; then
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
SUB="${BARE_HOST%.${DOMAIN}}"
TUNNEL_HOST="${SUB//./-}-ssh.${DOMAIN}"

exec ssh \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  -o "ProxyCommand=cloudflared access ssh --hostname $TUNNEL_HOST --id $CF_ID --secret $CF_SECRET" \
  "${args[@]}"
