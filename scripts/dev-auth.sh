#!/bin/bash
# Quick local authentication for development
# Usage: pnpm dev:auth (from turbo directory)
#
# This script calls the test-token endpoint to generate a CLI token
# and saves it to ~/.vm0/config.json for local development.
#
# Prerequisites:
#   - Dev server must be running (pnpm dev)
#   - Server must be in development mode (NODE_ENV=development)

set -euo pipefail

VM0_API_URL="${VM0_API_URL:-http://localhost:3000}"

echo "=== Dev Authentication ==="
echo "API URL: ${VM0_API_URL}"

# Call test-token endpoint
RESPONSE=$(curl -s -w "\n%{http_code}" \
  -H "Content-Type: application/json" \
  -X POST \
  "${VM0_API_URL}/api/cli/auth/test-token")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "❌ Error: test-token endpoint returned $HTTP_CODE"
  echo "Response: $BODY"
  echo ""
  echo "Make sure the dev server is running (pnpm dev)"
  exit 1
fi

# Extract token from response
TOKEN=$(echo "$BODY" | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)

if [[ -z "$TOKEN" ]]; then
  echo "❌ Error: Failed to extract token from response"
  echo "Response: $BODY"
  exit 1
fi

# Create config directory and file
CONFIG_DIR="$HOME/.vm0"
CONFIG_FILE="$CONFIG_DIR/config.json"

mkdir -p "$CONFIG_DIR"

cat > "$CONFIG_FILE" << EOF
{
  "token": "$TOKEN",
  "apiUrl": "$VM0_API_URL"
}
EOF

echo ""
echo "✅ Authenticated successfully!"
echo "Config saved to: $CONFIG_FILE"
