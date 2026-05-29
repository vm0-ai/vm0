#!/usr/bin/env bash
set -euo pipefail
umask 077

readonly DEFAULT_REPO="vm0-ai/vm0"
readonly MAX_GITHUB_SECRET_BYTES=49152
readonly SECRET_NAME="CONNECTOR_OAUTH_CLIENT_SECRETS"

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

usage() {
  cat <<EOF
Usage: $0 <development|production> [repo]

Build ${SECRET_NAME} from 1Password and write it to GitHub.

Targets:
  development  Development vault -> repository secret
  production   Production vault -> production environment secret

The repo defaults to ${DEFAULT_REPO}.

Prerequisites:
  - op can access the target 1Password vault through local sign-in or OP_SERVICE_ACCOUNT_TOKEN
  - gh is authenticated with permission to write repository and production environment secrets
EOF
}

error() {
  echo "Error: $*" >&2
}

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    error "$2"
    exit 1
  fi
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

build_bundle() {
  local vault_name="$1"
  local output_file="$2"
  local bundle_tmp="$3"
  local next_tmp="$4"

  printf '{}\n' > "$bundle_tmp"

  local failures=0
  local bundled=0

  local key
  for key in "${EXPECTED_KEYS[@]}"; do
    local item
    if ! item="$(op_item_for_key "$key")"; then
      error "No 1Password item mapping for ${key}"
      failures=$((failures + 1))
      continue
    fi

    local ref="op://${vault_name}/${item}/${key}"
    local value
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

    jq --arg key "$key" --arg value "$value" '. + {($key): $value}' "$bundle_tmp" > "$next_tmp"
    mv "$next_tmp" "$bundle_tmp"
    bundled=$((bundled + 1))
  done

  if [[ "$failures" -gt 0 ]]; then
    error "${failures} connector OAuth client secret value(s) failed validation"
    exit 1
  fi

  local bundle_json
  if ! bundle_json="$(jq -c -e . "$bundle_tmp")"; then
    error "generated connector OAuth client secret bundle is not valid JSON"
    exit 1
  fi

  local bundle_bytes
  bundle_bytes="$(printf '%s' "$bundle_json" | wc -c | tr -d '[:space:]')"
  if [[ "$bundle_bytes" -gt "$MAX_GITHUB_SECRET_BYTES" ]]; then
    error "connector OAuth client secret bundle is ${bundle_bytes} bytes; GitHub secret limit is ${MAX_GITHUB_SECRET_BYTES} bytes"
    exit 1
  fi

  printf '%s' "$bundle_json" > "$output_file"
  chmod 600 "$output_file"

  echo "Bundled ${bundled} connector OAuth client secret entries from ${vault_name} (${bundle_bytes} bytes)"
}

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage >&2
  exit 64
fi

scope="$1"
repo="${2:-$DEFAULT_REPO}"

case "$scope" in
  development)
    vault_name="Development"
    target_name="repository"
    gh_secret_args=(secret set "$SECRET_NAME" --repo "$repo")
    ;;
  production)
    vault_name="Production"
    target_name="production environment"
    gh_secret_args=(secret set "$SECRET_NAME" --repo "$repo" --env production)
    ;;
  *)
    usage >&2
    exit 64
    ;;
esac

require_tool op "1Password CLI (op) is not installed"
require_tool jq "jq is not installed"
require_tool gh "GitHub CLI (gh) is not installed"

if ! op vault get "$vault_name" >/dev/null 2>&1; then
  error "1Password CLI cannot access the ${vault_name} vault; sign in with op or set OP_SERVICE_ACCOUNT_TOKEN"
  exit 1
fi

bundle_file="$(mktemp "${TMPDIR:-/tmp}/connector-oauth-client-secrets-${scope}.XXXXXX")"
bundle_tmp="$(mktemp "${TMPDIR:-/tmp}/connector-oauth-client-secrets-${scope}-bundle.XXXXXX")"
next_tmp="$(mktemp "${TMPDIR:-/tmp}/connector-oauth-client-secrets-${scope}-next.XXXXXX")"
trap 'rm -f "$bundle_file" "$bundle_tmp" "$next_tmp"' EXIT

echo "Building ${SECRET_NAME} from the ${vault_name} 1Password vault..."
build_bundle "$vault_name" "$bundle_file" "$bundle_tmp" "$next_tmp"

echo "Writing ${SECRET_NAME} to the ${target_name} for ${repo}..."
if ! gh "${gh_secret_args[@]}" < "$bundle_file"; then
  error "failed to update ${target_name} secret ${SECRET_NAME} for ${repo}"
  exit 1
fi

echo "Updated ${target_name} secret ${SECRET_NAME} for ${repo}"
