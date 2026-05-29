#!/usr/bin/env bash
set -euo pipefail
umask 077

readonly DEFAULT_REPO="vm0-ai/vm0"
readonly SECRET_NAME="CONNECTOR_OAUTH_CLIENT_SECRETS"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILDER="${SCRIPT_DIR}/build-connector-oauth-client-secrets-bundle.sh"

usage() {
  cat <<EOF
Usage: $0 <development|production> [repo]

Build ${SECRET_NAME} from 1Password and write it to GitHub.

Targets:
  development  Development vault -> repository secret
  production   Production vault -> production environment secret

The repo defaults to ${DEFAULT_REPO}.
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

bundle_file="$(mktemp "${TMPDIR:-/tmp}/connector-oauth-client-secrets-${scope}.XXXXXX.json")"
trap 'rm -f "$bundle_file"' EXIT

echo "Building ${SECRET_NAME} from the ${vault_name} 1Password vault..."
VAULT_NAME="$vault_name" OUTPUT_FILE="$bundle_file" "$BUILDER"

echo "Writing ${SECRET_NAME} to the ${target_name} for ${repo}..."
if ! gh "${gh_secret_args[@]}" < "$bundle_file"; then
  error "failed to update ${target_name} secret ${SECRET_NAME} for ${repo}"
  exit 1
fi

echo "Updated ${target_name} secret ${SECRET_NAME} for ${repo}"
