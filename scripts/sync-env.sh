#!/usr/bin/env bash
set -e

# Sync all environment variables from .env.local.tpl files using 1Password CLI
#
# Usage: ./scripts/sync-env.sh

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- 1Password sync ---
sync_with_1password() {
  if ! command -v op >/dev/null 2>&1; then
    echo "Error: 1Password CLI (op) is not installed"
    echo "Install it from: https://developer.1password.com/docs/cli/get-started/"
    exit 1
  fi

  echo "Signing in to 1Password..."
  eval "$(op signin)"

  echo "Syncing all environment templates..."

  while IFS= read -r tpl_file; do
    output_file="${tpl_file%.tpl}"
    echo ""
    echo "Syncing: $tpl_file"
    echo "Output:  $output_file"
    op inject --force -i "$tpl_file" -o "$output_file"
    echo "✓ Synced successfully"
  done < <(find "$PROJECT_ROOT" -name ".env.local.tpl" -type f)

  echo ""
  echo "✓ All environment variables synced successfully"
}

WEB_ENV_LOCAL="$PROJECT_ROOT/turbo/apps/web/.env.local"

# --- Computed variables ---
# RUNNER_DEFAULT_GROUP is auto-derived from git email + hostname.
configure_runner_group() {
  [[ -f "$WEB_ENV_LOCAL" ]] || return 0

  # Derive from git email + hostname (e.g. alice@vm0.ai on macbook -> alice-macbook)
  local username hostname_short
  username=$(git config user.email 2>/dev/null | sed 's/@.*//' | tr '[:upper:].' '[:lower:]-' | sed 's/-$//' || true)
  hostname_short=$(hostname -s)

  if [[ -z "$username" ]]; then
    echo "  ✗ RUNNER_DEFAULT_GROUP skipped (git user.email not configured)"
    return 0
  fi

  local group_name="vm0/local-${username}-${hostname_short}"

  # Remove old value and its comment header if present, then append fresh
  if grep -q "^RUNNER_DEFAULT_GROUP=" "$WEB_ENV_LOCAL" 2>/dev/null; then
    sed -i '/^# Self-hosted Runner$/d; /^RUNNER_DEFAULT_GROUP=/d' "$WEB_ENV_LOCAL"
  fi

  # Remove trailing blank lines before appending
  while [[ -s "$WEB_ENV_LOCAL" && -z "$(tail -c 1 "$WEB_ENV_LOCAL")" ]] && tail -1 "$WEB_ENV_LOCAL" | grep -q '^$'; do
    sed -i '$ d' "$WEB_ENV_LOCAL"
  done

  echo "" >> "$WEB_ENV_LOCAL"
  echo "# Self-hosted Runner" >> "$WEB_ENV_LOCAL"
  echo "RUNNER_DEFAULT_GROUP=${group_name}" >> "$WEB_ENV_LOCAL"
  echo "  ✓ RUNNER_DEFAULT_GROUP=${group_name}"
}

# --- Main ---
sync_with_1password
configure_runner_group
