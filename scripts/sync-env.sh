#!/usr/bin/env bash
set -e

# Sync environment variables from .env.tpl files using 1Password CLI
# Usage: ./scripts/sync-env.sh [path/to/.env.tpl]

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Check if 1Password CLI is installed
if ! command -v op >/dev/null 2>&1; then
  echo "Error: 1Password CLI (op) is not installed"
  echo "Install it from: https://developer.1password.com/docs/cli/get-started/"
  exit 1
fi

# Sign in to 1Password once
echo "Signing in to 1Password..."
eval $(op signin)

# Function to sync a single template file
sync_template() {
  local template=$1
  local output="${template%.tpl}"

  if [ ! -f "$template" ]; then
    echo "⚠ Skipping: $template (not found)"
    return
  fi

  echo ""
  echo "Syncing: $template"
  echo "Output:  $output"
  op inject -i "$template" -o "$output"
  echo "✓ Synced successfully"
}

# If specific template provided, sync only that
if [ -n "$1" ]; then
  sync_template "$1"
else
  # Sync all known templates
  echo "Syncing all environment templates..."

  # Sync e2e environment
  sync_template "$PROJECT_ROOT/e2e/.env.tpl"

  # Sync web app environment (.env.local.tpl → turbo/apps/web/.env.local)
  if [ -f "$PROJECT_ROOT/.env.local.tpl" ]; then
    echo ""
    echo "Syncing: $PROJECT_ROOT/.env.local.tpl"
    echo "Output:  $PROJECT_ROOT/turbo/apps/web/.env.local"
    op inject -i "$PROJECT_ROOT/.env.local.tpl" -o "$PROJECT_ROOT/turbo/apps/web/.env.local"
    echo "✓ Synced successfully"
  else
    echo "⚠ Skipping: $PROJECT_ROOT/.env.local.tpl (not found)"
  fi
fi

echo ""
echo "✓ All environment variables synced successfully"
