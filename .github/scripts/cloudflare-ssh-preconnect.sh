#!/usr/bin/env bash
set -euo pipefail

SSH_USER="${1:-}"
SSH_HOSTS="${2:-}"
MAX_ATTEMPTS=3

if [ -z "$SSH_USER" ] || [ -z "$SSH_HOSTS" ]; then
  echo "Usage: $0 <ssh-user> <ssh-hosts>" >&2
  exit 2
fi

if [[ ! "$SSH_USER" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Invalid SSH user: ${SSH_USER}" >&2
  exit 2
fi

TEMP_ROOT="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
TEMP_DIR=$(mktemp -d "${TEMP_ROOT%/}/cloudflare-ssh-preconnect.XXXXXX")

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

redact_diagnostics() {
  local file="$1"
  sed -E \
    -e 's/(--secret(=|[[:space:]]+))[^[:space:]]+/\1[redacted]/g' \
    -e 's/(--id(=|[[:space:]]+))[^[:space:]]+/\1[redacted]/g' \
    -e 's/(CF_ACCESS_CLIENT_SECRET=)[^[:space:]]+/\1[redacted]/g' \
    -e 's/(CF_ACCESS_CLIENT_ID=)[^[:space:]]+/\1[redacted]/g' \
    -e 's/(TUNNEL_SERVICE_TOKEN_SECRET=)[^[:space:]]+/\1[redacted]/g' \
    -e 's/(TUNNEL_SERVICE_TOKEN_ID=)[^[:space:]]+/\1[redacted]/g' \
    -e 's/(Authorization:[[:space:]]*Bearer[[:space:]]+)[^[:space:]]+/\1[redacted]/Ig' \
    "$file"
}

is_permanent_failure() {
  local file="$1"
  grep -Eiq \
    "Permission denied|Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|Bad configuration option|Unsupported option|no such identity|Identity file .* not accessible|Could not open a connection to your authentication agent|Cloudflare Access credentials rejected|Cloudflare Access SSH not configured|cloudflared is not installed" \
    "$file"
}

emit_failure() {
  local host="$1"
  local reason="$2"
  local diagnostics_file="$3"

  echo "::error title=Cloudflare SSH preconnection failed::Unable to establish replay-safe SSH transport to ${host}: ${reason}" >&2
  if [ -s "$diagnostics_file" ]; then
    echo "----- SSH preconnection stderr (last 20 lines, redacted) -----" >&2
    redact_diagnostics "$diagnostics_file" \
      | sed -E 's/^::(error|warning)( title=[^:]*)?:://' \
      | tail -n 20 >&2
  fi
}

preconnect_host() {
  local host="$1"
  local target="${SSH_USER}@${host}"
  local attempt stderr_file summary_file status

  for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)); do
    stderr_file="${TEMP_DIR}/${host}.${attempt}.stderr"
    summary_file="${TEMP_DIR}/${host}.${attempt}.summary"
    status=0

    GITHUB_STEP_SUMMARY="$summary_file" \
      ssh -n -M -N -f "$target" 2> "$stderr_file" || status=$?

    if [ "$status" -eq 0 ]; then
      GITHUB_STEP_SUMMARY="$summary_file" \
        ssh -n -O check "$target" 2>> "$stderr_file" || status=$?
      if [ "$status" -eq 0 ]; then
        echo "Established replay-safe SSH transport to ${host}"
        return 0
      fi

      GITHUB_STEP_SUMMARY="$summary_file" \
        ssh -n -O exit "$target" >> "$stderr_file" 2>&1 || true
    fi

    if [ "$status" -ne 255 ] || is_permanent_failure "$stderr_file"; then
      emit_failure "$host" "permanent connection failure (exit ${status})" "$stderr_file"
      return "$status"
    fi

    if [ "$attempt" -eq "$MAX_ATTEMPTS" ]; then
      emit_failure "$host" "retry limit reached after ${MAX_ATTEMPTS} attempts" "$stderr_file"
      return "$status"
    fi

    echo "::warning title=Retrying Cloudflare SSH preconnection::Transient SSH transport failure for ${host} on attempt ${attempt}/${MAX_ATTEMPTS}; retrying before any remote command is submitted" >&2
    sleep "$attempt"
  done
}

host_lines=$(printf '%s\n' "$SSH_HOSTS" \
  | tr ',' '\n' \
  | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' \
  | sed '/^$/d')

if [ -z "$host_lines" ]; then
  echo "No SSH hosts configured" >&2
  exit 2
fi

declare -A seen_hosts=()
while IFS= read -r host; do
  if [[ ! "$host" =~ ^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$ ]]; then
    echo "Invalid SSH host: ${host}" >&2
    exit 2
  fi

  host_key=${host,,}
  if [ -n "${seen_hosts[$host_key]+x}" ]; then
    continue
  fi
  seen_hosts[$host_key]=1
  preconnect_host "$host"
done <<< "$host_lines"
