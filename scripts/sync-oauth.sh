#!/usr/bin/env bash
set -euo pipefail

# Sync OAuth connector credentials between 1Password and GitHub
#
# Flow:
#   1. Prompt for OAuth provider name (e.g., DOCUSIGN)
#   2. Create empty fields in 1Password (dev + prod)
#   3. Wait for user to fill in values in 1Password
#   4. Read values from 1Password and sync to GitHub vars/secrets
#
# Usage: ./scripts/sync-oauth.sh [PROVIDER_NAME]

# 1Password vault/item mapping
DEV_VAULT="Development"
DEV_ITEM="vm0-env-local"
PROD_VAULT="Production"
PROD_ITEM="vm0-env-production"

# --- Helpers ---

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: $1 is not installed."
    exit 1
  fi
}

# Check if a field exists AND has a real (non-empty, non-placeholder) value.
op_field_ready() {
  local vault="$1" item="$2" field="$3"
  local val
  val="$(op read "op://${vault}/${item}/${field}" 2>/dev/null)" || return 1
  [[ -n "$val" && "$val" != "REPLACE_ME" ]]
}

# Edit an item, retrying with a placeholder password if the item is a
# Password-type entry whose built-in password field is empty (triggers
# "Password item requires ps value" validation error).
op_safe_edit() {
  local vault="$1" item="$2"
  shift 2
  local err
  if err=$(op item edit "$item" --vault "$vault" "$@" 2>&1 >/dev/null); then
    return 0
  fi
  if [[ "$err" == *"Password item requires ps value"* ]]; then
    op item edit "$item" --vault "$vault" "password[password]=placeholder" "$@" >/dev/null
  else
    echo "$err" >&2
    return 1
  fi
}

# --- Main ---

require_tool op
require_tool gh

# Get provider name from argument or prompt
PROVIDER="${1:-}"
if [[ -z "$PROVIDER" ]]; then
  read -rp "Enter OAuth provider name (e.g., DOCUSIGN): " PROVIDER
fi

PROVIDER="$(echo "$PROVIDER" | tr '[:lower:]' '[:upper:]')"
if [[ -z "$PROVIDER" ]]; then
  echo "Error: provider name cannot be empty."
  exit 1
fi

CLIENT_ID="${PROVIDER}_OAUTH_CLIENT_ID"
CLIENT_SECRET="${PROVIDER}_OAUTH_CLIENT_SECRET"

echo ""
echo "Provider:      ${PROVIDER}"
echo "Client ID var: ${CLIENT_ID}"
echo "Secret var:    ${CLIENT_SECRET}"
echo ""

# Sign in to 1Password
echo "Signing in to 1Password..."
eval "$(op signin)"

# --- Step 1: Check if values already exist in 1Password ---

all_ready=true
for vault_item in "${DEV_VAULT}/${DEV_ITEM}" "${PROD_VAULT}/${PROD_ITEM}"; do
  vault="${vault_item%%/*}"
  item="${vault_item##*/}"
  if ! op_field_ready "$vault" "$item" "$CLIENT_ID" || ! op_field_ready "$vault" "$item" "$CLIENT_SECRET"; then
    all_ready=false
    break
  fi
done

if [[ "$all_ready" == true ]]; then
  # All 4 values already exist — skip 1Password creation, go straight to sync
  echo "All values already exist in 1Password."
else
  # --- Create placeholder fields in 1Password ---

  echo ""
  echo "=== Creating fields in 1Password ==="

  for vault_item in "${DEV_VAULT}/${DEV_ITEM}" "${PROD_VAULT}/${PROD_ITEM}"; do
    vault="${vault_item%%/*}"
    item="${vault_item##*/}"

    echo ""
    echo "--- ${vault} / ${item} ---"

    assignments=()

    if op_field_ready "$vault" "$item" "$CLIENT_ID"; then
      echo "  ${CLIENT_ID} already has a value, skipping."
    else
      assignments+=("${CLIENT_ID}[text]=REPLACE_ME")
    fi

    if op_field_ready "$vault" "$item" "$CLIENT_SECRET"; then
      echo "  ${CLIENT_SECRET} already has a value, skipping."
    else
      assignments+=("${CLIENT_SECRET}[password]=REPLACE_ME")
    fi

    if [[ ${#assignments[@]} -gt 0 ]]; then
      op_safe_edit "$vault" "$item" "${assignments[@]}"
      for a in "${assignments[@]}"; do
        field_name="${a%%\[*}"
        field_type="${a#*[}"
        field_type="${field_type%%]*}"
        echo "  Created ${field_name} (${field_type})"
      done
    fi
  done

  echo ""
  echo "=== 1Password fields are ready ==="
  echo "Please fill in the values in 1Password, then re-run:"
  echo ""
  echo "  bash scripts/sync-oauth.sh ${PROVIDER}"
  echo ""
  exit 0
fi

# --- Step 2: Read from 1Password and sync to GitHub ---

echo ""
echo "=== Reading values from 1Password ==="

dev_id="$(op read "op://${DEV_VAULT}/${DEV_ITEM}/${CLIENT_ID}")"
dev_secret="$(op read "op://${DEV_VAULT}/${DEV_ITEM}/${CLIENT_SECRET}")"
prod_id="$(op read "op://${PROD_VAULT}/${PROD_ITEM}/${CLIENT_ID}")"
prod_secret="$(op read "op://${PROD_VAULT}/${PROD_ITEM}/${CLIENT_SECRET}")"

# Validate values are not empty or placeholder
for var_name in dev_id dev_secret prod_id prod_secret; do
  if [[ -z "${!var_name}" || "${!var_name}" == "REPLACE_ME" ]]; then
    echo "Error: ${var_name} is empty or still has placeholder value. Please fill in the value in 1Password and retry."
    exit 1
  fi
done

# Mask secrets in preview: show first 4 chars then ***
mask() { local v="$1"; echo "${v:0:4}***"; }

echo ""
echo "=== The following commands will be executed ==="
echo ""
echo "  # Dev (repo-level)"
echo "  echo \"${dev_id}\" | gh variable --repo vm0-ai/vm0 set ${CLIENT_ID}"
echo "  echo \"$(mask "$dev_secret")\" | gh secret --repo vm0-ai/vm0 set ${CLIENT_SECRET}"
echo ""
echo "  # Production"
echo "  echo \"${prod_id}\" | gh variable --repo vm0-ai/vm0 set ${CLIENT_ID} -e production"
echo "  echo \"$(mask "$prod_secret")\" | gh secret --repo vm0-ai/vm0 set ${CLIENT_SECRET} -e production"
echo ""
read -rp "Proceed? [y/N] " confirm
if [[ ! "$confirm" =~ ^[Yy] ]]; then
  echo "Aborted."
  exit 0
fi

echo ""
echo "=== Syncing to GitHub ==="

# Dev (repo-level)
echo "$dev_id" | gh variable --repo vm0-ai/vm0 set "$CLIENT_ID"
echo "  Set repo variable: ${CLIENT_ID}"

echo "$dev_secret" | gh secret --repo vm0-ai/vm0 set "$CLIENT_SECRET"
echo "  Set repo secret:   ${CLIENT_SECRET}"

# Prod (production environment)
echo "$prod_id" | gh variable --repo vm0-ai/vm0 set "$CLIENT_ID" -e production
echo "  Set production variable: ${CLIENT_ID}"

echo "$prod_secret" | gh secret --repo vm0-ai/vm0 set "$CLIENT_SECRET" -e production
echo "  Set production secret:   ${CLIENT_SECRET}"

echo ""
echo "=== Done ==="
echo "OAuth credentials for ${PROVIDER} are synced to GitHub."
