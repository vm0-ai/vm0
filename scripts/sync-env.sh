#!/bin/bash
set -e

# Sync environment variables from .env.tpl using 1Password CLI
# Usage: ./scripts/sync-env.sh [path/to/.env.tpl]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Default to e2e/.env.tpl if no argument provided
ENV_TPL="${1:-$PROJECT_ROOT/e2e/.env.tpl}"
ENV_FILE="${ENV_TPL%.tpl}"

if [ ! -f "$ENV_TPL" ]; then
  echo "Error: Template file not found: $ENV_TPL"
  exit 1
fi

echo "Syncing environment variables..."
echo "Template: $ENV_TPL"
echo "Output: $ENV_FILE"

# Check if 1Password CLI is installed
if ! command -v op &> /dev/null; then
  echo "Error: 1Password CLI (op) is not installed"
  echo "Install it from: https://developer.1password.com/docs/cli/get-started/"
  exit 1
fi

# Sign in to 1Password and inject secrets
eval $(op signin)
op inject -i "$ENV_TPL" -o "$ENV_FILE"

echo "✓ Environment variables synced successfully"
