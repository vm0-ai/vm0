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

# Find all .env.local.tpl files and process each one
find "$PROJECT_ROOT" -name ".env.local.tpl" -type f | while read -r tpl_file; do
  output_file="${tpl_file%.tpl}"
  echo ""
  echo "Syncing: $tpl_file"
  echo "Output:  $output_file"
  op inject --force -i "$tpl_file" -o "$output_file"
  echo "✓ Synced successfully"
done

echo ""
echo "✓ All environment variables synced successfully"
