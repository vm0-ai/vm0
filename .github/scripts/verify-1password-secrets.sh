#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${OP_SERVICE_ACCOUNT_TOKEN:-}" ]]; then
  echo "::error::OP_SERVICE_ACCOUNT_TOKEN is not available"
  exit 1
fi

if [[ -z "${VAULT_NAME:-}" ]]; then
  echo "::error::VAULT_NAME is required"
  exit 1
fi

if [[ -z "${EXPECTED_KEYS:-}" ]]; then
  echo "::error::EXPECTED_KEYS is required"
  exit 1
fi

if ! command -v op >/dev/null 2>&1; then
  echo "::error::1Password CLI (op) is not installed"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "::error::jq is not installed"
  exit 1
fi

if ! visible_vaults="$(op vault list --format json | jq -r '.[].name' | sort)"; then
  echo "::error::failed to list 1Password vaults"
  exit 1
fi

if [[ -n "${EXPECTED_FORBIDDEN_VAULT:-}" ]] && grep -qx "$EXPECTED_FORBIDDEN_VAULT" <<< "$visible_vaults"; then
  echo "::error::1Password token unexpectedly has access to ${EXPECTED_FORBIDDEN_VAULT} vault"
  exit 1
fi

if ! grep -qx "$VAULT_NAME" <<< "$visible_vaults"; then
  visible_vault_count="$(awk 'NF { count++ } END { print count + 0 }' <<< "$visible_vaults")"
  echo "::error::1Password token cannot access ${VAULT_NAME} vault; visible vault count: ${visible_vault_count}"
  exit 1
fi

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

hash_value() {
  printf '%s' "$1" | sha256sum | cut -d' ' -f1
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

failures=0
checked=0

while IFS= read -r key; do
  [[ -n "$key" ]] || continue
  checked=$((checked + 1))

  has_github_value=true
  github_value="${!key-}"
  if [[ -z "$github_value" ]]; then
    echo "::error::${key} is missing from GitHub secrets"
    failures=$((failures + 1))
    has_github_value=false
  else
    mask_value "$github_value"
  fi

  if ! item="$(op_item_for_key "$key")"; then
    echo "::error::No 1Password item mapping for ${key}"
    failures=$((failures + 1))
    continue
  fi
  ref="op://${VAULT_NAME}/${item}/${key}"

  has_op_value=true
  if ! op_value="$(op read "$ref" 2>/dev/null)"; then
    echo "::error::${key} is missing or unreadable from 1Password (${ref})"
    failures=$((failures + 1))
    has_op_value=false
    op_value=
  fi

  if [[ "$has_op_value" == "true" && -z "$op_value" ]]; then
    echo "::error::${key} is empty in 1Password (${ref})"
    failures=$((failures + 1))
    has_op_value=false
  elif [[ "$has_op_value" == "true" ]]; then
    mask_value "$op_value"
  fi

  if [[ "$has_github_value" != "true" || "$has_op_value" != "true" ]]; then
    continue
  fi

  if [[ "$(hash_value "$github_value")" != "$(hash_value "$op_value")" ]]; then
    echo "::error::${key} differs between GitHub secrets and 1Password (${ref})"
    failures=$((failures + 1))
    continue
  fi

  echo "ok: ${key}"
done <<< "$EXPECTED_KEYS"

echo "Checked ${checked} ${VAULT_NAME} secrets"

if [[ "$failures" -gt 0 ]]; then
  echo "::error::${failures} secret comparison(s) failed"
  exit 1
fi
