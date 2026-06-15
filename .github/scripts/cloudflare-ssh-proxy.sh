#!/usr/bin/env bash
set -euo pipefail

HOST="${1:-}"
if [ -z "$HOST" ]; then
  echo "Usage: $0 <host>" >&2
  exit 2
fi

CF_ACCESS_ENV_FILE="${CF_ACCESS_ENV_FILE:-$HOME/.ssh/cf-access.env}"
if [ ! -f "$CF_ACCESS_ENV_FILE" ]; then
  echo "::error title=Cloudflare Access SSH not configured::Missing credentials file at ${CF_ACCESS_ENV_FILE}" >&2
  exit 2
fi

# shellcheck source=/dev/null
source "$CF_ACCESS_ENV_FILE"

if [ -z "${CF_ACCESS_CLIENT_ID:-}" ] || [ -z "${CF_ACCESS_CLIENT_SECRET:-}" ]; then
  echo "::error title=Cloudflare Access SSH not configured::CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must be set" >&2
  exit 2
fi

DOMAIN="${CF_TUNNEL_DOMAIN:-vm3.ai}"
SUB="${HOST%.${DOMAIN}}"
TUNNEL_HOST="${SUB//./-}-ssh.${DOMAIN}"
CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-cloudflared}"
LOG_DIR="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
mkdir -p "$LOG_DIR"

safe_host=$(printf '%s' "$HOST" | tr -c 'A-Za-z0-9_.-' '_')
LOG_FILE=$(mktemp "${LOG_DIR%/}/cloudflared-ssh-${safe_host}.XXXXXX.log")

github_escape() {
  local value="$1"
  value=${value//'%'/'%25'}
  value=${value//$'\r'/'%0D'}
  value=${value//$'\n'/'%0A'}
  printf '%s' "$value"
}

redact_cloudflared_log() {
  sed -E \
    -e 's/(--secret(=|[[:space:]]+))[^[:space:]]+/\1[redacted]/g' \
    -e 's/(--id(=|[[:space:]]+))[^[:space:]]+/\1[redacted]/g' \
    -e 's/(CF_ACCESS_CLIENT_SECRET=)[^[:space:]]+/\1[redacted]/g' \
    -e 's/(CF_ACCESS_CLIENT_ID=)[^[:space:]]+/\1[redacted]/g' \
    -e 's/(Authorization:[[:space:]]*Bearer[[:space:]]+)[^[:space:]]+/\1[redacted]/Ig' \
    "$LOG_FILE"
}

failure_title() {
  if grep -Eiq "Unable to reach the origin service|connection (refused|reset|timed out)|i/o timeout|context canceled|no route to host|websocket: bad handshake|EOF" "$LOG_FILE"; then
    echo "Metal Cloudflare tunnel unavailable"
  elif grep -Eiq "access denied|unauthorized|forbidden|invalid.*token|service token|authentication" "$LOG_FILE"; then
    echo "Cloudflare Access credentials rejected"
  elif grep -Eiq "command not found|No such file or directory" "$LOG_FILE"; then
    echo "cloudflared is not installed"
  else
    echo "Metal Cloudflare SSH tunnel failed"
  fi
}

failure_message() {
  local status="$1"
  local title="$2"
  case "$title" in
    "Metal Cloudflare tunnel unavailable")
      echo "Cloudflare Access SSH to ${HOST} (${TUNNEL_HOST}) failed with cloudflared exit ${status}. The metal host tunnel is disconnected or unreachable; check the cloudflared service on the metal host."
      ;;
    "Cloudflare Access credentials rejected")
      echo "Cloudflare Access SSH to ${HOST} (${TUNNEL_HOST}) failed with cloudflared exit ${status}. Check CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET for this workflow."
      ;;
    "cloudflared is not installed")
      echo "Cloudflare Access SSH to ${HOST} (${TUNNEL_HOST}) failed because cloudflared could not be executed."
      ;;
    *)
      echo "Cloudflare Access SSH to ${HOST} (${TUNNEL_HOST}) failed with cloudflared exit ${status}. Check the cloudflared stderr below."
      ;;
  esac
}

emit_failure_marker() {
  local status="$1"
  local title message escaped_title escaped_message
  title=$(failure_title)
  message=$(failure_message "$status" "$title")
  escaped_title=$(github_escape "$title")
  escaped_message=$(github_escape "$message")

  echo "::error title=${escaped_title}::${escaped_message}" >&2

  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo "### ${title}"
      echo ""
      echo "- Host: \`${HOST}\`"
      echo "- Tunnel: \`${TUNNEL_HOST}\`"
      echo "- cloudflared exit: \`${status}\`"
      echo "- Diagnosis: ${message}"
      echo ""
    } >> "$GITHUB_STEP_SUMMARY"
  fi

  if [ -s "$LOG_FILE" ]; then
    echo "----- cloudflared stderr (last 20 lines, redacted) -----" >&2
    redact_cloudflared_log | tail -n 20 >&2
  fi
}

status=0
"$CLOUDFLARED_BIN" access ssh \
  --hostname "$TUNNEL_HOST" \
  --id "$CF_ACCESS_CLIENT_ID" \
  --secret "$CF_ACCESS_CLIENT_SECRET" \
  2> "$LOG_FILE" || status=$?

if [ "$status" -ne 0 ]; then
  emit_failure_marker "$status"
fi

rm -f "$LOG_FILE"
exit "$status"
