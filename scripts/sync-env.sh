#!/usr/bin/env bash
set -e

# Sync all environment variables from .env.local.tpl files using 1Password CLI
# Usage: ./scripts/sync-env.sh

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

echo "Syncing all environment templates..."

# Sync e2e environment (e2e/.env.local.tpl → e2e/.env.local)
if [ -f "$PROJECT_ROOT/e2e/.env.local.tpl" ]; then
  echo ""
  echo "Syncing: $PROJECT_ROOT/e2e/.env.local.tpl"
  echo "Output:  $PROJECT_ROOT/e2e/.env.local"
  op inject --force -i "$PROJECT_ROOT/e2e/.env.local.tpl" -o "$PROJECT_ROOT/e2e/.env.local"
  echo "✓ Synced successfully"
else
  echo "⚠ Skipping: $PROJECT_ROOT/e2e/.env.local.tpl (not found)"
fi

# Sync web app environment (.env.local.tpl → turbo/apps/web/.env.local)
if [ -f "$PROJECT_ROOT/.env.local.tpl" ]; then
  echo ""
  echo "Syncing: $PROJECT_ROOT/.env.local.tpl"
  echo "Output:  $PROJECT_ROOT/turbo/apps/web/.env.local"
  op inject --force -i "$PROJECT_ROOT/.env.local.tpl" -o "$PROJECT_ROOT/turbo/apps/web/.env.local"
  echo "✓ Synced successfully"
else
  echo "⚠ Skipping: $PROJECT_ROOT/.env.local.tpl (not found)"
fi

# Sync platform app environment (turbo/apps/platform/.env.local.tpl → turbo/apps/platform/.env.local)
if [ -f "$PROJECT_ROOT/turbo/apps/platform/.env.local.tpl" ]; then
  echo ""
  echo "Syncing: $PROJECT_ROOT/turbo/apps/platform/.env.local.tpl"
  echo "Output:  $PROJECT_ROOT/turbo/apps/platform/.env.local"
  op inject --force -i "$PROJECT_ROOT/turbo/apps/platform/.env.local.tpl" -o "$PROJECT_ROOT/turbo/apps/platform/.env.local"
  echo "✓ Synced successfully"
else
  echo "⚠ Skipping: $PROJECT_ROOT/turbo/apps/platform/.env.local.tpl (not found)"
fi

echo ""
echo "✓ All environment variables synced successfully"
