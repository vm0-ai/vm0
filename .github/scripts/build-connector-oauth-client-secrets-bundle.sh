#!/usr/bin/env bash
set -euo pipefail
umask 077

readonly MAX_GITHUB_SECRET_BYTES=49152

readonly EXPECTED_KEYS=(
  AIRTABLE_OAUTH_CLIENT_SECRET
  ASANA_OAUTH_CLIENT_SECRET
  CANVA_OAUTH_CLIENT_SECRET
  CLOSE_OAUTH_CLIENT_SECRET
  DEEL_OAUTH_CLIENT_SECRET
  DOCUSIGN_OAUTH_CLIENT_SECRET
  DROPBOX_OAUTH_CLIENT_SECRET
  FIGMA_OAUTH_CLIENT_SECRET
  GH_OAUTH_CLIENT_SECRET
  GOOGLE_OAUTH_CLIENT_SECRET
  GUMROAD_OAUTH_CLIENT_SECRET
  AHREFS_OAUTH_CLIENT_SECRET
  HUBSPOT_OAUTH_CLIENT_SECRET
  INTERVALS_ICU_OAUTH_CLIENT_SECRET
  LINEAR_OAUTH_CLIENT_SECRET
  NEON_OAUTH_CLIENT_SECRET
  META_ADS_OAUTH_CLIENT_SECRET
  MERCURY_OAUTH_CLIENT_SECRET
  MICROSOFT_OAUTH_CLIENT_SECRET
  MONDAY_OAUTH_CLIENT_SECRET
  NOTION_OAUTH_CLIENT_SECRET
  POSTHOG_OAUTH_CLIENT_SECRET
  REDDIT_OAUTH_CLIENT_SECRET
  SENTRY_OAUTH_CLIENT_SECRET
  SLACK_OAUTH_CLIENT_SECRET
  SPOTIFY_OAUTH_CLIENT_SECRET
  STRAVA_OAUTH_CLIENT_SECRET
  STRIPE_OAUTH_CLIENT_SECRET
  SUPABASE_OAUTH_CLIENT_SECRET
  TODOIST_OAUTH_CLIENT_SECRET
  VERCEL_OAUTH_CLIENT_SECRET
  WEBFLOW_OAUTH_CLIENT_SECRET
  XERO_OAUTH_CLIENT_SECRET
  X_OAUTH_CLIENT_SECRET
)

error() {
  echo "::error::$*"
}

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    error "${name} is required"
    exit 1
  fi
}

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    error "$2"
    exit 1
  fi
}

mask_value() {
  if [[ "${GITHUB_ACTIONS:-}" != "true" || -z "$1" ]]; then
    return
  fi

  local value="$1"
  value="${value//'%'/'%25'}"
  value="${value//$'\r'/'%0D'}"
  value="${value//$'\n'/'%0A'}"
  echo "::add-mask::$value"
}

op_item_for_key() {
  local key="$1"
  case "$key" in
    GH_OAUTH_CLIENT_SECRET)
      printf 'github'
      ;;
    *_OAUTH_CLIENT_SECRET)
      local prefix="${key%_OAUTH_CLIENT_SECRET}"
      printf '%s' "$prefix" | tr '[:upper:]_' '[:lower:]-'
      ;;
    *)
      return 1
      ;;
  esac
}

require_env VAULT_NAME
require_env OUTPUT_FILE
require_env OP_SERVICE_ACCOUNT_TOKEN
require_tool op "1Password CLI (op) is not installed"
require_tool jq "jq is not installed"

case "$VAULT_NAME" in
  Development | Production) ;;
  *)
    error "VAULT_NAME must be Development or Production"
    exit 1
    ;;
esac

bundle_tmp="$(mktemp)"
next_tmp="$(mktemp)"
trap 'rm -f "$bundle_tmp" "$next_tmp"' EXIT

printf '{}\n' > "$bundle_tmp"

failures=0
bundled=0

for key in "${EXPECTED_KEYS[@]}"; do
  if ! item="$(op_item_for_key "$key")"; then
    error "No 1Password item mapping for ${key}"
    failures=$((failures + 1))
    continue
  fi

  ref="op://${VAULT_NAME}/${item}/${key}"
  if ! value="$(op read "$ref" 2>/dev/null)"; then
    error "${key} is missing or unreadable from 1Password (${ref})"
    failures=$((failures + 1))
    continue
  fi

  if [[ -z "$value" ]]; then
    error "${key} is empty in 1Password (${ref})"
    failures=$((failures + 1))
    continue
  fi

  mask_value "$value"

  jq --arg key "$key" --arg value "$value" '. + {($key): $value}' "$bundle_tmp" > "$next_tmp"
  mv "$next_tmp" "$bundle_tmp"
  bundled=$((bundled + 1))
done

if [[ "$failures" -gt 0 ]]; then
  error "${failures} connector OAuth client secret value(s) failed validation"
  exit 1
fi

if ! bundle_json="$(jq -c -e . "$bundle_tmp")"; then
  error "generated connector OAuth client secret bundle is not valid JSON"
  exit 1
fi

bundle_bytes="$(printf '%s' "$bundle_json" | wc -c | tr -d '[:space:]')"
if [[ "$bundle_bytes" -gt "$MAX_GITHUB_SECRET_BYTES" ]]; then
  error "connector OAuth client secret bundle is ${bundle_bytes} bytes; GitHub secret limit is ${MAX_GITHUB_SECRET_BYTES} bytes"
  exit 1
fi

mkdir -p "$(dirname "$OUTPUT_FILE")"
printf '%s' "$bundle_json" > "$OUTPUT_FILE"
chmod 600 "$OUTPUT_FILE"

echo "Bundled ${bundled} connector OAuth client secret entries from ${VAULT_NAME} into ${OUTPUT_FILE} (${bundle_bytes} bytes)"
